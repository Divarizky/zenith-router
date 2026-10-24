/**
 * Parking an account after repeated failures.
 *
 * One upstream 429 or 5xx no longer writes a lock immediately: the next request
 * used to hit "All accounts are cooling down" after the user had tried once. An
 * account is parked only after two separate client requests fail on it.
 * Failures inside one request (account failover, same-account retries, combo
 * members) share a request id and therefore count once.
 *
 * The failure itself is still reported to the client, so the caller sees the
 * real upstream error instead of a cooldown notice; this module only answers
 * whether the account has earned the park. Writing the lock is the caller's
 * effect, which keeps this module free of the database seam that the router
 * layer already owns.
 *
 * State is process memory only: locks in the database remain the source of
 * truth for routing, and a restart simply gives every account a fresh start.
 */

/** How long a parked account is held back. */
export const ACCOUNT_PARK_MS = 10 * 60 * 1000;

/** Separate client requests needed before the account is parked. */
const PARK_AFTER_STRIKES = 2;

/** A strike older than this no longer counts towards the next park. */
const STRIKE_WINDOW_MS = 10 * 60 * 1000;

const strikes = new Map();

/** `model:<id>` follows the per-model rate limit lock, `account` the account lock. */
function strikeKey(connection, scope) {
  return `${connection.id}:${connection.provider || ""}:${scope}`;
}

function recordStrike(key, requestId, now) {
  const entry = strikes.get(key);
  if (!entry || now - entry.at > STRIKE_WINDOW_MS) {
    strikes.set(key, { count: 1, request: requestId, at: now });
    return false;
  }
  // Repeated failures inside the same client request are not user attempts.
  if (requestId && entry.request === requestId) return entry.count >= PARK_AFTER_STRIKES;
  entry.count += 1;
  entry.request = requestId;
  entry.at = now;
  return entry.count >= PARK_AFTER_STRIKES;
}

/**
 * True when this failure is the second one recorded for the account across
 * separate client requests. Pass `modelId` to judge the per-model rate limit
 * lock, or leave it out for the account-wide auth lock.
 */
export function parkThresholdReached(connection, { modelId = null, requestId = null } = {}) {
  if (!connection?.id) return false;
  const scope = modelId ? `model:${modelId}` : "account";
  return recordStrike(strikeKey(connection, scope), requestId, Date.now());
}

/** A success clears both streaks so sporadic failures never accumulate. */
export function clearStrikes(connection, modelId) {
  strikes.delete(strikeKey(connection, "account"));
  if (modelId) strikes.delete(strikeKey(connection, `model:${modelId}`));
}

/** Test hook: forget every streak. */
export function resetAccountStrikes() {
  strikes.clear();
}
