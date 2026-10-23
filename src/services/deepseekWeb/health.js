/**
 * Session health for DeepSeek Web accounts.
 *
 * A web token cannot be refreshed: when it dies, every completion fails with
 * 401. The cheapest way to tell a live token from a dead one is the PoW
 * challenge endpoint, which authenticates the request but does not start a
 * chat turn, so the dashboard can probe an account without consuming the
 * account's parallel-session budget or touching conversation history.
 *
 * Results are cached per account (5 minutes for a definitive answer, 1 minute
 * for a transport error) so opening the provider page does not hammer the
 * upstream. Concurrent probes for the same account share one request.
 */
import { createHash } from "node:crypto";
import { resolveConnectionProxy } from "../proxyPools.js";
import { resolveDeepSeekTransport } from "./transport.js";

export const HEALTH_TTL_MS = 5 * 60 * 1000;
export const HEALTH_ERROR_TTL_MS = 60 * 1000;
export const HEALTH_TIMEOUT_MS = 8000;

const MAX_MESSAGE_LENGTH = 200;

const cache = new Map();
const inFlight = new Map();

function tokenFingerprint(connection) {
  const token = connection?.credentials?.token || connection?.credentials?.access_token || "";
  return createHash("md5").update(String(token)).digest("hex").slice(0, 8);
}

/** Cache key includes the token so a replaced token never inherits the old verdict. */
function keyOf(connection) {
  return `${connection?.id}:${tokenFingerprint(connection)}`;
}

function ttlFor(status) {
  return status === "error" ? HEALTH_ERROR_TTL_MS : HEALTH_TTL_MS;
}

function cleanMessage(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function record(connection, { status, code = null, message = "" }, now) {
  const entry = { status, code, message: cleanMessage(message), checkedAt: now };
  cache.set(keyOf(connection), entry);
  return entry;
}

/** Last verdict for this account, even when stale. Returns null when never checked. */
export function getSessionHealth(connection) {
  if (!connection) return null;
  return cache.get(keyOf(connection)) || null;
}

/** True when a cached verdict can still be trusted. */
export function isSessionHealthFresh(entry, now = Date.now()) {
  if (!entry) return false;
  return now - entry.checkedAt < ttlFor(entry.status);
}

/** Drop the verdict for one account, or every verdict when called without one. */
export function forgetSessionHealth(connection = null) {
  if (connection) cache.delete(keyOf(connection));
  else cache.clear();
}

function classify(err) {
  const status = Number(err?.status);
  if (err?.authExpired || status === 401 || status === 403) {
    return {
      status: "expired",
      code: err?.code || "invalid_token",
      message: err?.message || "DeepSeek menolak token sesi ini.",
    };
  }
  return {
    status: "error",
    code: err?.code || (status ? `http_${status}` : "unreachable"),
    message: err?.message || "Tidak bisa menghubungi DeepSeek.",
  };
}

async function probe(connection, { transportResolver = resolveDeepSeekTransport, proxyUrl = undefined, timeoutMs = HEALTH_TIMEOUT_MS, now = Date.now() } = {}) {
  const credentials = connection?.credentials || {};
  if (!(credentials.token || credentials.user_token || credentials.access_token)) {
    // No token at all: nothing to probe, and no upstream call is justified.
    return record(connection, { status: "expired", code: "invalid_token", message: "Akun ini tidak punya user token." }, now);
  }

  let resolvedProxy = proxyUrl;
  if (resolvedProxy === undefined) {
    const resolved = resolveConnectionProxy(connection);
    if (resolved.blocked) {
      return record(connection, { status: "error", code: "proxy_blocked", message: resolved.reason }, now);
    }
    resolvedProxy = resolved.proxyUrl;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const transport = transportResolver(connection, { proxyUrl: resolvedProxy });
    // Only the challenge: no chat session, no completion, no history.
    await transport.fetchChallenge(controller.signal);
    return record(connection, { status: "ok" }, now);
  } catch (err) {
    const verdict = controller.signal.aborted
      ? { status: "error", code: "timeout", message: "Health check melewati batas waktu." }
      : classify(err);
    return record(connection, verdict, now);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the token (unless a fresh verdict is cached) and return the verdict.
 * Concurrent callers for the same account share one request.
 */
export async function ensureSessionHealth(connection, options = {}) {
  if (!connection) return null;
  const now = options.now ?? Date.now();
  const cached = getSessionHealth(connection);
  if (!options.force && isSessionHealthFresh(cached, now)) return cached;

  const key = keyOf(connection);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = probe(connection, { ...options, now }).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Always probe, ignoring the cache (the "Periksa sesi" action). */
export function checkSessionHealth(connection, options = {}) {
  return ensureSessionHealth(connection, { ...options, force: true });
}

/**
 * Verify a token captured outside the dashboard (one-click login). The caller
 * needs a fresh answer for a token the user may still be producing, so this
 * bypasses the account cache and reports the verdict directly.
 */
export async function verifySessionToken({ token, cookies = "" }, options = {}) {
  const connection = {
    id: "browser-login",
    provider: "deepseek-web",
    auth_type: "session",
    credentials: { token, cookies },
  };
  forgetSessionHealth(connection);
  return probe(connection, { ...options });
}
