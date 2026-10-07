import { oauthFetch } from "../oauth/providers.js";

/**
 * Fetch live quota for Codex (ChatGPT Plus / Team / Pro)
 */
export async function fetchCodexQuota(connection) {
  const token = connection.credentials?.access_token;
  if (!token) return null;

  const url = "https://chatgpt.com/backend-api/wham/usage";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "codex_cli_rs/0.159.0",
  };

  const res = await oauthFetch(url, { headers }, { proxyUrl: connection.proxy_url });
  if (!res.ok) {
    throw new Error(`Codex usage API returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const rateLimit = data.rate_limit || data;

  const primaryUsed = Number(rateLimit.primary_used_percent ?? rateLimit.used_percent) || 0;
  const primaryReset = rateLimit.primary_reset_time || rateLimit.reset_time || null;
  const secondaryUsed = rateLimit.secondary_used_percent != null ? Number(rateLimit.secondary_used_percent) : null;
  const secondaryReset = rateLimit.secondary_reset_time || null;

  const isExhausted = primaryUsed >= 100 || (secondaryUsed != null && secondaryUsed >= 100);

  return {
    provider: "codex",
    plan: data.plan_type || data.plan || "ChatGPT",
    used_percent: primaryUsed,
    remaining_percent: Math.max(0, 100 - primaryUsed),
    reset_time: primaryReset,
    secondary_used_percent: secondaryUsed,
    secondary_reset_time: secondaryReset,
    is_exhausted: isExhausted,
    unit: "percent",
  };
}
