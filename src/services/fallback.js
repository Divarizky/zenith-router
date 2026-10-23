import {
  getConnections,
  getModelLockUntil,
  setConnectionCooldown,
  updateConnectionLastUsed,
  getAntigravityModelsByConnection,
  getAntigravityAccountModels,
} from "../db/index.js";
import { getProvider, getProviderModels, resolveProviderRuntime } from "../providers/index.js";
import { adaptPayloadForProvider, MODEL_ACCESS_DENIED_403 } from "../providers/params.js";
import { disableModel } from "./modelOverrides.js";
import { isConnectionExhausted, syncProviderQuota } from "./quota.js";
import { isAntigravityPoolExhausted } from "./antigravityPools.js";
import { isConnectionInCooldown, applyConnectionAuth } from "./auth.js";
import { extractClaudeSessionId } from "./claudeIdentity.js";
import { applyClaudeOAuthCloaking, isClaudeOAuthToken } from "./claudeCloaking.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "./tokenRefresh.js";
import { captureLine } from "./logger.js";
import { acquireAccountSlot, applyReactiveJitter } from "./trafficGuard.js";
import { resolveConnectionProxy, requireResolvedProxy, getProxyRotationStrategy, planProxyRotation } from "./proxyPools.js";
import { probeStreamError } from "./streamProbe.js";
import { clearCooldownStrike, cooldownStrikeReached } from "./cooldownStrikes.js";

// Callers that run several attempts for one client request pass the same id, so
// internal retries never count as separate user attempts.
let fallbackRequestSeq = 0;
function nextFallbackRequestId() {
  fallbackRequestSeq += 1;
  return `fallback-${fallbackRequestSeq}`;
}

/**
 * Key for the strike counter. `model:<id>` follows the per-model rate limit
 * lock; `account` follows the account-wide auth lock.
 */
function strikeKey(connection, scope) {
  return `${connection.id}:${connection.provider || ""}:${scope}`;
}

/**
 * Park the account only once this failure is the second one across separate
 * client requests. The failure itself is still reported to the client, so the
 * caller sees the real upstream error instead of a cooldown notice.
 */
function parkAfterRepeatedFailures(connection, scope, requestId) {
  return cooldownStrikeReached(strikeKey(connection, scope), requestId);
}

function clearFailureStrikes(connection, modelId) {
  clearCooldownStrike(strikeKey(connection, "account"));
  if (modelId) clearCooldownStrike(strikeKey(connection, `model:${modelId}`));
}

export function listAvailableConnections(providerId, { model = null, effort = undefined } = {}) {
  if (!providerId) return [];
  const providerDef = getProvider(providerId);
  const connections = getConnections(providerId);

  // Antigravity publishes a per-subscription model list, so an account that
  // does not carry the model is skipped instead of costing a wasted 403. The
  // gate fails open: an account that has never synced has no rows and stays
  // eligible, and the quota cache only expires with a new sync.
  const antigravityInventory = providerDef?.id === "antigravity" && model ? getAntigravityModelsByConnection() : null;
  const request = { providerDef, model, effort };

  const candidates = connections.filter(
    (c) =>
      c.is_active === 1 &&
      !isConnectionInCooldown(c, model) &&
      !isConnectionExhausted(c) &&
      // an account whose list proxy is inactive or gone is skipped
      // here and never falls back to a direct connection.
      !resolveConnectionProxy(c).blocked
  );
  // getConnections already returns the provider in priority order, so the first
  // account left after filtering is the highest-ranked one that can serve. A
  // spare is reached only while every account above it is unavailable.
  const available = candidates.filter((c) => servesModel(c, request, antigravityInventory));

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

/**
 * True when the model may be sent to this account. Only Antigravity is gated
 * today: its catalog is per subscription, and its 5h or weekly pool limit can
 * block a model group until the reset. Everything else always passes. An account
 * with no synced rows passes unless its pool is exhausted. The effort resolves against this
 * account's own variants, the same way the executor resolves it.
 */
function servesModel(connection, { providerDef, model, effort }, inventory) {
  if (!inventory || !connection.id) return true;
  const rows = inventory.get(connection.id);
  const hasRows = Boolean(rows && rows.size > 0);
  // Without synced rows the runtime cannot be resolved, so the requested id is checked against its pool.
  const runtimeId = hasRows ? (resolveProviderRuntime(providerDef, model, effort, rows)?.id ?? model) : model;
  // A pool limit applies even before the first inventory sync.
  if (isAntigravityPoolExhausted(connection.credentials?.quota, runtimeId)) return false;
  if (!hasRows) return true;

  const row = rows.get(runtimeId);
  if (!row) return false;
  const isExhausted = typeof row.quota_remaining === "number" && row.quota_remaining === 0;
  const hasFutureReset = Number(row.quota_reset_at || 0) > Date.now();
  return !(isExhausted && hasFutureReset);
}

export function getNextConnection(providerId, triedIds = [], model = null, effort = undefined) {
  const available = listAvailableConnections(providerId, { model, effort });
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

/**
 * Google's Cloud Code answers a model it cannot serve with this wording. When
 * the name it reports is not one we asked for, the upstream translated the
 * request into its own internal alias and routed it to a backend that does not
 * serve that alias for this API version. The account itself is healthy — the
 * same model served the previous request — so the failure is transient even
 * though the status is 404.
 */
const TRANSIENT_UPSTREAM_404 = /models\/([\w.-]+) is not found for API version [^,]+, or is not supported for generateContent/i;

// How often a transient upstream 404 is retried on the same account.
const MAX_TRANSIENT_NOT_FOUND_RETRIES = 1;

// Only Cloud Code speaks this wording, so no other provider is affected by
// mistaking its own 404 for a transient one. Antigravity is the only provider
// that talks to Cloud Code.
const CLOUD_CODE_PROVIDERS = new Set(["antigravity"]);

/**
 * The model ids this request can have put on the wire: the routed id, plus the
 * runtime id the executor resolves it to. A 404 that names one of these means
 * the model really is unavailable here, so it is reported as is.
 */
function sentModelIds(provider, modelId, effort, connection) {
  const ids = new Set(modelId ? [modelId] : []);
  if (CLOUD_CODE_PROVIDERS.has(provider?.id) && connection?.id) {
    try {
      const rows = getAntigravityAccountModels(connection.id);
      const picked = resolveProviderRuntime(provider, modelId, effort, rows?.size ? rows : null);
      if (picked?.id) ids.add(picked.id);
    } catch {}
  }
  return ids;
}

function isTransientUpstreamNotFound(res, errText, sentIds, provider) {
  if (res.status !== 404) return false;
  if (!CLOUD_CODE_PROVIDERS.has(provider?.id)) return false;
  const match = TRANSIENT_UPSTREAM_404.exec(errText || "");
  if (!match) return false;
  const reported = match[1].toLowerCase();
  for (const id of sentIds) {
    if (String(id).toLowerCase() === reported) return false;
  }
  return true;
}

function buildErrorPayload(targetFormat, type, message, code) {
  return targetFormat === "claude"
    ? { type: "error", error: { type, message } }
    : { error: { message, type, code } };
}

// The account stayed at its concurrency cap for the whole queue wait. Sending
// anyway would break the cap, so the request moves on to the next account and
// this is what the client sees when none is left.
function accountBusyResponse(targetFormat, connection) {
  const message = `Account '${connection.name || connection.id}' is at its concurrency limit; retry shortly.`;
  return new Response(
    JSON.stringify(buildErrorPayload(targetFormat, "rate_limit_error", message, "account_busy")),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "5" } }
  );
}

/**
 * Models that draw from the account's free-tier budget: the free models synced for
 * the provider, plus any `:free` id in its builtin list, plus the model that was called.
 */
function freeTierModelIds(provider, modelId) {
  const ids = new Set(modelId ? [modelId] : []);
  for (const m of getProviderModels(provider)) {
    if (m.source === "synced" || String(m.id).endsWith(":free")) ids.add(m.id);
  }
  return ids;
}

/**
 * Cooldown after a 429 or 5xx on one account. A 429 with `x-ratelimit-scope: free`
 * means the account's daily free-token budget is spent. That budget is shared by
 * every free model on the account, so all of them wait for the same reset. The
 * quota is then re-synced so the dashboard stops showing the stale balance.
 */
function applyRateLimitCooldown(connection, provider, res, errText, modelId, defaultMs) {
  const until = Date.now() + extractQuotaCooldownMs(res, errText, defaultMs);
  if (res.status === 429 && res.headers?.get?.("x-ratelimit-scope") === "free") {
    for (const id of freeTierModelIds(provider, modelId)) setConnectionCooldown(connection.id, until, id);
    syncProviderQuota(connection, { quiet: true }).catch(() => {});
    return;
  }
  setConnectionCooldown(connection.id, until, modelId);
}

// The executor's 502 for a failed upstream fetch, see src/executors/base.js.
const TRANSPORT_FAILURE_RE = /"type":"transport_error"/;

export function isTransportFailure(res, bodyText) {
  return res.status === 502 && TRANSPORT_FAILURE_RE.test(bodyText || "");
}

/**
 * Parses Google/Antigravity and standard rate limit reset indications.
 * Antigravity reports quota exhaustion with details containing:
 * - RetryInfo: { retryDelay: "497880.916563646s" }
 * - ErrorInfo: { metadata: { quotaResetTimeStamp: "2026-10-24T22:06:11Z", quotaResetDelay: "..." } }
 */
export function extractQuotaCooldownMs(res, bodyText, defaultDurationMs = 60000) {
  const retryAfterSec = Number(res?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return retryAfterSec * 1000;
  }

  if (!bodyText || typeof bodyText !== "string") return defaultDurationMs;

  try {
    const payload = JSON.parse(bodyText);
    const errorObj = payload?.error || payload;
    const details = Array.isArray(errorObj?.details) ? errorObj.details : [];

    for (const item of details) {
      // 1. Google RetryInfo: retryDelay format "123.456s" or numeric
      if (item?.retryDelay) {
        const sec = typeof item.retryDelay === "string" ? parseFloat(item.retryDelay) : Number(item.retryDelay);
        if (Number.isFinite(sec) && sec > 0) {
          return Math.ceil(sec * 1000);
        }
      }

      // 2. Google ErrorInfo metadata
      const meta = item?.metadata;
      if (meta && typeof meta === "object") {
        if (meta.quotaResetTimeStamp) {
          const resetTime = new Date(meta.quotaResetTimeStamp).getTime();
          const diffMs = resetTime - Date.now();
          if (Number.isFinite(diffMs) && diffMs > 0) {
            return diffMs;
          }
        }
        if (meta.quotaResetDelay) {
          const sec = typeof meta.quotaResetDelay === "string" ? parseFloat(meta.quotaResetDelay) : Number(meta.quotaResetDelay);
          if (Number.isFinite(sec) && sec > 0) {
            return Math.ceil(sec * 1000);
          }
        }
      }
    }
  } catch {
    // If not JSON, ignore and fallback to default
  }

  return defaultDurationMs;
}

export function buildErrorResponse(res, bodyText, targetFormat) {
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
  const headers = { "Content-Type": "application/json" };
  // Clients back off on Retry-After; the gate labels say why a route was refused.
  for (const name of ["retry-after", "x-opencode-gate", "x-opencode-log-id", "x-zenith-auth-expired"]) {
    const value = res.headers?.get?.(name);
    if (value) headers[name] = value;
  }
  return new Response(JSON.stringify(payload), { status: res.status, headers });
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
  sessionKey = null,
  effort = undefined,
  requestId = null,
}) {
  const modelId = targetModel || upstreamPayload?.model || "";
  // One client request = one attempt budget. Retries inside it reuse the id.
  const attemptId = requestId || nextFallbackRequestId();
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
  // Requests carrying tools belong to the agent loop; everything else is an
  // auxiliary call (session title, memory job) that must not take a slot a
  // conversation is waiting for.
  const purpose = Array.isArray(payload?.tools) && payload.tools.length > 0 ? "main" : "aux";
  let reasoningRetried = false;
  // Accounts that refused the model itself (tier), as opposed to other failures.
  let tierDenials = 0;
  // Connection of the first attempt. Encrypted reasoning items are bound to
  // the account that produced them, so a retry that lands on another
  // connection cannot verify them upstream — they are stripped instead of
  // risking a 400 that failover would not retry.
  let primaryConnectionId;

  function stripEncryptedReasoning(text) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.input)) return text;
      const input = parsed.input.filter(
        (item) => !(item?.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content)
      );
      if (input.length === parsed.input.length) return text;
      parsed.input = input;
      return JSON.stringify(parsed);
    } catch {
      return text;
    }
  }

  function bodyForConnection(connection) {
    if (provider.id === "claude" && isClaudeOAuthToken(connection?.credentials?.access_token)) {
      return JSON.stringify(applyClaudeOAuthCloaking(JSON.parse(bodyText)));
    }
    const format = String(targetFormat || "").toLowerCase();
    if (format === "openai-responses" || format === "responses") {
      if (connection?.id) {
        if (primaryConnectionId === undefined) primaryConnectionId = connection.id;
        else if (connection.id !== primaryConnectionId) {
          bodyText = stripEncryptedReasoning(bodyText);
        }
      }
      return bodyText;
    }
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
  const available = listAvailableConnections(provider.id, { model: modelId, effort });
  // provider tanpa akun dilayani koneksi virtual. Saat
  // strategi rotasi aktif dan ada proxy aktif, satu request mencoba sampai
  // tiga proxy berbeda; proxy yang gagal dilewati ke berikutnya dalam request
  // yang sama. Tanpa proxy aktif, koneksi virtual tetap memakai koneksi
  // langsung seperti sebelumnya.
  const virtualOnly = available.length === 1 && available[0].id === null;
  const rotationProxies = virtualOnly
    ? planProxyRotation(provider.id, getProxyRotationStrategy(provider.id))
    : [];
  const maxAttempts =
    rotationProxies.length > 0 ? rotationProxies.length : Math.max(1, available.length);
  let lastFailureResponse = null;
  // A transient upstream 404 is retried on the same account this many times
  // before it is reported to the client.
  let transientNotFoundRetries = 0;
  // The account a same-account retry goes back to.
  let retryConnection = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let connection;
    // An account held back for a same-account retry, so the retry does not
    // depend on the order accounts are picked in.
    if (retryConnection) {
      connection = retryConnection;
      retryConnection = null;
    } else if (rotationProxies.length > 0) {
      // Koneksi virtual dipakai ulang; yang berganti per percobaan hanya proxy.
      connection = available[0];
    } else {
      connection = getNextConnection(provider.id, triedIds, modelId, effort);
      if (!connection) break;
      triedIds.push(connection.id);
    }

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
      releaseSlot = await acquireAccountSlot(connection, signal, { purpose });
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      lastFailureResponse = accountBusyResponse(targetFormat, connection);
      captureLine(`[TRAFFIC] provider=${provider.id} account="${connection.name || connection.id}" ${err.message}`);
      continue;
    }

    const headers = { ...baseHeaders };
    // The upstream checks the session id against metadata.user_id, so both
    // have to come from the same request body.
    const claudeSessionId =
      provider.id === "claude" ? extractClaudeSessionId(payload?.metadata?.user_id) : null;
    applyConnectionAuth(headers, connection, { claudeSessionId });
    const url = resolveUrl(connection);
    const proxyUrl =
      rotationProxies.length > 0 ? rotationProxies[attempt - 1] ?? null : requireResolvedProxy(connection);

    let res;
    try {
      res = await executor.execute({
        url,
        method: "POST",
        headers,
        body: bodyForConnection(connection),
        signal,
        proxyUrl,
        connection,
        stream,
        targetModel,
        targetFormat,
        sessionKey,
        effort,
      });
      // An HTTP 200 stream whose first event is an error (rate limit, quota)
      // must fail here, or the error reaches the client as a success.
      res = await probeStreamError(res, signal);
    } catch (err) {
      if (releaseSlot) releaseSlot();
      throw err;
    }

    // Success: this connection can serve the request
    if (res.ok) {
      clearFailureStrikes(connection, modelId);
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

    // The client hung up mid-attempt: nothing is waiting for this answer, so it is
    // neither a failover nor a reason to park an account.
    if (signal?.aborted) return { ok: false, response: lastFailureResponse };

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

    // Upstream answered 404 for a model it does serve, because the request was
    // routed to a backend that does not know that model for this API version.
    // The account is healthy, so it is neither cooled down nor locked, and the
    // model stays available: another account takes over, and the same account
    // is retried once when no other one is left.
    if (isTransientUpstreamNotFound(res, errText, sentModelIds(provider, modelId, effort, connection), provider)) {
      const hasOtherAccount = listAvailableConnections(provider.id, { model: modelId, effort }).some(
        (c) => c.id && !triedIds.includes(c.id)
      );
      if (hasOtherAccount) {
        captureLine(
          `[FAILOVER] provider=${provider.id} account="${connection.name || connection.id}" transient 404 upstream, pindah ke akun lain`
        );
        continue;
      }
      if (transientNotFoundRetries < MAX_TRANSIENT_NOT_FOUND_RETRIES) {
        transientNotFoundRetries++;
        captureLine(
          `[RETRY] provider=${provider.id} account="${connection.name || connection.id}" transient 404 upstream, mengulang ke akun yang sama`
        );
        // Hold this account back so the next round runs the same request
        // against it again.
        retryConnection = connection;
        attempt--;
        continue;
      }
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
      // A transport failure means the path to upstream dropped, not that the
      // account is unusable. Parking the account for a network blip would push
      // every request onto the other connections for a minute.
      if (connection.id && !isTransportFailure(res, errText)) {
        if (parkAfterRepeatedFailures(connection, `model:${modelId}`, attemptId)) {
          applyRateLimitCooldown(connection, provider, res, errText, modelId, 60000 * attempt);
        }
      }
      await applyReactiveJitter(signal);
      continue;
    }

    // Auth failure: refresh once on this account, then decide
    if ((res.status === 401 || res.status === 403) && canRefresh(connection)) {
      try {
        const refreshed = await refreshOAuthToken(connection, { force: true });
        if (!refreshed) {
          if (connection.id && parkAfterRepeatedFailures(connection, "account", attemptId)) {
            setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
          }
          if (attempt < maxAttempts) continue;
          return { ok: false, response: lastFailureResponse };
        }
        connection = refreshed;
        applyConnectionAuth(headers, connection);

        try {
          releaseSlot = await acquireAccountSlot(connection, signal, { purpose });
        } catch (err) {
          if (signal?.aborted) return { ok: false, response: lastFailureResponse };
          lastFailureResponse = accountBusyResponse(targetFormat, connection);
          continue;
        }

        try {
          res = await executor.execute({
            url,
            method: "POST",
            headers,
            body: bodyForConnection(connection),
            signal,
            proxyUrl: requireResolvedProxy(connection),
            connection,
            stream,
            targetModel,
            targetFormat,
            sessionKey,
            effort,
          });
          res = await probeStreamError(res, signal);
        } catch (err) {
          if (releaseSlot) releaseSlot();
          throw err;
        }

        if (res.ok) return { ok: true, upstreamRes: attachSlotRelease(res, releaseSlot), connection };
        if (releaseSlot) {
          releaseSlot();
          releaseSlot = null;
        }
        const retryErrText = await res.text();
        lastFailureResponse = buildErrorResponse(res, retryErrText, targetFormat);
        if (res.status === 429 || res.status >= 500) {
          if (signal?.aborted) return { ok: false, response: lastFailureResponse };
          if (connection.id && !isTransportFailure(res, retryErrText)) {
            if (parkAfterRepeatedFailures(connection, `model:${modelId}`, attemptId)) {
              applyRateLimitCooldown(connection, provider, res, retryErrText, modelId, 60000);
            }
          }
          await applyReactiveJitter(signal);
          continue;
        }
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          if (connection.id && parkAfterRepeatedFailures(connection, "account", attemptId)) {
            setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
          }
          if (attempt < maxAttempts) continue;
        }
        return { ok: false, response: lastFailureResponse };
      } catch (err) {
        if (releaseSlot) releaseSlot();
        if (signal?.aborted) return { ok: false, response: lastFailureResponse };
        console.error(`[zenith] Reactive refresh error for ${connection.id}:`, err.message);
        if (connection.id && parkAfterRepeatedFailures(connection, "account", attemptId)) {
          setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
        }
        if (attempt < maxAttempts) continue;
        return { ok: false, response: lastFailureResponse };
      }
    }

    // Account-level failures can be isolated to this credential; try the next one.
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      if (connection.id && parkAfterRepeatedFailures(connection, "account", attemptId)) {
        setConnectionCooldown(connection.id, Date.now() + 10 * 60000);
      }
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

  // Tell the client how long the cooldown lasts instead of a bare 503. Only the
  // locks that actually block this model count: the account-wide one and this
  // model's own lock. A per-model lock for a different model stays invisible.
  const now = Date.now();
  const cooldownEnds = [];
  for (const c of getConnections(provider.id)) {
    if (c.is_active !== 1) continue;
    if (Number(c.cooldown_until) > now) cooldownEnds.push(Number(c.cooldown_until));
    if (modelId) {
      const lock = getModelLockUntil(c.id, modelId);
      if (lock) cooldownEnds.push(lock);
    }
  }
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
