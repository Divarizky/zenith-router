import { getConnections, mergeConnectionCredentials } from "../db/index.js";
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
 * Fetch live quota/balance for a connection from provider endpoint
 */
export async function syncProviderQuota(connection, { quiet = false } = {}) {
  if (!connection || !connection.id) return null;

  let quotaData = null;

  if (customQuotaFetcher) {
    quotaData = await customQuotaFetcher(connection);
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
  const quota = { ...quotaData, updated_at: Date.now() };
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
    quota: c.credentials?.quota || null,
    is_exhausted: isConnectionExhausted(c),
  }));
}

/**
 * HTTP handler for POST /dashboard/quota/sync — refresh one account's quota.
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
 * HTTP handler for GET /api/quota
 */
export function handleGetQuota(c) {
  const status = getAllQuotaStatus();
  return c.json(status);
}
