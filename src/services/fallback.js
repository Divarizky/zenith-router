import {
  getConnections,
  setConnectionCooldown,
  updateConnectionLastUsed,
} from "../db/index.js";
import { getProvider } from "../providers/index.js";
import { adaptPayloadForProvider, MODEL_ACCESS_DENIED_403 } from "../providers/params.js";
import { disableModel } from "./modelOverrides.js";
import { isConnectionExhausted } from "./quota.js";
import { isConnectionInCooldown, applyConnectionAuth } from "./auth.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "./tokenRefresh.js";
import { getSetting } from "./settings.js";
import { captureLine } from "./logger.js";
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

/**
 * Failures tied to this model or this request, not to the account. Waiting
 * never fixes them, and cooling the account down would also block every other
 * model on it, so callers skip the cooldown. Mistral reports them as:
 * - 429 with a 0 requests/minute or tokens/minute limit: model is outside the tier.
 * - 429 with the token budget still untouched (remaining == limit): the request
 *   alone is larger than the model's tokens/minute limit.
 * - 403 tier_not_allowed or labs_not_enabled.
 * Returns null for ordinary failures, `{}` to relay the upstream error as is, or
 * `{ status, code, message }` to replace it with a non-retryable error.
 */
function classifyModelLevelDenial(res, errText, model, providerName) {
  const header = (name) => res.headers?.get?.(name);
  if (res.status === 429) {
    const reqLimit = header("x-ratelimit-limit-req-minute");
    const tokLimit = header("x-ratelimit-limit-tokens-minute");
    if (reqLimit === "0" || tokLimit === "0") {
      return {
        status: 403,
        code: "model_not_available",
        message: `Model '${model}' is not available on this ${providerName} account tier (rate limit is 0 requests/minute).`,
      };
    }
    const tokRemaining = header("x-ratelimit-remaining-tokens-minute");
    if (tokLimit && Number(tokLimit) > 0 && tokRemaining === tokLimit) {
      return {
        status: 413,
        code: "request_too_large",
        message: `Request is too large for model '${model}': it exceeds the ${tokLimit} tokens/minute limit of this ${providerName} account tier. Shorten the context or use another model.`,
      };
    }
    return null;
  }
  if (res.status === 403 && MODEL_ACCESS_DENIED_403.test(errText)) return {};
  return null;
}

// "<provider>/<model>" pairs that rejected reasoning_effort. Clients like Pi send
// it to every model, so later requests drop it up front instead of failing first.
const reasoningUnsupported = new Set();

function isReasoningRejected(res, errText) {
  return res.status === 400 && /reasoning_effort is not (enabled|supported)/i.test(errText);
}

function buildErrorPayload(targetFormat, type, message, code) {
  return targetFormat === "claude"
    ? { type: "error", error: { type, message } }
    : { error: { message, type, code } };
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
  stream = false,
  targetModel = "",
}) {
  const modelId = targetModel || upstreamPayload?.model || "";
  const reasoningKey = `${provider.id}/${modelId}`;
  const withoutReasoning = (p) => {
    const { reasoning_effort, ...rest } = p;
    return rest;
  };
  let payload = adaptPayloadForProvider(provider, upstreamPayload);
  if (reasoningUnsupported.has(reasoningKey) && payload && "reasoning_effort" in payload) {
    payload = withoutReasoning(payload);
  }
  let bodyText = JSON.stringify(payload);
  let reasoningRetried = false;
  // Accounts that refused the model itself (tier), as opposed to other failures.
  let tierDenials = 0;

  function bodyForConnection(connection) {
    const format = String(targetFormat || "").toLowerCase();
    if (format !== "kiro" && format !== "codewhisperer") return bodyText;
    const profileArn = connection?.credentials?.profile_arn || connection?.credentials?.profileArn;
    if (!profileArn) return bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      if (!parsed.profileArn) parsed.profileArn = profileArn;
      return JSON.stringify(parsed);
    } catch {
      return bodyText;
    }
  }

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
        console.error(`[zenith] Proactive refresh error for ${connection.id}:`, err.message);
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
        body: bodyForConnection(connection),
        signal,
        proxyUrl: connection?.proxy_url,
        connection,
        stream,
        targetModel,
        targetFormat,
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

    captureLine(
      `[FAILOVER] provider=${provider.id} account="${connection.name || connection.id}" HTTP ${res.status} error=${errText.slice(0, 140).replace(/\s+/g, " ")}`
    );

    // Model has no reasoning mode: drop reasoning_effort and retry the same account once.
    if (isReasoningRejected(res, errText) && !reasoningRetried && payload && "reasoning_effort" in payload) {
      reasoningRetried = true;
      reasoningUnsupported.add(reasoningKey);
      payload = withoutReasoning(payload);
      bodyText = JSON.stringify(payload);
      captureLine(`[PARAMS] provider=${provider.id} model=${modelId} rejects reasoning_effort; retrying without it`);
      triedIds.pop();
      attempt--;
      continue;
    }

    // Model- or request-level denial: no cooldown, other models stay usable.
    // Another account may have a higher tier, so still try the next one.
    const denial = classifyModelLevelDenial(
      res,
      errText,
      targetModel || upstreamPayload?.model || "",
      provider.name || provider.id
    );
    if (denial) {
      if (denial.code !== "request_too_large") tierDenials++;
      if (denial.code) {
        // Not a 429 any more, so clients stop retrying something that never clears.
        const type = denial.status === 413 ? "invalid_request_error" : "permission_error";
        lastFailureResponse = new Response(
          JSON.stringify(buildErrorPayload(targetFormat, type, denial.message, denial.code)),
          { status: denial.status, headers: { "Content-Type": "application/json" } }
        );
      }
      continue;
    }

    // Transient failure: cool down, apply jitter, and try next account before any bytes are sent to client
    if (res.status === 429 || res.status >= 500) {
      if (connection.id) {
        const retryAfterSec = Number(res.headers?.get?.("retry-after"));
        const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 60000 * attempt;
        setConnectionCooldown(connection.id, Date.now() + cooldownMs);
      }
      await applyReactiveJitter(signal);
      continue;
    }

    // Auth failure: refresh once on this account, then decide
    if ((res.status === 401 || res.status === 403) && canRefresh(connection)) {
      try {
        const refreshed = await refreshOAuthToken(connection, { force: true });
        if (!refreshed) {
          if (connection.id) setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
          if (attempt < maxAttempts) continue;
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
            body: bodyForConnection(connection),
            signal,
            proxyUrl: connection?.proxy_url,
            connection,
            stream,
            targetModel,
            targetFormat,
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
        console.error(`[zenith] Reactive refresh error for ${connection.id}:`, err.message);
        if (connection.id) setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
        if (attempt < maxAttempts) continue;
        return { ok: false, response: lastFailureResponse };
      }
    }

    // Account-level failures can be isolated to this credential; try the next one.
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      if (connection.id) setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
      if (attempt < maxAttempts) continue;
    }

    // Other non-ok status (400, 422, etc.) — return immediately
    return { ok: false, response: lastFailureResponse };
  }

  // Every account refused the model for its tier: hide it from routing and
  // /v1/models so clients stop picking it. It can be re-enabled on the provider page.
  if (lastFailureResponse && tierDenials > 0 && tierDenials === triedIds.length && modelId) {
    disableModel(provider.id, modelId);
    captureLine(`[ROUTING] Disabled ${provider.id}/${modelId}: not available on any account tier`);
  }

  if (lastFailureResponse) {
    return { ok: false, response: lastFailureResponse };
  }

  captureLine(`[ROUTING] No available connection for provider '${provider.id}'`);

  // Tell the client how long the cooldown lasts instead of a bare 503.
  const now = Date.now();
  const cooldownEnds = getConnections(provider.id)
    .filter((c) => c.is_active === 1 && Number(c.cooldown_until) > now)
    .map((c) => Number(c.cooldown_until));
  const retryAfterSec = cooldownEnds.length ? Math.ceil((Math.min(...cooldownEnds) - now) / 1000) : 0;
  let message = `No available connection for provider '${provider.id}'.`;
  if (retryAfterSec) {
    message += ` All accounts are cooling down after upstream errors; retry in ${retryAfterSec}s.`;
  }
  const shape = buildErrorPayload(
    targetFormat,
    targetFormat === "claude" ? "overloaded_error" : "service_unavailable",
    message,
    "no_available_connection"
  );
  const headers = { "Content-Type": "application/json" };
  if (retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return { ok: false, response: new Response(JSON.stringify(shape), { status: 503, headers }) };
}
