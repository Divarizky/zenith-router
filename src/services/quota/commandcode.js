import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";
import { parseResetTime } from "./shared.js";

const BASE_URL = "https://api.commandcode.ai";

// Same plan names the official CLI shows on its /usage screen.
const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

// Statuses the CLI treats as a live subscription.
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function planName(planId) {
  if (!planId) return null;
  const id = String(planId).toLowerCase().replace(/_/g, "-");
  const key = Object.keys(PLAN_NAMES)
    .sort((a, b) => b.length - a.length)
    .find((k) => id.startsWith(k));
  return key ? PLAN_NAMES[key] : planId;
}

function windowBucket(label, win) {
  const cap = Number(win?.cap);
  if (!win || !Number.isFinite(cap) || cap <= 0) return null;
  const used = Math.max(0, Number(win.used) || 0);
  const usedPercent = Math.min(100, (used / cap) * 100);
  return {
    displayName: label,
    remainingPercentage: Math.max(0, 100 - usedPercent),
    usedLabel: `${Math.round(usedPercent)}% used`,
    resetAt: parseResetTime(win.resetAt),
    exceeded: win.exceeded === true,
  };
}

/**
 * Fetch live usage limits for Command Code: the 5-hour and weekly windows plus
 * the credit balance, from the same billing endpoints the official CLI reads.
 */
export async function fetchCommandCodeQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "x-command-code-version": "0.25.7",
    "x-cli-environment": "cli",
  };
  const options = { proxyUrl: requireResolvedProxy(connection) };

  const res = await oauthFetch(`${BASE_URL}/alpha/billing/credits`, { headers }, options);
  if (!res.ok) {
    throw new Error(`Command Code credits API returned HTTP ${res.status}`);
  }
  const data = await res.json();

  // The plan name is cosmetic, so a failing subscription call does not fail the sync.
  let plan = null;
  try {
    const subRes = await oauthFetch(`${BASE_URL}/alpha/billing/subscriptions`, { headers }, options);
    if (subRes.ok) {
      const sub = (await subRes.json())?.data;
      if (sub && LIVE_STATUSES.has(sub.status)) plan = planName(sub.planId);
    }
  } catch {}

  const windows = data?.windowLimits || {};
  const quotas = {};
  const fiveHour = windowBucket("5-hour", windows.fiveHour);
  const weekly = windowBucket("Weekly", windows.weekly);
  if (fiveHour) quotas.five_hour = fiveHour;
  if (weekly) quotas.weekly = weekly;

  const credits = data?.credits || {};
  const creditsLeft =
    Math.max(0, Number(credits.monthlyCredits) || 0) +
    Math.max(0, Number(credits.purchasedCredits) || 0) +
    Math.max(0, Number(credits.freeCredits) || 0);
  quotas.credits = {
    displayName: "Credits",
    remainingPercentage: null,
    usedLabel: `$${creditsLeft.toFixed(2)} left`,
    resetAt: null,
  };

  // Only a window the upstream itself reports as exceeded parks the account.
  // An empty credit balance does not: free models keep working without credits.
  const isExhausted = windows.exceeded === true || Boolean(fiveHour?.exceeded) || Boolean(weekly?.exceeded);

  return {
    provider: "commandcode",
    plan,
    quotas,
    credits_remaining: creditsLeft,
    is_exhausted: isExhausted,
    unit: "commandcode_plan",
  };
}
