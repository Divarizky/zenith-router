import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { syncProviderQuota, isConnectionExhausted } from "../src/services/quota.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";

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
