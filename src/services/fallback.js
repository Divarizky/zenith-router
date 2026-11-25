import {
  getConnectionById,
  getConnections,
  getModelLockUntil,
  getModelLockDetails,
  setConnectionCooldown,
  updateConnectionLastUsed,
  getAntigravityModelsByConnection,
  getAntigravityAccountModels,
  MODEL_LOCK_MAX_MS,
} from "../db/index.js";
import { getProvider, getProviderModels, resolveProviderRuntime } from "../providers/index.js";
import { adaptPayloadForProvider, MODEL_ACCESS_DENIED_403 } from "../providers/params.js";
import { disableModel } from "./modelOverrides.js";
import { isQuotaBlocking, isQuotaProbeDue, syncProviderQuota } from "./quota.js";
import { isAntigravityPoolExhausted } from "./antigravityPools.js";
import { buildAntigravityFamilies, normalizeEffort } from "./antigravityCatalog.js";
import { isConnectionInCooldown, applyConnectionAuth } from "./auth.js";
import { extractClaudeSessionId } from "./claudeIdentity.js";
import { applyClaudeOAuthCloaking, isClaudeOAuthToken } from "./claudeCloaking.js";
import { applyClaudePromptCache } from "./claudePromptCache.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "./tokenRefresh.js";
import { captureLine } from "./logger.js";
import { readErrorText } from "../utils/errorBody.js";
import { sessionPins, PIN_SCOPE_CLIENT } from "./sessionPin.js";
import { acquireAccountSlot, applyReactiveJitter, effectiveAccountSlotCap, getConnectionTraffic } from "./trafficGuard.js";
import {
  resolveConnectionProxy,
  requireResolvedProxy,
  getProxyRotationStrategy,
  planProxyRotationEntries,
  getOpencodeEgressPolicy,
  getOpencodeScopedPoolIds,
  getOpencodeHybridMode,
  getOpencodeHybridEgressConfig,
  planOpencodeHybridEntries,
  validateProxyAddress,
  notifyProxyRotate,
  beginProxyStream,
  signalProxy429,
  dispatchProxyFailureSignal,
  noteProxyPoolSuccess,
  extractWarpNode,
} from "./proxyPools.js";
import { probeStreamError } from "./streamProbe.js";
import {
  ACCOUNT_PARK_MS,
  clearStrikes,
  parkThresholdReached,
  setVirtualCooldown,
  isVirtualInCooldown,
  getVirtualCooldownUntil,
  VIRTUAL_COOLDOWN_DEFAULT_MS,
} from "./accountCooldown.js";

// Callers that run several attempts for one client request pass the same id, so
// internal retries never count as separate user attempts.
let fallbackRequestSeq = 0;
function nextFallbackRequestId() {
  fallbackRequestSeq += 1;
  return `fallback-${fallbackRequestSeq}`;
}

// Success clears both strikes: sporadic failures never accumulate into a park.
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
      // a grant marked dead needs a fresh login; routing it would only fail
      !c.credentials?.needs_login &&
      !isConnectionInCooldown(c, model) &&
      !isQuotaBlocking(c) &&
      // an account whose list proxy is inactive or gone is skipped
      // here and never falls back to a direct connection.
      !resolveConnectionProxy(c).blocked
  );
  // getConnections already returns the provider in priority order, so the first
  // account left after filtering is the highest-ranked one that can serve. A
  // spare is reached only while every account above it is unavailable.
  const available = candidates.filter((c) => servesModel(c, request, antigravityInventory));

  // One account whose cached quota says spent but carries no reset time is
  // probed once per window, highest priority first. Routing skips exhausted
  // accounts, so without this an account whose quota endpoint never recovers
  // stays parked forever: no request reaches it, so nothing refreshes the cache.
  const quotaProbe = connections.find(
    (c) =>
      c !== available[0] &&
      !available.includes(c) &&
      c.is_active === 1 &&
      isQuotaProbeDue(c) &&
      !isConnectionInCooldown(c, model) &&
      !resolveConnectionProxy(c).blocked &&
      servesModel(c, request, antigravityInventory)
  );
  // A probe only runs when nothing healthy can serve. Placing it ahead of a
  // healthy account would let a lower-priority, stale-cache account jump the queue.
  if (quotaProbe && available.length === 0) available.push(quotaProbe);

  if (antigravityInventory && normalizeEffort(effort)) {
    // Stable sort: exact max wins; otherwise keep the legacy xhigh preference.
    available.sort((a, b) => antigravityTierPriority(b, request, antigravityInventory) - antigravityTierPriority(a, request, antigravityInventory));
  }

  if (available.length === 0 && providerDef?.noAuth) {
    if (!isVirtualInCooldown(providerId, model)) {
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

function antigravityTierPriority(connection, { providerDef, model, effort }, inventory) {
  const wanted = normalizeEffort(effort);
  const rows = inventory?.get(connection.id);
  if (!wanted || wanted === "off" || !rows?.size) return 0;
  const family = buildAntigravityFamilies(
    Object.fromEntries([...rows].map(([id, row]) => [id, { displayName: row.display_name }]))
  ).get(model);
  if (!family) return 0;
  const runtime = resolveProviderRuntime(providerDef, model, effort, rows);
  if (!runtime) return 0;
  if (family.variants[wanted] === runtime.id ||
      (family.tiered === runtime.id && runtime.thinkingLevel === wanted)) return 2;
  return wanted === "max" && family.variants.xhigh === runtime.id ? 1 : 0;
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


/**
 * Menandai aliran sukses sebagai aktif pada proxy-nya selama body belum habis
 * atau dibatalkan, supaya rotasi node tidak memutusnya.
 */
function attachProxyStreamTracker(res, proxyEntry, onComplete = null) {
  if (!res?.body) return res;
  const release = beginProxyStream(proxyEntry);
  const tracker = new TransformStream({
    flush() {
      onComplete?.();
      release();
    },
    cancel() {
      release();
    },
  });
  return new Response(res.body.pipeThrough(tracker), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
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
 * model on it, so callers skip the cooldown. Upstreams report them as:
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
  return (
    (res.status === 400 || res.status === 422) &&
    (/reasoning_effort.*?(?:is\s+)?not\s+(?:currently\s+)?(enabled|supported)/i.test(errText) ||
      /(?:not\s+support|unsupported).*?reasoning_effort/i.test(errText))
  );
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

// Same-account retries for a 429 that means contention, not exhaustion.
const MAX_SOFT_RATE_LIMIT_RETRIES = 1;

/**
 * A 429 from a provider that serialises its turns means the account was pushed
 * while another turn was still running, not that its quota is spent. Locking the
 * model for a minute (and parking the whole account after two such failures)
 * would punish a healthy account for the router's own scheduling.
 */
function isSoftRateLimitResponse(provider, res) {
  return res.status === 429 && provider?.softRateLimit === true;
}

function parsedErrorPayload(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

/**
 * Nous fair-share throttles are authoritative model/account cooldowns, not
 * short-lived serialized-turn contention. Retrying the same account after the
 * local 2.5s throttle only repeats a several-minute upstream refusal.
 */
function isNousFairShareRateLimit(provider, res, bodyText) {
  if (provider?.id !== "nous" || res?.status !== 429) return false;
  const payload = parsedErrorPayload(bodyText);
  const error = payload?.error && typeof payload.error === "object" ? payload.error : payload || {};
  return error.reason === "rate_limited" || /fair.?share\s+rate\s+limit/i.test(String(error.message || ""));
}

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
const MIDSTREAM_ROTATE_RE = /FreeTierError|FreeUsageLimitError|"type"\s*:\s*"error"/i;

function attachMidstreamRotateObserver(res, proxyEntry, modelId = "", onFailure = null) {
  if (!res?.body || (!proxyEntry?.rotate_url && !extractWarpNode(proxyEntry))) return res;
  const decoder = new TextDecoder();
  let triggered = false;
  const observer = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!triggered) {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        if (MIDSTREAM_ROTATE_RE.test(text)) {
          triggered = true;
          onFailure?.();
          dispatchProxyFailureSignal(proxyEntry, {
            model: modelId,
            status: 429,
            reason: "midstream_error",
          });
        }
      }
    },
  });
  return new Response(res.body.pipeThrough(observer), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function applyRateLimitCooldown(connection, provider, res, errText, modelId, defaultMs, { skipVirtualCooldown = false } = {}) {
  const hint = extractRetryHint(res, errText);
  const waitMs = hint ? hint.ms : defaultMs;
  const until = Date.now() + waitMs;
  // Only a 429 can be a quota window (daily, weekly, free budget). An authoritative reset
  // longer than the transient cap keeps its full duration up to 30 days. Any other status,
  // including 5xx with a large Retry-After, is transient and stays within the one-hour cap.
  const isQuotaStatus = res.status === 429;
  const lockClass = isQuotaStatus && hint?.authoritative && waitMs > MODEL_LOCK_MAX_MS ? "quota" : "transient";
  // Only a 429 reset may shorten a model lock (opt-in flag, see setConnectionCooldown).
  const authoritative = isQuotaStatus && Boolean(hint?.authoritative);
  // A non-429 failure (5xx, transport) is transient: its deadline never exceeds the one-hour cap,
  // even on the account-wide path where no model id is available to pick the lock class.
  const transientUntil = !isQuotaStatus ? Math.min(until, Date.now() + MODEL_LOCK_MAX_MS) : until;
  if (!connection?.id) {
    if (skipVirtualCooldown) return;
    // Virtual / anonymous connection: apply virtual cooldown at model/provider level (5-15 min, default extracted)
    const virtualMs = Math.max(5 * 60 * 1000, Math.min(15 * 60 * 1000, until - Date.now() || VIRTUAL_COOLDOWN_DEFAULT_MS));
    setVirtualCooldown(provider.id, modelId, Date.now() + virtualMs);
    return;
  }
  if (res.status === 429 && res.headers?.get?.("x-ratelimit-scope") === "free") {
    for (const id of freeTierModelIds(provider, modelId)) {
      setConnectionCooldown(connection.id, until, id, {
        lockClass: "quota",
        authoritative,
        reason: provider?.id === "nous" && isNousFairShareRateLimit(provider, res, errText) ? "fair_share" : null,
      });
    }
    syncProviderQuota(connection, { quiet: true }).catch(() => {});
    return;
  }
  setConnectionCooldown(connection.id, transientUntil, modelId, {
    lockClass,
    authoritative,
    reason: provider?.id === "nous" && isNousFairShareRateLimit(provider, res, errText) ? "fair_share" : null,
  });
}

export function recordStreamRateLimitCooldown(connection, provider, modelId, event) {
  if (!connection?.id || provider?.id !== "nous" || !event || typeof event !== "object") return false;
  const bodyText = JSON.stringify(event);
  const status = event.status === 429 || event.reason === "rate_limited" || event.error?.reason === "rate_limited" ? 429 : 502;
  const res = new Response(bodyText, { status });
  if (!isNousFairShareRateLimit(provider, res, bodyText)) return false;
  applyRateLimitCooldown(connection, provider, res, bodyText, modelId, 60000);
  return true;
}

// The executor's 502 for a failed upstream fetch, see src/executors/base.js.
const TRANSPORT_FAILURE_RE = /"type":"transport_error"/;

export function isTransportFailure(res, bodyText) {
  return res.status === 502 && TRANSPORT_FAILURE_RE.test(bodyText || "");
}

/**
 * Retry-After (RFC 9110 §10.2.3): berupa detik (delta-seconds) atau tanggal HTTP (IMF-fixdate).
 * Mengembalikan milidetik > 0, atau null bila nilai kosong, invalid, atau tanggal sudah lampau.
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  const sec = Number(raw);
  if (Number.isFinite(sec)) return sec > 0 ? sec * 1000 : null;

  // IMF-fixdate wajib berakhir "GMT"; Date.parse menolak string tanpa pola ini.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) return null;
  const targetMs = Date.parse(raw);
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  return diffMs > 0 ? diffMs : null;
}

function secondsToMs(value) {
  const sec = typeof value === "string" ? parseFloat(value) : Number(value);
  return Number.isFinite(sec) && sec > 0 ? Math.ceil(sec * 1000) : null;
}

// reset_at may be epoch seconds, epoch milliseconds, or an ISO-8601 timestamp.
// Epoch seconds are below 1e11 until the year 5138, so smaller values are seconds.
function resetAtToMs(value, nowMs) {
  let target = null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    target = n < 1e11 ? n * 1000 : n;
  } else if (typeof value === "string") {
    target = Date.parse(value);
  }
  if (!Number.isFinite(target)) return null;
  const diff = target - nowMs;
  return diff > 0 ? diff : null;
}

/**
 * Reads the reset hint from an upstream rate-limit response. Order: Retry-After header,
 * then a structured reset_at (epoch or ISO), then retry_after (seconds) in the body, then
 * Google RetryInfo / ErrorInfo details. The first hint found wins.
 *
 * `authoritative` is true only when the upstream named an absolute reset (reset_at or a
 * Google quota reset timestamp) or sent a Retry-After. A bare default is not authoritative,
 * so it can never shorten an existing lock.
 */
export function extractRetryHint(res, bodyText, nowMs = Date.now()) {
  const retryAfter = parseRetryAfterMs(res?.headers?.get?.("retry-after"), nowMs);
  if (retryAfter !== null) return { ms: retryAfter, authoritative: true, source: "retry-after" };

  if (!bodyText || typeof bodyText !== "string") return null;

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const errorObj = payload?.error && typeof payload.error === "object" ? payload.error : payload;

  const structuredReset = resetAtToMs(payload?.reset_at ?? errorObj?.reset_at, nowMs);
  if (structuredReset !== null) return { ms: structuredReset, authoritative: true, source: "reset_at" };

  const directRetryAfter = secondsToMs(payload?.retry_after ?? errorObj?.retry_after);
  if (directRetryAfter !== null) return { ms: directRetryAfter, authoritative: true, source: "retry_after" };

  const details = Array.isArray(errorObj?.details) ? errorObj.details : [];
  for (const item of details) {
    // 1. Google RetryInfo: retryDelay format "123.456s" or numeric
    const retryDelay = secondsToMs(item?.retryDelay);
    if (retryDelay !== null) return { ms: retryDelay, authoritative: true, source: "google-retry-info" };

    // 2. Google ErrorInfo metadata
    const meta = item?.metadata;
    if (meta && typeof meta === "object") {
      if (meta.quotaResetTimeStamp) {
        const diffMs = resetAtToMs(String(meta.quotaResetTimeStamp), nowMs);
        if (diffMs !== null) return { ms: diffMs, authoritative: true, source: "google-quota-reset" };
      }
      const resetDelay = secondsToMs(meta.quotaResetDelay);
      if (resetDelay !== null) return { ms: resetDelay, authoritative: true, source: "google-quota-delay" };
    }
  }
  return null;
}

/**
 * Numeric duration helper kept for existing callers: returns the hinted wait in ms, or the
 * default when upstream stated nothing usable. Behaviour matches the pre-#4 contract.
 */
export function extractQuotaCooldownMs(res, bodyText, defaultDurationMs = 60000, nowMs = Date.now()) {
  const hint = extractRetryHint(res, bodyText, nowMs);
  return hint ? hint.ms : defaultDurationMs;
}

export function buildErrorResponse(res, bodyText, targetFormat, { provider = null, model = "" } = {}) {
  if (isNousFairShareRateLimit(provider, res, bodyText)) {
    const hint = extractRetryHint(res, bodyText);
    const retryAfter = hint ? Math.max(1, Math.ceil(hint.ms / 1000)) : null;
    const message = retryAfter
      ? `Nous membatasi model '${model || "ini"}'. Coba lagi dalam ${retryAfter} detik.`
      : `Nous membatasi model '${model || "ini"}'. Coba lagi nanti.`;
    const headers = {
      "Content-Type": "application/json",
      "X-Zenith-Error": "fair_share_rate_limited",
    };
    if (retryAfter) headers["Retry-After"] = String(retryAfter);
    return new Response(
      JSON.stringify(buildErrorPayload(targetFormat, "rate_limit_error", message, "fair_share_rate_limited")),
      { status: 429, headers }
    );
  }

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
  for (const name of [
    "retry-after",
    "x-opencode-gate",
    "x-opencode-log-id",
    "x-zenith-auth-expired",
    "x-zenith-error",
  ]) {
    const value = res.headers?.get?.(name);
    if (value) headers[name] = value;
  }
  if (!headers["retry-after"] && (res.status === 429 || res.status === 503)) {
    const bodyRetryAfter = payload?.retry_after ?? payload?.error?.retry_after;
    if (bodyRetryAfter !== undefined && bodyRetryAfter !== null) {
      const sec = typeof bodyRetryAfter === "string" ? parseFloat(bodyRetryAfter) : Number(bodyRetryAfter);
      if (Number.isFinite(sec) && sec > 0) {
        headers["retry-after"] = String(Math.ceil(sec));
      }
    }
  }
  return new Response(JSON.stringify(payload), { status: res.status, headers });
}

/**
 * The account a client session is pinned to, when that account is still in the
 * eligible list and has not been tried in this request. Eligibility (cooldown,
 * model lock, quota, serving the model) was already decided by listAvailableConnections,
 * so a pin never bypasses a parked account.
 */
function isAccountFull(connection) {
  return getConnectionTraffic(connection.id).inFlight >= effectiveAccountSlotCap(connection);
}

/**
 * When the session's pinned account is full, a sibling that still has a free slot is
 * preferred over the ordinary order, which would queue behind the full account first.
 * Returns null when every eligible sibling is full too; the caller then keeps the
 * ordinary order and the existing queue/timeout behaviour applies.
 */
function pickIdleSibling(available, triedIds, pin) {
  if (!pin) return null;
  return available.find((c) => c.id && !triedIds.includes(c.id) && !isAccountFull(c)) || null;
}

function pinnedAccountIsFull(available, pin) {
  const pinnedId = sessionPins.get(pin.providerId, pin.sessionKey, pin.model, pin.scope);
  const match = available.find((c) => c.id === pinnedId);
  return Boolean(match) && isAccountFull(match);
}

function pickPinnedConnection(available, triedIds, pin) {
  if (!pin) return null;
  const pinnedId = sessionPins.get(pin.providerId, pin.sessionKey, pin.model, pin.scope);
  if (pinnedId === null || pinnedId === undefined) return null;
  // A deleted account is not in `available`, so its stale pin falls through here and
  // expires with the TTL. The db layer cannot import services, so no delete hook is needed.
  const match = available.find((c) => c.id === pinnedId);
  // Lazy invalidation: a pin that points at a deleted account is dropped on first use.
  // A cooled-down account still exists and keeps its pin until the TTL.
  if (!match && pinnedId !== null && getConnectionById(pinnedId) === null) {
    sessionPins.drop(pin.providerId, pin.sessionKey, pin.scope);
    return null;
  }
  if (!match || triedIds.includes(match.id)) return null;
  // A full account (max_concurrent slots taken) is skipped: the session moves to a sibling
  // instead of queueing behind another conversation. The slot itself is still taken later.
  if (isAccountFull(match)) return null;
  updateConnectionLastUsed(match.id);
  return match;
}

// Plafon kiriman nyata ke upstream per request (akun + retry transport).
export const MAX_REQUEST_DISPATCHES = 3;
export const REQUEST_DEADLINE_MS = 300000;

/** Penghitung kiriman bersama; `spend` mencatat, `remaining` menyisakan kuota. */
export function createDispatchBudget(limit, deadlineAt = Date.now() + REQUEST_DEADLINE_MS) {
  let used = 0;
  return {
    limit,
    deadlineAt,
    spend() { used++; return used; },
    remaining() { return Math.max(0, limit - used); },
    remainingTimeMs(now = Date.now()) { return Math.max(0, deadlineAt - now); },
    get used() { return used; },
  };
}

function dispatchDeadlineResponse() {
  return new Response(JSON.stringify({ error: {
    message: "Upstream request deadline exceeded before another dispatch",
    type: "timeout_error",
    code: "gateway_timeout",
  } }), { status: 504, headers: { "Content-Type": "application/json" } });
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
  sessionSource = null,
  sessionApiKeyId = null,
  sessionPromptCacheKey = false,
  effort = undefined,
  adaptiveThinking = false,
  requestId = null,
  noFailover = false,
  requireProxyChain = false,
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
  // Breakpoints go on before serialization so the cloaking header lands in front of them.
  if (provider.id === "claude") payload = applyClaudePromptCache(payload);
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
  // Pin only a real client session. A gateway API key is shared by a team, so pinning
  // it would stick unrelated clients to one account (issue #5 acceptance criteria).
  // A failover-free probe never pins: it must measure the account it was asked about, not the session's.
  const pinnable = Boolean(sessionKey) && !noFailover && sessionSource !== "apikey" && !String(sessionKey).startsWith("apikey:");
  // Local namespace only: the gateway key id separates the pins of two keys that send the same
  // x-session-id. It is never sent upstream and never reaches the executor.
  const pinScope = sessionApiKeyId ? `${PIN_SCOPE_CLIENT}:${sessionApiKeyId}` : PIN_SCOPE_CLIENT;
  const pin = pinnable ? { providerId: provider.id, sessionKey, model: modelId, scope: pinScope } : null;
  // provider tanpa akun atau provider noAuth dilayani koneksi virtual / rotasi pool.
  // Saat strategi rotasi aktif dan ada proxy aktif, satu request mencoba sampai
  // tiga proxy berbeda; proxy yang gagal dilewati ke berikutnya dalam request
  // yang sama. Tanpa proxy aktif, koneksi virtual tetap memakai koneksi
  // langsung seperti sebelumnya.
  const hasRotation = getProxyRotationStrategy(provider.id) !== "off";
  const virtualOnly = available.length === 1 && available[0].id === null;
  const shouldUseRotation = (virtualOnly || Boolean(provider.noAuth)) && hasRotation;
  const egressPolicy = provider.id === "opencode" ? getOpencodeEgressPolicy() : "legacy";
  const hybridMode = provider.id === "opencode" ? getOpencodeHybridMode() : "off";
  const hybridConfig = provider.id === "opencode" && hybridMode !== "off" ? getOpencodeHybridEgressConfig() : null;
  if (hybridConfig?.mode === "enforce" && !hybridConfig.valid) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: {
        code: "proxy_required",
        type: "configuration_error",
        message: "OpenCode hybrid egress configuration is invalid.",
        details: hybridConfig.errors,
      } }), { status: 503, headers: { "content-type": "application/json" } }),
    };
  }
  const hybridEnforce = hybridConfig?.mode === "enforce" && hybridConfig.valid;
  const requireProxy = requireProxyChain || egressPolicy === "require" || hybridEnforce;
  const scopedPolicy = provider.id === "opencode" && (requireProxy || egressPolicy === "prefer");
  const rotationStrategy = getProxyRotationStrategy(provider.id);
  const rotationEntries = hybridEnforce
    ? planOpencodeHybridEntries(rotationStrategy === "random" ? "random" : "round_robin")
    : scopedPolicy
      ? planProxyRotationEntries(provider.id, rotationStrategy === "random" ? "random" : "round_robin", getOpencodeScopedPoolIds())
      : egressPolicy !== "direct" && shouldUseRotation ? planProxyRotationEntries(provider.id, rotationStrategy) : [];
  if (egressPolicy === "prefer" && rotationEntries.length === 0) captureLine("[EGRESS] provider=opencode policy=prefer fallback=direct");
  if (scopedPolicy && requireProxy && rotationEntries.length === 0) {
    return { ok: false, response: new Response(JSON.stringify({ error: { code: "proxy_required", message: "OpenCode requires an active scoped proxy." } }), { status: 503, headers: { "content-type": "application/json" } }) };
  }
  const rotationProxies = rotationEntries.map((e) => e.url);
  const maxAttempts =
    rotationEntries.length > 0 ? rotationEntries.length : Math.max(1, available.length);
  let lastFailureResponse = null;
  let hybridProtonBlocked = false;
  // A transient upstream 404 is retried on the same account this many times
  // before it is reported to the client.
  let transientNotFoundRetries = 0;
  // Same-account retries spent on a soft 429.
  let softRateLimitRetries = 0;
  // The account a same-account retry goes back to.
  let retryConnection = null;
  // Anggaran dispatch bersama: setiap kiriman nyata ke upstream (akun, retry
  // transport di executor) menghitung ke sini. Mencegah ledakan 2 x akun.
  const dispatchBudget = createDispatchBudget(MAX_REQUEST_DISPATCHES);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (dispatchBudget.remaining() <= 0 || dispatchBudget.remainingTimeMs() <= 0) {
      lastFailureResponse = dispatchDeadlineResponse();
      captureLine(`[DISPATCH] request_id=${attemptId} provider=${provider.id} budget_or_deadline=exhausted; berhenti`);
      break;
    }
    let connection;
    // An account held back for a same-account retry, so the retry does not
    // depend on the order accounts are picked in.
    if (retryConnection) {
      connection = retryConnection;
      retryConnection = null;
    } else if (rotationProxies.length > 0) {
      // Koneksi virtual dipakai ulang; yang berganti per percobaan hanya proxy.
      connection = available[0] || { id: null, provider: provider.id, auth_type: "none", is_active: 1 };
    } else {
      // Do not let session affinity override an untried, eligible exact-tier account.
      const inventory = provider.id === "antigravity" && modelId && normalizeEffort(effort)
        ? getAntigravityModelsByConnection() : null;
      const request = { providerDef: provider, model: modelId, effort };
      const tiers = inventory ? available.filter((c) => !triedIds.includes(c.id))
        .map((c) => [c, antigravityTierPriority(c, request, inventory)]) : [];
      const bestTier = Math.max(0, ...tiers.map(([, rank]) => rank));
      const pinCandidates = bestTier ? tiers.filter(([, rank]) => rank === bestTier).map(([c]) => c) : available;
      const pinned = pickPinnedConnection(pinCandidates, triedIds, pin);
      // A pin that points at an eligible but full account hands the turn to an idle sibling.
      const pinnedFull = !pinned && pin ? pinnedAccountIsFull(pinCandidates, pin) : false;
      connection = pinned || (pinnedFull ? pickIdleSibling(pinCandidates, triedIds, pin) : null) || getNextConnection(provider.id, triedIds, modelId, effort);
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

    const headers = { ...baseHeaders };
    // The upstream checks the session id against metadata.user_id, so both
    // have to come from the same request body.
    const claudeSessionId =
      provider.id === "claude" ? extractClaudeSessionId(payload?.metadata?.user_id) : null;
    applyConnectionAuth(headers, connection, { claudeSessionId, adaptiveThinking });
    const url = resolveUrl(connection);
    const proxyEntry = rotationEntries.length > 0 ? rotationEntries[attempt - 1] ?? null : null;
    if (hybridProtonBlocked && proxyEntry?.adapter === "proton") break;
    const proxyUrl = proxyEntry ? proxyEntry.url : egressPolicy === "direct" || scopedPolicy ? null : requireResolvedProxy(connection);
    if (requireProxy && (!proxyUrl || validateProxyAddress(proxyUrl))) {
      return { ok: false, response: new Response(JSON.stringify({ error: { code: "proxy_required", message: "This fallback requires a valid proxy." } }), { status: 503, headers: { "content-type": "application/json" } }) };
    }

    let releaseSlot = null;
    try {
      releaseSlot = await acquireAccountSlot(connection, signal, { purpose });
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      lastFailureResponse = accountBusyResponse(targetFormat, connection);
      captureLine(`[TRAFFIC] request_id=${attemptId} provider=${provider.id} account="${connection.name || connection.id}" ${err.message}`);
      continue;
    }

    let res;
    const requestStartedAt = Date.now();
    try {
      dispatchBudget.spend();
      res = await executor.execute({
        url,
        method: "POST",
        headers,
        body: bodyForConnection(connection),
        signal,
        dispatchBudget,
        dispatchAlreadyCounted: true,
        timeoutMs: Math.max(1, Math.min(REQUEST_DEADLINE_MS, dispatchBudget.remainingTimeMs())),
        proxyUrl,
        proxyMeta: proxyEntry,
        requireProxy,
        connection,
        stream,
        targetModel,
        targetFormat,
        sessionKey,
        sessionSource,
        sessionPromptCacheKey,
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
      clearStrikes(connection, modelId);
      if (pinnable && connection?.id) sessionPins.set(provider.id, sessionKey, connection.id, modelId, pinScope);
      let midstreamFailed = false;
      const observedRes =
        stream && provider.id === "opencode" && (proxyEntry?.rotate_url || extractWarpNode(proxyEntry))
          ? attachMidstreamRotateObserver(res, proxyEntry, modelId || targetModel, () => {
              midstreamFailed = true;
            })
          : res;
      const markVerifiedProxySuccess = () => {
        if (!midstreamFailed) noteProxyPoolSuccess(proxyEntry, requestStartedAt);
      };
      const trackedRes =
        stream && (proxyEntry?.rotate_url || extractWarpNode(proxyEntry))
          ? attachProxyStreamTracker(observedRes, proxyEntry, markVerifiedProxySuccess)
          : observedRes;
      if (!stream || !trackedRes.body) markVerifiedProxySuccess();
      return { ok: true, upstreamRes: attachSlotRelease(trackedRes, releaseSlot), connection };
    }

    // Attempt failed: release slot before processing failover or next attempt
    if (releaseSlot) {
      releaseSlot();
      releaseSlot = null;
    }

    // Capture response for error relaying
    const errText = await readErrorText(res);
    lastFailureResponse = buildErrorResponse(res, errText, targetFormat, { provider, model: targetModel });

    // The client hung up mid-attempt: nothing is waiting for this answer, so it is
    // neither a failover nor a reason to park an account.
    if (signal?.aborted) return { ok: false, response: lastFailureResponse };

    captureLine(
      `[FAILOVER] request_id=${attemptId} phase=${stream ? "before_first_token" : "request"} provider=${provider.id} account="${connection.name || connection.id}" model=${modelId} HTTP ${res.status} error=${errText.slice(0, 140).replace(/\s+/g, " ")}`
    );

    // In hybrid mode Proton is a transport backup, not a way around an
    // upstream quota/rejection. Other WARP lanes may still be tried, but the
    // Proton slot is cut after a non-transport WARP response.
    if (hybridEnforce && proxyEntry?.adapter === "warp" && !isTransportFailure(res, errText)) {
      hybridProtonBlocked = true;
    }

    // Probing murni (x-zenith-no-failover): satu upstream call, tanpa rotasi akun
    // dan tanpa mem-park akun. Respons gagal diteruskan apa adanya.
    if (noFailover) return { ok: false, response: lastFailureResponse };

    // Model has no reasoning mode: drop reasoning_effort and retry the same account once.
    if (isReasoningRejected(res, errText) && !reasoningRetried && payload && "reasoning_effort" in payload) {
      reasoningRetried = true;
      reasoningUnsupported.add(reasoningKey);
      payload = withoutReasoning(payload);
      bodyText = JSON.stringify(payload);
      captureLine(`[PARAMS] request_id=${attemptId} provider=${provider.id} model=${modelId} rejects reasoning_effort; retrying without it`);
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
          `[FAILOVER] request_id=${attemptId} provider=${provider.id} account="${connection.name || connection.id}" transient 404 upstream, pindah ke akun lain`
        );
        continue;
      }
      if (transientNotFoundRetries < MAX_TRANSIENT_NOT_FOUND_RETRIES) {
        transientNotFoundRetries++;
        captureLine(
          `[RETRY] request_id=${attemptId} provider=${provider.id} account="${connection.name || connection.id}" transient 404 upstream, mengulang ke akun yang sama`
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
      // Nous fair-share is an authoritative account x model cooldown. Do not
      // retry the same account after the local throttle gap; let the next
      // eligible account or configured fallback take the request instead.
      if (isNousFairShareRateLimit(provider, res, errText)) {
        applyRateLimitCooldown(connection, provider, res, errText, modelId, 60000);
        const hint = extractRetryHint(res, errText);
        captureLine(
          `[RATE_LIMIT] request_id=${attemptId} provider=${provider.id} model=${modelId} account="${connection.name || connection.id}" fair-share cooldown=${hint ? Math.ceil(hint.ms / 1000) : "default"}s; same account not retried`
        );
        continue;
      }

      // Contention on another serialised provider: the slot was released above,
      // so re-acquiring it applies the throttle gap and the turn is retried on
      // the same account. No lock, no park, no strike.
      if (connection.id && isSoftRateLimitResponse(provider, res)) {
        if (softRateLimitRetries < MAX_SOFT_RATE_LIMIT_RETRIES) {
          softRateLimitRetries++;
          captureLine(
            `[RETRY] request_id=${attemptId} provider=${provider.id} account="${connection.name || connection.id}" soft 429 upstream, mengulang ke akun yang sama setelah jeda throttle`
          );
          retryConnection = connection;
          attempt--;
        }
        // Either the retry round above or the next account; never a lock.
        continue;
      }

      // A transport failure means the path to upstream dropped, not that the
      // account is unusable. Parking the account for a network blip would push
      // every request onto the other connections for a minute.
      dispatchProxyFailureSignal(proxyEntry, {
        model: modelId || targetModel,
        status: res.status,
        reason: errText,
        retryAfterMs: parseRetryAfterMs(res.headers?.get?.("retry-after")),
      });
      if (!isTransportFailure(res, errText)) {
        const skipVirtual = !connection?.id && rotationEntries.length > 0 && attempt < maxAttempts;
        if (!skipVirtual && parkThresholdReached(connection, { modelId, requestId: attemptId })) {
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
          if (connection.id && parkThresholdReached(connection, { requestId: attemptId })) {
            setConnectionCooldown(connection.id, Date.now() + ACCOUNT_PARK_MS);
          }
          if (attempt < maxAttempts) continue;
          return { ok: false, response: lastFailureResponse };
        }
        connection = refreshed;
        applyConnectionAuth(headers, connection, { adaptiveThinking });
        const retryProxyUrl = proxyEntry
          ? proxyEntry.url
          : egressPolicy === "direct" || scopedPolicy
            ? null
            : requireResolvedProxy(connection);

        try {
          releaseSlot = await acquireAccountSlot(connection, signal, { purpose });
        } catch (err) {
          if (signal?.aborted) return { ok: false, response: lastFailureResponse };
          lastFailureResponse = accountBusyResponse(targetFormat, connection);
          continue;
        }

        if (dispatchBudget.remaining() <= 0 || dispatchBudget.remainingTimeMs() <= 0) {
          if (releaseSlot) releaseSlot();
          releaseSlot = null;
          return { ok: false, response: lastFailureResponse || dispatchDeadlineResponse() };
        }
        try {
          dispatchBudget.spend();
          res = await executor.execute({
            url,
            method: "POST",
            headers,
            body: bodyForConnection(connection),
            signal,
            dispatchBudget,
            dispatchAlreadyCounted: true,
            timeoutMs: Math.max(1, Math.min(REQUEST_DEADLINE_MS, dispatchBudget.remainingTimeMs())),
            proxyUrl: retryProxyUrl,
            proxyMeta: proxyEntry,
            requireProxy,
            connection,
            stream,
            targetModel,
            targetFormat,
            sessionKey,
            sessionSource,
            sessionPromptCacheKey,
            effort,
          });
          res = await probeStreamError(res, signal);
        } catch (err) {
          if (releaseSlot) releaseSlot();
          throw err;
        }

        if (res.ok) {
          // Same pin rule as the main path: the session follows the account that served it,
          // including an account that only answered after an OAuth refresh.
          if (pinnable && connection?.id) sessionPins.set(provider.id, sessionKey, connection.id, modelId, pinScope);
          return { ok: true, upstreamRes: attachSlotRelease(res, releaseSlot), connection };
        }
        if (releaseSlot) {
          releaseSlot();
          releaseSlot = null;
        }
        const retryErrText = await readErrorText(res);
        lastFailureResponse = buildErrorResponse(res, retryErrText, targetFormat, { provider, model: targetModel });
        if (res.status === 429 || res.status >= 500) {
          if (signal?.aborted) return { ok: false, response: lastFailureResponse };
          if (isNousFairShareRateLimit(provider, res, retryErrText)) {
            applyRateLimitCooldown(connection, provider, res, retryErrText, modelId, 60000);
          } else if (!isSoftRateLimitResponse(provider, res) && !isTransportFailure(res, retryErrText)) {
            // Same rule as the main branch: a soft 429 is contention, so it never
            // locks the account and never counts as a park strike.
            if (parkThresholdReached(connection, { modelId, requestId: attemptId })) {
              applyRateLimitCooldown(connection, provider, res, retryErrText, modelId, 60000);
            }
          }
          await applyReactiveJitter(signal);
          continue;
        }
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          if (connection.id && parkThresholdReached(connection, { requestId: attemptId })) {
            setConnectionCooldown(connection.id, Date.now() + ACCOUNT_PARK_MS);
          }
          if (attempt < maxAttempts) continue;
        }
        return { ok: false, response: lastFailureResponse };
      } catch (err) {
        if (releaseSlot) releaseSlot();
        if (signal?.aborted) return { ok: false, response: lastFailureResponse };
        console.error(`[zenith] Reactive refresh error for ${connection.id}:`, err.message);
        if (connection.id && parkThresholdReached(connection, { requestId: attemptId })) {
          setConnectionCooldown(connection.id, Date.now() + ACCOUNT_PARK_MS);
        }
        if (attempt < maxAttempts) continue;
        return { ok: false, response: lastFailureResponse };
      }
    }

    // Account-level failures can be isolated to this credential; try the next one.
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      if (res.status === 403 && proxyEntry?.rotate_url) {
        notifyProxyRotate(proxyEntry, { status: res.status, reason: errText.slice(0, 120) }).catch(() => {});
      }
      if (connection.id && parkThresholdReached(connection, { requestId: attemptId })) {
        setConnectionCooldown(connection.id, Date.now() + ACCOUNT_PARK_MS);
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
    captureLine(`[ROUTING] request_id=${attemptId} Disabled ${provider.id}/${modelId}: not available on any account tier`);
  }

  if (lastFailureResponse) {
    return { ok: false, response: lastFailureResponse };
  }

  captureLine(`[ROUTING] request_id=${attemptId} No available connection for provider '${provider.id}'`);

  // Tell the client how long the cooldown lasts instead of a bare 503. Only the
  // locks that actually block this model count: the account-wide one and this
  // model's own lock. A per-model lock for a different model stays invisible.
  const now = Date.now();
  const connections = getConnections(provider.id);
  const eligibleForFairShare = provider.id === "nous"
    ? connections.filter(
        (c) =>
          c.is_active === 1 &&
          !c.credentials?.needs_login &&
          !(Number(c.cooldown_until) > now) &&
          !isQuotaBlocking(c) &&
          !resolveConnectionProxy(c).blocked
      )
    : [];
  const fairShareLocks = eligibleForFairShare
    .map((c) => ({ connection: c, lock: modelId ? getModelLockDetails(c.id, modelId) : null }))
    .filter(({ lock }) => lock?.reason === "fair_share");
  const fairShareOnly =
    provider.id === "nous" &&
    Boolean(modelId) &&
    eligibleForFairShare.length > 0 &&
    fairShareLocks.length === eligibleForFairShare.length;
  const cooldownEnds = [];
  for (const c of connections) {
    if (c.is_active !== 1) continue;
    if (Number(c.cooldown_until) > now) cooldownEnds.push(Number(c.cooldown_until));
    if (modelId) {
      const lock = getModelLockUntil(c.id, modelId);
      if (lock) cooldownEnds.push(lock);
    }
  }
  const virtualUntil = getVirtualCooldownUntil(provider.id, modelId) || getVirtualCooldownUntil(provider.id, null);
  if (virtualUntil && virtualUntil > now) cooldownEnds.push(virtualUntil);
  const retryAfterSec = cooldownEnds.length ? Math.ceil((Math.min(...cooldownEnds) - now) / 1000) : 0;
  if (fairShareOnly) {
    const retryAt = Math.min(...fairShareLocks.map(({ lock }) => lock.until));
    const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1000));
    const message = `Nous membatasi model '${modelId}'. Coba lagi dalam ${retryAfterSec} detik.`;
    return {
      ok: false,
      response: new Response(
        JSON.stringify(buildErrorPayload(targetFormat, "rate_limit_error", message, "fair_share_rate_limited")),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfterSec),
            "X-Zenith-Error": "fair_share_rate_limited",
          },
        }
      ),
    };
  }

  let message = `No available connection for provider '${provider.id}'.`;
  const needLogin = connections.filter((c) => c.is_active === 1 && c.credentials?.needs_login).length;
  if (needLogin) {
    message += ` ${needLogin} account${needLogin === 1 ? "" : "s"} need a new login in the dashboard.`;
  }
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
