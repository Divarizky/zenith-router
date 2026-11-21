/**
 * Bounded read of an upstream error body.
 *
 * An error body is only used for classification (rate limit wording, quota
 * reset hints, model-level denials), so the first 64 KiB is enough. A body that
 * stalls or keeps streaming must not hold the account concurrency slot for
 * longer than the read deadline, so every read is capped by bytes and by time.
 *
 * Several layers read the same failed response (executor peek, protocol retry,
 * failover classification, error relay). `readErrorBody` caches the bounded
 * result per response object in a WeakMap, so a later caller awaits the same
 * promise instead of reading the body again and stacking another deadline.
 * The original response is left unconsumed: reads go through `clone()`.
 */

export const ERROR_BODY_MAX_BYTES = 64 * 1024;
export const ERROR_BODY_TIMEOUT_MS = 5000;

export const ERROR_BODY_TRUNCATED_MARKER = "\n[zenith: error body truncated]";

const cache = new WeakMap();

/**
 * Read up to `maxBytes` of `res` as text, giving up after `timeoutMs`.
 *
 * Returns `{ text, truncated, timedOut }`. `text` holds whatever was read before
 * the cap or deadline; `truncated` is true when more bytes existed beyond the cap
 * or the deadline cut the read short. A response without a readable body yields
 * an empty text rather than throwing.
 */
export function readErrorBody(res, { maxBytes = ERROR_BODY_MAX_BYTES, timeoutMs = ERROR_BODY_TIMEOUT_MS } = {}) {
  if (!res || typeof res !== "object") return Promise.resolve(EMPTY());
  const key = `${maxBytes}:${timeoutMs}`;
  let perRes = cache.get(res);
  if (!perRes) {
    perRes = new Map();
    cache.set(res, perRes);
  }
  if (!perRes.has(key)) perRes.set(key, readUncached(res, maxBytes, timeoutMs));
  return perRes.get(key);
}

function EMPTY() {
  return { text: "", truncated: false, timedOut: false };
}

async function readUncached(res, maxBytes, timeoutMs) {
  // Read a clone when possible so the caller's response stays usable.
  let source = res;
  if (typeof res.clone === "function") {
    try {
      source = res.clone();
    } catch {
      return EMPTY();
    }
  }
  if (!source?.body || typeof source.body.getReader !== "function") {
    if (typeof source?.text === "function") {
      // No stream reader: read under the same deadline, then cut to the byte cap.
      try {
        const full = await withDeadline(source.text(), timeoutMs);
        if (full === DEADLINE) return { text: "", truncated: true, timedOut: true };
        return cutText(full, maxBytes);
      } catch {
        return EMPTY();
      }
    }
    return EMPTY();
  }

  const reader = source.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  let truncated = false;
  let timedOut = false;

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });

  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next && next.timeout) {
        timedOut = true;
        truncated = true;
        break;
      }
      const { value, done } = next;
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      // Cap reached: stop here. No extra probe read, so a stream that stalls
      // after exactly 64 KiB cannot hold the slot until the deadline.
      if (total >= maxBytes) {
        // Exactly at the cap: only an already-finished stream counts as complete. The probe
        // waits one macrotask at most, never for a stalled stream, so a body that hangs
        // after 64 KiB cannot hold the slot until the deadline.
        const finished = await probeFinished(reader);
        truncated = !finished;
        break;
      }
    }
  } catch {
    // A failed read ends the body here; what was read so far is still usable.
  } finally {
    clearTimeout(timer);
    // Non-blocking: cancelling the discarded branch must never hold the caller.
    reader.cancel().catch(() => {});
  }

  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  if (truncated) text += ERROR_BODY_TRUNCATED_MARKER;
  return { text, truncated, timedOut };
}

const DEADLINE = Symbol("deadline");

function withDeadline(promise, timeoutMs) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function probeFinished(reader) {
  const settled = await Promise.race([
    reader.read().then((r) => ({ r })),
    new Promise((resolve) => setImmediate(() => resolve({ pending: true }))),
  ]);
  if (settled.pending) return false;
  return Boolean(settled.r.done);
}

function cutText(full, maxBytes) {
  const buf = new TextEncoder().encode(full);
  if (buf.byteLength <= maxBytes) return { text: full, truncated: false, timedOut: false };
  const text = new TextDecoder().decode(buf.subarray(0, maxBytes)) + ERROR_BODY_TRUNCATED_MARKER;
  return { text, truncated: true, timedOut: false };
}

/** Convenience wrapper returning only the text. */
export async function readErrorText(res, options) {
  return (await readErrorBody(res, options)).text;
}
