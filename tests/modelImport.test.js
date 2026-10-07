import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { importProviderModels } from "../src/services/modelImport.js";
import { listImportedModels } from "../src/services/modelOverrides.js";
import { getAvailableModels } from "../src/providers/index.js";
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

const OPENCODE_LIST = {
  object: "list",
  data: [
    { id: "big-pickle" },
    { id: "exo-free" },
    { id: "muse-spark-1.2-contributor-free" },
    { id: "claude-opus-5-5" },
  ],
};

test("opencode import - free only, no credentials, paid Zen models excluded", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  const calls = mockUpstream(OPENCODE_LIST);

  const result = await importProviderModels("opencode", "free");
  assert.deepStrictEqual(result, { code: "imported", count: 2 });
  assert.strictEqual(calls[0].url, "https://opencode.ai/zen/v1/models");
  assert.strictEqual(calls[0].method, "GET");
  assert.ok(!("Authorization" in calls[0].headers));

  // big-pickle is free without the suffix; the built-in muse-spark entry is not duplicated.
  const ids = listImportedModels("opencode").map((m) => m.model_id);
  assert.deepStrictEqual(ids, ["big-pickle", "exo-free"]);

  const routed = getAvailableModels().map((m) => m.id);
  assert.ok(routed.includes("oc/exo-free"));
  assert.ok(!routed.includes("oc/claude-opus-5-5"));

  // "all" is not offered for OpenCode: paid models would need an API key.
  assert.strictEqual((await importProviderModels("opencode", "all")).code, "unsupported");
});

test("kilocode import - all vs free uses payload evidence (explicit isFree wins)", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream({
    data: [
      { id: "kilo-auto/free", isFree: true, pricing: { prompt: "-1", completion: "-1" } },
      { id: "vendor/a:free" },
      { id: "vendor/b", pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/c:free", isFree: false },
      { id: "vendor/paid", pricing: { prompt: "0.000002", completion: "0.000008" } },
    ],
  });

  assert.deepStrictEqual(await importProviderModels("kilocode", "free"), { code: "imported", count: 3 });
  assert.deepStrictEqual(
    listImportedModels("kilocode").map((m) => m.model_id),
    ["kilo-auto/free", "vendor/a:free", "vendor/b"]
  );

  // Re-import replaces the previous rows.
  assert.deepStrictEqual(await importProviderModels("kilocode", "all"), { code: "imported", count: 5 });
  const rows = listImportedModels("kilocode");
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows.find((m) => m.model_id === "vendor/paid").is_free, 0);
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
  mockUpstream(OPENCODE_LIST);
  await importProviderModels("opencode", "free");

  mockUpstream({ error: "nope" }, 503);
  assert.deepStrictEqual(await importProviderModels("opencode", "free"), {
    code: "upstream_error",
    count: 0,
    status: 503,
  });
  assert.strictEqual(listImportedModels("opencode").length, 2);

  assert.strictEqual((await importProviderModels("kiro", "all")).code, "unsupported");
});

test("dashboard import flow - modal, redirect notice, Free pill, and clear", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  mockUpstream(OPENCODE_LIST);

  let html = await (await app.request("/dashboard/providers/opencode")).text();
  assert.ok(html.includes("Import Models"));
  assert.ok(html.includes("Hanya model gratis"));
  assert.ok(!html.includes(`value="all"`), "OpenCode offers free-only import");

  // Providers without an importer do not show the button.
  const kiro = await (await app.request("/dashboard/providers/kiro")).text();
  assert.ok(!kiro.includes("openModal('import-models-modal')"));

  const res = await app.request("/dashboard/providers/models/import", {
    method: "POST",
    body: form({ provider: "opencode", mode: "free" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/opencode?import=imported&count=2");

  html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("2 model berhasil di-import."));
  assert.ok(html.includes("oc/exo-free"));
  assert.ok(html.includes("Imported"));
  assert.ok(html.includes(">Free</span>"));
  assert.ok(html.includes("Clear Imported"));

  // Unknown notice codes are ignored rather than echoed.
  const bogus = await (await app.request("/dashboard/providers/opencode?import=%3Cscript%3E")).text();
  assert.ok(!bogus.includes("<script>x"));
  assert.ok(!bogus.includes(`class="notice`));

  const cleared = await app.request("/dashboard/providers/models/import/clear", {
    method: "POST",
    body: form({ provider: "opencode" }),
  });
  assert.strictEqual(cleared.headers.get("location"), "/dashboard/providers/opencode?import=cleared");
  assert.strictEqual(listImportedModels("opencode").length, 0);
});
