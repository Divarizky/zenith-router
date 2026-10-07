import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { importProviderModels, getImportModes } from "../src/services/modelImport.js";
import { listImportedModels } from "../src/services/modelOverrides.js";
import { getAvailableModels, getProvider } from "../src/providers/index.js";
import { app } from "../src/index.js";

/** Mock upstream that records each call and answers with `payload` (or `status`). */
function mockUpstream(payload, status = 200) {
  const calls = [];
  setCustomExecutor({
    execute: async (req) => {
      calls.push(req);
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return calls;
}

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const KILO_LIST = {
  data: [
    { id: "kilo-auto/free", isFree: true, pricing: { prompt: "-1", completion: "-1" } },
    { id: "vendor/a:free" },
    { id: "vendor/b", pricing: { prompt: "0", completion: "0" } },
    { id: "vendor/c:free", isFree: false },
    { id: "vendor/paid", pricing: { prompt: "0.000002", completion: "0.000008" } },
  ],
};

test("import modes - free-only import is dropped for providers that sync free models", () => {
  assert.deepStrictEqual(getImportModes(getProvider("opencode")), []);
  assert.deepStrictEqual(getImportModes(getProvider("kilocode")), ["all"]);
  assert.deepStrictEqual(getImportModes(getProvider("glm")), ["all", "free"]);
  assert.deepStrictEqual(getImportModes(getProvider("kiro")), []);
});

test("opencode import - refused because its free models are synced automatically", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream({ data: [{ id: "exo-free" }] });

  assert.strictEqual((await importProviderModels("opencode", "free")).code, "unsupported");
  assert.strictEqual((await importProviderModels("opencode", "all")).code, "unsupported");
  assert.strictEqual(calls.length, 0);
});

test("kilocode import - all models, with the free flag kept per row", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream(KILO_LIST);

  assert.deepStrictEqual(await importProviderModels("kilocode", "all"), { code: "imported", count: 5 });
  assert.strictEqual(calls[0].url, "https://api.kilo.ai/api/openrouter/models");
  const rows = listImportedModels("kilocode");
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows.find((m) => m.model_id === "vendor/paid").is_free, 0);
  assert.strictEqual(rows.find((m) => m.model_id === "vendor/c:free").is_free, 0, "explicit isFree:false wins");
  assert.ok(getAvailableModels().some((m) => m.id === "kc/vendor/paid"));

  assert.strictEqual((await importProviderModels("kilocode", "free")).code, "unsupported");
});

test("glm import - needs an account, sends its key, free rule from Omni catalog", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream({ data: [{ id: "glm-4.7-flash" }, { id: "glm-5.1" }] });

  assert.deepStrictEqual(await importProviderModels("glm", "all"), { code: "no_account", count: 0 });
  assert.strictEqual(calls.length, 0);

  addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "glm-key" }, proxy_url: "http://127.0.0.1:7890" });
  assert.deepStrictEqual(await importProviderModels("glm", "free"), { code: "imported", count: 1 });
  assert.strictEqual(calls[0].headers.Authorization, "Bearer glm-key");
  assert.strictEqual(calls[0].proxyUrl, "http://127.0.0.1:7890");
  assert.deepStrictEqual(listImportedModels("glm").map((m) => m.model_id), ["glm-4.7-flash"]);
});

test("claude import - OAuth token gets the oauth beta header and only claude-* ids", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Max", auth_type: "oauth", credentials: { access_token: "tok" } });
  const calls = mockUpstream({ data: [{ id: "claude-new-model", display_name: "Claude New" }, { id: "other" }] });

  assert.deepStrictEqual(await importProviderModels("claude", "all"), { code: "imported", count: 1 });
  assert.strictEqual(calls[0].headers.Authorization, "Bearer tok");
  assert.strictEqual(calls[0].headers["anthropic-beta"], "oauth-2025-04-20");
  assert.strictEqual(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.strictEqual(listImportedModels("claude")[0].name, "Claude New");
  assert.strictEqual((await importProviderModels("claude", "free")).code, "unsupported");
});

test("import - upstream error keeps the previous import and unsupported providers are refused", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream(KILO_LIST);
  await importProviderModels("kilocode", "all");

  mockUpstream({ error: "nope" }, 503);
  assert.deepStrictEqual(await importProviderModels("kilocode", "all"), {
    code: "upstream_error",
    count: 0,
    status: 503,
  });
  assert.strictEqual(listImportedModels("kilocode").length, 5);

  assert.strictEqual((await importProviderModels("kiro", "all")).code, "unsupported");
});

test("dashboard import flow - modal, redirect notice, selection column, and clear", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream(KILO_LIST);

  let html = await (await app.request("/dashboard/providers/kilocode")).text();
  assert.ok(html.includes("openModal('import-models-modal')"));
  assert.ok(html.includes(`value="all"`));
  assert.ok(!html.includes(`value="free"`), "free models are synced, not imported");
  assert.ok(!html.includes(`data-select-all="imported"`), "no selection column without imported rows");

  // OpenCode syncs its free models: no import button, a Sync Now button instead.
  const oc = await (await app.request("/dashboard/providers/opencode")).text();
  assert.ok(!oc.includes("openModal('import-models-modal')"));
  assert.ok(oc.includes("Sync Now"));

  const res = await app.request("/dashboard/providers/models/import", {
    method: "POST",
    body: form({ provider: "kilocode", mode: "all" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/kilocode?import=imported&count=5");

  html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("5 model berhasil di-import."));
  assert.ok(html.includes("kc/vendor/paid"));
  assert.ok(html.includes("Imported"));
  assert.ok(html.includes(">Free</span>"));
  assert.ok(html.includes(`data-select-all="imported"`));
  assert.strictEqual((html.match(/name="model_ids"/g) || []).length, 5, "one checkbox per imported row");
  assert.ok(html.includes("Delete Selected"));
  assert.ok(html.includes("Clear Imported"));

  // Unknown notice codes are ignored rather than echoed.
  const bogus = await (await app.request("/dashboard/providers/kilocode?import=%3Cscript%3E")).text();
  assert.ok(!bogus.includes(`class="notice`));

  const cleared = await app.request("/dashboard/providers/models/import/clear", {
    method: "POST",
    body: form({ provider: "kilocode" }),
  });
  assert.strictEqual(cleared.headers.get("location"), "/dashboard/providers/kilocode?import=cleared");
  assert.strictEqual(listImportedModels("kilocode").length, 0);
});

test("POST /dashboard/providers/models/import/delete - removes only the selected imported models", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream(KILO_LIST);
  await importProviderModels("kilocode", "all");

  const fd = new FormData();
  fd.append("provider", "kilocode");
  fd.append("model_ids", "vendor/paid");
  fd.append("model_ids", "vendor/b");
  fd.append("model_ids", "not-imported");
  const res = await app.request("/dashboard/providers/models/import/delete", { method: "POST", body: fd });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/kilocode?import=deleted&count=2");

  const left = listImportedModels("kilocode").map((m) => m.model_id);
  assert.deepStrictEqual(left, ["kilo-auto/free", "vendor/a:free", "vendor/c:free"]);
  assert.ok(!getAvailableModels().some((m) => m.id === "kc/vendor/paid"));

  const html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("2 model hasil import dihapus."));

  // A single selected value and an empty selection both work.
  const one = await app.request("/dashboard/providers/models/import/delete", {
    method: "POST",
    body: form({ provider: "kilocode", model_ids: "vendor/a:free" }),
  });
  assert.strictEqual(one.headers.get("location"), "/dashboard/providers/kilocode?import=deleted&count=1");
  const none = await app.request("/dashboard/providers/models/import/delete", {
    method: "POST",
    body: form({ provider: "kilocode" }),
  });
  assert.strictEqual(none.headers.get("location"), "/dashboard/providers/kilocode?import=deleted&count=0");

  // Another provider's rows are never touched through this provider's form.
  const other = await app.request("/dashboard/providers/models/import/delete", {
    method: "POST",
    body: form({ provider: "glm", model_ids: "kilo-auto/free" }),
  });
  assert.strictEqual(other.headers.get("location"), "/dashboard/providers/glm?import=deleted&count=0");
  assert.strictEqual(listImportedModels("kilocode").length, 2);
});
