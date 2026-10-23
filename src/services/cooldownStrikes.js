/**
 * Cooldown strikes: an account is parked only after two separate client
 * requests fail on it, not after one failure plus the internal retries of that
 * same request.
 *
 * A single upstream 429 or 5xx used to write a lock immediately, so the next
 * request hit "All accounts are cooling down" even though the user had tried
 * once. Failures inside one request (account failover, same-account retries,
 * combo members) share a request id and therefore count once.
 *
 * State is process memory only: locks in the database remain the source of
 * truth for routing, and a restart simply gives every account a fresh start.
 */

/** Separate client requests needed before the account is parked. */
export const COOLDOWN_STRIKES = 2;

/** A strike older than this no longer counts towards the next park. */
const STRIKE_WINDOW_MS = 10 * 60 * 1000;

const strikes = new Map();

/**
 * Record one failure and report whether the account has now earned a cooldown.
 * `scope` separates independent budgets, e.g. one model's rate limit from the
 * account-wide auth state.
 */
export function cooldownStrikeReached(key, requestId = null, now = Date.now()) {
  const entry = strikes.get(key);
  if (!entry || now - entry.at > STRIKE_WINDOW_MS) {
    strikes.set(key, { count: 1, request: requestId, at: now });
    return false;
  }
  // Repeated failures inside the same client request are not user attempts.
  if (requestId && entry.request === requestId) return entry.count >= COOLDOWN_STRIKES;
  entry.count += 1;
  entry.request = requestId;
  entry.at = now;
  return entry.count >= COOLDOWN_STRIKES;
}

/** A success clears the streak so sporadic failures never accumulate. */
export function clearCooldownStrike(key) {
  strikes.delete(key);
}

/** Test hook: forget every streak. */
export function resetCooldownStrikes() {
  strikes.clear();
}
