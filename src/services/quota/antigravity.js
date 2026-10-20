import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";
import { parseResetTime } from "./shared.js";
import { antigravityUserAgent } from "../antigravityIdentity.js";

// agy 1.4.0 queries the daily host with the consumer project + CLI User-Agent:
// cloudcode-pa + personal project never lists gemini-4-argon. Verified against a live Pro account.
const ANTIGRAVITY_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_LEGACY_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_CONSUMER_PROJECT = "aicode-consumers";

const LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
// 5h and weekly pool limits per model group. The daily host matches what agy reads;
// the legacy host returns different buckets.
const ANTIGRAVITY_QUOTA_SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const POOL_WINDOW_LABELS = new Map([
  ["5h", "5 jam"],
  ["weekly", "Mingguan"],
]);


// Models worth a bar. fetchAvailableModels also returns tab-completion helpers,
// legacy aliases (gemini-2.5-*) and flash-lite variants that all share one bucket.
function isImportantModel(key) {
  if (/^tab_/.test(key) || /lite/.test(key) || /^gemini-2./.test(key)) return false;
  return /^gemini-/.test(key) || /^claude-/.test(key) || /^gpt-oss-/.test(key);
}

function prettifyKey(key) {
  return key
    .replace(/-tiered$/, "")
    .split("-")
    .map((w) => (/^d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Parse per-model quota buckets from fetchAvailableModels (same shape used by
 * upstream reference and vscode-antigravity-cockpit): data.models[key].quotaInfo.remainingFraction.
 */
function parseModelQuotas(models) {
  const quotas = {};
  const entries = Array.isArray(models)
    ? models.map((m, i) => [m?.modelId || m?.id || String(i), m])
    : Object.entries(models || {});

  const keys = new Set(entries.map(([k]) => k));
  const seen = new Set();

  for (const [modelKey, info] of entries) {
    const quotaInfo = info?.quotaInfo;
    if (!quotaInfo || info?.isInternal || !isImportantModel(modelKey)) continue;
    // "-tiered" is the family bucket; skip when explicit high/medium/low entries exist.
    if (modelKey.endsWith("-tiered")) {
      const family = modelKey.replace(/-tiered$/, "");
      if ([...keys].some((k) => k !== modelKey && k.startsWith(family + "-"))) continue;
    }
    const label = info.displayName && info.displayName !== modelKey ? info.displayName : prettifyKey(modelKey);
    const dedupeKey = label + "|" + quotaInfo.remainingFraction + "|" + quotaInfo.resetTime;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const fraction = Number(quotaInfo.remainingFraction) || 0;
    const total = 1000; // normalized base, same as the upstream
    const remaining = Math.round(total * fraction);
    quotas[modelKey] = {
      used: total - remaining,
      total,
      remainingPercentage: fraction * 100,
      resetAt: parseResetTime(quotaInfo.resetTime),
      displayName: label,
    };
  }
  return quotas;
}

/**
 * Parses the pool limits from retrieveUserQuotaSummary. A group shares one 5h and one weekly limit
 * across its models. Disabled buckets are skipped, and an unknown window is dropped instead of being
 * forced into one of the two known windows.
 */
export function parseQuotaPools(summary) {
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  const pools = [];
  for (const group of groups) {
    const groupName = typeof group?.displayName === "string" && group.displayName ? group.displayName : null;
    if (!groupName || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const windowLabel = POOL_WINDOW_LABELS.get(bucket?.window);
      if (!windowLabel || bucket.disabled === true || typeof bucket.remainingFraction !== "number") continue;
      if (!Number.isFinite(bucket.remainingFraction)) continue;
      pools.push({
        group: groupName,
        window: bucket.window,
        label: `${groupName} · ${windowLabel}`,
        bucketId: typeof bucket.bucketId === "string" ? bucket.bucketId : null,
        remainingPercentage: Math.min(100, Math.max(0, bucket.remainingFraction * 100)),
        resetAt: parseResetTime(bucket.resetTime),
      });
    }
  }
  return pools;
}

async function fetchQuotaSummary(connection, projectId) {
  try {
    const res = await postQuota(ANTIGRAVITY_QUOTA_SUMMARY_URL, connection, projectId);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function postQuota(url, connection, projectId) {
  const headers = {
    Authorization: `Bearer ${connection.credentials?.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": antigravityUserAgent(),
  };
  const body = JSON.stringify({ project: projectId || ANTIGRAVITY_CONSUMER_PROJECT });
  return oauthFetch(url, { method: "POST", headers, body }, { proxyUrl: requireResolvedProxy(connection) });
}

/** Subscription tier name (e.g. "Google AI Pro") from loadCodeAssist; null on any failure. */
async function fetchPlanName(connection) {
  try {
    const res = await oauthFetch(
      LOAD_CODE_ASSIST_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.credentials?.access_token}`,
          "Content-Type": "application/json",
          "User-Agent": antigravityUserAgent(),
        },
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      },
      { proxyUrl: requireResolvedProxy(connection) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.paidTier?.name || data.currentTier?.name || null;
  } catch {
    return null;
  }
}

/**
 * Fetch live quota for Google Antigravity (Gemini Code Assist).
 * Reads per-model remainingFraction buckets so the dashboard can render bars.
 */
export async function fetchAntigravityQuota(connection) {
  const token = connection.credentials?.access_token;
  if (!token) return null;

  const projectId = connection.credentials?.project_id || "";
  let data = null;
  let authError = null;

  // Preferred endpoint (returns quotaInfo buckets); fall back to the legacy
  // cloudaicompanion host when it fails so tier info still shows up.
  for (const url of [ANTIGRAVITY_QUOTA_URL, ANTIGRAVITY_LEGACY_QUOTA_URL]) {
    try {
      const res = await postQuota(url, connection, projectId);
      if (res.ok) {
        data = await res.json();
        break;
      }
      if (res.status === 401 || res.status === 403) {
        authError = `Quota API menolak token (${res.status}). Chat tetap bisa jalan.`;
        break;
      }
    } catch {
      // try the next endpoint
    }
  }
  if (authError) return { provider: "antigravity", unit: "tier", is_exhausted: false, error: authError };
  if (!data) return null;

  const models = data.models || [];
  const defaultTier = data.allowedTiers?.find((t) => t.isDefault)?.id || "standard";
  const [plan, summary] = await Promise.all([fetchPlanName(connection), fetchQuotaSummary(connection, projectId)]);
  const pools = parseQuotaPools(summary);
  const quotas = parseModelQuotas(models);
  const modelCount = Array.isArray(models) ? models.length : Object.keys(models).length;
  const modelInventory = parseModelInventory(data);
  const isExhausted = Object.values(quotas).every((q) => q.remainingPercentage <= 0);

  return {
    provider: "antigravity",
    tier: defaultTier,
    plan,
    available_models_count: modelCount,
    project_id: projectId,
    is_exhausted: Object.keys(quotas).length > 0 && isExhausted,
    unit: "tier",
    pools,
    quotas,
    // Persisted into antigravity_account_models by the quota sync layer, then
    // stripped: the stored quota must not carry the whole catalog.
    modelInventory,
  };
}

/**
 * Every model the account can see, flagged by whether Antigravity's Recommended
 * agent list carries it. This is what makes the catalog subscription-aware:
 * a Pro account lists Claude 5.5 and gemini-4-argon, a free one does not.
 */
export function parseModelInventory(data) {
  const models = data?.models || {};
  const recommendedIds = new Set(
    (data?.agentModelSorts || []).flatMap((s) => (s.groups || []).flatMap((g) => g.modelIds || []))
  );
  // disabled entries are placeholders shown as "Unavailable" in agy (e.g.
  // gemini-4-argon-disabled on plans without Argon); they are never callable.
  return Object.entries(models).filter(([, info]) => info?.disabled !== true).map(([modelId, info]) => ({
    modelId,
    displayName: info?.displayName || null,
    recommended: recommendedIds.has(modelId),
    quotaRemaining: typeof info?.quotaInfo?.remainingFraction === "number" ? info.quotaInfo.remainingFraction : undefined,
    quotaResetAt: parseResetTime(info?.quotaInfo?.resetTime),
    maxTokens: info?.maxTokens,
    maxOutputTokens: info?.maxOutputTokens,
    supportsImages: info?.supportsImages,
    supportsThinking: info?.supportsThinking,
  }));
}
