import test from "node:test";
import assert from "node:assert/strict";
import { initDb, addConnection } from "../src/db/index.js";
import { getAvailableModels, getProvider, getProviderModels } from "../src/providers/index.js";
import { listSyncedModels } from "../src/services/modelOverrides.js";
import { syncCodexModels } from "../src/services/codexModelSync.js";
import { saveOAuthConnection } from "../src/services/oauth/flows.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const creds = { access_token: "mock-value", account_id: "account-2" };

test("Codex login discovers models with the new account credentials", async (t) => {
  initDb(":memory:");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let request;
  let done;
  const called = new Promise((resolve) => { done = resolve; });
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), ...init };
    done();
    return json({ models: [
      { slug: "gpt-new", display_name: "GPT New", visibility: "list" },
      { slug: "internal", visibility: "hide" },
    ] });
  };
  const connection = saveOAuthConnection("codex", { ...creds, extra: { account_id: creds.account_id } });
  assert.ok(connection.id);
  await called;
  for (let i = 0; i < 20 && !listSyncedModels("codex").length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(request.url, /\/backend-api\/codex\/models\?client_version=/);
  assert.equal(request.headers.get("Authorization"), "Bearer mock-value");
  assert.equal(request.headers.get("chatgpt-account-id"), "account-2");
  assert.equal(request.headers.get("Accept"), "application/json");
  assert.ok(getProviderModels(getProvider("codex")).some((m) => m.id === "gpt-new"));
  assert.ok(getAvailableModels().some((m) => m.id === "cx/gpt-new"));
  assert.ok(!listSyncedModels("codex").some((m) => m.model_id === "internal"));
});

test("Codex discovery keeps previously synced models when a later sync fails or returns empty", async (t) => {
  initDb(":memory:");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const connection = addConnection({ provider: "codex", name: "test", auth_type: "oauth", credentials: creds });
  globalThis.fetch = async () => json({ models: [{ slug: "first" }] });
  await syncCodexModels(connection);
  globalThis.fetch = async () => json({ models: [{ slug: "second" }] });
  await syncCodexModels(connection);
  globalThis.fetch = async () => json({}, 500);
  await syncCodexModels(connection);
  globalThis.fetch = async () => json({ models: [] });
  await syncCodexModels(connection);
  assert.deepEqual(listSyncedModels("codex").map((m) => m.model_id).sort(), ["first", "second"]);
});

test("Codex login tetap berhasil ketika discovery gagal, dan koneksi tetap tersimpan", async (t) => {
  initDb(":memory:");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let attempted;
  const discoveryAttempted = new Promise((resolve) => { attempted = resolve; });
  // A 200 with a non-JSON body makes response.json() throw inside syncCodexModels.
  globalThis.fetch = async () => { attempted(); return new Response("<html>not json</html>", { status: 200 }); };
  const connection = saveOAuthConnection("codex", { ...creds, extra: { account_id: creds.account_id } });
  assert.ok(connection.id, "login menghasilkan koneksi meski discovery gagal");
  await discoveryAttempted;
  // Sync runs fire-and-forget; yield until its rejection has been caught by the login flow.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listSyncedModels("codex"), [], "tidak ada model sinkron dari discovery yang gagal");
});

test("Codex sync membuat id model tanpa suffix menjadi cx/ dengan thinking levels xhigh dan max", async (t) => {
  initDb(":memory:");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const connection = addConnection({ provider: "codex", name: "test", auth_type: "oauth", credentials: creds });
  globalThis.fetch = async () => json({ models: [{ slug: "gpt-6" }, { slug: "gpt-5.6" }, { slug: "gpt-5.5" }] });
  await syncCodexModels(connection);
  const byId = Object.fromEntries(getAvailableModels({ all: true }).map((m) => [m.id, m]));
  assert.deepEqual(byId["cx/gpt-6"]?.thinking_levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(byId["cx/gpt-5.6"]?.thinking_levels, ["low", "medium", "high", "xhigh", "max"]);
  // gpt-5.5 also exists in the builtin catalog, so the sync result is checked directly.
  assert.ok(listSyncedModels("codex").some((m) => m.model_id === "gpt-5.5"), "gpt-5.5 harus tersinkron");
  assert.equal(byId["cx/gpt-5.5"].thinking_levels, undefined);
});
