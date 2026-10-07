import { oauthFetch } from "../oauth/providers.js";

/**
 * Fetch live credit balance for OpenRouter
 */
export async function fetchOpenRouterQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const url = "https://openrouter.ai/api/v1/auth/key";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  const res = await oauthFetch(url, { headers }, { proxyUrl: connection.proxy_url });
  if (!res.ok) {
    throw new Error(`OpenRouter key API returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const data = json.data || json;

  const usage = Number(data.usage) || 0;
  const limit = data.limit != null ? Number(data.limit) : null;
  const isFreeTier = data.is_free_tier === true;
  const remaining = limit != null ? Math.max(0, limit - usage) : null;
  const isExhausted = limit != null && usage >= limit;

  return {
    provider: "openrouter",
    label: data.label || "OpenRouter Key",
    usage,
    limit,
    remaining,
    is_free_tier: isFreeTier,
    is_exhausted: isExhausted,
    unit: "credits_usd",
  };
}
