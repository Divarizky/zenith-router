import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { syncProviderQuota } from "../src/services/quota.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import { app } from "../src/index.js";
import { hasQuotaFetcher } from "../src/services/quota/index.js";

test("OpenRouter Quota - registered in quota fetchers", () => {
  assert.strictEqual(hasQuotaFetcher("openrouter"), true);
});

test("OpenRouter Quota - renders in usage dashboard UI", async () => {
  initDb(":memory:");
  addConnection({
    provider: "openrouter",
    name: "OpenRouter UI Account",
    credentials: {
      api_key: "sk-or-test-ui",
      quota: {
        provider: "openrouter",
        usage: 5.5,
        limit: 10.0,
        remaining: 4.5,
        unit: "credits_usd",
        quotas: {
          key_limit: {
            displayName: "Key Limit",
            remainingPercentage: 45,
            usedLabel: "$4.50 left of $10.00",
          },
          account_balance: {
            displayName: "Account Balance",
            remainingPercentage: 26,
            usedLabel: "$6.50 balance",
          },
        },
      },
    },
  });

  const res = await app.request("/dashboard/usage");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("OpenRouter UI Account"));
  assert.ok(html.includes("Key Limit"));
  assert.ok(html.includes("$4.50 left of $10.00"));
  assert.ok(html.includes("Account Balance"));
});

test("OpenRouter Quota - merges /key and /credits endpoints with granular rows", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/v1/key")) {
      return new Response(
        JSON.stringify({
          data: {
            label: "Dev Key",
            usage: 5.5,
            limit: 10.0,
            limit_remaining: 4.5,
            limit_reset: "2026-11-01T00:00:00Z",
            is_free_tier: false,
            usage_daily: 0.85,
            usage_weekly: 3.2,
            usage_monthly: 5.5,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/api/v1/credits")) {
      return new Response(
        JSON.stringify({
          data: {
            total_credits: 25.0,
            total_usage: 18.5,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "openrouter",
      name: "OpenRouter Main",
      auth_type: "apikey",
      credentials: { api_key: "sk-or-v1-test" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.provider, "openrouter");
    assert.strictEqual(quota.label, "Dev Key");
    assert.strictEqual(quota.usage, 5.5);
    assert.strictEqual(quota.limit, 10.0);
    assert.strictEqual(quota.remaining, 4.5);
    assert.strictEqual(quota.is_exhausted, false);
    assert.strictEqual(quota.credit_balance, 6.5);
    assert.strictEqual(quota.total_credits, 25.0);
    assert.strictEqual(quota.total_usage, 18.5);
    assert.strictEqual(quota.usage_daily, 0.85);
    assert.strictEqual(quota.usage_monthly, 5.5);

    assert.ok(quota.quotas);
    assert.strictEqual(quota.quotas.key_limit.displayName, "Key Limit");
    assert.strictEqual(quota.quotas.key_limit.remainingPercentage, 45);
    assert.strictEqual(quota.quotas.key_limit.usedLabel, "$4.50 left of $10.00");
    assert.strictEqual(quota.quotas.key_limit.resetAt, "2026-11-01T00:00:00Z");

    assert.strictEqual(quota.quotas.account_balance.displayName, "Account Balance");
    assert.strictEqual(quota.quotas.account_balance.remainingPercentage, 26);
    assert.strictEqual(quota.quotas.account_balance.usedLabel, "$6.50 balance (used $18.50)");

    assert.strictEqual(quota.quotas.usage_daily.displayName, "Daily Spend");
    assert.strictEqual(quota.quotas.usage_daily.usedLabel, "$0.85 today");
  } finally {
    setOAuthFetch(null);
  }
});

test("OpenRouter Quota - graceful degradation when /credits fails", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/v1/key")) {
      return new Response(
        JSON.stringify({
          data: {
            label: "Fallback Key",
            usage: 2.0,
            limit: 5.0,
            is_free_tier: false,
          },
        }),
        { status: 200 }
      );
    }
    // /credits returns 500 error
    return new Response("Internal error", { status: 500 });
  });

  try {
    const conn = addConnection({
      provider: "openrouter",
      name: "OpenRouter Key Only",
      credentials: { api_key: "sk-or-v1-key-only" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.provider, "openrouter");
    assert.strictEqual(quota.limit, 5.0);
    assert.strictEqual(quota.remaining, 3.0);
    assert.strictEqual(quota.is_exhausted, false);
    assert.strictEqual(quota.credit_balance, null);
    assert.ok(quota.quotas.key_limit);
    assert.strictEqual(quota.quotas.account_balance, undefined);
  } finally {
    setOAuthFetch(null);
  }
});

test("OpenRouter Quota - graceful degradation when /key fails but /credits succeeds", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/v1/credits")) {
      return new Response(
        JSON.stringify({
          data: {
            total_credits: 50.0,
            total_usage: 20.0,
          },
        }),
        { status: 200 }
      );
    }
    // /key fails
    return new Response("Rate limited", { status: 429 });
  });

  try {
    const conn = addConnection({
      provider: "openrouter",
      name: "OpenRouter Credits Only",
      credentials: { api_key: "sk-or-v1-credits-only" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.provider, "openrouter");
    assert.strictEqual(quota.credit_balance, 30.0);
    assert.strictEqual(quota.remaining, 30.0);
    assert.strictEqual(quota.is_exhausted, false);
    assert.ok(quota.quotas.account_balance);
  } finally {
    setOAuthFetch(null);
  }
});

test("OpenRouter Quota - free tier accounts stay usable even with zero balance", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/v1/key")) {
      return new Response(
        JSON.stringify({
          data: {
            is_free_tier: true,
            limit: null,
            usage: 0,
          },
        }),
        { status: 200 }
      );
    }
    if (url.includes("/api/v1/credits")) {
      return new Response(
        JSON.stringify({
          data: {
            total_credits: 0,
            total_usage: 0,
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "openrouter",
      name: "OpenRouter Free",
      credentials: { api_key: "sk-or-free" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.is_free_tier, true);
    assert.strictEqual(quota.remaining, null);
    assert.strictEqual(quota.is_exhausted, false);
  } finally {
    setOAuthFetch(null);
  }
});

test("OpenRouter Quota - exhausted when limit is reached", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/v1/key")) {
      return new Response(
        JSON.stringify({
          data: {
            usage: 10.0,
            limit: 10.0,
            limit_remaining: 0,
            is_free_tier: false,
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "openrouter",
      name: "OpenRouter Depleted",
      credentials: { api_key: "sk-or-depleted" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.remaining, 0);
    assert.strictEqual(quota.is_exhausted, true);
  } finally {
    setOAuthFetch(null);
  }
});
