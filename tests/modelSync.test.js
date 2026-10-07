import test from "node:test";
import assert from "node:assert";
import { initDb, getDb } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import {
  syncFreeModels,
  syncAllFreeModels,
  getSyncIntervalMs,
  startModelSyncScheduler,
} from "../src/services/modelSync.js";
import { listSyncedModels, listImportedModels, getModelSyncState, disableModel } from "../src/services/modelOverrides.js";
import { getAvailableModels, getProvider, getProviderModels } from "../src/providers/index.js";
import { app } from "../src/index.js";

/** Mock upstream: answers per URL substring, records every call. */
function mockUpstream(routes) {
  const calls = [];
  setCustomExecutor({
    execute: async (req) => {
      calls.push(req);
      const hit = Object.entries(routes).find(([key]) => req.url.includes(key));
      if (!hit) return new Response("{}", { status: 404 });
      const [, { payload, status = 200 }] = hit;
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return calls;
}

const OPENCODE = {
  payload: {
    object: "list",
    data: [
      { id: "big-pickle" },
      { id: "exo-free" },
      { id: "muse-spark-1.3-contributor-free" },
      { id: "claude-opus-5-5" },
    ],
  },
};

const KILO = {
  payload: {
    data: [
      { id: "kilo-auto/free", isFree: true, pricing: { prompt: "-1", completion: "-1" } },
      { id: "vendor/a:free" },
      { id: "vendor/b", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/c:free", isFree: false },
      { id: "vendor/paid", pricing: { prompt: "0.000002", completion: "0.000008" } },
    ],
  },
};

const ids = () => getAvailableModels().map((m) => m.id);

test("opencode sync - live free list replaces the hardcoded list; paid Zen models excluded", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");

  // Before any sync the hardcoded list is the fallback.
  assert.ok(ids().includes("oc/union-alpha"));
  assert.strictEqual(getProviderModels(getProvider("opencode"))[0].source, "builtin");

  const calls = mockUpstream({ "opencode.ai": OPENCODE });
  assert.deepStrictEqual(await syncFreeModels("opencode"), { code: "synced", count: 3 });
  assert.ok(!("Authorization" in calls[0].headers), "no credentials for a noAuth provider");

  const routed = ids();
  assert.ok(routed.includes("oc/exo-free"));
  assert.ok(routed.includes("oc/big-pickle"), "free without the -free suffix");
  assert.ok(!routed.includes("oc/union-alpha"), "stale hardcoded model gone after sync");
  assert.ok(!routed.includes("oc/claude-opus-5-5"), "paid Zen model never synced");
  assert.ok(getProviderModels(getProvider("opencode")).every((m) => m.source === "synced"));

  const state = getModelSyncState("opencode");
  assert.strictEqual(state.ok, 1);
  assert.strictEqual(state.count, 3);
  assert.ok(state.last_success_at > 0);
});

test("kilocode sync - free models merge into the hardcoded list (9router kiloFreeModels)", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "api.kilo.ai": KILO });

  assert.deepStrictEqual(await syncFreeModels("kilocode"), { code: "synced", count: 3 });
  const routed = ids();
  assert.ok(routed.includes("kc/deepseek-chat"), "hardcoded models stay");
  assert.ok(routed.includes("kc/kilo-auto/free"));
  assert.ok(routed.includes("kc/vendor/b"), "zero price counts as free");
  assert.ok(!routed.includes("kc/vendor/c:free"), "explicit isFree:false wins over the suffix");
  assert.ok(!routed.includes("kc/vendor/paid"));
});

test("opencode sync - clears leftover imported rows so dropped models stop routing", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  // Rows from before OpenCode switched to sync; one of them is no longer upstream.
  const insert = getDb().prepare(
    "INSERT INTO imported_models (provider, model_id, name, is_free, imported_at) VALUES (?, ?, ?, 1, ?)"
  );
  insert.run("opencode", "exo-free", null, Date.now());
  insert.run("opencode", "retired-free", null, Date.now());
  assert.ok(ids().includes("oc/retired-free"));

  mockUpstream({ "opencode.ai": OPENCODE });
  await syncFreeModels("opencode");
  assert.strictEqual(listImportedModels("opencode").length, 0);
  assert.ok(!ids().includes("oc/retired-free"));
  assert.ok(ids().includes("oc/exo-free"));
});

test("kilocode sync - keeps imported rows (merge providers still offer import)", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  getDb()
    .prepare("INSERT INTO imported_models (provider, model_id, name, is_free, imported_at) VALUES (?, ?, ?, 0, ?)")
    .run("kilocode", "vendor/paid", null, Date.now());

  mockUpstream({ "api.kilo.ai": KILO });
  await syncFreeModels("kilocode");
  assert.deepStrictEqual(listImportedModels("kilocode").map((m) => m.model_id), ["vendor/paid"]);
});

test("sync - failures keep the previous list and record the error", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "opencode.ai": OPENCODE });
  await syncFreeModels("opencode");

  mockUpstream({ "opencode.ai": { payload: { error: "down" }, status: 503 } });
  assert.deepStrictEqual(await syncFreeModels("opencode"), { code: "upstream_error", count: 0, status: 503 });
  assert.strictEqual(listSyncedModels("opencode").length, 3);
  let state = getModelSyncState("opencode");
  assert.strictEqual(state.ok, 0);
  assert.strictEqual(state.count, 3, "count of the list still in use");
  assert.match(state.error, /HTTP 503/);

  // An empty free list is treated as a failure too, never as "no models".
  mockUpstream({ "opencode.ai": { payload: { data: [{ id: "claude-opus-5-5" }] } } });
  assert.strictEqual((await syncFreeModels("opencode")).code, "empty");
  assert.strictEqual(listSyncedModels("opencode").length, 3);

  mockUpstream({ "opencode.ai": OPENCODE });
  await syncFreeModels("opencode");
  state = getModelSyncState("opencode");
  assert.strictEqual(state.ok, 1);
  assert.strictEqual(state.error, null);
});

test("sync - only providers with freeModelSync; disabled toggles still apply", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream({ "opencode.ai": OPENCODE, "api.kilo.ai": KILO });

  assert.strictEqual((await syncFreeModels("glm")).code, "unsupported");
  assert.strictEqual((await syncFreeModels("kiro")).code, "unsupported");

  const results = await syncAllFreeModels();
  assert.deepStrictEqual(Object.keys(results).sort(), ["kilocode", "opencode"]);
  assert.strictEqual(calls.length, 2);

  disableModel("opencode", "exo-free");
  assert.ok(!ids().includes("oc/exo-free"));
});

test("sync interval - env override, default 6h, 0 turns the scheduler off", () => {
  const original = process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS;
  try {
    delete process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS;
    assert.strictEqual(getSyncIntervalMs(), 6 * 3_600_000);
    process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS = "12";
    assert.strictEqual(getSyncIntervalMs(), 12 * 3_600_000);
    process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS = "0";
    assert.strictEqual(getSyncIntervalMs(), 0);
    assert.strictEqual(startModelSyncScheduler(), null);
    process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS = "abc";
    assert.strictEqual(getSyncIntervalMs(), 0);
  } finally {
    if (original === undefined) delete process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS;
    else process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS = original;
  }
});

test("dashboard - Sync Now redirects with a notice and the page shows synced rows and status", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");

  let html = await (await app.request("/dashboard/providers/opencode")).text();
  assert.ok(html.includes("Belum pernah berhasil sinkron"));

  mockUpstream({ "opencode.ai": OPENCODE });
  const fd = new FormData();
  fd.append("provider", "opencode");
  const res = await app.request("/dashboard/providers/models/sync", { method: "POST", body: fd });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/opencode?sync=synced&count=3");

  html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("Sinkron selesai: 3 model gratis."));
  assert.ok(html.includes("Synced"));
  assert.match(html, /Terakhir sinkron \d{2}-\d{2}-\d{4} \d{2}:\d{2} WIB \(3 model\)/);
  assert.ok(!html.includes("oc/union-alpha"));

  // The providers list counts the synced list, not the hardcoded one.
  const list = await (await app.request("/dashboard/providers")).text();
  assert.match(list, /oc\/<\/code> &middot; 3 model/);

  mockUpstream({ "opencode.ai": { payload: {}, status: 502 } });
  const failed = await app.request("/dashboard/providers/models/sync", { method: "POST", body: fd });
  assert.strictEqual(failed.headers.get("location"), "/dashboard/providers/opencode?sync=upstream_error&count=0&status=502");
  html = await (await app.request(failed.headers.get("location"))).text();
  assert.ok(html.includes("Sinkron gagal (HTTP 502)"));
  assert.ok(html.includes("gagal:"));
});
