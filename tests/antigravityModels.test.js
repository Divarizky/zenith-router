import test from "node:test";
import assert from "node:assert";
import { AntigravityExecutor } from "../src/executors/antigravity.js";
import antigravity from "../src/providers/registry/antigravity.js";

function capture() {
  const seen = {};
  const executor = new AntigravityExecutor({
    fetchFn: async (url, init = {}) => {
      seen.url = url;
      seen.body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    },
  });
  return { executor, seen };
}

const call = (executor, model, request = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }) =>
  executor.execute({
    url: "x",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
    targetModel: model,
    connection: { credentials: { project_id: "proj-1" } },
  });

test("antigravity registry - no model id carries a (tier) suffix, Google answers 404 for those", () => {
  for (const m of antigravity.models) {
    assert.ok(!/\(.*\)/.test(m.upstreamModelId || m.id), `${m.id} still uses a suffixed upstream name`);
  }
});

test("antigravity executor - tier variants share one *-tiered model and set thinkingLevel", async () => {
  const { executor, seen } = capture();
  for (const [id, upstream, level] of [
    ["gemini-3.8-flash-high", "gemini-3.8-flash-tiered", "high"],
    ["gemini-3.7-flash-low", "gemini-3.7-flash-tiered", "low"],
    ["gemini-3.6-flash-medium", "gemini-3.6-flash-tiered", "medium"],
  ]) {
    await call(executor, id);
    assert.strictEqual(seen.body.model, upstream);
    assert.strictEqual(seen.body.request.generationConfig.thinkingConfig.thinkingLevel, level);
  }
});

test("antigravity executor - a client thinking choice wins over the model tier", async () => {
  const { executor, seen } = capture();
  await call(executor, "gemini-3.8-flash-high", {
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
  });
  assert.strictEqual(seen.body.request.generationConfig.thinkingConfig.thinkingLevel, undefined);
  assert.strictEqual(seen.body.request.generationConfig.thinkingConfig.thinkingBudget, 512);
});

test("antigravity executor - gemini-3.5-flash-high maps to gemini-3-flash-agent, plain models are untouched", async () => {
  const { executor, seen } = capture();
  await call(executor, "gemini-3.5-flash-high");
  assert.strictEqual(seen.body.model, "gemini-3-flash-agent");
  assert.strictEqual(seen.body.request.generationConfig, undefined);
  await call(executor, "claude-sonnet-4-6");
  assert.strictEqual(seen.body.model, "claude-sonnet-4-6");
  assert.strictEqual(seen.body.request.generationConfig, undefined);
});
