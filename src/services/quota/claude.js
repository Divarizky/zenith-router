import { oauthFetch } from "../oauth/providers.js";
import { parseResetTime } from "./shared.js";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * Fetch live quota for Claude Code OAuth accounts (session 5h + weekly 7d
 * windows, same parse as 9router open-sse/services/usage/claude.js).
 */
export async function fetchClaudeQuota(connection) {
  const token = connection.credentials?.access_token;
  if (!token) return null;

  const res = await oauthFetch(
    CLAUDE_USAGE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
    },
    { proxyUrl: connection.proxy_url }
  );
  if (!res.ok) {
    throw new Error(`Claude usage endpoint returned HTTP ${res.status}`);
  }

  const data = await res.json();

  // utilization = % used; the quota object mirrors 9router's shape.
  const hasUtilization = (w) => w && typeof w === "object" && typeof w.utilization === "number";
  const makeRow = (w) => {
    const used = w.utilization;
    const remaining = Math.max(0, 100 - used);
    return {
      used,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      resetAt: parseResetTime(w.resets_at),
      usedLabel: used + "% used",
    };
  };

  const quotas = {};
  if (hasUtilization(data.five_hour)) quotas["session (5h)"] = makeRow(data.five_hour);
  if (hasUtilization(data.seven_day)) quotas["weekly (7d)"] = makeRow(data.seven_day);
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
      quotas["weekly " + key.replace("seven_day_", "") + " (7d)"] = makeRow(value);
    }
  }

  if (Object.keys(quotas).length === 0) return null;

  return {
    provider: "claude",
    plan: data.plan_name || "Claude Code",
    extra_usage: data.extra_usage ?? null,
    is_exhausted: Object.values(quotas).every((q) => q.remainingPercentage <= 0),
    unit: "percent",
    quotas,
  };
}
