/**
 * Prefix trace: fingerprints the upstream request prefix per client session, so
 * cache misses can be traced to a change in the prefix between turns.
 *
 * Only digests are kept. Session keys are hashed before they reach the log or
 * the in-memory map, and no request content is stored.
 */
import { createHash } from "node:crypto";

const DEFAULT_MAX_SESSIONS = 256;

function stableStringify(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val) ?? "null";
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 12);
}

function shortId(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

/** Digests of the parts a provider cache can match on: system, tools, and each message in order. */
export function fingerprintRequest(request) {
  const contents = Array.isArray(request?.contents) ? request.contents : [];
  return {
    system: request?.systemInstruction === undefined ? null : digest(request.systemInstruction),
    tools: request?.tools === undefined ? null : digest(request.tools),
    messages: contents.map((message) => digest(message)),
  };
}

/**
 * Compare two fingerprints of the same session. `divergeAt` is the first message
 * index whose digest differs; `null` means the new history extends the old one.
 * A value below `prevLength` means earlier history was rewritten, which a prefix
 * cache cannot reuse past that index.
 */
export function compareFingerprints(prev, next) {
  const shared = Math.min(prev.messages.length, next.messages.length);
  let divergeAt = null;
  for (let i = 0; i < shared; i++) {
    if (prev.messages[i] !== next.messages[i]) {
      divergeAt = i;
      break;
    }
  }
  if (divergeAt === null && next.messages.length < prev.messages.length) divergeAt = shared;
  return {
    systemChanged: prev.system !== next.system,
    toolsChanged: prev.tools !== next.tools,
    divergeAt,
    prevLength: prev.messages.length,
    length: next.messages.length,
  };
}

function formatLine({ provider, model, sid, turn, next, result }) {
  const part = (changed) => (result === null ? "first" : changed ? "changed" : "same");
  const diverge = result === null ? "n/a" : result.divergeAt === null ? "none" : `${result.divergeAt}/${result.prevLength}`;
  return (
    `[CACHE-TRACE] provider=${provider} model=${model} session=${sid} turn=${turn} msgs=${next.messages.length} ` +
    `system=${part(result?.systemChanged)} tools=${part(result?.toolsChanged)} divergeAt=${diverge}`
  );
}

/**
 * Creates a tracer that keeps the last fingerprint per session. When disabled it
 * does nothing, so the request path pays no cost.
 */
export function createPrefixTracer({ enabled = false, log = () => {}, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  const sessions = new Map();

  return {
    observe({ provider, sessionKey, model, request }) {
      if (!enabled || !sessionKey) return null;
      const sid = shortId(sessionKey);
      const cacheKey = createHash("sha256").update(String(sessionKey)).digest("hex");

      const next = fingerprintRequest(request);
      const prev = sessions.get(cacheKey);
      const turn = (prev?.turn ?? 0) + 1;
      next.turn = turn;

      sessions.delete(cacheKey);
      sessions.set(cacheKey, next);
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);

      const result = prev ? compareFingerprints(prev, next) : null;
      log(formatLine({ provider, model, sid, turn, next, result }));
      return result;
    },
  };
}
