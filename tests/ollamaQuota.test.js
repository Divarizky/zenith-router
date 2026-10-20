import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { syncProviderQuota } from "../src/services/quota.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import { app } from "../src/index.js";
import { hasQuotaFetcher } from "../src/services/quota/index.js";

test("Ollama Quota - registered in quota fetchers", () => {
  assert.strictEqual(hasQuotaFetcher("ollama"), true);
  assert.strictEqual(hasQuotaFetcher("ollama-cloud"), true);
});

test("Ollama Quota - renders in usage dashboard UI", async () => {
  initDb(":memory:");
  addConnection({
    provider: "ollama",
    name: "Ollama Cloud UI Account",
    credentials: {
      api_key: "ollama-ui-key",
      quota: {
        provider: "ollama",
        unit: "percent",
        quotas: {
          monthly: {
            displayName: "Monthly Allowance",
            remainingPercentage: 75,
            usedLabel: "$15.00 / $20.00 left",
          },
          session: {
            displayName: "Session",
            remainingPercentage: 85,
            usedLabel: "85% left",
          },
        },
      },
    },
  });

  const res = await app.request("/dashboard/usage");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Ollama Cloud UI Account"));
  assert.ok(html.includes("Monthly Allowance"));
  assert.ok(html.includes("$15.00 / $20.00 left"));
  assert.ok(html.includes("Session"));
});

test("Ollama Quota - parses standard plan monthly allowance and purchased credits", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/balance")) {
      return new Response(
        JSON.stringify({
          included: {
            allowance_usd: 20.0,
            balance_usd: 15.0,
            period: {
              until: "2026-11-01T00:00:00Z",
            },
          },
          purchased: {
            balance_usd: 5.0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "ollama",
      name: "Ollama Cloud Pro",
      auth_type: "apikey",
      credentials: { api_key: "ollama-sk-test" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.provider, "ollama");
    assert.strictEqual(quota.unit, "percent");
    assert.strictEqual(quota.is_exhausted, false);

    assert.ok(quota.quotas);
    assert.strictEqual(quota.quotas.monthly.displayName, "Monthly Allowance");
    assert.strictEqual(quota.quotas.monthly.remainingPercentage, 75);
    assert.strictEqual(quota.quotas.monthly.remaining, 15.0);
    assert.strictEqual(quota.quotas.monthly.total, 20.0);
    assert.strictEqual(quota.quotas.monthly.usedLabel, "$15.00 / $20.00 left");
    assert.strictEqual(quota.quotas.monthly.resetAt, "2026-11-01T00:00:00Z");

    assert.strictEqual(quota.quotas.credits.displayName, "Purchased Credits");
    assert.strictEqual(quota.quotas.credits.remainingPercentage, null);
    assert.strictEqual(quota.quotas.credits.remaining, 5.0);
    assert.strictEqual(quota.quotas.credits.usedLabel, "$5.00 credits");
  } finally {
    setOAuthFetch(null);
  }
});

test("Ollama Quota - parses legacy session and weekly windows", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/balance")) {
      return new Response(
        JSON.stringify({
          included: {
            session: {
              remaining_percent: 85,
              resets_at: "2026-10-20T16:00:00Z",
            },
            weekly: {
              remaining_percent: 92,
              resets_at: "2026-10-26T00:00:00Z",
            },
          },
          purchased: {
            balance_usd: 0,
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "ollama",
      name: "Ollama Legacy",
      credentials: { api_key: "ollama-legacy" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.provider, "ollama");
    assert.strictEqual(quota.is_exhausted, false);

    assert.ok(quota.quotas.session);
    assert.strictEqual(quota.quotas.session.remainingPercentage, 85);
    assert.strictEqual(quota.quotas.session.usedLabel, "85% left");
    assert.strictEqual(quota.quotas.session.resetAt, "2026-10-20T16:00:00Z");

    assert.ok(quota.quotas.weekly);
    assert.strictEqual(quota.quotas.weekly.remainingPercentage, 92);
    assert.strictEqual(quota.quotas.weekly.usedLabel, "92% left");
    assert.strictEqual(quota.quotas.weekly.resetAt, "2026-10-26T00:00:00Z");
  } finally {
    setOAuthFetch(null);
  }
});

test("Ollama Quota - marks account exhausted when monthly balance is 0 and no credits", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/balance")) {
      return new Response(
        JSON.stringify({
          included: {
            allowance_usd: 20.0,
            balance_usd: 0.0,
            period: { until: "2026-11-01T00:00:00Z" },
          },
          purchased: { balance_usd: 0.0 },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "ollama",
      name: "Ollama Zero",
      credentials: { api_key: "ollama-zero" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.is_exhausted, true);
    assert.strictEqual(quota.quotas.monthly.remainingPercentage, 0);
  } finally {
    setOAuthFetch(null);
  }
});

test("Ollama Quota - account with 0 monthly balance stays usable if purchased credits exist", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/balance")) {
      return new Response(
        JSON.stringify({
          included: {
            allowance_usd: 20.0,
            balance_usd: 0.0,
            period: { until: "2026-11-01T00:00:00Z" },
          },
          purchased: { balance_usd: 12.5 },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "ollama",
      name: "Ollama Buffer",
      credentials: { api_key: "ollama-buf" },
    });

    const quota = await syncProviderQuota(conn);
    assert.strictEqual(quota.is_exhausted, false);
    assert.strictEqual(quota.quotas.credits.remaining, 12.5);
  } finally {
    setOAuthFetch(null);
  }
});

test("Ollama Quota - handles HTTP 401 error gracefully", async () => {
  initDb(":memory:");

  setOAuthFetch(async (url) => {
    if (url.includes("/api/balance")) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const conn = addConnection({
      provider: "ollama",
      name: "Ollama Bad Key",
      credentials: { api_key: "ollama-bad" },
    });

    const quota = await syncProviderQuota(conn, { quiet: true });
    assert.strictEqual(quota.unit, "unknown");
  } finally {
    setOAuthFetch(null);
  }
});
