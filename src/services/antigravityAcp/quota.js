import { workerIdForAccount } from "./accounts.js";
import { createAntigravityAcpClient } from "./client.js";
import { createAntigravityAcpTransport } from "./transport.js";
import { markAntigravityAcpAccountLimited } from "./profiles.js";

// Port of Troupe's antigravity_quota_message: the agent reports an exhausted quota as plain text.
const QUOTA_TITLE = "Usage Limit Reached";
const QUOTA_BODY = "You have reached your current quota for this period.";
export const DEFAULT_LIMIT_MS = 5 * 3_600_000;
const UNIT_MS = { day: 86_400_000, hour: 3_600_000, hr: 3_600_000, minute: 60_000, min: 60_000, second: 1000, sec: 1000 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function sentence(text) {
  const t = text.trim();
  const m = t.match(/\.(\s|$)/);
  return (m ? t.slice(0, m.index) : t).trim();
}

function relativeReset(text) {
  let total = 0;
  let parts = 0;
  for (const part of text.split(",").flatMap((p) => p.split(" and ")).map((p) => p.trim()).filter(Boolean)) {
    const words = part.split(/\s+/);
    if (words.length !== 2 || !/^\d+$/.test(words[0])) return null;
    const unit = UNIT_MS[words[1].toLowerCase().replace(/s$/, "")];
    if (!unit) return null;
    total += Number(words[0]) * unit;
    parts += 1;
  }
  return parts > 0 && Number.isSafeInteger(total) ? total : null;
}

function absoluteReset(text) {
  const m = text.trim().match(/^(\w{3})\w*\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*UTC$/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const at = Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]));
  return Number.isFinite(at) ? at : null;
}

/** Returns `{ resetAt }` (epoch ms or null when not reported) for a quota message, else null. */
export function parseAntigravityQuotaMessage(text, nowMs = Date.now()) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith(QUOTA_TITLE) || !t.includes(QUOTA_BODY)) return null;
  let resetAt = null;
  const rel = t.indexOf("reset in ");
  const abs = t.indexOf("reset on ");
  if (rel >= 0) {
    const ms = relativeReset(sentence(t.slice(rel + 9)));
    resetAt = ms === null ? null : nowMs + ms;
  } else if (abs >= 0) {
    resetAt = absoluteReset(sentence(t.slice(abs + 9)));
  }
  return { resetAt };
}

export const DEFAULT_QUOTA_TTL_MS = 300_000;
export const DEFAULT_QUOTA_TIMEOUT_MS = 5_000;

const quotaCache = new Map();
const inFlightProbes = new Map();

function defaultCreateClient(workerId, options) {
  return createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);
}

function isQuotaLimitError(err) {
  if (!err) return false;
  const code = err.code ?? err.rpcCode;
  const msg = String(err.message || err || "");
  if (parseAntigravityQuotaMessage(msg)) return true;
  if (code === -32000 && /quota|limit|rate/i.test(msg)) return true;
  return false;
}

export function getAntigravityAcpCachedQuota(accountId, { ttlMs = DEFAULT_QUOTA_TTL_MS, nowMs = Date.now() } = {}) {
  const entry = quotaCache.get(accountId);
  if (!entry) return null;
  if (nowMs - entry.checkedAt >= ttlMs) return null;
  return entry;
}

export function clearAntigravityAcpQuotaCacheForTests() {
  quotaCache.clear();
  inFlightProbes.clear();
}

export async function inspectAntigravityAcpAccountQuota(
  accountId,
  {
    createClient = defaultCreateClient,
    timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
    ttlMs = DEFAULT_QUOTA_TTL_MS,
    force = false,
  } = {},
) {
  if (!force) {
    const cached = getAntigravityAcpCachedQuota(accountId, { ttlMs });
    if (cached) return cached;
  }

  if (inFlightProbes.has(accountId)) {
    return inFlightProbes.get(accountId);
  }

  const probePromise = (async () => {
    const controller = new AbortController();
    let client = null;
    let timedOut = false;
    let timer = null;

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
        resolve({ status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() });
      }, timeoutMs);
    });

    const runProbe = async () => {
      const workerId = workerIdForAccount(accountId);
      client = await createClient(workerId, { signal: controller.signal });
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }

      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }

      const session = await client.newSession({ cwd: client.cwd || process.cwd(), mcpServers: [] });
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }

      const sessionText = typeof session?.message === "string" ? session.message : "";
      const parsedSession = parseAntigravityQuotaMessage(sessionText);
      if (parsedSession) {
        markAntigravityAcpAccountLimited(accountId, parsedSession.resetAt);
        const result = { status: "limited", resetAt: parsedSession.resetAt, checkedAt: Date.now() };
        quotaCache.set(accountId, result);
        return result;
      }

      const result = { status: "ready", resetAt: null, checkedAt: Date.now() };
      quotaCache.set(accountId, result);
      return result;
    };

    try {
      return await Promise.race([runProbe(), timeoutPromise]);
    } catch (err) {
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }
      if (isQuotaLimitError(err)) {
        const parsed = parseAntigravityQuotaMessage(String(err?.message || ""));
        const resetAt = parsed?.resetAt ?? null;
        markAntigravityAcpAccountLimited(accountId, resetAt);
        const result = { status: "limited", resetAt, checkedAt: Date.now() };
        quotaCache.set(accountId, result);
        return result;
      }
      return { status: "unknown", resetAt: null, checkedAt: Date.now() };
    } finally {
      if (timer) clearTimeout(timer);
      if (client && typeof client.close === "function") {
        try { await client.close(); } catch {}
      }
      inFlightProbes.delete(accountId);
    }
  })();

  inFlightProbes.set(accountId, probePromise);
  return probePromise;
}
