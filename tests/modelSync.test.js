import test from "node:test";
import assert from "node:assert";
import { initDb, getDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import {
  syncFreeModels,
  syncAllFreeModels,
  getSyncIntervalMs,
  startModelSyncScheduler,
} from "../src/services/modelSync.js";
import { listSyncedModels, listImportedModels, getModelSyncState, disableModel } from "../src/services/modelOverrides.js";
import { importProviderModels, getImportModes } from "../src/services/modelImport.js";
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

const CLINE = {
  payload: {
    recommended: [
      { id: "anthropic/claude-opus-4.8" },
      { id: "cline-free/solar-mini4", name: "Solar Mini 4" },
    ],
    free: [
      { id: "cline-free/solar-mini4", name: "Solar Mini 4" },
      { id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash" },
    ],
  },
};

const OPENROUTER = {
  payload: {
    data: [
      { id: "google/gemini-2.0-flash-exp:free" },
      { id: "other/paid-model", pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "meta-llama/llama-3.3-70b-instruct", pricing: { prompt: "0", completion: "0" } },
    ],
  },
};

const MISTRAL = {
  payload: {
    data: [
      // Real /v1/models shape: no pricing fields, free-ness comes from capabilities.
      { id: "mistral-large-latest", name: "Mistral Large 3", capabilities: { completion_chat: true } },
      { id: "devstral-latest", name: "Devstral 2", capabilities: { completion_chat: true } },
      { id: "mistral-embed", capabilities: { completion_chat: false } },
      { id: "mistral-retired-latest", capabilities: { completion_chat: true }, deprecation: "2026-01-01" },
    ],
  },
};

const OLLAMA = {
  payload: {
    data: [
      { id: "llama3.3:latest", pricing: { prompt: "0", completion: "0" } },
      { id: "qwen2.5-coder:32b", pricing: { prompt: "0", completion: "0" } },
    ],
  },
};

const OVH = {
  payload: {
    data: [
      { id: "gpt-oss-120b", context_length: 131072, max_completion_tokens: 131072, pricing: { prompt: "0", completion: "0" } },
      { id: "Qwen3.5-397B-A17B", context_length: 262144, max_completion_tokens: 262144, pricing: { prompt: "0.00000071", completion: "0.00000425" } },
      // Not a chat endpoint: guard models carry a budget but are no chat models.
      { id: "Qwen3Guard-Gen-0.6B", context_length: 32768, max_completion_tokens: 16384, pricing: { prompt: "0", completion: "0" } },
    ],
  },
};

const XKIRO = {
  payload: {
    data: [
      { id: "qwen/qwen3-coder-plus:free", access_tier: "free" },
      { id: "minimax/minimax-m3:free", access_tier: "free" },
    ],
  },
};

const CMC_SYNC = {
  payload: {
    object: "list",
    data: [
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", supported_endpoints: ["/chat/completions"] },
      { id: "stealth/glyph-cluster:free", name: "Glyph", supported_endpoints: ["/chat/completions"] },
      { id: "poolside/laguna-s-2.1-free", name: "Laguna", supported_endpoints: ["/chat/completions"] },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", supported_endpoints: ["/messages"] },
    ],
  },
};

const ids = () => getAvailableModels({ all: true }).map((m) => m.id);

test("opencode sync - live free list replaces the hardcoded list; paid Zen models excluded", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");

  // Before any sync the hardcoded list is the fallback.
  assert.ok(ids().includes("oc/big-pickle"));
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
  assert.ok(routed.includes("kc/deepseek/deepseek-chat"), "hardcoded models stay");
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

test("cline sync - public feed merges free models without requiring an account", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "api.cline.bot": CLINE });

  assert.deepStrictEqual(await syncFreeModels("cline"), { code: "synced", count: 2 });
  const routed = ids();
  assert.ok(routed.includes("cl/anthropic/claude-sonnet-5.5"), "hardcoded models stay in merge mode");
  assert.ok(routed.includes("cl/cline-free/solar-mini4"));
  assert.ok(routed.includes("cl/cline-free/mimo-v2.6-flash"));
});

test("openrouter sync - public model list merges free models without requiring an account", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "openrouter.ai": OPENROUTER });

  assert.deepStrictEqual(await syncFreeModels("openrouter"), { code: "synced", count: 2 });
  const routed = ids();
  assert.ok(routed.includes("or/openrouter/auto"), "hardcoded models stay");
  assert.ok(routed.includes("or/google/gemini-2.0-flash-exp:free"));
  assert.ok(routed.includes("or/meta-llama/llama-3.3-70b-instruct"), "zero pricing counted as free");
  assert.ok(!routed.includes("or/other/paid-model"));
});

test("ollama sync - public cloud model list merges free cloud models without requiring an account", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "ollama.com": { payload: { data: [{ id: "gpt-oss:120b", pricing: { prompt: "0", completion: "0" } }, { id: "mistral-large-4", pricing: { prompt: "0", completion: "0" } }] } } });

  assert.deepStrictEqual(await syncFreeModels("ollama"), { code: "synced", count: 2 });
  const routed = ids();
  assert.ok(routed.includes("ol/kimi-k3"), "hardcoded models stay");
  assert.ok(routed.includes("ol/gpt-oss:120b"));
  assert.ok(routed.includes("ol/mistral-large-4"));
});

test("ovhcloud - free access is account-level credit, so sync is unsupported", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "ovh.net": OVH });

  assert.deepStrictEqual(await syncFreeModels("ovhcloud"), { code: "unsupported", count: 0 });
  // Import still offers the live chat list.
  assert.deepStrictEqual(getImportModes(getProvider("ovhcloud")), ["all"]);
  const imported = await importProviderModels("ovhcloud", "all");
  assert.strictEqual(imported.code, "imported");
  // gpt-oss-120b is built-in; the rest are imported (chat only, guard models dropped).
  assert.strictEqual(imported.count, 1);
  assert.ok(ids().includes("ovh/Qwen3.5-397B-A17B"));
  assert.ok(!ids().includes("ovh/Qwen3Guard-Gen-0.6B"), "guard models are not chat models");
});

test("xkiro sync - public free model list merges free models without requiring an account", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "xkiro.com": XKIRO });

  assert.deepStrictEqual(await syncFreeModels("xkiro"), { code: "synced", count: 2 });
  const routed = ids();
  assert.ok(routed.includes("xkr/qwen/qwen3-coder-plus:free"));
  assert.ok(routed.includes("xkr/minimax/minimax-m3:free"));
});

test("conditional sync - glm, bazaarlink, and mistral require connection, sync when account is added", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");

  // Without connection
  assert.deepStrictEqual(await syncFreeModels("glm"), { code: "no_account", count: 0 });
  assert.deepStrictEqual(await syncFreeModels("bazaarlink"), { code: "no_account", count: 0 });
  assert.deepStrictEqual(await syncFreeModels("mistral"), { code: "no_account", count: 0 });

  // With connection
  addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "glm-key" } });
  addConnection({ provider: "bazaarlink", name: "BZL", credentials: { api_key: "bzl-key" } });
  addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mis-key" } });

  mockUpstream({
    "api.z.ai": { payload: { data: [{ id: "glm-4.7-flash" }, { id: "glm-5.1" }] } },
    "bazaarlink.ai": { payload: { data: [{ id: "auto:free", isFree: true }, { id: "gpt-5.5", isFree: false }] } },
    "api.mistral.ai": MISTRAL,
  });

  assert.deepStrictEqual(await syncFreeModels("glm"), { code: "synced", count: 1 });
  assert.deepStrictEqual(await syncFreeModels("bazaarlink"), { code: "synced", count: 1 });
  assert.deepStrictEqual(await syncFreeModels("mistral"), { code: "synced", count: 2 });
  const routed = ids();
  assert.ok(routed.includes("glm/glm-4.7-flash"));
  assert.ok(routed.includes("bzl/auto:free"));
  assert.ok(routed.includes("mis/mistral-large-latest"));
});

test("sync - only providers with freeModelSync; disabled toggles still apply", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream({
    "opencode.ai": OPENCODE,
    "api.kilo.ai": KILO,
    "api.cline.bot": CLINE,
    "openrouter.ai": OPENROUTER,
    "ollama.com": { payload: { data: [{ id: "gpt-oss:120b" }] } },
    "xkiro.com": XKIRO,
  });
  // commandcode memakai transport mentah (BaseExecutor) agar tidak ditulis
  // ulang oleh CommandCodeExecutor; mock di sini meniru transport itu.
  const { BaseExecutor } = await import("../src/executors/base.js");
  const originalExecute = BaseExecutor.prototype.execute;
  BaseExecutor.prototype.execute = async function (req) {
    calls.push(req);
    return new Response(JSON.stringify(CMC_SYNC.payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { BaseExecutor.prototype.execute = originalExecute; });

  assert.strictEqual((await syncFreeModels("together")).code, "unsupported");
  assert.strictEqual((await syncFreeModels("kiro")).code, "unsupported");
  const cmc = await syncFreeModels("commandcode");
  assert.strictEqual(cmc.code, "synced");
  assert.strictEqual(cmc.count, 2, "hanya model :free, Claude tersaring");

  const results = await syncAllFreeModels();
  assert.deepStrictEqual(Object.keys(results).sort(), [
    "bazaarlink",
    "cline",
    "commandcode",
    "freebuff",
    "glm",
    "kilocode",
    "mistral",
    "ollama",
    "opencode",
    "openrouter",
    "xkiro",
  ]);
  // 7 public providers make calls (+1 dari sync commandcode langsung di atas); bazaarlink, freebuff, glm, dan mistral return no_account tanpa calls
  assert.strictEqual(calls.length, 8);

  disableModel("opencode", "exo-free");
  assert.ok(!ids().includes("oc/exo-free"));
});

test("sync interval - env override, default 6h, 0 turns the scheduler off", () => {
  const original = process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS;
  try {
    delete process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS;
    assert.strictEqual(getSyncIntervalMs(), 6 * 3_600_000);
    process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS = "12";
    assert.strictEqual(getSyncIntervalMs(), 12 * 3_600_000);
    process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS = "0";
    assert.strictEqual(getSyncIntervalMs(), 0);
    assert.strictEqual(startModelSyncScheduler(), null);
    process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS = "abc";
    assert.strictEqual(getSyncIntervalMs(), 0);
  } finally {
    if (original === undefined) delete process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS;
    else process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS = original;
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
  assert.ok(html.includes("Sinkron"));
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

test("mistral sync - drops models the account tier refuses, checked with a zero-token request", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mis-key" } });

  const probes = [];
  setCustomExecutor({
    execute: async (req) => {
      if (req.url.endsWith("/v1/models")) {
        const data = ["ministral-3b-2512", "mistral-medium-latest", "mistral-large-latest", "mistral-small-2603", "labs-leanstral-1-5"].map((id) => ({
          id,
          capabilities: { completion_chat: true },
        }));
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(req.body);
      probes.push(body);
      const err = (status, extra = {}, msg = "Rate limit exceeded") =>
        new Response(JSON.stringify({ object: "error", message: msg }), {
          status,
          headers: { "Content-Type": "application/json", ...extra },
        });
      if (body.model === "mistral-medium-latest") return err(429, { "x-ratelimit-limit-req-minute": "0" });
      if (body.model === "mistral-large-latest") return err(403, {}, "tier_not_allowed: not available in your subscription tier");
      if (body.model === "labs-leanstral-1-5") return err(403, {}, "Model labs-leanstral-1-5 is a Labs model. labs_not_enabled");
      // A transient failure must not drop a model.
      if (body.model === "mistral-small-2603") return err(503);
      return err(400, {}, "messages must not be empty");
    },
  });

  assert.deepStrictEqual(await syncFreeModels("mistral"), { code: "synced", count: 2 });
  assert.ok(probes.every((b) => Array.isArray(b.messages) && b.messages.length === 0), "probes carry no messages");

  const routed = ids();
  assert.ok(routed.includes("mis/ministral-3b-2512"));
  assert.ok(routed.includes("mis/mistral-small-2603"));
  assert.ok(!routed.includes("mis/mistral-medium-latest"), "0/minute model is not listed");
  assert.ok(!routed.includes("mis/mistral-large-latest"), "tier_not_allowed model is not listed");
  assert.ok(!routed.includes("mis/labs-leanstral-1-5"), "Labs model not enabled for the org is not listed");
  assert.ok(!routed.includes("mis/devstral-latest"), "static fallback list is replaced after sync");
});

test("mistral sync - stores the reasoning/vision capabilities the API reports", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mis-key" } });

  setCustomExecutor({
    execute: async (req) => {
      if (req.url.endsWith("/v1/models")) {
        const data = [
          { id: "ministral-14b-latest", capabilities: { completion_chat: true, vision: true, reasoning: false } },
          { id: "codestral-2508", capabilities: { completion_chat: true, vision: false, reasoning: false } },
        ];
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "messages must not be empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.deepStrictEqual(await syncFreeModels("mistral"), { code: "synced", count: 2 });

  const rows = listSyncedModels("mistral");
  const byId = Object.fromEntries(rows.map((r) => [r.model_id, r.capabilities]));
  assert.deepEqual(JSON.parse(byId["ministral-14b-latest"]), { vision: true, reasoning: false });
  assert.deepEqual(JSON.parse(byId["codestral-2508"]), { vision: false, reasoning: false });
});
