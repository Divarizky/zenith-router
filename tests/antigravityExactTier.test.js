import test from "node:test";
import assert from "node:assert/strict";
import { initDb, addConnection, replaceAntigravityAccountModels, setConnectionCooldown } from "../src/db/index.js";
import { listAvailableConnections, getNextConnection } from "../src/services/fallback.js";
import { sessionPins } from "../src/services/sessionPin.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { AntigravityExecutor } from "../src/executors/antigravity.js";
import { app } from "../src/index.js";

const model = "gemini-4-carbon";
function account(name, levels, exhausted = false) {
  const c = addConnection({ provider: "antigravity", name, auth_type: "oauth", credentials: { access_token: name, project_id: name } });
  if (levels) replaceAntigravityAccountModels(c.id, "free-tier", levels.map(level => ({
    modelId: `${model}-${level}`, displayName: `Carbon (${level})`, quotaRemaining: exhausted && level === "high" ? 0 : 1,
    quotaResetAt: Date.now() + 3600000,
  })));
  return c;
}
function setup() {
  initDb(":memory:");
  const medium = account("medium", ["medium"]);
  const full = account("full", ["low", "medium", "high"]);
  return { medium, full };
}
function ids(effort) {
  return listAvailableConnections("antigravity", { model, effort }).map(c => c.id);
}

test("prioritas tier persis stabil dan inventori kosong tetap fail-open", () => {
  const { medium, full } = setup();
  const unknown = account("unknown", null);
  assert.deepEqual(ids("high"), [full.id, medium.id, unknown.id]);
  assert.equal(getNextConnection("antigravity", [], model, "high").id, full.id);
  assert.deepEqual(ids("xhigh"), [medium.id, full.id, unknown.id]);
  assert.deepEqual(ids(undefined), [medium.id, full.id, unknown.id]);
});

test("kuota habis atau cooldown mempertahankan fallback; satu akun tidak berubah", () => {
  initDb(":memory:");
  const medium = account("medium", ["medium"]);
  const full = account("full", ["medium", "high"], true);
  assert.deepEqual(ids("high"), [medium.id]);
  replaceAntigravityAccountModels(full.id, "free-tier", [{ modelId: `${model}-high`, displayName: "Carbon (High)", quotaRemaining: 1 }]);
  setConnectionCooldown(full.id, Date.now() + 3600000);
  assert.deepEqual(ids("high"), [medium.id]);
  initDb(":memory:");
  const only = account("only", ["medium"]);
  assert.equal(getNextConnection("antigravity", [], model, "high").id, only.id);
});

test("HTTP memilih runtime high dan pin medium dipertahankan hanya untuk medium", async () => {
  const { medium, full } = setup();
  const sent = [];
  const executor = new AntigravityExecutor({ fetchFn: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  setCustomExecutor(executor);
  const request = effort => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-session-id": "exact-tier-test" }, body: JSON.stringify({ model: `ag/${model}`, reasoning_effort: effort, messages: [{ role: "user", content: "hi" }] }) });
  try {
    sessionPins.set("antigravity", "exact-tier-test", medium.id, model);
    assert.equal((await request("medium")).status, 200);
    assert.equal(sent.at(-1).project, "medium");
    assert.equal((await request("high")).status, 200);
    assert.equal(sent.at(-1).project, "full");
    assert.equal(sent.at(-1).model, `${model}-high`);
    assert.equal(getNextConnection("antigravity", [], model, "high").id, full.id);
  } finally { setCustomExecutor(null); sessionPins.drop("antigravity", "exact-tier-test"); }
});
