import { getConnectionById, getConnections, updateConnection } from "../db/index.js";
import { logQuiet } from "./logger.js";
import { OAUTH_CONFIG, oauthFetch, fetchCopilotToken, fetchKiroProfileArn } from "./oauth/providers.js";
import { requireResolvedProxy } from "./proxyPools.js";

let customTokenRefresher = null;
const inFlightRefreshes = new Map();

/**
 * Set custom token refresher (for tests and mocking)
 */
export function setCustomTokenRefresher(fn) {
  customTokenRefresher = fn;
}

/**
 * Whether the connection holds what its provider needs to mint a new access token.
 * GitHub has no refresh token: the Copilot token is re-minted from the stored GitHub token.
 */
export function canRefresh(connection) {
  if (!connection || connection.auth_type !== "oauth") return false;
  const creds = connection.credentials || {};
  if (connection.provider === "github") {
    return Boolean(creds.github_token || (typeof creds.access_token === "string" && /^gh[oup]_/.test(creds.access_token)));
  }
  return Boolean(creds.refresh_token);
}

/**
 * Determine if an OAuth connection needs token refresh (< 5 minutes left or already expired)
 */
export function needsTokenRefresh(connection) {
  if (!canRefresh(connection)) return false;
  const creds = connection.credentials;

  // If no expires_at is set, assume it doesn't need proactive refresh unless reactive 401 triggers
  if (!creds.expires_at) return false;

  const fiveMinutesMs = 5 * 60 * 1000;
  return Number(creds.expires_at) - Date.now() < fiveMinutesMs;
}

async function postJson(url, body, label, extraHeaders = {}, proxyUrl = null) {
  const res = await oauthFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  }, { proxyUrl });
  if (!res.ok) throw new Error(`${label} refresh failed with HTTP ${res.status}`);
  return res.json();
}

async function postForm(url, params, label, proxyUrl = null) {
  const res = await oauthFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  }, { proxyUrl });
  if (!res.ok) throw new Error(`${label} refresh failed with HTTP ${res.status}`);
  return res.json();
}

function expiresAt(seconds) {
  return Date.now() + (Number(seconds) || 3600) * 1000;
}

// Per-provider refresh, matching 9router open-sse/services/tokenRefresh/providers.js.
// Each returns { access_token, refresh_token?, expires_at, ...extra credential fields }.
const REFRESHERS = {
  async claude(creds, proxyUrl) {
    const t = await postJson(
      OAUTH_CONFIG.claude.tokenUrl,
      { grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: OAUTH_CONFIG.claude.clientId },
      "Claude",
      {},
      proxyUrl
    );
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expiresAt(t.expires_in) };
  },

  async codex(creds, proxyUrl) {
    const t = await postJson(
      OAUTH_CONFIG.codex.tokenUrl,
      { grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: OAUTH_CONFIG.codex.clientId },
      "Codex",
      {},
      proxyUrl
    );
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: expiresAt(t.expires_in),
      ...(t.id_token ? { id_token: t.id_token } : {}),
    };
  },

  async antigravity(creds, proxyUrl) {
    const cfg = OAUTH_CONFIG.antigravity;
    const t = await postForm(
      cfg.tokenUrl,
      {
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      },
      "Google",
      proxyUrl
    );
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expiresAt(t.expires_in) };
  },

  async cline(creds, proxyUrl) {
    const body = await postJson(
      OAUTH_CONFIG.cline.refreshUrl,
      { refreshToken: creds.refresh_token, grantType: "refresh_token", clientType: "extension" },
      "Cline",
      {},
      proxyUrl
    );
    const t = body?.data || body;
    return {
      access_token: t.accessToken,
      refresh_token: t.refreshToken,
      expires_at: t.expiresAt ? new Date(t.expiresAt).getTime() : expiresAt(3600),
    };
  },

  async kiro(creds, proxyUrl) {
    let t;
    if (creds.client_id && creds.client_secret) {
      // Builder ID / IdC: AWS SSO OIDC refresh with the registered client.
      const region = creds.auth_method === "idc" && creds.region ? creds.region : "us-east-1";
      t = await postJson(
        `https://oidc.${region}.amazonaws.com/token`,
        {
          clientId: creds.client_id,
          clientSecret: creds.client_secret,
          refreshToken: creds.refresh_token,
          grantType: "refresh_token",
        },
        "Kiro",
        {},
        proxyUrl
      );
    } else {
      // Social (Google/GitHub) login from the Kiro IDE.
      t = await postJson(OAUTH_CONFIG.kiro.socialRefreshUrl, { refreshToken: creds.refresh_token }, "Kiro", {
        "User-Agent": "kiro-cli/1.0.0",
      }, proxyUrl);
    }
    const profileArn = creds.profile_arn || t.profileArn || (await fetchKiroProfileArn(t.accessToken, { proxyUrl }));
    return {
      access_token: t.accessToken,
      refresh_token: t.refreshToken,
      expires_at: expiresAt(t.expiresIn),
      ...(profileArn ? { profile_arn: profileArn } : {}),
    };
  },

  async github(creds, proxyUrl) {
    const ghToken = creds.github_token || creds.access_token;
    const copilot = await fetchCopilotToken(ghToken, { proxyUrl });
    return { access_token: copilot.token, expires_at: copilot.expiresAt, github_token: ghToken };
  },
};

/**
 * Default provider refresh handler
 */
async function defaultRefreshHandler(connection) {
  const refresher = REFRESHERS[connection.provider];
  if (!refresher) throw new Error(`Token refresh is not supported for ${connection.provider}`);
  return refresher(connection.credentials || {}, requireResolvedProxy(connection));
}

/**
 * Perform actual refresh execution
 */
async function executeRefresh(connection) {
  let newTokens;
  if (customTokenRefresher) {
    newTokens = await customTokenRefresher(connection);
  } else {
    newTokens = await defaultRefreshHandler(connection);
  }

  if (!newTokens || !newTokens.access_token) {
    throw new Error("Invalid token payload returned from refresher");
  }

  const { access_token, refresh_token, expires_at, ...extra } = newTokens;
  const updatedCreds = {
    ...(connection.credentials || {}),
    ...extra,
    access_token,
    expires_at: expires_at || Date.now() + 3600 * 1000,
  };
  const nextRefresh = refresh_token || connection.credentials?.refresh_token;
  if (nextRefresh) updatedCreds.refresh_token = nextRefresh;

  const updated = updateConnection(connection.id, { credentials: updatedCreds });
  return updated;
}

/**
 * Refresh OAuth token for a connection and update the SQLite database.
 * Uses a single-flight mutex per connection.id to prevent race conditions on token rotation.
 * In-flight callers share the same refresh promise. Once resolved, subsequent callers re-check DB state.
 */
export function refreshOAuthToken(connection, { force = false } = {}) {
  if (!connection || !connection.id) return Promise.resolve(null);

  const existing = inFlightRefreshes.get(connection.id);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const freshConn = getConnectionById(connection.id) || connection;
      if (!force && !needsTokenRefresh(freshConn)) {
        return freshConn;
      }
      return await executeRefresh(freshConn);
    } finally {
      inFlightRefreshes.delete(connection.id);
    }
  })();

  inFlightRefreshes.set(connection.id, promise);
  return promise;
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
        // Background scan: dashboard console only, never the terminal.
        logQuiet(`[zenith] Proactive token refresh failed for connection ${conn.id}: ${err.message}`, "error");
      }
    }
  }

  return refreshedCount;
}

const REFRESH_SCAN_INTERVAL_MS = 5 * 60 * 1000; // matches the <5 min proactive window
let refreshTimer = null;

/**
 * Background token refresher. First pass runs right away so accounts that were
 * already close to expiry before boot are renewed, then it rescans on the
 * interval. Timers are unref'd like the model and quota schedulers, so the
 * scan never keeps the process alive. There is no on/off toggle: it runs
 * whenever the server does.
 */
export function startTokenRefreshScheduler() {
  if (refreshTimer) return refreshTimer;

  const tick = () => {
    // Background job: dashboard console only, never the terminal.
    scanAndRefreshTokens().catch((err) => {
      logQuiet(`[zenith] Background token refresh failed: ${err.message}`, "error");
    });
  };

  tick();
  refreshTimer = setInterval(tick, REFRESH_SCAN_INTERVAL_MS);
  refreshTimer.unref?.();
  return refreshTimer;
}

export function stopTokenRefreshScheduler() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}
