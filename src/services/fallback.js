import {
  getConnections,
  setConnectionCooldown,
  updateConnectionLastUsed,
} from "../db/index.js";
import { getProvider } from "../providers/index.js";
import { isConnectionExhausted } from "./quota.js";
import { isConnectionInCooldown, applyConnectionAuth } from "./auth.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "./tokenRefresh.js";
import { getSetting } from "./settings.js";
import { acquireAccountSlot, applyReactiveJitter } from "./trafficGuard.js";

export function listAvailableConnections(providerId, { rotation = null } = {}) {
  if (!providerId) return [];
  const providerDef = getProvider(providerId);
  const connections = getConnections(providerId);

  const available = connections.filter(
    (c) => c.is_active === 1 && !isConnectionInCooldown(c) && !isConnectionExhausted(c)
  );

  const strategy = rotation || getSetting("account_rotation", "lru");
  if (strategy === "sticky") {
    available.sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0));
  } else {
    available.sort((a, b) => (a.last_used_at || 0) - (b.last_used_at || 0));
  }

  if (available.length === 0 && providerDef?.noAuth) {
    available.push({
      id: null,
      provider: providerId,
      name: `${providerDef.name || providerId} (Virtual Free)`,
      auth_type: "noauth",
      credentials: {},
      proxy_url: null,
      is_active: 1,
      cooldown_until: 0,
    });
  }

  return available;
}

export function getNextConnection(providerId, triedIds = []) {
  const available = listAvailableConnections(providerId);
  for (const c of available) {
    if (!triedIds.includes(c.id)) {
      if (c.id) updateConnectionLastUsed(c.id);
      return c;
    }
  }
  return null;
}

export function markProviderCooldown(providerId, durationMs = 60000) {
  if (!providerId) return;
  const connections = getConnections(providerId);
  const until = Date.now() + durationMs;
  for (const c of connections) {
    setConnectionCooldown(c.id, until);
  }
}

function attachSlotRelease(res, releaseSlot) {
  if (!res || !releaseSlot) return res;
  if (!res.body) {
    releaseSlot();
    return res;
  }
  let released = false;
  const safeRelease = () => {
    if (!released) {
      released = true;
      releaseSlot();
    }
  };
  const releaseTransform = new TransformStream({
    flush() {
      safeRelease();
    },
    cancel() {
      safeRelease();
    },
  });
  const wrappedBody = res.body.pipeThrough(releaseTransform);
  return new Response(wrappedBody, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function buildErrorResponse(res, bodyText, targetFormat) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    if (targetFormat === "claude") {
      payload = {
        type: "error",
        error: {
          type: "upstream_error",
          message: bodyText || `Upstream returned HTTP ${res.status}`,
        },
      };
    } else {
      payload = {
        error: {
          message: bodyText || `Upstream returned HTTP ${res.status}`,
          type: "upstream_error",
          code: `http_${res.status}`,
        },
      };
    }
  }
  return new Response(JSON.stringify(payload), { status: res.status, headers: { "Content-Type": "application/json" } });
}

/**
 * Try one or more connections for the provider.
 * Returns { ok: true, upstreamRes, connection } or { ok: false, response }.
 */
export async function executeWithFallback({
  provider,
  targetFormat,
  upstreamPayload,
  baseHeaders,
  executor,
  signal,
  resolveUrl,
}) {
  const bodyText = JSON.stringify(upstreamPayload);
  const triedIds = [];
  const available = listAvailableConnections(provider.id);
  const maxAttempts = Math.max(1, available.length);
  let lastFailureResponse = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let connection = getNextConnection(provider.id, triedIds);
    if (!connection) break;
    triedIds.push(connection.id);

    // Proactive token refresh if near expiry
    if (needsTokenRefresh(connection)) {
      try {
        const refreshed = await refreshOAuthToken(connection);
        if (refreshed) connection = refreshed;
      } catch (err) {
        console.error(`[zenroute] Proactive refresh error for ${connection.id}:`, err.message);
      }
    }

    let releaseSlot = null;
    try {
      releaseSlot = await acquireAccountSlot(connection, signal);
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
    }

    const headers = { ...baseHeaders };
    applyConnectionAuth(headers, connection);
    const url = resolveUrl(connection);

    let res;
    try {
      res = await executor.execute({
        url,
        method: "POST",
        headers,
        body: bodyText,
        signal,
        proxyUrl: connection?.proxy_url,
      });
    } catch (err) {
      if (releaseSlot) releaseSlot();
      throw err;
    }

    // Success: this connection can serve the request
    if (res.ok) {
      return { ok: true, upstreamRes: attachSlotRelease(res, releaseSlot), connection };
    }

    // Attempt failed: release slot before processing failover or next attempt
    if (releaseSlot) {
      releaseSlot();
      releaseSlot = null;
    }

    // Capture response for error relaying
    const errText = await res.text();
    lastFailureResponse = buildErrorResponse(res, errText, targetFormat);

    console.warn(
      `[FAILOVER] provider=${provider.id} account="${connection.name || connection.id}" HTTP ${res.status} error=${errText.slice(0, 140).replace(/\s+/g, " ")}`
    );

    // Transient failure: cool down, apply jitter, and try next account before any bytes are sent to client
    if (res.status === 429 || res.status >= 500) {
      if (connection.id) setConnectionCooldown(connection.id, Date.now() + 60000);
      await applyReactiveJitter(signal);
      continue;
    }

    // Auth failure: refresh once on this account, then decide
    if ((res.status === 401 || res.status === 403) && canRefresh(connection)) {
      try {
        const refreshed = await refreshOAuthToken(connection, { force: true });
        if (!refreshed) {
          return { ok: false, response: lastFailureResponse };
        }
        connection = refreshed;
        applyConnectionAuth(headers, connection);

        try {
          releaseSlot = await acquireAccountSlot(connection, signal);
        } catch {}

        try {
          res = await executor.execute({
            url,
            method: "POST",
            headers,
            body: bodyText,
            signal,
            proxyUrl: connection?.proxy_url,
          });
        } catch (err) {
          if (releaseSlot) releaseSlot();
          throw err;
        }

        if (res.ok) return { ok: true, upstreamRes: attachSlotRelease(res, releaseSlot), connection };
        if (releaseSlot) {
          releaseSlot();
          releaseSlot = null;
        }
        lastFailureResponse = buildErrorResponse(res, await res.text(), targetFormat);
        if (res.status === 429 || res.status >= 500) {
          if (connection.id) setConnectionCooldown(connection.id, Date.now() + 60000);
          await applyReactiveJitter(signal);
          continue;
        }
        return { ok: false, response: lastFailureResponse };
      } catch (err) {
        if (releaseSlot) releaseSlot();
        console.error(`[zenroute] Reactive refresh error for ${connection.id}:`, err.message);
        return { ok: false, response: lastFailureResponse };
      }
    }

    // Other non-ok status (400, 404, 422, etc.) — return immediately
    return { ok: false, response: lastFailureResponse };
  }

  if (lastFailureResponse) {
    return { ok: false, response: lastFailureResponse };
  }

  console.error(`[ROUTING] No available connection for provider '${provider.id}'`);

  const shape = targetFormat === "claude"
    ? { type: "error", error: { type: "overloaded_error", message: `No available connection for provider '${provider.id}'.` } }
    : { error: { message: `No available connection for provider '${provider.id}'.`, type: "service_unavailable", code: "no_available_connection" } };
  return { ok: false, response: new Response(JSON.stringify(shape), { status: 503, headers: { "Content-Type": "application/json" } }) };
}
