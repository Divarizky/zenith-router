/**
 * One-click login for browser-session providers, driven over the Chrome
 * DevTools Protocol instead of a WebDriver dependency.
 *
 * The flow: open a tab on the DeepSeek login page in a Chromium browser that
 * speaks CDP, let the user log in by hand (DeepSeek asks for a captcha or an SMS
 * code, so automating the form is not worth it), then read the session token
 * out of localStorage and close the tab. A browser the user already started
 * with a debugging port is reused; otherwise an installed Chrome/Edge runs with
 * an empty throwaway profile that is deleted afterwards, so nothing is injected
 * into the user's normal profile. The window starts from a copy of the user's
 * own session files (cookies plus web storage), so an existing DeepSeek login is
 * reused without opening their live profile.
 *
 * The CDP surface used here is small on purpose: one page target, Runtime
 * evaluate, and Network.getCookies.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { normalizeSessionToken } from "./token.js";
import { verifySessionToken } from "./health.js";
import { restoreSystemProfile } from "./browserProfile.js";

export const LOGIN_URL = "https://chat.deepseek.com/sign_in";

const LAUNCH_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 1200;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PROFILE_PREFIX = "zenith-login-";
// Do not re-ask the upstream about the same rejected token more often than this.
const VERIFY_RETRY_MS = 5000;
const VERIFY_TIMEOUT_MS = 8000;

const SESSION_PROBE = `(() => {
  try {
    return JSON.stringify({ token: localStorage.getItem("userToken"), href: location.href });
  } catch (error) {
    return "";
  }
})()`;

/**
 * Which browser the user picked as their default, as a family name. Windows
 * stores it as a ProgId (`MSEdgeHTM`, `ChromeHTML`); macOS and Linux expose the
 * handler differently, so there the family stays unknown and install order wins.
 */
export function defaultBrowserFamily(platform = process.platform) {
  const known = { msedgehtm: "edge", msedge: "edge", chromehtml: "chrome", chromiumhtml: "chromium", bravehtml: "brave", vivaldihtml: "vivaldi" };
  try {
    if (platform === "win32") {
      const key = "HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
      const out = execFileSync("reg", ["query", key, "/v", "ProgId"], { encoding: "utf8", windowsHide: true, timeout: 4000 });
      const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out);
      return match ? known[String(match[1]).toLowerCase()] || "" : "";
    }
    if (platform === "darwin") {
      const out = execFileSync(
        "defaults",
        ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
        { encoding: "utf8", timeout: 4000 }
      );
      const section = /LSHandlerURLScheme\s*=\s*https;[\s\S]{0,400}?LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/.exec(out);
      const id = String(section?.[1] || "").toLowerCase();
      if (id.includes("edge")) return "edge";
      if (id.includes("chrome")) return "chrome";
      if (id.includes("chromium")) return "chromium";
      return "";
    }
  } catch {
    // No readable preference; fall back to install order.
  }
  return "";
}

/** Every Chromium-family install worth trying, in the order they are probed. */
function allCandidates(platform) {
  if (platform === "win32") {
    return [
      { family: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
      { family: "chrome", path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
      { family: "edge", path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" },
      { family: "edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
      { family: "brave", path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
      { family: "vivaldi", path: "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe" },
    ];
  }
  if (platform === "darwin") {
    return [
      { family: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { family: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { family: "chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { family: "brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    ];
  }
  return [
    { family: "chrome", path: "/usr/bin/google-chrome" },
    { family: "chromium", path: "/usr/bin/chromium" },
    { family: "chromium", path: "/usr/bin/chromium-browser" },
    { family: "edge", path: "/usr/bin/microsoft-edge" },
  ];
}

/**
 * Executables to try, in order. ZENITH_BROWSER_PATH wins when set; otherwise the
 * user's default browser is tried before the rest, so the login window opens in
 * the browser they actually use instead of whichever happens to be installed.
 */
export function browserCandidates(platform = process.platform) {
  const override = String(process.env.ZENITH_BROWSER_PATH || "").trim();
  if (override) return [override];
  const candidates = allCandidates(platform);
  const preferred = defaultBrowserFamily(platform);
  if (!preferred) return candidates.map((c) => c.path);
  const first = candidates.filter((c) => c.family === preferred).map((c) => c.path);
  const rest = candidates.filter((c) => c.family !== preferred).map((c) => c.path);
  return [...first, ...rest];
}

export function findBrowser() {
  const override = String(process.env.ZENITH_BROWSER_PATH || "").trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`ZENITH_BROWSER_PATH menunjuk ke berkas yang tidak ada: ${override}`);
    }
    return override;
  }
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome, Edge, atau Chromium tidak ditemukan. Pasang salah satunya atau set ZENITH_BROWSER_PATH.");
}

/**
 * A token worth verifying: long enough to be a session JWT and free of the
 * whitespace a wrapper or a failed paste would leave behind. The upstream probe
 * is still what decides, this only avoids pointless round trips.
 */
export function looksLikeSessionToken(token) {
  const value = String(token || "");
  return value.length >= 40 && !/\s/.test(value);
}

/** Ports a browser is commonly started with for debugging, in probe order. */
const CDP_PORTS = [9222, 9223, 9224, 9333];

/** Debug endpoint of a browser the user already has open (Chrome/Edge flag). */
export function cdpEndpoint() {
  return String(process.env.ZENITH_CDP_ENDPOINT || "http://127.0.0.1:9222").replace(/\/+$/, "");
}

/** Every endpoint worth probing: the configured one first, then common ports. */
export function cdpEndpoints() {
  const configured = process.env.ZENITH_CDP_ENDPOINT ? [cdpEndpoint()] : [];
  const defaults = CDP_PORTS.map((port) => `http://127.0.0.1:${port}`);
  return [...new Set([...configured, ...defaults])];
}

/** Browser info when a debuggable browser is already listening, else null. */
async function browserAt(endpoint) {
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const info = await res.json();
    // Another tool may own the port; only a Chromium browser speaks this CDP.
    return /chrome|chromium|edg/i.test(String(info?.Browser || "")) ? info : null;
  } catch {
    return null;
  }
}

/**
 * First debuggable browser found. The user only has to have started Chrome or
 * Edge with any of the usual debugging ports; no dashboard button needed.
 */
async function existingBrowser() {
  for (const endpoint of cdpEndpoints()) {
    const info = await browserAt(endpoint);
    if (info) return { endpoint, info };
  }
  return null;
}

/** Open a tab in the user's browser and return its CDP target. */
async function openTab(endpoint, url) {
  // Chrome >= 111 requires PUT; older builds still answer GET.
  let res = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 405) {
    res = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5000) });
  }
  if (!res.ok) throw new Error(`Browser yang sudah terbuka menolak tab baru (HTTP ${res.status}).`);
  const target = await res.json();
  if (!target?.webSocketDebuggerUrl) throw new Error("Tab baru tidak memberi alamat CDP.");
  return target;
}

async function closeTab(endpoint, id) {
  if (!id) return;
  try {
    await fetch(`${endpoint}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2000) });
  } catch {
    // The tab is already gone; nothing to clean up.
  }
}

/** The first two lines of DevToolsActivePort are the port and the browser ws path. */
export function parseDevToolsActivePort(text) {
  const [portLine, wsPath] = String(text || "").trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, wsPath: wsPath || "" };
}

/** Cookie header in the same shape users paste manually. */
export function cookiesToHeader(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value ?? ""}`)
    .join("; ");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Login dibatalkan."));
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** A TCP port that is free right now, for this browser's debugging endpoint. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForFile(file, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (isAlive && !isAlive()) return reject(new Error("Jendela browser ditutup sebelum siap."));
      if (existsSync(file)) {
        return resolve(readFileSync(file, "utf8"));
      }
      if (Date.now() > deadline) return reject(new Error("Browser tidak membuka port debugging."));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Minimal CDP client over the WebSocket built into Node. `closed` turns true
 * when the tab (or the whole window) goes away; navigation inside the tab keeps
 * the socket open.
 */
export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "CDP error"));
      else entry.resolve(message.result || {});
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error("Koneksi ke browser terputus."));
      this.pending.clear();
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve(new CdpConnection(ws));
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error("Tidak bisa terhubung ke browser lewat CDP."));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

async function pageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`Browser menolak daftar target (HTTP ${res.status}).`);
  const targets = await res.json();
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => String(target.url).includes("deepseek.com")) || pages[0] || null;
}

async function readCookies(connection) {
  try {
    await connection.send("Network.enable");
    const { cookies } = await connection.send("Network.getCookies", { urls: ["https://chat.deepseek.com"] });
    return cookiesToHeader(cookies);
  } catch {
    // Cookies are optional: the token alone works for most accounts.
    return "";
  }
}

/**
 * Chrome spawns renderer processes that keep the profile directory locked, so a
 * plain SIGTERM leaves the temp profile behind on Windows. /T kills the tree.
 */
function killBrowser(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

async function removeProfile(dir) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/**
 * Launch a Chromium window with a debugging port that this process owns.
 *
 * The port is fixed and chosen up front (not `=0`) because `--user-data-dir`
 * isolation is what makes it possible: a fresh profile never piggybacks on the
 * user's running Chrome, so the flag is honoured even while their daily browser
 * is open. The window is the user's own Chrome/Edge binary, so the session they
 * create is a real DeepSeek session they can reuse.
 */
async function launchOwnBrowser({ proxyUrl, deadline, onStatus }) {
  const executable = findBrowser();
  const profileDir = mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  // Their cookies and web storage travel into the throwaway profile, so an
  // existing login shows up immediately. Nothing is written to the real profile.
  onStatus?.("profile");
  const restored = restoreSystemProfile(executable, profileDir);
  const port = await pickFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    // Must match the copied directory: web storage is per profile.
    `--profile-directory=${restored.profile || "Default"}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--window-size=1100,820",
    LOGIN_URL,
  ];
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

  const proc = spawn(executable, args, { stdio: "ignore", windowsHide: false });
  let spawnError = null;
  proc.once("error", (error) => {
    spawnError = error;
  });
  // Chrome's launcher process may hand the window to a child and exit 0, so an
  // exit is only fatal with a non-zero code. The endpoint is the real proof.
  let exited = null;
  proc.once("exit", (code) => {
    exited = code;
  });

  const endpoint = `http://127.0.0.1:${port}`;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Browser gagal dijalankan: ${spawnError.message}`);
      const info = await browserAt(endpoint);
      if (info) return { proc, profileDir, endpoint, restored };
      if (exited !== null && exited !== 0) {
        throw new Error(`Browser berhenti saat dibuka (kode ${exited}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Browser tidak membuka port debugging tepat waktu.");
  } catch (error) {
    killBrowser(proc);
    await removeProfile(profileDir);
    throw error;
  }
}

/**
 * Open a browser, wait until a DeepSeek session exists, and return its token.
 *
 * The window always runs with a debugging port, so the flow is the same
 * everywhere: a tab on the DeepSeek login page whose token is read through CDP.
 * A browser the user already started with one of the usual debugging ports is
 * reused (its existing login included) and only the extra tab is closed
 * afterwards; otherwise a throwaway profile is launched. Either way the token is
 * verified against the PoW challenge endpoint before it is returned, so a
 * half-loaded page or a guest token never becomes an account.
 */
export async function captureBrowserSession({ proxyUrl = "", timeoutMs, signal, onStatus } = {}) {
  if (signal?.aborted) throw new Error("Login dibatalkan.");
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : Number(process.env.ZENITH_LOGIN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budget;

  const found = await existingBrowser();
  let attachTo = found?.info || null;
  let endpoint = found?.endpoint || cdpEndpoint();
  let proc = null;
  let profileDir = null;
  let restored = [];
  let launchedProfile = "";
  let tab = null;
  let connection = null;

  try {
    if (attachTo) {
      onStatus?.("attaching");
    } else {
      onStatus?.("launching");
      const launched = await launchOwnBrowser({ proxyUrl, deadline, onStatus });
      proc = launched.proc;
      profileDir = launched.profileDir;
      endpoint = launched.endpoint;
      restored = launched.restored.copied;
      launchedProfile = launched.restored.profile;
    }

    tab = await openTab(endpoint, LOGIN_URL);
    connection = await CdpConnection.open(tab.webSocketDebuggerUrl);
    await connection.send("Runtime.enable");
    onStatus?.("waiting");

    // A token that the upstream already rejected is not re-checked on every
    // poll; the user needs a moment to finish logging in.
    const rejected = new Map();
    let lastVerdict = null;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Login dibatalkan.");
      // A launcher that exits 0 handed the window to a child; a live CDP
      // endpoint is what tells us the browser is still there.
      if (proc && proc.exitCode !== null && proc.exitCode !== 0) {
        throw new Error("Jendela browser ditutup sebelum login selesai.");
      }
      // A closed window usually exits with code 0, so the socket is the signal;
      // without this check the loop would poll a dead tab until the timeout.
      if (connection.closed) {
        throw new Error("Jendela atau tab login ditutup sebelum login selesai.");
      }
      try {
        const { result } = await connection.send("Runtime.evaluate", {
          expression: SESSION_PROBE,
          returnByValue: true,
          awaitPromise: false,
        });
        const state = JSON.parse(result?.value || "{}");
        const token = normalizeSessionToken(state.token || "");
        const onLoginPage = /\/sign_in/.test(String(state.href || ""));
        if (token && looksLikeSessionToken(token) && !onLoginPage) {
          const fingerprint = `${token.length}:${token.slice(0, 16)}:${token.slice(-8)}`;
          const lastRejected = rejected.get(fingerprint);
          if (!lastRejected || Date.now() - lastRejected > VERIFY_RETRY_MS) {
            const cookies = await readCookies(connection);
            onStatus?.("verifying");
            const verdict = await verifySessionToken({ token, cookies }, { proxyUrl, timeoutMs: VERIFY_TIMEOUT_MS });
            if (verdict?.status === "ok") {
              onStatus?.("captured");
              return {
                token,
                cookies,
                href: state.href || "",
                attached: Boolean(attachTo),
                // Which session files the window inherited from the user's own
                // browser; empty when it started from a clean profile.
                restored,
                profile: launchedProfile || "",
              };
            }
            // Guest tokens and half-initialised pages land here; keep the window
            // open and wait for the real login.
            lastVerdict = verdict;
            rejected.set(fingerprint, Date.now());
            onStatus?.("waiting");
          }
        }
      } catch {
        // The page is navigating, so the execution context is gone; poll again.
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
    if (lastVerdict) {
      // A token was seen but the upstream refused it or the gateway could not
      // reach DeepSeek: say which, instead of a bare timeout.
      throw new Error(
        `Sesi terdeteksi tetapi belum bisa diverifikasi (${lastVerdict.code || lastVerdict.status}: ${
          lastVerdict.message || "tanpa keterangan"
        }). Ulangi login atau tempel token manual.`
      );
    }
    throw new Error("Waktu login habis. Ulangi login dan selesaikan sebelum 5 menit.");
  } finally {
    connection?.close();
    if (attachTo) {
      // The browser belongs to the user: close only the tab we opened.
      await closeTab(endpoint, tab?.id);
    } else if (proc) {
      killBrowser(proc);
      // Trashed profiles can lag behind the process on Windows, hence the retries.
      if (profileDir) await removeProfile(profileDir);
    }
  }
}
