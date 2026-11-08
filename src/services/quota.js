import { getConnectionById, getConnections, mergeConnectionCredentials, replaceAntigravityAccountModels } from "../db/index.js";
import { fetchLiveQuota } from "./quota/index.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "./tokenRefresh.js";
import { logQuiet } from "./logger.js";

let customQuotaFetcher = null;

/**
 * Set custom quota fetcher (for tests and mocking)
 */
export function setCustomQuotaFetcher(fn) {
  customQuotaFetcher = fn;
}

/**
 * Check if a connection has exhausted its quota or balance
 */
export function isConnectionExhausted(connection) {
  if (!connection || !connection.credentials) return false;
  const quota = connection.credentials.quota;
  if (!quota) return false;

  if (quota.is_exhausted === true) return true;
  if (typeof quota.remaining === "number" && quota.remaining <= 0) return true;

  return false;
}

/**
 * How long a cached exhausted snapshot without a reset time may hold an account
 * back before routing probes it once. Without this, an account whose quota
 * endpoint never answers again stays excluded forever: routing skips it, so no
 * request ever reaches it, so nothing ever refreshes the cache.
 */
export const QUOTA_PROBE_MS = 30 * 60 * 1000;

function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Latest reset timestamp advertised by a cached quota snapshot, or null when
 * the provider does not publish one. Providers describe resets in different
 * shapes, so every place a timestamp can appear is read: top-level fields,
 * per-window rows, GLM-style session/weekly rows, and Antigravity pools. The
 * latest one wins: an account stays spent until its last window resets.
 */
export function quotaResetAt(quota) {
  if (!quota || typeof quota !== "object") return null;
  const found = [];
  const push = (value) => {
    const ms = toEpochMs(value);
    if (ms !== null) found.push(ms);
  };
  push(quota.reset_at);
  push(quota.resetAt);
  push(quota.reset_time);
  for (const row of Object.values(quota.quotas || {})) {
    if (!row || typeof row !== "object") continue;
    push(row.resetAt);
    push(row.reset_at);
    push(row.reset_time);
  }
  for (const row of [quota.session_quota, quota.weekly_quota]) {
    if (!row || typeof row !== "object") continue;
    push(row.resetAt);
    push(row.reset_at);
    push(row.reset_time);
  }
  for (const pool of Array.isArray(quota.pools) ? quota.pools : []) {
    if (!pool || typeof pool !== "object") continue;
    push(pool.resetAt);
    push(pool.reset_at);
    push(pool.reset_time);
  }
  return found.length ? Math.max(...found) : null;
}

/**
 * True when the cached exhaustion has a reset time that has already passed, so
 * the account may be routed to again. The cache itself is only rewritten by the
 * next sync; this predicate is what keeps a stale snapshot from parking an
 * account indefinitely.
 */
export function isQuotaExpired(connection, now = Date.now()) {
  if (!isConnectionExhausted(connection)) return false;
  const resetAt = quotaResetAt(connection?.credentials?.quota);
  return resetAt !== null && resetAt <= now;
}

/**
 * Routing gate: the cached snapshot says spent AND its reset window has not
 * passed. An expired window no longer blocks, so the account is retried and the
 * next sync corrects the numbers.
 */
export function isQuotaBlocking(connection, now = Date.now()) {
  if (!isConnectionExhausted(connection)) return false;
  return !isQuotaExpired(connection, now);
}

/**
 * True when a quota-blocked account has no reset time and its cache is older
 * than QUOTA_PROBE_MS. Routing lets the highest-priority such account through
 * once per window so the snapshot can be refreshed by a real request.
 */
export function isQuotaProbeDue(connection, now = Date.now()) {
  if (!isQuotaBlocking(connection, now)) return false;
  const quota = connection?.credentials?.quota;
  if (quotaResetAt(quota) !== null) return false;
  const updatedAt = Number(quota?.updated_at) || 0;
  return updatedAt > 0 && now - updatedAt >= QUOTA_PROBE_MS;
}

/**
 * Fetch live quota/balance for a connection from provider endpoint
 */
export async function syncProviderQuota(connection, { quiet = false } = {}) {
  if (!connection || !connection.id) return null;

  let quotaData = null;
  let fetchedOk = false;

  if (customQuotaFetcher) {
    quotaData = await customQuotaFetcher(connection);
    fetchedOk = !!quotaData && !quotaData.error;
  } else {
    // Quota endpoints reject expired tokens. Refresh first when the token is
    // (nearly) expired, and once more reactively if the provider still says 401/403.
    connection = await withFreshToken(connection, false, quiet);
    try {
      let live = await fetchLiveQuota(connection);
      if (live?.error && canRefresh(connection)) {
        const retried = await withFreshToken(connection, true, quiet);
        if (retried !== connection) {
          connection = retried;
          live = await fetchLiveQuota(connection);
        }
      }
      if (live) {
        quotaData = live;
        fetchedOk = !live.error;
      }
    } catch (err) {
      const msg = `[zenith] Failed to fetch live quota for ${connection.provider} (#${connection.id}): ${err.message}`;
      if (quiet) logQuiet(msg, "error");
      else console.error(msg);
    }

    if (!quotaData) {
      quotaData = connection.credentials?.quota || {
        remaining: null,
        unit: "unknown",
        is_exhausted: false,
      };
    } else if (quotaData.error && connection.credentials?.quota) {
      // Keep the last good bars visible next to the error instead of wiping them.
      const prev = connection.credentials.quota;
      quotaData = { ...prev, ...quotaData, quotas: quotaData.quotas || prev.quotas };
    }
  }

  // Only the quota key is written: `connection` is a snapshot from before the
  // awaits above, and its tokens may already have been rotated by a refresh.
  const { modelInventory, ...quotaDataOnly } = quotaData || {};
  if (connection.provider === "antigravity" && Array.isArray(modelInventory)) {
    try {
      replaceAntigravityAccountModels(connection.id, quotaDataOnly.tier, modelInventory);
    } catch (err) {
      const msg = `[zenith] Failed to store Antigravity model inventory for #${connection.id}: ${err.message}`;
      if (quiet) logQuiet(msg, "warn");
      else console.warn(msg);
    }
  }
  // updated_at is the age of the last *successful* fetch. A failed sync keeps the
  // previous stamp so a stale account can become due for a probe again.
  // Read the stored row: `connection` may be a snapshot from before the awaits above.
  const prevUpdatedAt = getConnectionById(connection.id)?.credentials?.quota?.updated_at;
  const stamp = fetchedOk || prevUpdatedAt == null ? Date.now() : prevUpdatedAt;
  const quota = { ...quotaDataOnly, updated_at: stamp };
  mergeConnectionCredentials(connection.id, { quota });
  return quota;
}

/** Returns the connection with a valid access token; the input one if refresh is unavailable or fails. */
async function withFreshToken(connection, force, quiet) {
  if (!force && !needsTokenRefresh(connection)) return connection;
  try {
    return (await refreshOAuthToken(connection, { force })) || connection;
  } catch (err) {
    const msg = `[zenith] Token refresh before quota sync failed for ${connection.provider} (#${connection.id}): ${err.message}`;
    if (force || quiet) logQuiet(msg, "error");
    else console.error(msg);
    return connection;
  }
}

/**
 * Retrieve current quota status for all connections
 */
export function getAllQuotaStatus() {
  const connections = getConnections();
  return connections.map((c) => ({
    id: c.id,
    name: c.name,
    provider: c.provider,
    auth_type: c.auth_type,
    is_active: c.is_active,
    priority: c.priority,
    quota: c.credentials?.quota || null,
    is_exhausted: isConnectionExhausted(c),
  }));
}

/**
 * HTTP handler for POST /dashboard/quota/sync — refresh one account's quota.
 *
 * Registered directly on the route in src/index.js. It is the transport for this
 * operation, not a general-purpose service API: keep it here so the form
 * contract (multipart body, redirect target) stays next to the operation.
 */
export async function handleSyncQuotaForm(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  const connection = getConnections().find((x) => x.id === id);
  if (connection) {
    try {
      await syncProviderQuota(connection);
    } catch (err) {
      console.error(`[zenith] Quota sync failed for connection #${id}:`, err.message);
    }
  }
  return c.redirect("/dashboard/usage?synced=1");
}

/**
 * HTTP handler for GET /api/quota. Transport for this operation only; the
 * reusable part is `getAllQuotaStatus` above, which takes no Hono context.
 */
export function handleGetQuota(c) {
  const status = getAllQuotaStatus();
  return c.json(status);
}
