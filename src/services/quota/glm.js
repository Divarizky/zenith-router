import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";

/**
 * Fetch live quota for GLM (Z.ai Coding Plan)
 */
export async function fetchGlmQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const url = "https://api.z.ai/api/paas/v4/user/quota";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  const res = await oauthFetch(url, { headers }, { proxyUrl: requireResolvedProxy(connection) });
  if (!res.ok) {
    throw new Error(`GLM quota API returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const data = json.data || json;
  const limits = Array.isArray(data.limits) ? data.limits : [];

  let sessionLimit = null;
  let weeklyLimit = null;
  let isExhausted = false;

  for (const l of limits) {
    const used = Number(l.percentage) || 0;
    if (used >= 100) isExhausted = true;
    if (l.unit === 3) sessionLimit = { used_percent: used, reset_time: l.nextResetTime };
    if (l.unit === 6) weeklyLimit = { used_percent: used, reset_time: l.nextResetTime };
  }

  return {
    provider: "glm",
    session_quota: sessionLimit,
    weekly_quota: weeklyLimit,
    is_exhausted: isExhausted,
    unit: "coding_plan",
  };
}
