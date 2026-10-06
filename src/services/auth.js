import {
  getConnections,
  setConnectionCooldown,
  updateConnectionLastUsed,
} from "../db/index.js";
import { getProvider } from "../providers/index.js";
import { isConnectionExhausted } from "./quota.js";

/**
 * Check if a connection is currently locked under cooldown
 */
export function isConnectionInCooldown(connection) {
  if (!connection || !connection.cooldown_until) return false;
  return connection.cooldown_until > Date.now();
}

/**
 * Mark a connection as unavailable under rate-limit cooldown
 */
export function markConnectionCooldown(connectionId, durationMs = 60000) {
  if (!connectionId) return;
  const until = Date.now() + durationMs;
  setConnectionCooldown(connectionId, until);
}

/**
 * Resolve an active, available connection for the given provider
 */
export function getActiveConnection(providerId) {
  if (!providerId) return null;

  const connections = getConnections(providerId);

  // Filter out inactive, cooldown, or exhausted accounts
  const available = connections.filter(
    (c) => c.is_active === 1 && !isConnectionInCooldown(c) && !isConnectionExhausted(c)
  );

  if (available.length > 0) {
    // Sort by last_used_at ascending (least-recently-used rotation)
    available.sort((a, b) => (a.last_used_at || 0) - (b.last_used_at || 0));
    const picked = available[0];
    if (picked.id) {
      updateConnectionLastUsed(picked.id);
    }
    return picked;
  }

  // If no DB connection exists, check if provider is free/noauth
  const providerDef = getProvider(providerId);
  if (providerDef && (providerDef.category === "free" || providerDef.noAuth)) {
    return {
      id: null,
      provider: providerId,
      name: `${providerDef.name || providerId} (Virtual Free)`,
      auth_type: "noauth",
      credentials: {},
      proxy_url: null,
      is_active: 1,
      cooldown_until: 0,
    };
  }

  return null;
}

/**
 * Apply credentials from connection to request headers
 */
export function applyConnectionAuth(headers, connection) {
  if (!connection || !connection.credentials) return headers;

  const creds = connection.credentials;

  // Bearer token (access_token or api_key with bearer scheme)
  if (creds.access_token) {
    headers["Authorization"] = `Bearer ${creds.access_token}`;
  } else if (creds.api_key) {
    if (connection.provider === "claude") {
      headers["x-api-key"] = creds.api_key;
    } else {
      headers["Authorization"] = `Bearer ${creds.api_key}`;
    }
  }

  return headers;
}
