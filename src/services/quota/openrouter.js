import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";

function fmtUsd(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

/**
 * Fetch live credit balance and key limits for OpenRouter.
 *
 * OpenRouter exposes two documented monitoring endpoints:
 *   GET https://openrouter.ai/api/v1/key
 *     -> { data: { label, usage, limit, limit_remaining, limit_reset,
 *                  is_free_tier, usage_daily, usage_weekly, usage_monthly } }
 *   GET https://openrouter.ai/api/v1/credits
 *     -> { data: { total_credits, total_usage } }
 *
 * Both are queried and merged into one quota object. If either endpoint fails
 * (e.g. rate limit or unexpected response), the other provides graceful degradation.
 */
export async function fetchOpenRouterQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const proxyUrl = requireResolvedProxy(connection);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  let keyData = null;
  let creditsData = null;
  let lastErr = null;

  // 1. Fetch Key endpoint (/api/v1/key with fallback to /api/v1/auth/key)
  try {
    let res = await oauthFetch("https://openrouter.ai/api/v1/key", { headers }, { proxyUrl });
    if (res.status === 404) {
      res = await oauthFetch("https://openrouter.ai/api/v1/auth/key", { headers }, { proxyUrl });
    }
    if (res.ok) {
      const json = await res.json();
      keyData = json.data || json;
    } else {
      lastErr = new Error(`OpenRouter key API returned HTTP ${res.status}`);
    }
  } catch (err) {
    lastErr = err;
  }

  // 2. Fetch Credits endpoint (/api/v1/credits)
  try {
    const res = await oauthFetch("https://openrouter.ai/api/v1/credits", { headers }, { proxyUrl });
    if (res.ok) {
      const json = await res.json();
      creditsData = json.data || json;
    }
  } catch {}

  // If neither succeeded and key returned an error, throw so the caller knows
  if (!keyData && !creditsData) {
    throw lastErr || new Error("Failed to fetch OpenRouter quota");
  }

  // Parse Key values
  const usage = keyData ? (Number(keyData.usage) || 0) : 0;
  const limit = keyData?.limit != null ? Number(keyData.limit) : null;
  const isFreeTier = keyData?.is_free_tier === true;
  const limitRemaining =
    keyData?.limit_remaining != null
      ? Number(keyData.limit_remaining)
      : limit != null
        ? Math.max(0, limit - usage)
        : null;
  const limitReset = keyData?.limit_reset || null;
  const usageDaily = keyData?.usage_daily != null ? Number(keyData.usage_daily) : null;
  const usageWeekly = keyData?.usage_weekly != null ? Number(keyData.usage_weekly) : null;
  const usageMonthly = keyData?.usage_monthly != null ? Number(keyData.usage_monthly) : null;

  // Parse Credits values
  const totalCredits = creditsData?.total_credits != null ? Number(creditsData.total_credits) : null;
  const totalUsage = creditsData?.total_usage != null ? Number(creditsData.total_usage) : null;
  const creditBalance =
    totalCredits != null && totalUsage != null ? Math.max(0, totalCredits - totalUsage) : null;

  // Calculate top-level remaining & is_exhausted
  let remaining = null;
  let isExhausted = false;

  if (limit != null) {
    remaining = limitRemaining != null ? limitRemaining : Math.max(0, limit - usage);
    isExhausted = remaining <= 0;
  } else if (creditBalance != null) {
    if (isFreeTier) {
      // Free tier accounts can continue serving :free models regardless of credit balance
      remaining = null;
      isExhausted = false;
    } else {
      remaining = creditBalance;
      isExhausted = creditBalance <= 0;
    }
  }

  // Build granular quota rows for UI
  const quotas = {};
  if (limit != null) {
    const remPct = limit > 0 ? Math.max(0, Math.min(100, ((limitRemaining ?? remaining ?? 0) / limit) * 100)) : 0;
    quotas.key_limit = {
      displayName: "Key Limit",
      remainingPercentage: remPct,
      remaining: limitRemaining ?? remaining,
      total: limit,
      usedLabel: `${fmtUsd(limitRemaining ?? remaining)} left of ${fmtUsd(limit)}`,
      resetAt: limitReset,
    };
  }
  if (creditBalance != null) {
    const remPct = totalCredits > 0 ? Math.max(0, Math.min(100, (creditBalance / totalCredits) * 100)) : null;
    quotas.account_balance = {
      displayName: "Account Balance",
      remainingPercentage: remPct,
      remaining: creditBalance,
      total: totalCredits,
      usedLabel: `${fmtUsd(creditBalance)} balance (used ${fmtUsd(totalUsage)})`,
      resetAt: null,
    };
  }
  if (usageDaily != null && usageDaily > 0) {
    quotas.usage_daily = {
      displayName: "Daily Spend",
      remainingPercentage: null,
      usedLabel: `${fmtUsd(usageDaily)} today`,
      resetAt: null,
    };
  }
  if (usageMonthly != null && usageMonthly > 0) {
    quotas.usage_monthly = {
      displayName: "Monthly Spend",
      remainingPercentage: null,
      usedLabel: `${fmtUsd(usageMonthly)} this month`,
      resetAt: null,
    };
  }

  return {
    provider: "openrouter",
    label: keyData?.label || "OpenRouter Key",
    usage,
    limit,
    remaining,
    is_free_tier: isFreeTier,
    is_exhausted: isExhausted,
    unit: "credits_usd",
    credit_balance: creditBalance,
    total_credits: totalCredits,
    total_usage: totalUsage,
    usage_daily: usageDaily,
    usage_weekly: usageWeekly,
    usage_monthly: usageMonthly,
    quotas: Object.keys(quotas).length > 0 ? quotas : undefined,
  };
}
