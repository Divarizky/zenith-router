import { oauthFetch } from "../oauth/providers.js";
import { parseResetTime } from "./shared.js";

/** "Weekly (7d)" / "Session (5h)" from the window length; null when unknown. */
function windowLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const days = Math.round(s / 86400);
  if (days >= 28) return `Monthly (${days}d)`;
  if (days === 7) return "Weekly (7d)";
  if (days >= 1) return `${days}-day (${days}d)`;
  return `Session (${Math.round(s / 3600)}h)`;
}

function toWindow(raw, fallbackLabel) {
  const used = Math.max(0, Math.min(100, Number(raw.used_percent ?? raw.percent_used) || 0));
  const reset =
    parseResetTime(raw.reset_at ?? raw.resets_at ?? raw.reset_time) ||
    (Number(raw.reset_after_seconds) > 0
      ? new Date(Date.now() + Number(raw.reset_after_seconds) * 1000).toISOString()
      : null);
  return {
    label: windowLabel(raw.limit_window_seconds) || fallbackLabel,
    used,
    resetAt: reset,
  };
}

/**
 * Fetch live quota for Codex (ChatGPT Free / Plus / Team / Pro).
 * The usage endpoint returns rate_limit.primary_window / secondary_window; free
 * accounts typically carry a single weekly window, so each bar is labelled from
 * its own length instead of a fixed "primary/secondary" name.
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
  const rateLimit = data.rate_limit || data.rate_limits || data;

  const windows = [];
  const primaryRaw = rateLimit.primary_window || rateLimit.primary;
  const secondaryRaw = rateLimit.secondary_window || rateLimit.secondary;
  if (primaryRaw) windows.push(toWindow(primaryRaw, "Session"));
  else if (rateLimit.primary_used_percent != null || rateLimit.used_percent != null) {
    // Older flat shape.
    windows.push(
      toWindow(
        {
          used_percent: rateLimit.primary_used_percent ?? rateLimit.used_percent,
          reset_at: rateLimit.primary_reset_time || rateLimit.reset_time,
        },
        "Session"
      )
    );
  }
  if (secondaryRaw) windows.push(toWindow(secondaryRaw, "Weekly"));
  else if (rateLimit.secondary_used_percent != null) {
    windows.push(
      toWindow({ used_percent: rateLimit.secondary_used_percent, reset_at: rateLimit.secondary_reset_time }, "Weekly")
    );
  }

  const quotas = {};
  windows.forEach((w, i) => {
    quotas[`window_${i + 1}`] = {
      used: w.used,
      total: 100,
      remainingPercentage: Math.max(0, 100 - w.used),
      usedLabel: `${w.used}% used`,
      resetAt: w.resetAt,
      displayName: w.label,
    };
  });

  const [first, second] = windows;
  const isExhausted = rateLimit.limit_reached === true || windows.some((w) => w.used >= 100);

  return {
    provider: "codex",
    plan: data.plan_type || data.plan || "ChatGPT",
    // Flat fields stay for callers/tests that read the first two windows directly.
    used_percent: first ? first.used : 0,
    remaining_percent: first ? Math.max(0, 100 - first.used) : 100,
    reset_time: first?.resetAt || null,
    secondary_used_percent: second ? second.used : null,
    secondary_reset_time: second?.resetAt || null,
    is_exhausted: isExhausted,
    unit: "percent",
    quotas,
  };
}
