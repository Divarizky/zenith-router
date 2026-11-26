import { createHash, randomBytes } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { createAntigravityAcpClient } from "./client.js";
import { createAntigravityAcpTransport } from "./transport.js";
import { getAntigravityAcpWorker, workerRuntimeEnv } from "./workers.js";
import { isValidAccountId, workerIdForAccount } from "./accounts.js";
import {
  acquireAntigravityAcpAccountUse,
  completeAntigravityAcpLogin,
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
const attempts = new Map();
let starting = false;
let spawnFn = defaultSpawn;
let clientFactory = (workerId, options) => createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);
let timing = {
  urlWaitMs: AGY_LOGIN_URL_WAIT_MS,
  urlSettleMs: AGY_LOGIN_URL_SETTLE_MS,
  ttlMs: AGY_LOGIN_TTL_MS,
  exitWaitMs: AGY_LOGIN_EXIT_WAIT_MS,
  verifyWaitMs: AGY_LOGIN_VERIFY_WAIT_MS,
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

function safeWorkerSnapshot(worker) {
  return {
    workerId: worker.workerId,
    launcher: worker.launcher,
    loginLauncher: worker.loginLauncher,
    loginLauncherArgs: worker.loginLauncherArgs || [],
    launcherArgs: worker.launcherArgs || [],
    isolatedHome: worker.isolatedHome,
    appData: worker.appData,
    workspace: worker.workspace,
  };
}

async function selectLoginWorker(accountId) {
  if (!isValidAccountId(accountId)) return null;
  if (!getAntigravityAcpProfiles().some((account) => account.id === accountId)) return null;
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
  record.resolveUrl?.(genericFailure(code));
  record.resolveExit?.({ exited: record.exited, code: record.exitCode, signal: record.exitSignal });
  record.resolveExit = null;
  forgetLater(record);
}

function finishUrl(record, url) {
  if (record.terminal || record.url) return;
  clearTimer(record.settleTimer);
  clearTimer(record.urlTimer);
  record.url = url;
  record.state = "awaiting_code";
  record.resolveUrl?.({ ok: true, attemptId: record.attemptId, authorizationUrl: url, expiresIn: Math.ceil(timing.ttlMs / 1000) });
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
  child.stdout?.on?.("data", (chunk) => consumeOutput(record, chunk));
  child.stderr?.on?.("data", (chunk) => consumeOutput(record, chunk));
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
    return typeof session?.sessionId === "string" && session.sessionId.length > 0;
  } catch {
    return false;
  } finally {
    record.verifyAbortController = null;
    try { await client?.close?.(); } catch {}
  }
}

function validateCode(code) {
  if (typeof code !== "string" || code.length === 0 || code.length > AGY_LOGIN_MAX_CODE_LENGTH) return false;
  if (code.includes("://") || /[\s\u0000-\u001f\u007f]/.test(code)) return false;
  return CODE_PATTERN.test(code);
}

export async function startAntigravityAcpLogin(binding, accountId) {
  if ([...attempts.values()].some((attempt) => !attempt.terminal) || starting) return genericFailure("login_busy");
  starting = true;
  try {
    const worker = await selectLoginWorker(accountId);
    if (!worker) return genericFailure("login_unavailable");
    const record = {
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
      const env = process.platform === "win32"
        ? { PATH: `${process.env.SystemRoot || "C:\\Windows"}\\System32;${process.env.SystemRoot || "C:\\Windows"}`, SYSTEMROOT: process.env.SystemRoot || "C:\\Windows" }
        : { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
      Object.assign(env, workerRuntimeEnv(record.worker));
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
  if (!validateCode(code)) return genericFailure("invalid_authorization_code");
  record.state = "submitting";
  let rawCode = code;
  try {
    if (!record.child?.stdin || typeof record.child.stdin.write !== "function") {
      failRecord(record, "login_process_failed");
      return genericFailure("login_process_failed");
    }
    record.child.stdin.write(`${rawCode}\n`);
    rawCode = "";
    record.child.stdin.end?.();
  } catch {
    rawCode = "";
    failRecord(record, "login_process_failed");
    return genericFailure("login_process_failed");
  }
  const exit = await waitForExit(record, timing.exitWaitMs);
  rawCode = "";
  if (!exit.exited || exit.code !== 0) {
    if (!record.terminal) failRecord(record, "login_process_failed");
    return genericFailure(record.errorCode || "login_process_failed");
  }
  if (record.terminal) return genericFailure(record.errorCode || "login_process_failed");
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
  return { ok: true, status: "ready" };
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

export function setAntigravityAcpLoginDependenciesForTests({ spawn, createClient, timings } = {}) {
  if (typeof spawn === "function") spawnFn = spawn;
  if (typeof createClient === "function") clientFactory = createClient;
  if (timings && typeof timings === "object") timing = {
    urlWaitMs: Number.isFinite(timings.urlWaitMs) ? timings.urlWaitMs : timing.urlWaitMs,
    urlSettleMs: Number.isFinite(timings.urlSettleMs) ? timings.urlSettleMs : timing.urlSettleMs,
    ttlMs: Number.isFinite(timings.ttlMs) ? timings.ttlMs : timing.ttlMs,
    exitWaitMs: Number.isFinite(timings.exitWaitMs) ? timings.exitWaitMs : timing.exitWaitMs,
    verifyWaitMs: Number.isFinite(timings.verifyWaitMs) ? timings.verifyWaitMs : timing.verifyWaitMs,
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
  clientFactory = (workerId, options) => createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);
  timing = {
    urlWaitMs: AGY_LOGIN_URL_WAIT_MS,
    urlSettleMs: AGY_LOGIN_URL_SETTLE_MS,
    ttlMs: AGY_LOGIN_TTL_MS,
    exitWaitMs: AGY_LOGIN_EXIT_WAIT_MS,
    verifyWaitMs: AGY_LOGIN_VERIFY_WAIT_MS,
  };
}

export function extractAgyAuthorizationUrlForTests(text) {
  return extractAuthorizationUrl(text);
}