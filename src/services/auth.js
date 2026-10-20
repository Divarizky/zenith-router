import {
  getConnections,
  getModelLockUntil,
  setConnectionCooldown,
  updateConnectionLastUsed,
} from "../db/index.js";
import { getProvider } from "../providers/index.js";
import { isConnectionExhausted } from "./quota.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * Check if a connection is currently locked under cooldown for a given model.
 *
 * Two independent locks exist: the account-wide one on the connection row
 * (broken credentials) blocks every model, and the per-pair one in
 * connection_model_locks (rate limit) blocks only that model. Omitting the model
 * asks the account-wide question only.
 */
export function isConnectionInCooldown(connection, model = null) {
  if (!connection) return false;
  if (connection.cooldown_until && connection.cooldown_until > Date.now()) return true;
  if (model && getModelLockUntil(connection.id, model)) return true;
  return false;
}

/**
 * True when the whole account is parked, with no usable model left.
 *
 * A per-model lock is not an outage: the account still serves every other model,
 * and the dashboard must not paint it as dead.
 */
export function isConnectionFullyCooledDown(connection) {
  return Boolean(connection?.cooldown_until && connection.cooldown_until > Date.now());
}

/**
 * Mark a connection as unavailable under rate-limit cooldown. Pass a model when
 * only that model is unusable, leave it out to park the whole account.
 */
export function markConnectionCooldown(connectionId, durationMs = 60000, model = null) {
  if (!connectionId) return;
  const until = Date.now() + durationMs;
  setConnectionCooldown(connectionId, until, model);
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
    // Same order as routing: getConnections returns the provider by priority.
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

// Trimmed from the upstream shared.js (CLAUDE_CODE_HEADERS + ANTHROPIC_BETA_BASE).
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
    // Cline free models are gated to recognized product surfaces (mirrors the upstream
    // shared/clineAuth.js buildClineHeaders): without client identity headers the
    // upstream answers 403 "only available via Cline product surfaces".
    if (connection.provider === "cline") {
      // Cline OAuth access tokens are WorkOS JWTs and must carry the "workos:" prefix.
      if (/^eyJ[\w-]+\.[\w-]+/.test(token)) token = `workos:${token}`;
      const v = pkg.version || "0.0.0";
      if (!headers["User-Agent"]) headers["User-Agent"] = `zenith-router/${v}`;
      if (!headers["X-CLIENT-TYPE"]) headers["X-CLIENT-TYPE"] = "zenith-router";
      headers["X-CLIENT-VERSION"] = headers["X-CLIENT-VERSION"] || v;
      headers["X-CORE-VERSION"] = headers["X-CORE-VERSION"] || v;
      headers["X-PLATFORM"] = headers["X-PLATFORM"] || process.platform;
      headers["X-PLATFORM-VERSION"] = headers["X-PLATFORM-VERSION"] || process.version;
      headers["X-IS-MULTIROOT"] = headers["X-IS-MULTIROOT"] || "false";
    }
    headers["Authorization"] = `Bearer ${token}`;
    // Claude Code subscription usage: same identity bundle the upstream sends (shared.js CLAUDE_CODE_HEADERS).
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
