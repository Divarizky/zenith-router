import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";
import { parseResetTime } from "./shared.js";

/** Used/total from one paid-plan quota snapshot. */
function fromSnapshot(quota) {
  if (!quota) return { used: 0, total: 0, unlimited: true };
  const entitlement = Number(quota.entitlement) || 0;
  const remaining = Number(quota.remaining) || 0;
  return { used: Math.max(0, entitlement - remaining), total: entitlement, unlimited: entitlement === 0 };
}

/**
 * Normalize GitHub Copilot quota payloads (paid `quota_snapshots` or free
 * `monthly_quotas`/`limited_user_quotas`) into progress rows.
 */
function buildGitHubQuotas(data) {
  const quotas = {};
  const row = (used, total, unlimited, resetAt) => ({
    used,
    total,
    remaining: Math.max(0, total - used),
    remainingPercentage: !unlimited && total > 0 ? (Math.max(0, total - used) / total) * 100 : null,
    resetAt: resetAt || null,
    unlimited: !!unlimited || total === 0,
    usedLabel: unlimited || total === 0 ? "Unlimited" : `${used.toLocaleString()} / ${total.toLocaleString()}`,
  });

  if (data.quota_snapshots) {
    const resetAt = parseResetTime(data.quota_reset_date);
    for (const [name, snap] of Object.entries(data.quota_snapshots)) {
      const f = fromSnapshot(snap);
      quotas[name] = row(f.used, f.total, f.unlimited, resetAt);
    }
  } else if (data.monthly_quotas || data.limited_user_quotas) {
    const monthly = data.monthly_quotas || {};
    const used = data.limited_user_quotas || {};
    const resetAt = parseResetTime(data.limited_user_reset_date);
    for (const name of new Set([...Object.keys(monthly), ...Object.keys(used)])) {
      const total = Number(monthly[name]) || 0;
      quotas[name] = row(Number(used[name]) || 0, total, total === 0, resetAt);
    }
  }
  return quotas;
}

/**
 * Fetch live quota and subscription status for GitHub Copilot
 */
export async function fetchGitHubQuota(connection) {
  const token = connection.credentials?.github_token || connection.credentials?.access_token;
  if (!token) return null;

  const url = "https://api.github.com/copilot_internal/user";
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const res = await oauthFetch(url, { headers }, { proxyUrl: requireResolvedProxy(connection) });
  if (!res.ok) {
    throw new Error(`GitHub Copilot user API returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const plan = data.plan || (data.access_type ? `Copilot (${data.access_type})` : data.copilot_plan || "Copilot");
  const quotas = buildGitHubQuotas(data);
  const numeric = Object.values(quotas).filter((q) => q.total > 0);

  return {
    provider: "github",
    plan,
    login: data.login || data.user_id || "GitHub User",
    chat_enabled: data.chat_enabled !== false,
    is_exhausted: numeric.length > 0 && numeric.every((q) => q.remainingPercentage <= 0),
    unit: "subscription",
    quotas,
  };
}
