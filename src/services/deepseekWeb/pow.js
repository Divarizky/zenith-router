/**
 * Proof-of-work entry point for the DeepSeek Web transport.
 *
 * The upstream rejects a completion without an `x-ds-pow-response` header, and
 * the header only validates when the payload carries `target_path` — the field
 * the Python reference package's `to_answer_payload()` omits. The payload is
 * built here so every caller gets the same shape.
 */
import { DeepSeekPowSolver } from "../../vendor/deepseekPow/solver.js";

export const POW_TARGET_PATH = "/api/v0/chat/completion";
export const POW_ALGORITHM = "DeepSeekHashV1";

// One solution per challenge is enough: the same challenge is retried by the
// gateway's failover path, and solving it twice only burns the event loop.
const CACHE_LIMIT = 200;
const CACHE_GUARD_MS = 5000;
const cache = new Map();

function cacheKey(challenge) {
  return `${challenge.challenge}|${challenge.salt}|${challenge.difficulty}|${challenge.expire_at}`;
}

export function clearPowCache() {
  cache.clear();
}

/** The solver never checks the clock; the transport must reject stale challenges. */
export function isChallengeExpired(challenge, now = Date.now()) {
  const expiresAt = Number(challenge?.expire_at);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export class PowError extends Error {
  constructor(message, code = "pow_failed") {
    super(message);
    this.name = "PowError";
    this.status = 502;
    this.code = code;
  }
}

function validate(challenge) {
  if (!challenge || typeof challenge !== "object") throw new PowError("PoW challenge is missing", "pow_invalid");
  if (challenge.algorithm !== POW_ALGORITHM) {
    throw new PowError(`Unsupported PoW algorithm: ${challenge.algorithm}`, "pow_invalid");
  }
  if (typeof challenge.challenge !== "string" || challenge.challenge.length === 0) {
    throw new PowError("PoW challenge has no challenge string", "pow_invalid");
  }
  if (typeof challenge.salt !== "string" || challenge.salt.length === 0) {
    throw new PowError("PoW challenge has no salt", "pow_invalid");
  }
  const difficulty = Number(challenge.difficulty);
  if (!Number.isFinite(difficulty) || difficulty < 0) {
    throw new PowError("PoW challenge has an invalid difficulty", "pow_invalid");
  }
  if (challenge.expire_at === undefined || challenge.expire_at === null || challenge.expire_at === "") {
    throw new PowError("PoW challenge has no expiry", "pow_invalid");
  }
}

/**
 * Solve a challenge and return the object to base64 into `x-ds-pow-response`.
 * `answer` stays an f64; JSON.stringify drops the trailing `.0` for integer
 * answers, which is what the web client sends.
 */
export function createPowSolver({ wasmPath } = {}) {
  const solver = new DeepSeekPowSolver(wasmPath);
  let initialized = null;

  const ready = () => {
    if (!initialized) {
      initialized = solver.init().catch((err) => {
        initialized = null;
        throw new PowError(`Failed to load PoW solver: ${err.message}`, "pow_unavailable");
      });
    }
    return initialized;
  };

  return {
    async solve(challenge) {
      validate(challenge);

      const key = cacheKey(challenge);
      const expiresAt = Number(challenge.expire_at);
      const cached = cache.get(key);
      if (cached && (!Number.isFinite(expiresAt) || cached.expiresAt > Date.now() + CACHE_GUARD_MS)) {
        return cached.payload;
      }

      await ready();
      try {
        const answer = solver.solve(challenge);
        const payload = {
          algorithm: POW_ALGORITHM,
          challenge: challenge.challenge,
          salt: challenge.salt,
          answer,
          signature: challenge.signature ?? null,
          target_path: challenge.target_path || POW_TARGET_PATH,
        };
        if (cache.size >= CACHE_LIMIT) {
          const moment = Date.now();
          for (const [cacheKeyValue, entry] of cache) {
            if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= moment) cache.delete(cacheKeyValue);
          }
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
        }
        cache.set(key, { payload, expiresAt });
        return payload;
      } catch (err) {
        if (err instanceof PowError) throw err;
        throw new PowError(`PoW solve failed: ${err.message}`, "pow_failed");
      }
    },
  };
}

const defaultSolver = createPowSolver();

/** Solve with the shared solver instance (WASM is loaded once per process). */
export function solvePowChallenge(challenge) {
  return defaultSolver.solve(challenge);
}

/** Base64 the payload the way the web client puts it in `x-ds-pow-response`. */
export function encodePowHeader(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
