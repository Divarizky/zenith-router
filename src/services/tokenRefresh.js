import { getConnections, updateConnection } from "../db/index.js";

let customTokenRefresher = null;

/**
 * Set custom token refresher (for tests and mocking)
 */
export function setCustomTokenRefresher(fn) {
  customTokenRefresher = fn;
}

/**
 * Determine if an OAuth connection needs token refresh (< 5 minutes left or already expired)
 */
export function needsTokenRefresh(connection) {
  if (!connection || connection.auth_type !== "oauth") return false;
  const creds = connection.credentials;
  if (!creds || !creds.refresh_token) return false;

  // If no expires_at is set, assume it doesn't need proactive refresh unless reactive 401 triggers
  if (!creds.expires_at) return false;

  const fiveMinutesMs = 5 * 60 * 1000;
  return Number(creds.expires_at) - Date.now() < fiveMinutesMs;
}

/**
 * Default provider refresh handler using standard OAuth token endpoint
 */
async function defaultRefreshHandler(connection) {
  const creds = connection.credentials || {};
  const refreshToken = creds.refresh_token;
  if (!refreshToken) throw new Error("Missing refresh token");

  let tokenUrl = creds.token_url;
  if (!tokenUrl) {
    if (connection.provider === "codex") {
      tokenUrl = "https://auth.openai.com/oauth/token";
    } else if (connection.provider === "claude") {
      tokenUrl = "https://api.anthropic.com/v1/oauth/token";
    } else {
      tokenUrl = "https://oauth.example.com/token";
    }
  }

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.client_id || "",
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  const expiresIn = Number(data.expires_in) || 3600;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
  };
}

/**
 * Refresh OAuth token for a connection and update the SQLite database
 */
export function refreshOAuthToken(connection) {
  return (async () => {
    if (!connection || !connection.id) return null;

    let newTokens;
    if (customTokenRefresher) {
      newTokens = await customTokenRefresher(connection);
    } else {
      newTokens = await defaultRefreshHandler(connection);
    }

    if (!newTokens || !newTokens.access_token) {
      throw new Error("Invalid token payload returned from refresher");
    }

    const updatedCreds = {
      ...(connection.credentials || {}),
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token || connection.credentials?.refresh_token,
      expires_at: newTokens.expires_at || Date.now() + 3600 * 1000,
    };

    const updated = updateConnection(connection.id, { credentials: updatedCreds });
    return updated;
  })();
}

/**
 * Scan all OAuth connections and renew those that are nearing expiry
 */
export async function scanAndRefreshTokens() {
  const allConnections = getConnections();
  let refreshedCount = 0;

  for (const conn of allConnections) {
    if (conn.is_active && needsTokenRefresh(conn)) {
      try {
        await refreshOAuthToken(conn);
        refreshedCount++;
      } catch (err) {
        console.error(`[zenroute] Proactive token refresh failed for connection ${conn.id}:`, err.message);
      }
    }
  }

  return refreshedCount;
}
