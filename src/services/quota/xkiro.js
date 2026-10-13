import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";

const XKIRO_USAGE_URL = "https://api.xkiro.com/v1/usage";

const usd = (v) => `$${(Number(v) || 0).toFixed(2)}`;

function nextUtcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function windowLabel(sec, kind) {
  if (sec === 18000) return "session (5h)";
  if (sec === 604800) return "weekly (7d)";
  if (sec > 0 && sec % 86400 === 0) return `${sec / 86400}d window`;
  if (sec > 0 && sec % 3600 === 0) return `${sec / 3600}h window`;
  return `${kind || "plan"} window`;
}

/**
 * Fetch xKiro account usage: daily free-token allowance (resets 00:00 UTC),
 * plan spend windows and wallet balance. GET /v1/usage is free and unmetered.
 * https://docs.xkiro.com/api/usage/
 */
export async function fetchXkiroQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const res = await oauthFetch(
    XKIRO_USAGE_URL,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    { proxyUrl: requireResolvedProxy(connection) }
  );
  if (!res.ok) {
    throw new Error(`xKiro usage API returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const quotas = {};

  // Free-model token allowance (separate budget from plan/wallet).
  const free = data.free_tokens;
  if (free && typeof free === "object") {
    const used = Number(free.used_today) || 0;
    const limit = free.limit_per_day != null ? Number(free.limit_per_day) : null;
    if (limit != null && limit > 0) {
      const remaining = Math.max(0, free.remaining != null ? Number(free.remaining) : limit - used);
      quotas["free tokens (daily)"] = {
        used,
        total: limit,
        remaining,
        remainingPercentage: (remaining / limit) * 100,
        resetAt: nextUtcMidnight(),
      };
    } else {
      quotas["free tokens (daily)"] = {
        used,
        total: 0,
        remainingPercentage: null,
        usedLabel: `${used.toLocaleString()} used · no cap`,
        resetAt: nextUtcMidnight(),
      };
    }
  }

  // Plan spend windows (empty on pay-as-you-go).
  for (const w of Array.isArray(data.windows) ? data.windows : []) {
    const spent = parseFloat(w.spent_usd) || 0;
    const cap = parseFloat(w.cap_usd) || 0;
    const remaining = Math.max(0, w.remaining_usd != null ? parseFloat(w.remaining_usd) || 0 : cap - spent);
    const resetsIn = Number(w.resets_in_sec);
    quotas[windowLabel(Number(w.window_sec), w.kind)] = {
      used: spent,
      total: cap,
      remaining,
      remainingPercentage: cap > 0 ? (remaining / cap) * 100 : null,
      usedLabel: `${usd(spent)} / ${usd(cap)}`,
      resetAt: Number.isFinite(resetsIn) ? new Date(Date.now() + resetsIn * 1000).toISOString() : null,
    };
  }

  // Wallet balance: informational, no bar.
  if (data.wallet && typeof data.wallet === "object") {
    const balance = parseFloat(data.wallet.balance_usd ?? data.wallet.balance);
    if (Number.isFinite(balance)) {
      quotas["wallet"] = { used: 0, total: 0, remainingPercentage: null, usedLabel: `${usd(balance)} balance`, resetAt: null };
    }
  }

  const barred = Object.values(quotas).filter((q) => q.remainingPercentage != null);
  return {
    provider: "xkiro",
    plan: data.plan ? String(data.plan) : "Pay-as-you-go",
    login: data.user?.email || data.user?.name || null,
    is_exhausted: barred.length > 0 && barred.every((q) => q.remainingPercentage <= 0),
    unit: "tier",
    quotas,
  };
}
