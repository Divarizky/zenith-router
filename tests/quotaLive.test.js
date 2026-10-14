import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { syncProviderQuota, isConnectionExhausted } from "../src/services/quota.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import { setCustomTokenRefresher } from "../src/services/tokenRefresh.js";
import { getConnectionById } from "../src/db/index.js";

test("Live Quota - Codex parses rate limit from usage endpoint", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/wham/usage")) {
      return new Response(
        JSON.stringify({
          plan_type: "ChatGPT Plus",
          rate_limit: {
            primary_used_percent: 42,
            primary_reset_time: "2026-10-08T12:00:00Z",
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "codex",
    name: "My Codex Account",
    auth_type: "oauth",
    credentials: { access_token: "mock_codex_token" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "codex");
  assert.strictEqual(quota.used_percent, 42);
  assert.strictEqual(quota.remaining_percent, 58);
  assert.strictEqual(quota.is_exhausted, false);
  assert.strictEqual(quota.plan, "ChatGPT Plus");

  setOAuthFetch(null);
});

test("Live Quota - Codex labels windows by length (free plan = weekly only)", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/wham/usage")) {
      return new Response(
        JSON.stringify({
          plan_type: "free",
          rate_limit: {
            limit_reached: false,
            primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 3600 },
            secondary_window: null,
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "codex",
    name: "Free Codex",
    auth_type: "oauth",
    credentials: { access_token: "mock_codex_token" },
  });

  try {
    const quota = await syncProviderQuota(conn);
    const rows = Object.values(quota.quotas);
    assert.strictEqual(rows.length, 1, "free plan has a single window");
    assert.strictEqual(rows[0].displayName, "Weekly (7d)");
    assert.strictEqual(rows[0].remainingPercentage, 88);
    assert.ok(rows[0].resetAt, "reset time derived from reset_after_seconds");
    assert.strictEqual(quota.used_percent, 12);
  } finally {
    setOAuthFetch(null);
  }
});

test("Live Quota - OpenRouter parses credit balance and limit", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/auth/key")) {
      return new Response(
        JSON.stringify({
          data: {
            label: "Production Key",
            usage: 25.5,
            limit: 100.0,
            is_free_tier: false,
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "openrouter",
    name: "My OpenRouter Key",
    auth_type: "apikey",
    credentials: { api_key: "sk-or-v1-mock" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "openrouter");
  assert.strictEqual(quota.usage, 25.5);
  assert.strictEqual(quota.limit, 100);
  assert.strictEqual(quota.remaining, 74.5);
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("Live Quota - GLM parses coding plan limits and flags exhaustion when 100%", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/user/quota")) {
      return new Response(
        JSON.stringify({
          data: {
            limits: [
              { unit: 3, percentage: 100, nextResetTime: Date.now() + 3600000 },
              { unit: 6, percentage: 30, nextResetTime: Date.now() + 86400000 },
            ],
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "glm",
    name: "Z.ai GLM Key",
    auth_type: "apikey",
    credentials: { api_key: "mock_glm_key" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "glm");
  assert.strictEqual(quota.is_exhausted, true);
  assert.strictEqual(quota.session_quota.used_percent, 100);
  assert.strictEqual(quota.weekly_quota.used_percent, 30);

  setOAuthFetch(null);
});

test("Live Quota - Antigravity parses per-model remainingFraction buckets", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("fetchAvailableModels")) {
      return new Response(
        JSON.stringify({
          allowedTiers: [{ id: "legacy-tier", isDefault: true }],
          models: {
            "gemini-3.6-flash-high": {
              displayName: "Gemini 3.6 Flash High",
              quotaInfo: { remainingFraction: 0.62, resetTime: 1791000000 },
            },
            "internal-model": { isInternal: true, quotaInfo: { remainingFraction: 1 } },
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "antigravity",
    name: "user@gmail.com",
    auth_type: "oauth",
    credentials: { access_token: "mock_ag_token" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "antigravity");
  assert.strictEqual(quota.tier, "legacy-tier");
  assert.deepStrictEqual(Object.keys(quota.quotas), ["gemini-3.6-flash-high"]);
  assert.strictEqual(quota.quotas["gemini-3.6-flash-high"].used, 380);
  assert.strictEqual(quota.quotas["gemini-3.6-flash-high"].total, 1000);
  assert.strictEqual(Math.round(quota.quotas["gemini-3.6-flash-high"].remainingPercentage), 62);
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("Live Quota - Claude parses 5h and 7d utilization windows", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/oauth/usage")) {
      return new Response(
        JSON.stringify({
          plan_name: "Claude Code",
          five_hour: { utilization: 87, resets_at: "2026-10-08T12:00:00Z" },
          seven_day: { utilization: 30, resets_at: "2026-10-14T00:00:00Z" },
          seven_day_sonnet: { utilization: 55, resets_at: "2026-10-14T00:00:00Z" },
          extra_usage: null,
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "claude",
    name: "Claude Code",
    auth_type: "oauth",
    credentials: { access_token: "mock_claude_token" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "claude");
  assert.strictEqual(quota.plan, "Claude Code");
  assert.deepStrictEqual(Object.keys(quota.quotas), ["session (5h)", "weekly (7d)", "weekly sonnet (7d)"]);
  assert.strictEqual(quota.quotas["session (5h)"].used, 87);
  assert.strictEqual(quota.quotas["session (5h)"].remainingPercentage, 13);
  assert.strictEqual(quota.quotas["session (5h)"].usedLabel, "87% used");
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("Live Quota - GitHub parses paid quota_snapshots into used/total rows", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("copilot_internal/user")) {
      return new Response(
        JSON.stringify({
          copilot_plan: "Pro",
          login: "octocat",
          quota_reset_date: "2026-11-01T00:00:00Z",
          quota_snapshots: {
            chat: { entitlement: 300, remaining: 120 },
            completions: { entitlement: 100, remaining: 100 },
            premium_interactions: { entitlement: 50, remaining: 45 },
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "github",
    name: "Copilot Work",
    auth_type: "oauth",
    credentials: { github_token: "mock_github_token" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "github");
  assert.strictEqual(quota.plan, "Pro");
  assert.strictEqual(quota.quotas.chat.used, 180);
  assert.strictEqual(quota.quotas.chat.total, 300);
  assert.strictEqual(Math.round(quota.quotas.chat.remainingPercentage), 40);
  assert.strictEqual(quota.quotas.completions.remainingPercentage, 100);
  assert.strictEqual(Math.round(quota.quotas.premium_interactions.remainingPercentage), 90);
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("Live Quota - Kiro parses usageBreakdownList limits", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("getUsageLimits")) {
      return new Response(
        JSON.stringify({
          subscriptionInfo: { subscriptionTitle: "Kiro Free" },
          nextDateReset: "2026-10-09T00:00:00Z",
          usageBreakdownList: [
            { resourceType: "AGENTIC_REQUEST", currentUsageWithPrecision: 75, usageLimitWithPrecision: 200 },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "kiro",
    name: "Kiro Builder",
    auth_type: "oauth",
    credentials: { access_token: "mock_kiro_token", auth_method: "builder-id" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "kiro");
  assert.strictEqual(quota.plan, "Kiro Free");
  assert.strictEqual(quota.quotas.agentic_request.used, 75);
  assert.strictEqual(quota.quotas.agentic_request.total, 200);
  assert.strictEqual(Math.round(quota.quotas.agentic_request.remainingPercentage), 63);
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("Live Quota - xKiro parses free tokens, plan windows and wallet", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url, init) => {
    if (url === "https://api.xkiro.com/v1/usage") {
      assert.strictEqual(init.headers.Authorization, "Bearer sk-xt-mock");
      return new Response(
        JSON.stringify({
          object: "usage",
          plan: null,
          user: { name: "Diva", email: "diva@example.com", avatar_url: null },
          windows: [
            { kind: "short", window_sec: 18000, spent_usd: "1.000000", cap_usd: "4.000000", remaining_usd: "3.000000", resets_in_sec: 3600 },
          ],
          free_tokens: { used_today: 1_250_000, limit_per_day: 5_000_000, remaining: 3_750_000 },
          wallet: { balance_usd: "2.500000" },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "xkiro",
    name: "xKiro Free",
    auth_type: "apikey",
    credentials: { api_key: "sk-xt-mock" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "xkiro");
  assert.strictEqual(quota.plan, "Pay-as-you-go");
  const free = quota.quotas["free tokens (daily)"];
  assert.strictEqual(free.used, 1_250_000);
  assert.strictEqual(free.total, 5_000_000);
  assert.strictEqual(free.remainingPercentage, 75);
  assert.ok(free.resetAt.endsWith("T00:00:00.000Z"));
  assert.strictEqual(quota.quotas["session (5h)"].remainingPercentage, 75);
  assert.strictEqual(quota.quotas["session (5h)"].usedLabel, "$1.00 / $4.00");
  assert.strictEqual(quota.quotas.wallet.usedLabel, "$2.50 balance");
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("Live Quota - Antigravity filters noise models, dedupes buckets and reads plan name", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("fetchAvailableModels")) {
      const q = { remainingFraction: 0.5, resetTime: "2026-10-15T07:17:49Z" };
      return new Response(
        JSON.stringify({
          models: {
            tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
            "gemini-2.5-flash": { displayName: "Gemini 3.5 Flash Lite", quotaInfo: q },
            "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite", quotaInfo: q },
            "gemini-3.6-flash-high": { displayName: "Gemini 3.6 Flash (High)", quotaInfo: q },
            "gemini-3.6-flash-tiered": { displayName: "gemini-3.6-flash-tiered", quotaInfo: q },
            "gemini-3.8-flash-tiered": { displayName: "gemini-3.8-flash-tiered", quotaInfo: q },
            "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)", quotaInfo: q },
            "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)", quotaInfo: q },
          },
        }),
        { status: 200 }
      );
    }
    if (url.includes("loadCodeAssist")) {
      return new Response(JSON.stringify({ currentTier: { name: "Google AI Pro" } }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  });

  const conn = addConnection({
    provider: "antigravity",
    name: "ag",
    auth_type: "oauth",
    credentials: { access_token: "t" },
  });
  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.plan, "Google AI Pro");
  assert.deepStrictEqual(Object.keys(quota.quotas), ["gemini-3.6-flash-high", "gemini-3.8-flash-tiered", "gemini-pro-agent"]);
  assert.strictEqual(quota.quotas["gemini-3.8-flash-tiered"].displayName, "Gemini 3.8 Flash");

  setOAuthFetch(async () => new Response("denied", { status: 403 }));
  const denied = await syncProviderQuota(conn);
  assert.match(denied.error, /menolak token/);

  setOAuthFetch(null);
});

test("Live Quota - expired OAuth token is refreshed before the quota call", async () => {
  initDb(":memory:");
  const seen = [];

  setCustomTokenRefresher(async () => ({ access_token: "fresh_token", expires_at: Date.now() + 3600_000 }));
  setOAuthFetch(async (url, init) => {
    const auth = init?.headers?.Authorization;
    seen.push(auth);
    if (auth !== "Bearer fresh_token") return new Response("expired", { status: 401 });
    return new Response(
      JSON.stringify({
        models: {
          "gemini-3-flash-agent": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-10T00:00:00Z" } },
        },
      }),
      { status: 200 }
    );
  });

  const conn = addConnection({
    provider: "antigravity",
    name: "Expired AG",
    auth_type: "oauth",
    credentials: {
      access_token: "stale_token",
      refresh_token: "r",
      expires_at: Date.now() - 60_000,
      project_id: "p",
    },
  });

  try {
    const quota = await syncProviderQuota(conn);
    assert.ok(!quota.error, "no auth error after refresh");
    assert.strictEqual(Object.keys(quota.quotas).length, 1);
    assert.strictEqual(seen[0], "Bearer fresh_token", "stale token is never sent");
    const stored = getConnectionById(conn.id).credentials;
    assert.strictEqual(stored.access_token, "fresh_token", "refreshed token is persisted, not overwritten");
  } finally {
    setCustomTokenRefresher(null);
    setOAuthFetch(null);
  }
});

function commandCodeFetch({ credits, subscription, subscriptionStatus = 200 }) {
  const seen = [];
  setOAuthFetch(async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    if (url.includes("/alpha/billing/credits")) return new Response(JSON.stringify(credits), { status: 200 });
    if (url.includes("/alpha/billing/subscriptions")) {
      return new Response(JSON.stringify(subscription || {}), { status: subscriptionStatus });
    }
    return new Response("Not found", { status: 404 });
  });
  return seen;
}

test("Live Quota - Command Code parses 5-hour and weekly windows plus credits", async () => {
  initDb(":memory:");
  const seen = commandCodeFetch({
    credits: {
      credits: { monthlyCredits: 9.5607332, purchasedCredits: 0, freeCredits: 0.5 },
      windowLimits: {
        limited: true,
        exceeded: null,
        fiveHour: { used: 0.75, cap: 3, exceeded: false, resetAt: 1791979402793 },
        weekly: { used: 3, cap: 6, exceeded: false, resetAt: 1792566202793 },
      },
    },
    subscription: { success: true, data: { status: "active", planId: "individual-go-v1" } },
  });

  const conn = addConnection({
    provider: "commandcode",
    name: "Command Code",
    auth_type: "apikey",
    credentials: { api_key: "user_mock" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.provider, "commandcode");
  assert.strictEqual(quota.plan, "Go");
  assert.strictEqual(quota.is_exhausted, false);
  assert.strictEqual(quota.quotas.five_hour.remainingPercentage, 75);
  assert.strictEqual(quota.quotas.five_hour.resetAt, new Date(1791979402793).toISOString());
  assert.strictEqual(quota.quotas.weekly.remainingPercentage, 50);
  assert.strictEqual(quota.quotas.credits.usedLabel, "$10.06 left");
  assert.ok(seen.every((s) => s.auth === "Bearer user_mock"));
  assert.ok(!isConnectionExhausted(getConnectionById(conn.id)));

  setOAuthFetch(null);
});

test("Live Quota - Command Code marks the account exhausted when a window is exceeded", async () => {
  initDb(":memory:");
  commandCodeFetch({
    credits: {
      credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: 1791979402793 },
        weekly: { used: 3, cap: 6, exceeded: false, resetAt: 1792566202793 },
      },
    },
    subscriptionStatus: 500,
  });

  const conn = addConnection({
    provider: "commandcode",
    name: "Command Code",
    auth_type: "apikey",
    credentials: { api_key: "user_mock" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.is_exhausted, true);
  assert.strictEqual(quota.plan, null, "subscription yang gagal tidak menggagalkan sync");
  assert.strictEqual(quota.quotas.five_hour.remainingPercentage, 0);
  assert.ok(isConnectionExhausted(getConnectionById(conn.id)));

  setOAuthFetch(null);
});

test("Live Quota - Command Code with an empty balance stays usable for free models", async () => {
  initDb(":memory:");
  commandCodeFetch({
    credits: { credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { limited: false } },
  });

  const conn = addConnection({
    provider: "commandcode",
    name: "Command Code",
    auth_type: "apikey",
    credentials: { api_key: "user_mock" },
  });

  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.is_exhausted, false);
  assert.strictEqual(quota.quotas.five_hour, undefined);
  assert.strictEqual(quota.quotas.credits.usedLabel, "$0.00 left");

  setOAuthFetch(null);
});
