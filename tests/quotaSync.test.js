import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById } from "../src/db/index.js";
import { setCustomQuotaFetcher } from "../src/services/quota.js";
import {
  syncAllQuotas,
  getQuotaSyncIntervalMs,
  runQuotaSyncTick,
  startQuotaSyncScheduler,
  stopQuotaSyncScheduler,
} from "../src/services/quotaSync.js";
import { setSetting } from "../src/services/settings.js";
import { app } from "../src/index.js";

const ENV_KEY = "ZENROUTE_QUOTA_SYNC_INTERVAL_MINUTES";

function addGlmConnection(name, quota) {
  return addConnection({
    provider: "glm",
    name,
    credentials: { api_key: "k", ...(quota ? { quota } : {}) },
  });
}

test("quotaSync - syncAllQuotas refreshes every fetcher-backed connection", async () => {
  initDb(":memory:");
  const a = addGlmConnection("A");
  const b = addGlmConnection("B");
  addConnection({ provider: "custom", name: "No Fetcher", credentials: {} });

  const calls = [];
  setCustomQuotaFetcher(async (connection) => {
    calls.push(connection.id);
    return { remaining: 1000, unit: "tokens", is_exhausted: false };
  });

  try {
    const results = await syncAllQuotas();

    assert.strictEqual(calls.length, 2, "only fetcher-backed connections are queried");
    assert.ok(calls.includes(a.id) && calls.includes(b.id));
    assert.strictEqual(results[a.id].ok, true);
    assert.strictEqual(getConnectionById(a.id).credentials.quota.remaining, 1000);
    assert.ok(getConnectionById(a.id).credentials.quota.updated_at > 0);
    assert.ok(results[b.id].ok);
  } finally {
    setCustomQuotaFetcher(null);
  }
});

test("quotaSync - minAgeMs skips connections with a fresh cache", async () => {
  initDb(":memory:");
  const conn = addGlmConnection("Fresh", {
    remaining: 500,
    unit: "tokens",
    is_exhausted: false,
    updated_at: Date.now(),
  });

  const calls = [];
  setCustomQuotaFetcher(async () => {
    calls.push(1);
    return { remaining: 500, unit: "tokens", is_exhausted: false };
  });

  try {
    const results = await syncAllQuotas({ minAgeMs: 60_000 });
    assert.strictEqual(calls.length, 0, "fresh cache must not be refetched");
    assert.deepStrictEqual(results, {});

    const stale = await syncAllQuotas({ minAgeMs: 0 });
    assert.strictEqual(calls.length, 1, "stale cache (minAgeMs off) is refetched");
    assert.ok(stale[conn.id].ok);
  } finally {
    setCustomQuotaFetcher(null);
  }
});

test("quotaSync - getQuotaSyncIntervalMs reads env, defaults to 30min, 0 turns off", () => {
  const prev = process.env[ENV_KEY];
  try {
    delete process.env[ENV_KEY];
    assert.strictEqual(getQuotaSyncIntervalMs(), 30 * 60_000);

    process.env[ENV_KEY] = "45";
    assert.strictEqual(getQuotaSyncIntervalMs(), 45 * 60_000);

    process.env[ENV_KEY] = "0";
    assert.strictEqual(getQuotaSyncIntervalMs(), 0);

    process.env[ENV_KEY] = "not-a-number";
    assert.strictEqual(getQuotaSyncIntervalMs(), 0);
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
});

test("quotaSync - runQuotaSyncTick honors the quota_auto_sync toggle", async () => {
  initDb(":memory:");
  addGlmConnection("Toggled");

  const calls = [];
  setCustomQuotaFetcher(async () => {
    calls.push(1);
    return { remaining: 1, unit: "tokens", is_exhausted: false };
  });

  try {
    setSetting("quota_auto_sync", "false");
    const off = await runQuotaSyncTick({ intervalMs: 0 });
    assert.strictEqual(calls.length, 0, "disabled toggle must not fetch");
    assert.deepStrictEqual(off, {});

    setSetting("quota_auto_sync", "true");
    const on = await runQuotaSyncTick({ intervalMs: 0 });
    assert.strictEqual(calls.length, 1, "enabled toggle fetches");
    assert.ok(Object.keys(on).length === 1);
  } finally {
    setCustomQuotaFetcher(null);
    setSetting("quota_auto_sync", "true");
  }
});

test("quotaSync - scheduler off via env, runs first pass on start, stop clears timer", async () => {
  initDb(":memory:");
  const prev = process.env[ENV_KEY];
  try {
    process.env[ENV_KEY] = "0";
    assert.strictEqual(startQuotaSyncScheduler(), null, "env 0 disables the scheduler");

    process.env[ENV_KEY] = "30";
    setSetting("quota_auto_sync", "true");
    const calls = [];
    setCustomQuotaFetcher(async () => {
      calls.push(1);
      return { remaining: 1, unit: "tokens", is_exhausted: false };
    });
    addGlmConnection("Sched");

    try {
      const timer = startQuotaSyncScheduler();
      assert.ok(timer, "scheduler starts with default interval");
      assert.strictEqual(startQuotaSyncScheduler(), timer, "start is idempotent");

      // First pass runs immediately (async); poll for it.
      for (let i = 0; i < 40 && calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.strictEqual(calls.length, 1, "startup pass syncs once");

      stopQuotaSyncScheduler();
      stopQuotaSyncScheduler(); // idempotent
      assert.ok(true);
    } finally {
      stopQuotaSyncScheduler();
      setCustomQuotaFetcher(null);
    }
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
});

test("GET /api/quota - reflects auto-synced values", async () => {
  initDb(":memory:");
  const conn = addGlmConnection("Live", { remaining: 7, unit: "tokens" });
  setCustomQuotaFetcher(async () => ({ remaining: 999, unit: "tokens", is_exhausted: false }));
  try {
    await syncAllQuotas();
    const res = await app.request("/api/quota");
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    const row = json.find((r) => r.id === conn.id);
    assert.ok(row);
    assert.strictEqual(row.quota.remaining, 999);
  } finally {
    setCustomQuotaFetcher(null);
  }
});
