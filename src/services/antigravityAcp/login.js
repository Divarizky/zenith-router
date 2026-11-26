import { createHash, randomBytes } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { recordAntigravityAcpAccountCatalog } from "./catalog.js";
import pkg from "../../../package.json" with { type: "json" };
import { createAntigravityAcpClient } from "./client.js";
import { createAntigravityAcpTransport } from "./transport.js";
import { getAntigravityAcpWorker, isPendingAntigravityAcpAccount, workerRuntimeEnv } from "./workers.js";
import { isValidAccountId, workerIdForAccount } from "./accounts.js";
import {
  acquireAntigravityAcpAccountUse,
  beginNewAntigravityAcpAccount,
  completeAntigravityAcpLogin,
  discardPendingAntigravityAcpAccount,
  getAntigravityAcpConfigGeneration,
  getAntigravityAcpProfiles,
} from "./profiles.js";

export const AGY_LOGIN_URL_WAIT_MS = 15_000;
export const AGY_LOGIN_URL_SETTLE_MS = 200;
export const AGY_LOGIN_TTL_MS = 120_000;
export const AGY_LOGIN_EXIT_WAIT_MS = 15_000;
export const AGY_LOGIN_VERIFY_WAIT_MS = 15_000;
export const AGY_LOGIN_MAX_OUTPUT_BYTES = 64 * 1024;
export const AGY_LOGIN_MAX_CODE_LENGTH = 512;

const GOOGLE_LOGIN_HOST = "accounts.google.com";
const GOOGLE_LOGIN_PATH = /^\/o\/oauth2\/(?:v2\/)?auth\/?$/;
const CODE_PATTERN = /^[A-Za-z0-9._~:/-]{1,512}$/;
export const AGY_CALLBACK_TIMEOUT_MS = 15_000;
export const AGY_CALLBACK_MAX_URL_LENGTH = 4096;
const SHIM_PROGRAMS = ["xdg-open", "sensible-browser", "x-www-browser", "www-browser", "gnome-open", "kde-open", "open", "gio"];
// Captures the URL and never falls through to a real opener: the agent must not open a browser on the server host.
const SHIM_SCRIPT = `#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
url=""
for a in "$@"; do case "$a" in http://*|https://*) url="$a";; esac; done
if [ -n "$url" ]; then printf '%s\\n' "$url" >> "$dir/urls"; fi
exit 0
`;
const attempts = new Map();
let starting = false;
let spawnFn = defaultSpawn;
let platformOverride = null;
const currentPlatform = () => platformOverride || process.platform;
let clientFactory = (workerId, options) => createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);
let timing = {
  urlWaitMs: AGY_LOGIN_URL_WAIT_MS,
  urlSettleMs: AGY_LOGIN_URL_SETTLE_MS,
  ttlMs: AGY_LOGIN_TTL_MS,
  exitWaitMs: AGY_LOGIN_EXIT_WAIT_MS,
  verifyWaitMs: AGY_LOGIN_VERIFY_WAIT_MS,
  callbackMs: AGY_CALLBACK_TIMEOUT_MS,
};

function genericFailure(code = "login_failed") {
  return { ok: false, code };
}

function bindingHash(value) {
  return createHash("sha256").update(String(value || "in-process")).digest("hex");
}

/** Bind an attempt to the already authenticated browser session without storing its credential. */
export function getAntigravityAcpLoginBinding(request) {
  const cookie = request?.header?.("cookie") || "";
  const adminToken = request?.header?.("x-zenith-admin-token") || "";
  const authorization = request?.header?.("authorization") || "";
  return bindingHash(cookie || adminToken || authorization || "in-process");
}

export function validateAgyAuthorizationUrl(raw) {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.hostname !== GOOGLE_LOGIN_HOST || url.port || url.username || url.password || url.hash) return null;
    if (!GOOGLE_LOGIN_PATH.test(url.pathname) || !url.search) return null;
    return url.href;
  } catch {
    return null;
  }
}

function extractAuthorizationUrl(text) {
  if (typeof text !== "string") return null;
  // Agy's supported machine-readable line is:
  // AGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?... 
  // The fallback accepts the same official URL when a CLI version prefixes it
  // with human-readable text; it never accepts a URL supplied by the browser.
  const cleanText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const candidates = [];
  const marked = cleanText.match(/(?:^|\n)\s*(?:AGY_LOGIN_URL|LOGIN_URL|AUTHORIZATION_URL)\s*[:=]\s*(\S+)/i);
  if (marked?.[1]) candidates.push(marked[1]);
  const urls = cleanText.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/gi) || [];
  candidates.push(...urls);
  for (const candidate of candidates) {
    const clean = candidate.replace(/[),.;]+$/, "");
    const validated = validateAgyAuthorizationUrl(clean);
    if (validated) return validated;
  }
  return null;
}

/**
 * Validates the loopback redirect_uri that Agy puts in the authorization URL.
 * Strict: http, literal loopback host (127.0.0.1, localhost, [::1]), explicit unprivileged port, no credentials/query/hash.
 * Returns null when absent or invalid; `{ invalid: true }` is never returned, callers distinguish via hasRedirectUri.
 */
export function parseLoopbackRedirect(raw) {
  if (typeof raw !== "string" || raw.length > 512) return null;
  // WHATWG URL silently normalizes "/../" and "/./", so dot segments and encoded separators are rejected on the raw string.
  if (/(?:^|\/)\.\.?(?:\/|$)|%2e|%2f|%5c|\\/i.test(raw.replace(/^http:\/\/[^/]*/i, ""))) return null;
  // The literal host text must already be canonical: URL() would rewrite "127.1", "0x7f.1" or "2130706433" to 127.0.0.1.
  const rawHost = raw.match(/^http:\/\/([^/?#@]*)/i)?.[1]?.replace(/:\d*$/, "");
  if (!rawHost || !["127.0.0.1", "localhost", "[::1]"].includes(rawHost)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" || url.username || url.password || url.hash || url.search) return null;
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return null;
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(url.pathname) || url.pathname.includes("..") || url.pathname.includes("//")) return null;
  return { host, port, path: url.pathname, ip: host === "[::1]" ? "::1" : "127.0.0.1" };
}

/** Extracts and validates the callback target; `state` is kept in memory only to match pasted redirects. */
function callbackFromAuthorizationUrl(authorizationUrl) {
  const params = new URL(authorizationUrl).searchParams;
  const redirect = params.get("redirect_uri");
  if (redirect === null) return { callback: null, ok: true };
  const callback = parseLoopbackRedirect(redirect);
  if (!callback) return { callback: null, ok: false };
  return { callback: { ...callback, state: params.get("state") || "" }, ok: true };
}

/** Validates a pasted full callback URL against the redirect the agent registered. Returns the request target or null. */
export function validatePastedCallback(raw, callback) {
  if (!callback || typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > AGY_CALLBACK_MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" || url.username || url.password || url.hash) return null;
  if (url.hostname !== callback.host || Number(url.port) !== callback.port || url.pathname !== callback.path) return null;
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048 || url.searchParams.has("error")) return null;
  if (!callback.state || url.searchParams.get("state") !== callback.state) return null;
  return { ip: callback.ip, port: callback.port, hostHeader: `${callback.host}:${callback.port}`, target: `${url.pathname}${url.search}` };
}

/** One GET to the literal loopback IP (no DNS, so no rebinding), no redirects, bounded time and body. Never logs the URL. */
function replayCallback({ ip, port, hostHeader, target }, timeoutMs = AGY_CALLBACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const req = http.request({ host: ip, port, path: target, method: "GET", headers: { Host: hostHeader, Connection: "close" }, agent: false, timeout: timeoutMs }, (res) => {
        const status = res.statusCode || 0;
        res.resume();
        res.once("end", () => done(status >= 200 && status < 400));
        res.once("error", () => done(false));
        res.once("close", () => done(status >= 200 && status < 400));
      });
      req.once("timeout", () => { req.destroy(); done(false); });
      req.once("error", () => done(false));
      req.end();
    } catch { done(false); }
  });
}

async function createBrowserShim() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-agy-shim-"));
  try {
    for (const name of SHIM_PROGRAMS) await writeFile(path.join(dir, name), SHIM_SCRIPT, { mode: 0o700 });
    await writeFile(path.join(dir, "urls"), "", { mode: 0o600 });
    return dir;
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

function startShimWatcher(record) {
  const sink = path.join(record.shimDir, "urls");
  record.shimTimer = setInterval(async () => {
    if (record.terminal || record.url) return;
    try {
      const text = (await readFile(sink, "utf8")).slice(0, AGY_LOGIN_MAX_OUTPUT_BYTES);
      for (const line of text.split("\n")) {
        const url = validateAgyAuthorizationUrl(line);
        if (url) { finishUrl(record, url); return; }
      }
    } catch {}
  }, 100);
  record.shimTimer.unref?.();
}

function cleanupShim(record) {
  clearInterval(record.shimTimer);
  record.shimTimer = null;
  if (record.shimDir) {
    const dir = record.shimDir;
    record.shimDir = null;
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function safeWorkerSnapshot(worker) {
  return {
    workerId: worker.workerId,
    launcher: worker.launcher,
    loginLauncher: worker.loginLauncher,
    loginLauncherArgs: worker.loginLauncherArgs || [],
    loginMode: worker.loginMode,
    authMethodId: worker.authMethodId,
    launcherArgs: worker.launcherArgs || [],
    isolatedHome: worker.isolatedHome,
    appData: worker.appData,
    workspace: worker.workspace,
  };
}

async function selectLoginWorker(accountId) {
  if (!isValidAccountId(accountId)) return null;
  if (!getAntigravityAcpProfiles().some((account) => account.id === accountId) && !isPendingAntigravityAcpAccount(accountId)) return null;
  const worker = await getAntigravityAcpWorker(workerIdForAccount(accountId));
  return worker && typeof worker.loginLauncher === "string" ? worker : null;
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

function forgetLater(record) {
  record.forgetTimer = setTimeout(() => {
    if (attempts.get(record.attemptId) === record) attempts.delete(record.attemptId);
  }, timing.ttlMs);
  record.forgetTimer.unref?.();
}

function terminateChild(record) {
  if (!record.child || record.exited) return;
  try { record.child.stdin?.destroy?.(); } catch {}
  try { record.child.kill?.("SIGTERM"); } catch {}
  const killTimer = setTimeout(() => {
    if (!record.exited) {
      try { record.child.kill?.("SIGKILL"); } catch {}
    }
  }, 1000);
  killTimer.unref?.();
}

function failRecord(record, code = "login_failed") {
  if (record.terminal) return;
  record.terminal = true;
  record.state = code === "login_cancelled" ? "cancelled" : "failed";
  record.errorCode = code;
  clearTimer(record.settleTimer);
  clearTimer(record.urlTimer);
  clearTimer(record.ttlTimer);
  clearTimer(record.exitTimer);
  record.verifyAbortController?.abort();
  record.releaseUse?.();
  terminateChild(record);
  cleanupShim(record);
  if (record.isNewAccount) void discardPendingAntigravityAcpAccount(record.accountId);
  record.resolveUrl?.(genericFailure(code));
  record.resolveExit?.({ exited: record.exited, code: record.exitCode, signal: record.exitSignal });
  record.resolveExit = null;
  forgetLater(record);
}

function finishUrl(record, url) {
  if (record.terminal || record.url) return;
  const { callback, ok } = callbackFromAuthorizationUrl(url);
  if (!ok) { failRecord(record, "login_callback_invalid"); return; }
  clearTimer(record.settleTimer);
  clearTimer(record.urlTimer);
  record.callback = callback;
  record.url = url;
  record.state = "awaiting_code";
  record.resolveUrl?.({ ok: true, attemptId: record.attemptId, authorizationUrl: url, expiresIn: Math.ceil(timing.ttlMs / 1000), callback: callback ? { host: callback.host, port: callback.port } : null });
  record.resolveUrl = null;
}

function isSettledAuthorizationUrl(urlStr, rawBuffer = "") {
  if (!urlStr) return false;
  const trimmed = rawBuffer.replace(/\r/g, "\n").trimEnd();
  if (/[&=]$/.test(trimmed)) return false;
  try {
    const parsed = new URL(urlStr);
    const clientId = parsed.searchParams.get("client_id");
    const state = parsed.searchParams.get("state");
    return Boolean(clientId && clientId.trim() && state && state.trim());
  } catch {
    return false;
  }
}

function collectStrings(value, out, depth = 0) {
  if (depth > 6) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, out, depth + 1));
}

function writeRpc(record, message) {
  try { record.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); return true; } catch { return false; }
}

/** ACP login: initialize, then authenticate(methodId). The agent raises the Google URL as a request/notification; nothing else is read. */
function consumeAcpStdout(record, chunk) {
  if (record.terminal) return;
  record.rpcBuffer = ((record.rpcBuffer || "") + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || ""))).slice(-AGY_LOGIN_MAX_OUTPUT_BYTES);
  const lines = record.rpcBuffer.split("\n");
  record.rpcBuffer = lines.pop();
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (!message || message.jsonrpc !== "2.0") continue;
    if (message.id === 1 && !message.method) {
      if (message.error || message.result?.protocolVersion !== 1) { failRecord(record, "login_process_failed"); return; }
      writeRpc(record, { id: 2, method: "authenticate", params: { methodId: record.worker.authMethodId || "oauth-personal" } });
    } else if (message.id === 2 && !message.method) {
      if (message.error) { failRecord(record, "login_process_failed"); return; }
      record.authenticated = true;
      record.resolveAuth?.(true);
      record.resolveAuth = null;
      if (record.callback && record.state === "awaiting_code" && !record.manual && !record.terminal) {
        // Local browser: the agent's own listener received the redirect; complete without user input.
        terminateChild(record);
        void finalizeLogin(record);
      }
    } else if (message.method) {
      if (Object.hasOwn(message, "id") && /elicitation/i.test(message.method)) record.elicitationId = message.id;
      else if (Object.hasOwn(message, "id")) writeRpc(record, { id: message.id, error: { code: -32601, message: "Method not found" } });
      if (!record.url) {
        const strings = [];
        collectStrings(message.params, strings);
        const url = extractAuthorizationUrl(strings.join("\n"));
        if (url) finishUrl(record, url);
      }
    }
  }
}

function consumeAcpStderr(record, chunk) {
  if (record.terminal || record.url) return;
  record.errBuffer = ((record.errBuffer || "") + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || ""))).slice(-AGY_LOGIN_MAX_OUTPUT_BYTES);
  const cut = record.errBuffer.lastIndexOf("\n");
  if (cut === -1) return;
  const complete = record.errBuffer.slice(0, cut);
  record.errBuffer = record.errBuffer.slice(cut + 1);
  const url = extractAuthorizationUrl(complete);
  if (url) finishUrl(record, url);
}

function consumeOutput(record, chunk) {
  if (record.terminal || record.url) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  if (!text) return;
  record.outputBuffer = (record.outputBuffer + text).slice(-AGY_LOGIN_MAX_OUTPUT_BYTES);
  record.outputBuffer = record.outputBuffer.replace(/\r\n/g, "\n");
  if (record.outputBuffer.endsWith("\r")) {
    record.outputBuffer = record.outputBuffer.slice(0, -1).replace(/\r/g, "\n") + "\r";
  } else {
    record.outputBuffer = record.outputBuffer.replace(/\r/g, "\n");
  }

  clearTimer(record.settleTimer);

  // Only scan complete lines closed by newline while stream is in progress
  // to avoid matching partially delivered URLs.
  const lastNewline = record.outputBuffer.lastIndexOf("\n");
  if (lastNewline !== -1) {
    const completeLines = record.outputBuffer.slice(0, lastNewline);
    record.outputBuffer = record.outputBuffer.slice(lastNewline + 1);
    const url = extractAuthorizationUrl(completeLines);
    if (url) {
      finishUrl(record, url);
      return;
    }
  }

  // If output remains without a newline, settle briefly before flushing
  if (!record.terminal && !record.url && record.outputBuffer) {
    record.settleTimer = setTimeout(() => {
      if (!record.terminal && !record.url) {
        flushSettleBuffer(record);
      }
    }, timing.urlSettleMs);
    record.settleTimer.unref?.();
  }
}

function flushSettleBuffer(record) {
  clearTimer(record.settleTimer);
  if (record.terminal || record.url || !record.outputBuffer) return;
  const candidateUrl = extractAuthorizationUrl(record.outputBuffer);
  if (!candidateUrl) return;
  if (!isSettledAuthorizationUrl(candidateUrl, record.outputBuffer)) {
    return;
  }
  record.outputBuffer = "";
  finishUrl(record, candidateUrl);
}

function flushOutputBuffer(record) {
  clearTimer(record.settleTimer);
  if (record.terminal || record.url || !record.outputBuffer) return;
  const url = extractAuthorizationUrl(record.outputBuffer);
  record.outputBuffer = "";
  if (url) {
    finishUrl(record, url);
  }
}

function attachChild(record, child) {
  record.child = child;
  if (record.worker.loginMode === "acp-authenticate") {
    child.stdout?.on?.("data", (chunk) => consumeAcpStdout(record, chunk));
    // Real agy prints the Google URL on stderr and calls xdg-open. Only complete lines are scanned for the
    // official authorization URL; nothing from stderr is stored or logged otherwise.
    child.stderr?.on?.("data", (chunk) => consumeAcpStderr(record, chunk));
    writeRpc(record, { id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zenith-router", version: pkg.version } } });
  } else {
    child.stdout?.on?.("data", (chunk) => consumeOutput(record, chunk));
    child.stderr?.on?.("data", (chunk) => consumeOutput(record, chunk));
  }
  child.stdout?.once?.("end", () => flushOutputBuffer(record));
  child.stdout?.once?.("close", () => flushOutputBuffer(record));
  child.stderr?.once?.("end", () => flushOutputBuffer(record));
  child.stderr?.once?.("close", () => flushOutputBuffer(record));
  const onExit = (code, signal) => {
    if (record.exited) return;
    record.exited = true;
    record.exitCode = code;
    record.exitSignal = signal;
    clearTimer(record.settleTimer);
    if (!record.url) flushOutputBuffer(record);
    clearTimer(record.exitTimer);
    record.resolveAuth?.(Boolean(record.authenticated));
    record.resolveAuth = null;
    record.resolveExit?.({ exited: true, code, signal });
    record.resolveExit = null;
    if (!record.terminal && record.state !== "submitting") failRecord(record, code === 0 ? "login_process_ended" : "login_process_failed");
  };
  child.once?.("error", () => {
    if (!record.exited) {
      if (!record.url) flushOutputBuffer(record);
      onExit(null, "error");
    }
  });
  child.once?.("exit", onExit);
  child.once?.("close", onExit);
}

function waitForExit(record, timeoutMs) {
  if (record.exited) return Promise.resolve({ exited: true, code: record.exitCode, signal: record.exitSignal });
  return new Promise((resolve) => {
    record.resolveExit = resolve;
    record.exitTimer = setTimeout(() => {
      record.resolveExit = null;
      failRecord(record, "login_process_timeout");
      resolve({ exited: false, timeout: true });
    }, timeoutMs);
  });
}

async function verifyWorker(record) {
  if (record.terminal) return false;
  const controller = new AbortController();
  record.verifyAbortController = controller;
  let client;
  const withinDeadline = (promise) => {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("ACP verification timeout"));
        }, timing.verifyWaitMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimer(timer));
  };
  try {
    client = await withinDeadline(clientFactory(record.worker.workerId, { signal: controller.signal }));
    if (!client || typeof client.initialize !== "function" || typeof client.newSession !== "function" || typeof client.close !== "function" || client.cwd !== record.worker.workspace || !path.isAbsolute(client.cwd)) {
      return false;
    }
    const initialized = await withinDeadline(client.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "zenith-router", version: pkg.version },
    }));
    if (initialized?.protocolVersion !== 1) return false;
    const session = await withinDeadline(client.newSession({ cwd: client.cwd, mcpServers: [] }));
    const ok = typeof session?.sessionId === "string" && session.sessionId.length > 0;
    if (ok && record.accountId) recordAntigravityAcpAccountCatalog(record.accountId, session);
    return ok;
  } catch {
    return false;
  } finally {
    record.verifyAbortController = null;
    try { await client?.close?.(); } catch {}
  }
}

function extractCode(code) {
  if (typeof code !== "string") return "";
  const value = code.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { return new URL(value).searchParams.get("code") || ""; } catch { return ""; }
  }
  if (/[?&]code=/.test(value) || value.startsWith("code=")) {
    try { return new URLSearchParams(value.replace(/^.*?\?/, "")).get("code") || ""; } catch { return ""; }
  }
  return value;
}

function validateCode(code) {
  const extracted = extractCode(code);
  if (!extracted || extracted.length > AGY_LOGIN_MAX_CODE_LENGTH) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(extracted)) return false;
  return CODE_PATTERN.test(extracted);
}

/**
 * Starts a Google login. Without `accountId` it adds a NEW account: a random id and folders are made,
 * but the account is listed only after the login verified. With `accountId` it signs an existing account in again.
 */
export async function startAntigravityAcpLogin(binding, accountId) {
  if ([...attempts.values()].some((attempt) => !attempt.terminal) || starting) return genericFailure("login_busy");
  starting = true;
  let isNewAccount = false;
  try {
    if (accountId === undefined || accountId === null || accountId === "") {
      const begun = await beginNewAntigravityAcpAccount();
      if (!begun.ok) return genericFailure("login_unavailable");
      accountId = begun.accountId;
      isNewAccount = true;
    }
    const worker = await selectLoginWorker(accountId);
    if (!worker) {
      if (isNewAccount) await discardPendingAntigravityAcpAccount(accountId);
      return genericFailure("login_unavailable");
    }
    const record = {
      isNewAccount,
      attemptId: randomBytes(24).toString("base64url"),
      accountId,
      releaseUse: acquireAntigravityAcpAccountUse(accountId),
      binding,
      worker: safeWorkerSnapshot(worker),
      generation: getAntigravityAcpConfigGeneration(),
      state: "starting",
      outputBuffer: "",
      url: null,
      child: null,
      exited: false,
      terminal: false,
      exitCode: null,
      exitSignal: null,
      resolveUrl: null,
      resolveExit: null,
      urlTimer: null,
      settleTimer: null,
      ttlTimer: null,
      exitTimer: null,
    };
    attempts.set(record.attemptId, record);
    record.ttlTimer = setTimeout(() => failRecord(record, "login_expired"), timing.ttlMs);
    record.ttlTimer.unref?.();
    const urlPromise = new Promise((resolve) => { record.resolveUrl = resolve; });
    record.urlTimer = setTimeout(() => failRecord(record, "login_url_timeout"), timing.urlWaitMs);
    let child;
    try {
      // No browser shim exists on Windows, so the agent could open a browser on the server host: fail closed.
      if (currentPlatform() === "win32" && record.worker.loginMode === "acp-authenticate") {
        failRecord(record, "login_unavailable");
        return genericFailure("login_unavailable");
      }
      const env = currentPlatform() === "win32"
        ? { PATH: `${process.env.SystemRoot || "C:\\Windows"}\\System32;${process.env.SystemRoot || "C:\\Windows"}`, SYSTEMROOT: process.env.SystemRoot || "C:\\Windows" }
        : { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
      Object.assign(env, workerRuntimeEnv(record.worker));
      if (currentPlatform() !== "win32" && record.worker.loginMode === "acp-authenticate") {
        record.shimDir = await createBrowserShim();
        if (!record.shimDir) { failRecord(record, "login_unavailable"); return genericFailure("login_unavailable"); }
        env.PATH = `${record.shimDir}:${env.PATH}`;
        env.BROWSER = path.join(record.shimDir, "xdg-open");
        startShimWatcher(record);
      }
      child = spawnFn(record.worker.loginLauncher, record.worker.loginLauncherArgs || [], {
        cwd: record.worker.workspace,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      attachChild(record, child);
    } catch {
      failRecord(record, "login_unavailable");
      return genericFailure("login_unavailable");
    }
    const result = await urlPromise;
    return result;
  } finally {
    starting = false;
  }
}

export async function submitAntigravityAcpLogin({ attemptId, binding, code }) {
  const record = attempts.get(attemptId);
  if (!record || record.binding !== binding || record.terminal) return genericFailure("login_attempt_invalid");
  if (record.state !== "awaiting_code") return genericFailure("login_attempt_used");
  const acpMode = record.worker.loginMode === "acp-authenticate";
  if (acpMode && record.callback) {
    // Remote browser: the user pastes the full failed loopback redirect; it is replayed to the agent's own listener.
    const target = validatePastedCallback(code, record.callback);
    if (!target) return genericFailure("invalid_authorization_code");
    record.state = "submitting";
    record.manual = true;
    const delivered = await replayCallback(target, timing.callbackMs);
    if (record.terminal) return genericFailure(record.errorCode || "login_cancelled");
    if (!delivered) {
      // The listener may be gone or the state rejected; the attempt stays usable until it expires.
      record.state = "awaiting_code";
      record.manual = false;
      return genericFailure("login_callback_failed");
    }
    return finishAcp(record);
  }
  const extractedCode = acpMode ? "" : extractCode(code);
  if (!acpMode && !validateCode(extractedCode)) return genericFailure("invalid_authorization_code");
  record.state = "submitting";
  record.manual = true;
  if (acpMode) {
    // Elicitation fallback: the agent completes the redirect itself; the submitted value is only a confirmation.
    if (record.elicitationId !== undefined) writeRpc(record, { id: record.elicitationId, result: { action: "accept" } });
    return finishAcp(record);
  }
  try {
    if (!record.child?.stdin || typeof record.child.stdin.write !== "function") {
      failRecord(record, "login_process_failed");
      return genericFailure("login_process_failed");
    }
    record.child.stdin.write(`${extractedCode}\n`);
    record.child.stdin.end?.();
  } catch {
    failRecord(record, "login_process_failed");
    return genericFailure("login_process_failed");
  }
  const exit = await waitForExit(record, timing.exitWaitMs);
  if (!exit.exited || exit.code !== 0) {
    if (!record.terminal) failRecord(record, "login_process_failed");
    return genericFailure(record.errorCode || "login_process_failed");
  }
  return finalizeLogin(record);
}

/** Waits for the agent's authenticate response, then verifies and registers. */
async function finishAcp(record) {
  const done = record.authenticated || await new Promise((resolve) => {
    record.resolveAuth = resolve;
    record.exitTimer = setTimeout(() => { record.resolveAuth = null; resolve(false); }, timing.exitWaitMs);
    record.exitTimer.unref?.();
  });
  clearTimer(record.exitTimer);
  if (record.terminal) return genericFailure(record.errorCode || "login_cancelled");
  terminateChild(record);
  if (!done) { failRecord(record, "login_process_timeout"); return genericFailure("login_process_timeout"); }
  return finalizeLogin(record);
}

function finalizeLogin(record) {
  if (!record.finalizing) record.finalizing = runFinalize(record);
  return record.finalizing;
}

async function runFinalize(record) {
  record.state = "submitting";
  const verified = await verifyWorker(record);
  if (record.terminal) return genericFailure(record.errorCode || "login_cancelled");
  if (!verified) {
    failRecord(record, "login_verification_failed");
    return genericFailure("login_verification_failed");
  }
  if (record.terminal) return genericFailure(record.errorCode || "login_cancelled");
  const registered = await completeAntigravityAcpLogin(record.accountId, {
    expectedWorker: record.worker,
    shouldCommit: () => !record.terminal,
  });
  if (record.terminal) return genericFailure(record.errorCode || "login_cancelled");
  if (!registered.ok) {
    failRecord(record, "login_configuration_changed");
    return genericFailure(record.errorCode);
  }
  record.terminal = true;
  record.releaseUse?.();
  record.state = "ready";
  record.errorCode = null;
  clearTimer(record.ttlTimer);
  forgetLater(record);
  return { ok: true, status: "ready", added: record.isNewAccount === true };
}

export function getAntigravityAcpLoginStatus({ attemptId, binding }) {
  const record = attempts.get(attemptId);
  if (!record || record.binding !== binding) return genericFailure("login_attempt_invalid");
  return { ok: true, status: record.state, error: record.errorCode || undefined };
}

export function cancelAntigravityAcpLogin({ attemptId, binding }) {
  const record = attempts.get(attemptId);
  if (!record || record.binding !== binding) return genericFailure("login_attempt_invalid");
  clearTimer(record.settleTimer);
  if (record.terminal) return { ok: true, status: record.state };
  failRecord(record, "login_cancelled");
  return { ok: true, status: "cancelled" };
}

export function setAntigravityAcpLoginDependenciesForTests({ spawn, createClient, timings, platform } = {}) {
  if (typeof platform === "string") platformOverride = platform;
  if (typeof spawn === "function") spawnFn = spawn;
  if (typeof createClient === "function") clientFactory = createClient;
  if (timings && typeof timings === "object") timing = {
    urlWaitMs: Number.isFinite(timings.urlWaitMs) ? timings.urlWaitMs : timing.urlWaitMs,
    urlSettleMs: Number.isFinite(timings.urlSettleMs) ? timings.urlSettleMs : timing.urlSettleMs,
    ttlMs: Number.isFinite(timings.ttlMs) ? timings.ttlMs : timing.ttlMs,
    exitWaitMs: Number.isFinite(timings.exitWaitMs) ? timings.exitWaitMs : timing.exitWaitMs,
    verifyWaitMs: Number.isFinite(timings.verifyWaitMs) ? timings.verifyWaitMs : timing.verifyWaitMs,
    callbackMs: Number.isFinite(timings.callbackMs) ? timings.callbackMs : timing.callbackMs,
  };
}

export function resetAntigravityAcpLoginForTests() {
  for (const record of attempts.values()) {
    failRecord(record, "login_cancelled");
    clearTimer(record.forgetTimer);
    clearTimer(record.settleTimer);
    clearTimer(record.urlTimer);
    clearTimer(record.ttlTimer);
    clearTimer(record.exitTimer);
  }
  attempts.clear();
  starting = false;
  spawnFn = defaultSpawn;
  platformOverride = null;
  clientFactory = (workerId, options) => createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);
  timing = {
    urlWaitMs: AGY_LOGIN_URL_WAIT_MS,
    urlSettleMs: AGY_LOGIN_URL_SETTLE_MS,
    ttlMs: AGY_LOGIN_TTL_MS,
    exitWaitMs: AGY_LOGIN_EXIT_WAIT_MS,
    verifyWaitMs: AGY_LOGIN_VERIFY_WAIT_MS,
    callbackMs: AGY_CALLBACK_TIMEOUT_MS,
  };
}

export function extractAgyAuthorizationUrlForTests(text) {
  return extractAuthorizationUrl(text);
}