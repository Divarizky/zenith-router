import { getConnections } from "../db/index.js";
import { syncProviderQuota } from "./quota.js";
import { hasQuotaFetcher } from "./quota/index.js";
import { getSetting } from "./settings.js";

const DEFAULT_INTERVAL_MINUTES = 30;

let timer = null;
let running = false;

/**
 * Interval from ZENROUTE_QUOTA_SYNC_INTERVAL_MINUTES (default 30);
 * 0 or negative turns auto sync off.
 */
export function getQuotaSyncIntervalMs() {
  const raw = process.env.ZENROUTE_QUOTA_SYNC_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw === "" ? DEFAULT_INTERVAL_MINUTES : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

function isAutoSyncEnabled() {
  return getSetting("quota_auto_sync", "true") !== "false";
}

/**
 * Refresh cached quota/balance for every connection with a live fetcher.
 * Sequential on purpose: provider quota endpoints are rate-limited, and a
 * burst of parallel calls across many accounts looks like scripted traffic.
 * `minAgeMs` skips accounts whose cache is still fresh, so a tick landing
 * right after a manual sync does not hammer the same endpoint twice.
 * Returns { [connectionId]: { ok, quota? | error? } }.
 */
export async function syncAllQuotas({ minAgeMs = 0 } = {}) {
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
        results[c.id] = { ok: true, quota: await syncProviderQuota(c) };
        synced++;
      } catch (err) {
        results[c.id] = { ok: false, error: err.message };
        console.warn(`[zenroute] Quota auto-sync failed for ${c.provider} (#${c.id}): ${err.message}`);
      }
    }
    if (synced > 0) {
      console.log(`[zenroute] Quota auto-sync: ${synced} akun diperbarui`);
    }
  } finally {
    running = false;
  }
  return results;
}

/**
 * One scheduler pass: honors the quota_auto_sync toggle, then refreshes
 * caches older than half the interval. Exported so tests (and future callers)
 * can trigger a tick without waiting for the timer.
 */
export async function runQuotaSyncTick({ intervalMs = getQuotaSyncIntervalMs() } = {}) {
  if (!isAutoSyncEnabled()) return {};
  return syncAllQuotas({ minAgeMs: Math.floor(intervalMs / 2) });
}

/**
 * First pass right away, then on an interval. Timers are unref'd so they never
 * keep the process alive. The quota_auto_sync setting is re-read on every tick,
 * so toggling it in Settings takes effect without a restart.
 * Returns the timer, or null when auto sync is turned off via env.
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
