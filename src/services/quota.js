import { getConnections, updateConnection } from "../db/index.js";

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
export async function syncProviderQuota(connection) {
  if (!connection || !connection.id) return null;

  let quotaData = null;

  if (customQuotaFetcher) {
    quotaData = await customQuotaFetcher(connection);
  } else {
    // Default provider quota checks can be added per-provider as needed
    quotaData = connection.credentials?.quota || {
      remaining: null,
      unit: "unknown",
      updated_at: Date.now(),
      is_exhausted: false,
    };
  }

  const updatedCreds = {
    ...(connection.credentials || {}),
    quota: {
      ...quotaData,
      updated_at: Date.now(),
    },
  };

  updateConnection(connection.id, { credentials: updatedCreds });
  return updatedCreds.quota;
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
 * HTTP handler for GET /api/quota
 */
export function handleGetQuota(c) {
  const status = getAllQuotaStatus();
  return c.json(status);
}
