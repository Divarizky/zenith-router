import { getConnections } from "../db/index.js";
import { syncProviderQuota } from "./quota.js";
import { hasQuotaFetcher } from "./quota/index.js";
import { logQuiet } from "./logger.js";

const DEFAULT_INTERVAL_MINUTES = 15;

let timer = null;
let running = false;

/**
 * Interval from ZENITH_QUOTA_SYNC_INTERVAL_MINUTES (default 15);
 * 0 or negative turns auto sync off.
 */
export function getQuotaSyncIntervalMs() {
  const raw = process.env.ZENITH_QUOTA_SYNC_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw === "" ? DEFAULT_INTERVAL_MINUTES : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/**
 * Refresh cached quota/balance for every connection with a live fetcher.
 * Sequential on purpose: provider quota endpoints are rate-limited, and a
 * burst of parallel calls across many accounts looks like scripted traffic.
 * `minAgeMs` skips accounts whose cache is still fresh, so a tick landing
 * right after a manual sync does not hammer the same endpoint twice.
 * Returns { [connectionId]: { ok, quota? | error? } }.
 */
export async function syncAllQuotas({ minAgeMs = 0, quiet = false } = {}) {
  if (running) return {};
  running = true;
  const results = {};
  let synced = 0;
  try {
    const now = Date.now();
    for (const c of getConnections()) {
      if (!hasQuotaFetcher(c.provider)) continue;
      const updatedAt = Number(c.credentials?.quota?.updated_at) || 0;
      if (minAgeMs > 0 && now - updatedAt < minAgeMs) continue;
      try {
        results[c.id] = { ok: true, quota: await syncProviderQuota(c, { quiet }) };
        synced++;
      } catch (err) {
        results[c.id] = { ok: false, error: err.message };
        // Auto sync is background work: dashboard console only, terminal stays clean.
        if (quiet) logQuiet(`[zenith] Quota sync failed for ${c.provider} (#${c.id}): ${err.message}`, "warn");
        else console.warn(`[zenith] Quota sync failed for ${c.provider} (#${c.id}): ${err.message}`);
      }
    }
    if (synced > 0) {
      const msg = `[zenith] Quota sync: ${synced} akun diperbarui`;
      if (quiet) logQuiet(msg);
      else console.log(msg);
    }
  } finally {
    running = false;
  }
  return results;
}

/**
 * One scheduler pass: refreshes caches older than half the interval. Exported
 * so tests (and future callers) can trigger a tick without waiting for the
 * timer. There is no on/off toggle: auto sync always runs unless the env
 * interval is 0.
 */
export async function runQuotaSyncTick({ intervalMs = getQuotaSyncIntervalMs() } = {}) {
  return syncAllQuotas({ minAgeMs: Math.floor(intervalMs / 2), quiet: true });
}

/**
 * First pass right away, then on an interval. Timers are unref'd so they never
 * keep the process alive. Returns the timer, or null when auto sync is turned
 * off via env.
 */
export function startQuotaSyncScheduler() {
  const intervalMs = getQuotaSyncIntervalMs();
  if (!intervalMs) return null;
  if (timer) return timer;

  const tick = () => {
    runQuotaSyncTick({ intervalMs }).catch(() => {});
  };

  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

export function stopQuotaSyncScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
