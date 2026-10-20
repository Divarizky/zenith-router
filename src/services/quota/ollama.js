import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";

function fmtUsd(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function finiteNumber(val) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim().length > 0) {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Fetch live balance and allowance for Ollama Cloud.
 *
 * GET https://ollama.com/api/balance
 *
 * Supports:
 *   - Included monthly allowance: `included.allowance_usd` & `included.balance_usd`
 *     with period expiration `included.period.until`.
 *   - Included session window: `included.session.remaining_percent` & `included.session.resets_at`.
 *   - Included weekly window: `included.weekly.remaining_percent` & `included.weekly.resets_at`.
 *   - Purchased USD credits: `purchased.balance_usd`.
 */
export async function fetchOllamaQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const url = process.env.ZENITH_OLLAMA_BALANCE_URL || "https://ollama.com/api/balance";
  const proxyUrl = requireResolvedProxy(connection);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  const res = await oauthFetch(url, { headers }, { proxyUrl });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Ollama Cloud authentication failed (HTTP 401). Check API key.");
    }
    if (res.status === 403) {
      throw new Error("Ollama Cloud account is suspended (HTTP 403).");
    }
    if (res.status === 429) {
      throw new Error("Ollama Cloud balance is rate limited (HTTP 429).");
    }
    throw new Error(`Ollama Cloud balance API returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const root = json && typeof json === "object" ? json : {};
  const included = root.included && typeof root.included === "object" ? root.included : {};
  const purchased = root.purchased && typeof root.purchased === "object" ? root.purchased : {};

  const quotas = {};

  // 1. Monthly Allowance
  const allowanceUsd = finiteNumber(included.allowance_usd);
  const balanceUsd = finiteNumber(included.balance_usd);
  const periodUntil = included.period?.until || null;

  if (allowanceUsd != null && allowanceUsd > 0 && balanceUsd != null) {
    const remPct = Math.max(0, Math.min(100, (balanceUsd / allowanceUsd) * 100));
    quotas.monthly = {
      displayName: "Monthly Allowance",
      remainingPercentage: remPct,
      remaining: balanceUsd,
      total: allowanceUsd,
      usedLabel: `${fmtUsd(balanceUsd)} / ${fmtUsd(allowanceUsd)} left`,
      resetAt: periodUntil,
    };
  }

  // 2. Legacy / Sessional Windows (Session & Weekly)
  const sessionData = included.session && typeof included.session === "object" ? included.session : null;
  const sessionRem = sessionData ? finiteNumber(sessionData.remaining_percent) : null;
  if (sessionRem != null) {
    const pct = Math.max(0, Math.min(100, sessionRem));
    quotas.session = {
      displayName: "Session",
      remainingPercentage: pct,
      remaining: pct,
      total: 100,
      usedLabel: `${Math.round(pct)}% left`,
      resetAt: sessionData.resets_at || null,
    };
  }

  const weeklyData = included.weekly && typeof included.weekly === "object" ? included.weekly : null;
  const weeklyRem = weeklyData ? finiteNumber(weeklyData.remaining_percent) : null;
  if (weeklyRem != null) {
    const pct = Math.max(0, Math.min(100, weeklyRem));
    quotas.weekly = {
      displayName: "Weekly",
      remainingPercentage: pct,
      remaining: pct,
      total: 100,
      usedLabel: `${Math.round(pct)}% left`,
      resetAt: weeklyData.resets_at || null,
    };
  }

  // 3. Purchased Credits
  const purchasedUsd = finiteNumber(purchased.balance_usd);
  if (purchasedUsd != null && purchasedUsd > 0) {
    quotas.credits = {
      displayName: "Purchased Credits",
      remainingPercentage: null,
      remaining: purchasedUsd,
      total: purchasedUsd,
      usedLabel: `${fmtUsd(purchasedUsd)} credits`,
      resetAt: null,
    };
  }

  // Check if completely exhausted
  let isExhausted = false;
  const hasCredits = purchasedUsd != null && purchasedUsd > 0;
  if (!hasCredits) {
    const monthlyZero = allowanceUsd != null && balanceUsd != null && balanceUsd <= 0;
    const sessionZero = sessionRem != null && sessionRem <= 0;
    const weeklyZero = weeklyRem != null && weeklyRem <= 0;

    if (monthlyZero) {
      isExhausted = true;
    } else if (sessionZero && (!weeklyData || weeklyZero)) {
      isExhausted = true;
    }
  }

  return {
    provider: "ollama",
    label: "Ollama Cloud",
    unit: "percent",
    is_exhausted: isExhausted,
    quotas: Object.keys(quotas).length > 0 ? quotas : undefined,
  };
}
