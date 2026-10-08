import { oauthFetch } from "../oauth/providers.js";
import { parseResetTime } from "./shared.js";

const ANTIGRAVITY_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_LEGACY_QUOTA_URL = "https://cloudaicompanion.googleapis.com/v1internal:fetchAvailableModels";

const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const CLIENT_VERSION = "2.1.1";

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
 * 9router / vscode-antigravity-cockpit): data.models[key].quotaInfo.remainingFraction.
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
    const total = 1000; // normalized base, same as 9router
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

async function postQuota(url, connection, projectId) {
  const headers = {
    Authorization: `Bearer ${connection.credentials?.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Client-Name": "antigravity",
    "X-Client-Version": CLIENT_VERSION,
    "User-Agent": "antigravity/ide/0.0.1 darwin/arm64",
  };
  const body = projectId ? JSON.stringify({ project: projectId }) : "{}";
  return oauthFetch(url, { method: "POST", headers, body }, { proxyUrl: connection.proxy_url });
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
          "User-Agent": "antigravity/ide/0.0.1 darwin/arm64",
        },
        body: JSON.stringify({ metadata: { ideType: 9, pluginType: 2 } }),
      },
      { proxyUrl: connection.proxy_url }
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
  const plan = await fetchPlanName(connection);
  const quotas = parseModelQuotas(models);
  const modelCount = Array.isArray(models) ? models.length : Object.keys(models).length;
  const isExhausted = Object.values(quotas).every((q) => q.remainingPercentage <= 0);

  return {
    provider: "antigravity",
    tier: defaultTier,
    plan,
    available_models_count: modelCount,
    project_id: projectId,
    is_exhausted: Object.keys(quotas).length > 0 && isExhausted,
    unit: "tier",
    quotas,
  };
}
