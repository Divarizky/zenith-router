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

  // If no DB connection exists, only no-auth providers can run without an account.
  // category "free" alone is not enough: kiro is free but still requires a login token.
  const providerDef = getProvider(providerId);
  if (providerDef && providerDef.noAuth) {
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

// Trimmed from 9router open-sse/providers/shared.js (CLAUDE_CODE_HEADERS + ANTHROPIC_BETA_BASE).
// Pinned version; bump when the real CLI moves (format changes are rare).
const CLAUDE_CLI_VERSION = "2.1.280";
const CLAUDE_CODE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];

/**
 * Apply credentials from connection to request headers, based on the connection auth type
 */
export function applyConnectionAuth(headers, connection) {
  if (!connection || !connection.credentials || connection.auth_type === "noauth") return headers;

  const creds = connection.credentials;

  if (connection.auth_type === "oauth") {
    let token = creds.access_token || creds.api_key;
    if (!token) return headers;
    // Cline OAuth access tokens are WorkOS JWTs and must carry the "workos:" prefix.
    if (connection.provider === "cline" && /^eyJ[\w-]+\.[\w-]+/.test(token)) token = `workos:${token}`;
    headers["Authorization"] = `Bearer ${token}`;
    // Claude Code subscription usage: same identity bundle 9router sends (shared.js CLAUDE_CODE_HEADERS).
    // ponytail: x-claude-code-session-id alignment and X-Stainless SDK telemetry skipped; add if upstream rejects.
    if (connection.provider === "claude") {
      const beta = headers["anthropic-beta"] || headers["Anthropic-Beta"];
      delete headers["Anthropic-Beta"];
      const flags = new Set([...CLAUDE_CODE_BETAS, ...String(beta || "").split(",").map((s) => s.trim()).filter(Boolean)]);
      headers["anthropic-beta"] = [...flags].join(",");
      headers["User-Agent"] = `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`;
      headers["X-App"] = "cli";
      headers["Anthropic-Dangerous-Direct-Browser-Access"] = "true";
    }
    if (connection.provider === "kilocode" && creds.org_id) headers["X-Kilocode-OrganizationID"] = creds.org_id;
    return headers;
  }

  const apiKey = creds.api_key || creds.access_token;
  if (!apiKey) return headers;

  // Anthropic API keys go in x-api-key; Bearer is reserved for OAuth tokens there
  if (connection.provider === "claude") {
    headers["x-api-key"] = apiKey;
  } else if (
    (connection.provider === "cloudflare-ai" || connection.provider === "cloudflare") &&
    apiKey.includes(":")
  ) {
    const token = apiKey.split(":")[1];
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}
