import test from "node:test";
import assert from "node:assert";
import { initDb, getDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import {
  syncFreeModels,
  syncAllFreeModels,
  refreshProviderCatalog,
  getSyncIntervalMs,
  startModelSyncScheduler,
} from "../src/services/modelSync.js";
import {
  listSyncedModels,
  listImportedModels,
  listRetiredModels,
  getModelSyncState,
  disableModel,
} from "../src/services/modelOverrides.js";
import { importProviderModels, getImportModes } from "../src/services/modelImport.js";
import { getAvailableModels, getProvider, getProviderModels } from "../src/providers/index.js";
import { getComboByName } from "../src/services/combos.js";
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
    opencode: {
      api: "https://opencode.ai/inference/openai/v1",
      models: {
        "big-pickle": { name: "Big Pickle", cost: { input: 0, output: 0 } },
        "exo-free": { name: "Exo", cost: { input: 0, output: 0 } },
        "nemotron-3-ultra-free": { name: "Nemotron 3 Ultra", cost: { input: 0, output: 0 } },
        "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: 3, output: 15 } },
        // Cost is free but upstream retired it: status wins over price.
        "muse-spark-1.3-contributor-free": { name: "Muse Spark 1.3", status: "deprecated", cost: { input: 0, output: 0 } },
        // Free evaluation models are not routed.
        "jev-1.13-free": { name: "JEV 1.13", cost: { input: 0, output: 0 } },
      },
    },
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

const LLM7 = {
  payload: {
    data: [
      {
        id: "codestral-latest",
        tier: "turbo",
        pricing: { input: 0.01, output: 0.02 },
        capabilities: { tools: true },
      },
      { id: "mistral-Nemo-Instruct-2407", tier: "turbo" },
      // Listed but paid: kept as a built-in only if the registry carries it.
      { id: "gpt-oss:20b", tier: "pro", usage_based_only: true },
      { id: "some-new-turbo", tier: "turbo" },
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
  assert.ok(routed.includes("oc/nemotron-3-ultra-free"), "model the legacy /inference/v1 gateway refuses");
  assert.ok(!routed.includes("oc/union-alpha"), "stale hardcoded model gone after sync");
  assert.ok(!routed.includes("oc/claude-opus-5-5"), "paid Zen model never synced");
  assert.ok(!routed.includes("oc/muse-spark-1.3-contributor-free"), "deprecated model never synced");
  assert.ok(!routed.includes("oc/jev-1.13-free"), "free evaluation model never synced");
  assert.ok(getProviderModels(getProvider("opencode")).every((m) => m.source === "synced"));

  const state = getModelSyncState("opencode");
  assert.strictEqual(state.ok, 1);
  assert.strictEqual(state.count, 3);
  assert.ok(state.last_success_at > 0);
});

test("kilocode sync - free models merge into the hardcoded list (kiloFreeModels)", async (t) => {
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

test("llm7 sync - live free list merges, and built-ins the catalog dropped stop routing", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const llm7 = getProvider("llm7");

  // `default` and `fast` are chat aliases: callable, never listed.
  assert.deepStrictEqual(llm7.builtinAliases, ["default", "fast"]);
  assert.ok(ids().includes("llm7/minimax-m2.7"), "hardcoded model listed before any sync");

  mockUpstream({ "api.llm7.io": LLM7 });
  const result = await syncFreeModels("llm7");
  assert.strictEqual(result.code, "synced");
  assert.strictEqual(result.count, 5, "three turbo ids plus the default/fast aliases");

  const routed = ids();
  assert.ok(routed.includes("llm7/codestral-latest"), "turbo id from the live list");
  assert.ok(routed.includes("llm7/some-new-turbo"), "new turbo id merged in");
  assert.ok(routed.includes("llm7/default"), "alias survives the refresh");
  assert.ok(routed.includes("llm7/fast"), "alias survives the refresh");
  assert.ok(routed.includes("llm7/gpt-oss:20b"), "still listed upstream, so kept");
  assert.ok(!routed.includes("llm7/minimax-m2.7"), "not in the catalog: the chat endpoint answers model_unavailable");
  assert.ok(!routed.includes("llm7/GLM-5.3-Flash"));
  assert.ok(result.retired > 0);
});

test("llm7 sync - an empty payload never retires built-in models despite builtinAliases", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  assert.ok(ids().includes("llm7/minimax-m2.7"));

  mockUpstream({ "api.llm7.io": { payload: { data: [] } } });
  const result = await syncFreeModels("llm7");
  assert.strictEqual(result.code, "empty");
  assert.strictEqual(listRetiredModels("llm7").length, 0, "no built-in is retired when upstream returns empty payload");
  assert.ok(ids().includes("llm7/minimax-m2.7"), "built-ins stay routable");
});

test("llm7 sync - a built-in that reappears upstream routes again", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "api.llm7.io": LLM7 });
  await syncFreeModels("llm7");
  assert.ok(!ids().includes("llm7/minimax-m2.7"));

  mockUpstream({
    "api.llm7.io": { payload: { data: [{ id: "minimax-m2.7", tier: "turbo" }] } },
  });
  await syncFreeModels("llm7");
  const routed = ids();
  assert.ok(routed.includes("llm7/minimax-m2.7"), "the retired set is rewritten, not accumulated");
  assert.ok(!routed.includes("llm7/codestral-latest"), "built-in absent from this payload is held back");
});

test("kilo-free sync - the live free list replaces the hardcoded catalog", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  assert.ok(ids().includes("kcf/liquid/lfm-2.5-2.6b:free"), "hardcoded row before sync");

  mockUpstream({ "api.kilo.ai": KILO });
  assert.deepStrictEqual(await syncFreeModels("kilo-free"), { code: "synced", count: 3 });
  assert.strictEqual(listRetiredModels("kilo-free").length, 0, "kilo-free relies on replace mode, not retired_models");
  const routed = ids();
  assert.ok(routed.includes("kcf/kilo-auto/free"));
  assert.ok(routed.includes("kcf/vendor/b"));
  assert.ok(!routed.includes("kcf/liquid/lfm-2.5-2.6b:free"), "retired id no longer offered");
  assert.ok(!routed.includes("kcf/vendor/paid"));
  assert.ok(getProviderModels(getProvider("kilo-free")).every((m) => m.source === "synced"));
});

test("catalog refresh - ovhcloud retires built-ins the live list dropped", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  assert.ok(ids().includes("ovh/Qwen2.5-VL-72B-Instruct"));

  mockUpstream({
    "kepler.ai.cloud.ovh.net": {
      payload: {
        data: [
          { id: "gpt-oss-120b", context_length: 131072, max_completion_tokens: 32768 },
          { id: "Mistral-Small-3.2-24B-Instruct-2506", context_length: 32768, max_completion_tokens: 8192 },
          { id: "text-embedding-3-large", context_length: 8192, max_completion_tokens: 0 },
        ],
      },
    },
  });

  const result = await refreshProviderCatalog("ovhcloud");
  assert.strictEqual(result.code, "refreshed");
  assert.strictEqual(result.retired, 3);
  const routed = ids();
  assert.ok(routed.includes("ovh/gpt-oss-120b"));
  assert.ok(!routed.includes("ovh/Qwen3.6-27B"));
  assert.ok(!routed.includes("ovh/Qwen2.5-VL-72B-Instruct"));
  assert.ok(!routed.includes("ovh/gpt-oss-20b"));
  assert.strictEqual(listSyncedModels("ovhcloud").length, 0, "no free list is invented");
});

test("catalog refresh - an empty payload never retires the whole catalog", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({ "kepler.ai.cloud.ovh.net": { payload: { data: [] } } });

  const result = await refreshProviderCatalog("ovhcloud");
  assert.strictEqual(result.code, "empty");
  assert.strictEqual(result.retired, 0);
  assert.ok(ids().includes("ovh/Qwen3.6-27B"), "built-ins stay when upstream answers nothing");
  assert.strictEqual(getModelSyncState("ovhcloud").ok, 0);
});

test("catalog refresh - providers without catalogRefresh are refused", async () => {
  initDb(":memory:");
  assert.strictEqual((await refreshProviderCatalog("together")).code, "unsupported");
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
  mockUpstream({
    "opencode.ai": {
      payload: {
        opencode: {
          api: "https://opencode.ai/inference/openai/v1",
          models: { "claude-opus-5-5": { cost: { input: 3, output: 15 } } },
        },
      },
    },
  });
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

test("ollama sync - the public list is filtered by what a free key can actually call", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  // The real /v1/models carries no pricing fields, so a listed id is no proof of
  // being free: gemma3:4b answers 402 on a free key and glm-5.3 is paid. Only
  // gpt-oss:20b from this payload is callable without credits.
  mockUpstream({
    "ollama.com": {
      payload: {
        data: [{ id: "gpt-oss:20b" }, { id: "gemma3:4b" }, { id: "glm-5.3" }],
      },
    },
  });

  assert.deepStrictEqual(await syncFreeModels("ollama"), { code: "synced", count: 1 });
  const routed = ids();
  assert.ok(routed.includes("ol/gemma4:31b"), "hardcoded models stay");
  assert.ok(routed.includes("ol/gpt-oss:20b"), "a callable free-plan model is synced");
  assert.ok(!routed.includes("ol/gemma3:4b"), "listed upstream but 402 on a free key, so not synced");
  assert.ok(!routed.includes("ol/glm-5.3"), "a paid model is not synced as free");
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

test("conditional sync - glm requires connection, sync when account is added", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");

  // Without connection
  assert.deepStrictEqual(await syncFreeModels("glm"), { code: "no_account", count: 0 });

  // With connection
  addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "glm-key" } });

  mockUpstream({
    "api.z.ai": { payload: { data: [{ id: "glm-4.7-flash" }, { id: "glm-5.1" }] } },
  });

  assert.deepStrictEqual(await syncFreeModels("glm"), { code: "synced", count: 1 });
  const routed = ids();
  assert.ok(routed.includes("glm/glm-4.7-flash"));
});

test("sync - only providers with freeModelSync; disabled toggles still apply", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream({
    "opencode.ai": OPENCODE,
    "api.kilo.ai": KILO,
    "api.llm7.io": LLM7,
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
    "cline",
    "commandcode",
    "freebuff",
    "glm",
    "kilo-free",
    "kilocode",
    "llm7",
    "ollama",
    "opencode",
    "openrouter",
    "xkiro",
  ]);
  // 9 public providers make calls (+1 dari sync commandcode langsung di atas); freebuff dan glm return no_account tanpa calls
  assert.strictEqual(calls.length, 10);

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

test("dashboard - catalog-only provider offers Sync Now and reports retired ids", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");

  // OVHcloud has no per-model free tier, but its catalog can still drift.
  const html = await (await app.request("/dashboard/providers/ovhcloud")).text();
  assert.ok(html.includes("Katalog model disinkron otomatis"));
  assert.ok(html.includes("Sinkron Sekarang"));
  assert.ok(html.includes("menyembunyikan model bawaan yang sudah tidak ada"));

  mockUpstream({
    "kepler.ai.cloud.ovh.net": {
      payload: { data: [{ id: "gpt-oss-120b", context_length: 131072, max_completion_tokens: 32768 }] },
    },
  });
  const fd = new FormData();
  fd.append("provider", "ovhcloud");
  const res = await app.request("/dashboard/providers/models/sync", { method: "POST", body: fd });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/ovhcloud?sync=refreshed&count=4&retired=4");

  const page = await (await app.request(res.headers.get("location"))).text();
  assert.ok(page.includes("4 model bawaan sudah tidak ada di provider"));
  assert.ok(page.includes("Katalog diperbarui"));
});

test("dashboard - manual sync rebuilds the managed combos without probing upstream", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream({ "api.llm7.io": LLM7 });
  assert.strictEqual(getComboByName("zenith-free"), null, "no combo before the first sync");

  const fd = new FormData();
  fd.append("provider", "llm7");
  const res = await app.request("/dashboard/providers/models/sync", { method: "POST", body: fd });
  assert.strictEqual(res.status, 302);

  const combo = getComboByName("zenith-free");
  assert.ok(combo, "manual sync stores the managed combos");
  assert.strictEqual(combo.enabled, 1);
  assert.ok(combo.models.includes("llm7/codestral-latest"), "newly synced id is routable at once");
  assert.ok(!combo.models.includes("llm7/minimax-m2.7"), "retired id never enters the combo");
  assert.strictEqual(calls.length, 1, "the rebuild issues no probe request");
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
