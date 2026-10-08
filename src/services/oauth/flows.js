import http from "node:http";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { addConnection } from "../../db/index.js";
import { getProvider } from "../../providers/index.js";
import { getOAuthFlow } from "./providers.js";

// Pending logins live in memory only: a restart simply means "log in again".
// The browser never sees PKCE verifiers or device secrets, only an opaque flowId.

const FLOW_TTL_MS = 10 * 60 * 1000;
const flows = new Map();

function pkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function closeListener(flow) {
  if (flow.listener) {
    flow.listener.close();
    flow.listener = null;
  }
}

function prune() {
  const now = Date.now();
  for (const [id, flow] of flows) {
    if (flow.expiresAt < now) {
      closeListener(flow);
      flows.delete(id);
    }
  }
}

function finish(flow, patch) {
  Object.assign(flow, patch);
  closeListener(flow);
  // Keep the result around briefly so the dashboard can read it.
  flow.expiresAt = Math.min(flow.expiresAt, Date.now() + 2 * 60 * 1000);
}

/** Store tokens from any login method as an oauth connection. Returns the account name. */
export function saveOAuthConnection(providerId, tokens, { name, proxyUrl } = {}) {
  const provider = getProvider(providerId);
  const expiresAt =
    tokens.expires_at || (Number(tokens.expires_in) > 0 ? Date.now() + Number(tokens.expires_in) * 1000 : undefined);
  const credentials = { access_token: tokens.access_token };
  if (tokens.refresh_token) credentials.refresh_token = tokens.refresh_token;
  if (expiresAt) credentials.expires_at = expiresAt;
  if (tokens.email) credentials.email = tokens.email;
  Object.assign(credentials, tokens.extra || {});

  const accountName = name || tokens.email || tokens.name || `${provider.name} OAuth`;
  return addConnection({
    provider: provider.id,
    name: accountName,
    auth_type: "oauth",
    credentials,
    proxy_url: proxyUrl || null,
  });
}

/**
 * Start a login. `origin` is the dashboard origin, used for the /callback redirect.
 * Returns what the dashboard needs to show: an auth URL, or a device code to enter.
 */
export async function startOAuthFlow({ providerId, origin, name, proxyUrl }) {
  prune();
  const provider = getProvider(providerId);
  const impl = provider && getOAuthFlow(provider.id);
  if (!impl) throw new Error("Provider ini tidak mendukung login OAuth.");

  const flowId = crypto.randomBytes(16).toString("base64url");
  const flow = {
    id: flowId,
    providerId: provider.id,
    impl,
    name: name || "",
    proxyUrl: proxyUrl || "",
    status: "pending",
    expiresAt: Date.now() + FLOW_TTL_MS,
  };

  if (impl.flowType === "device_code") {
    const d = await impl.start({ proxyUrl: flow.proxyUrl });
    Object.assign(flow, {
      deviceCode: d.deviceCode,
      deviceState: d.state || {},
      interval: Math.max(1, Number(d.interval) || 5) * 1000,
      nextPollAt: 0,
    });
    if (Number(d.expiresIn) > 0) flow.expiresAt = Math.min(flow.expiresAt, Date.now() + Number(d.expiresIn) * 1000);
    flows.set(flowId, flow);
    return {
      flowId,
      flowType: "device_code",
      userCode: d.userCode || null,
      verificationUri: d.verificationUri,
      interval: flow.interval / 1000,
    };
  }

  const { codeVerifier, codeChallenge } = pkcePair();
  const state = crypto.randomBytes(24).toString("base64url");
  const redirectUri = impl.fixedPort
    ? `http://localhost:${impl.fixedPort}${impl.callbackPath}`
    : `${origin.replace("127.0.0.1", "localhost")}/callback`;
  Object.assign(flow, { state, codeVerifier, redirectUri });
  flows.set(flowId, flow);

  // Codex only accepts its CLI redirect, so listen there for the duration of the login.
  let listening = true;
  if (impl.fixedPort) listening = await listenForFixedCallback(flow);

  return {
    flowId,
    flowType: "authorization_code",
    authUrl: impl.buildAuthUrl({ redirectUri, state, codeChallenge: impl.pkce ? codeChallenge : undefined }),
    // When the redirect cannot reach zenroute, the user pastes the callback URL instead.
    listening,
  };
}

function listenForFixedCallback(flow) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, flow.redirectUri);
      if (url.pathname !== flow.impl.callbackPath) {
        res.writeHead(404).end();
        return;
      }
      const result = await completeCallback(Object.fromEntries(url.searchParams));
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCallbackPage(result));
    });
    server.once("error", () => resolve(false));
    server.listen(flow.impl.fixedPort, "127.0.0.1", () => {
      server.unref();
      flow.listener = server;
      resolve(true);
    });
  });
}

async function exchangeAndSave(flow, code, state) {
  try {
    const tokens = await flow.impl.exchange({
      code,
      state,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
      proxyUrl: flow.proxyUrl,
    });
    if (!tokens?.access_token) throw new Error("Provider tidak mengembalikan access token.");
    const conn = saveOAuthConnection(flow.providerId, tokens, flow);
    finish(flow, { status: "done", account: conn?.name });
    return { ok: true, providerId: flow.providerId, account: conn?.name };
  } catch (err) {
    finish(flow, { status: "error", error: err.message });
    return { ok: false, error: err.message };
  }
}

function findByState(state) {
  for (const flow of flows.values()) {
    if (flow.state && flow.state === state && flow.status === "pending") return flow;
  }
  return null;
}

/** Handle the provider redirect: /callback?code=&state= (or ?error=). */
export async function completeCallback(params = {}) {
  prune();
  const flow = params.state ? findByState(params.state) : null;
  if (!flow) return { ok: false, error: "Sesi login tidak ditemukan atau sudah kedaluwarsa. Ulangi dari dashboard." };
  if (params.error) {
    finish(flow, { status: "error", error: params.error_description || params.error });
    return { ok: false, error: flow.error };
  }
  if (!params.code) return { ok: false, error: "Callback tidak berisi code." };
  return exchangeAndSave(flow, params.code, params.state);
}

/**
 * Finish an authorization-code login from pasted input: the full callback URL,
 * a "code#state" string (Claude's manual page), or a bare code.
 */
export async function completeManual(flowId, input) {
  prune();
  const flow = flows.get(flowId);
  if (!flow || flow.status !== "pending" || !flow.state) {
    return { ok: false, error: "Sesi login tidak ditemukan atau sudah selesai." };
  }
  const raw = String(input || "").trim();
  let code = raw;
  let state = flow.state;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    code = url.searchParams.get("code") || "";
    state = url.searchParams.get("state") || "";
    if (url.searchParams.get("error")) return { ok: false, error: url.searchParams.get("error") };
  } else if (raw.includes("#")) {
    state = raw.split("#")[1];
  }
  if (!code) return { ok: false, error: "Tidak menemukan code di input." };
  if (state !== flow.state) return { ok: false, error: "State tidak cocok. Pastikan URL berasal dari login yang sama." };
  return exchangeAndSave(flow, code, state);
}

/**
 * Status for the dashboard. For device flows this also polls the provider,
 * at most once per the provider's interval.
 */
export async function pollOAuthFlow(flowId) {
  prune();
  const flow = flows.get(flowId);
  if (!flow) return { status: "error", error: "Sesi login kedaluwarsa. Ulangi login." };
  if (flow.status !== "pending" || flow.impl.flowType !== "device_code" || Date.now() < flow.nextPollAt) {
    return { status: flow.status, error: flow.error, account: flow.account };
  }

  flow.nextPollAt = Date.now() + flow.interval;
  try {
    const result = await flow.impl.poll({
      deviceCode: flow.deviceCode,
      state: flow.deviceState,
      proxyUrl: flow.proxyUrl,
    });
    if (result.pending) return { status: "pending" };
    if (result.error) {
      finish(flow, { status: "error", error: result.error });
    } else {
      const conn = saveOAuthConnection(flow.providerId, result.tokens, flow);
      finish(flow, { status: "done", account: conn?.name });
    }
  } catch (err) {
    finish(flow, { status: "error", error: err.message });
  }
  return { status: flow.status, error: flow.error, account: flow.account };
}

export function cancelOAuthFlow(flowId) {
  const flow = flows.get(flowId);
  if (flow) {
    closeListener(flow);
    flows.delete(flowId);
  }
}

export function renderCallbackPage({ ok, error, account }) {
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const body = ok
    ? `<h1>Login berhasil</h1><p>${account ? `Akun <strong>${esc(account)}</strong> tersimpan. ` : ""}Tab ini boleh ditutup.</p>`
    : `<h1>Login gagal</h1><p>${esc(error)}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>zenroute</title>
<style>body{background:#000;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:2rem;border:1px solid #333;border-radius:10px}h1{font-size:1.2rem}p{color:#aaa}</style>
</head><body><main>${body}</main>${ok ? "<script>setTimeout(function(){window.close()},1500)</script>" : ""}</body></html>`;
}

// ---------------------------------------------------------------------------
// Import from a vendor CLI/IDE already logged in on this machine (9router auto-import).
// ---------------------------------------------------------------------------

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Freebuff/Codebuff CLI login. Newer CLIs keep only metadata in
 * ~/.config/manicode/credentials.json and the token in the OS keychain
 * (Windows Credential Manager target "freebuff-cli/<credentials path>").
 */
async function importFreebuff() {
  for (const dir of ["manicode", "codebuff"]) {
    const credPath = join(homedir(), ".config", dir, "credentials.json");
    const data = await readJsonFile(credPath);
    const user = data?.default || data;
    let token = user?.authToken || null;
    if (!token && user && process.platform === "win32") {
      token = await readWindowsCredential(`freebuff-cli/${credPath}`);
    }
    if (!token) continue;
    // A mis-decoded blob comes back as "????"; storing it only yields "Invalid Codebuff API key" later.
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new Error("Token Freebuff dari aplikasi lokal tidak terbaca dengan benar. Login ulang di `freebuff` lalu import lagi.");
    }
    return { access_token: token, email: user.email, name: user.name };
  }
  throw new Error("Kredensial Freebuff tidak ditemukan. Jalankan `freebuff` (npm i -g freebuff) lalu login dulu.");
}

/** Credential blobs are raw bytes: UTF-8 for most CLIs (9router zedCredentials.js), UTF-16LE for some. */
export function decodeCredentialBlob(buf) {
  const looksUtf16 = buf.length >= 2 && buf.length % 2 === 0 && buf.every((b, i) => i % 2 === 0 || b === 0);
  return buf.toString(looksUtf16 ? "utf16le" : "utf8").replace(/\0+$/, "").trim();
}

/** Read a generic Windows credential via CredRead (no new dependencies, .NET only). */
async function readWindowsCredential(target) {
  const { execFile } = await import("node:child_process");
  const script = [
    "Add-Type @'",
    "using System; using System.Runtime.InteropServices;",
    "public class ZrCred {",
    "  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
    "  public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredBlobSize; public IntPtr CredBlob; public int Persist; public int AttrCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }",
    '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
    "  public static extern bool CredRead(string t, int ty, int f, out IntPtr c);",
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);',
    "}",
    "'@",
    `$t = "${target.replace(/"/g, '""')}"`,
    "$p = [IntPtr]::Zero",
    "if ([ZrCred]::CredRead($t, 1, 0, [ref]$p)) {",
    "  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][ZrCred+CRED])",
    "  $b = New-Object byte[] $c.CredBlobSize",
    "  [Runtime.InteropServices.Marshal]::Copy($c.CredBlob, $b, 0, $c.CredBlobSize)",
    "  [ZrCred]::CredFree($p)",
    // Base64 keeps the bytes intact; the console code page would turn non-ASCII into "?".
    "  [Convert]::ToBase64String($b)",
    "}",
  ].join("\n");
  try {
    const out = await new Promise((resolve, reject) =>
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      )
    );
    const b64 = String(out || "").trim();
    return b64 ? decodeCredentialBlob(Buffer.from(b64, "base64")) || null : null;
  } catch {
    return null;
  }
}

/** Kiro IDE keeps its login in the AWS SSO cache (~/.aws/sso/cache). */
async function importKiro() {
  const cache = join(homedir(), ".aws", "sso", "cache");
  let files = [];
  try {
    files = await readdir(cache);
  } catch {
    throw new Error("Cache AWS SSO tidak ditemukan. Login ke Kiro IDE dulu.");
  }
  const ordered = ["kiro-auth-token.json", ...files.filter((f) => f.endsWith(".json") && f !== "kiro-auth-token.json")];
  let token = null;
  for (const file of ordered) {
    if (!files.includes(file)) continue;
    const data = await readJsonFile(join(cache, file));
    if (data?.refreshToken?.startsWith("aorAAAAAG")) {
      token = data;
      break;
    }
  }
  if (!token) throw new Error("Token Kiro tidak ditemukan di cache AWS SSO. Login ke Kiro IDE dulu.");

  // IdC/Builder ID logins link to a client registration needed for refresh.
  const client = token.clientIdHash ? await readJsonFile(join(cache, `${token.clientIdHash}.json`)) : null;
  const hasClient = client?.clientId && client?.clientSecret;
  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
  return {
    access_token: token.accessToken || "",
    refresh_token: token.refreshToken,
    // Unknown or past expiry makes the gateway refresh before the first request.
    expires_at: expiresAt || 1,
    extra: {
      auth_method: hasClient ? (String(token.authMethod).toLowerCase() === "idc" ? "idc" : "builder-id") : "social",
      region: token.region || "us-east-1",
      ...(hasClient ? { client_id: client.clientId, client_secret: client.clientSecret } : {}),
      ...(token.profileArn ? { profile_arn: token.profileArn } : {}),
    },
  };
}

/** CommandCode CLI keeps its API key in ~/.commandcode/auth.json. */
async function importCommandCode() {
  const filePath = join(homedir(), ".commandcode", "auth.json");
  const data = await readJsonFile(filePath);
  if (!data) {
    throw new Error("File ~/.commandcode/auth.json tidak ditemukan. Login ke Command Code CLI (cmd login) dulu.");
  }

  // Precedence matches CLI resolver: apiKey, commandcode, access_token, token
  const key =
    (typeof data.apiKey === "string" && data.apiKey) ||
    (typeof data.commandcode === "string" && data.commandcode) ||
    (typeof data.token === "string" && data.token) ||
    (typeof data.access_token === "string" && data.access_token) ||
    (data.commandcode && typeof data.commandcode === "object" ? data.commandcode.key || data.commandcode.access : null) ||
    (data["command-code"] && typeof data["command-code"] === "object" ? data["command-code"].key || data["command-code"].access : null);

  if (!key) {
    throw new Error("API Key tidak ditemukan di ~/.commandcode/auth.json. Login ke Command Code CLI dulu.");
  }

  return {
    access_token: key,
    api_key: key,
    extra: {
      api_key: key,
    },
  };
}

const LOCAL_IMPORTERS = { freebuff: importFreebuff, kiro: importKiro, commandcode: importCommandCode };

export function hasLocalImport(providerId) {
  return Boolean(LOCAL_IMPORTERS[providerId]);
}

export async function importLocalLogin(providerId, opts = {}) {
  const importer = LOCAL_IMPORTERS[providerId];
  if (!importer) throw new Error("Provider ini tidak mendukung import dari aplikasi lokal.");
  const tokens = await importer();
  const conn = saveOAuthConnection(providerId, tokens, opts);
  return { account: conn?.name, connection: conn };
}

/** Test hook: drop every pending flow and close listeners. */
export function resetOAuthFlows() {
  for (const flow of flows.values()) closeListener(flow);
  flows.clear();
}
