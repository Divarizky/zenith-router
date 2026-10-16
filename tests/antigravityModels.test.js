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

const call = (executor, model, request = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }, effort) =>
  executor.execute({
    url: "x",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
    targetModel: model,
    effort,
    connection: { credentials: { project_id: "proj-1" } },
  });

test("antigravity registry - katalog berisi keluarga, bukan varian bertingkat", () => {
  assert.deepStrictEqual(
    antigravity.models.map((m) => m.id),
    ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4-6", "claude-sonnet-4-6", "gpt-oss-120b"]
  );
  for (const m of antigravity.models) {
    assert.ok(!/-high$|-medium$|-low$/.test(m.id), `${m.id} masih memakai akhiran tingkat`);
  }
});

test("antigravity executor - effort memilih varian runtime keluarga", async () => {
  const { executor, seen } = capture();
  for (const [effort, upstream] of [
    ["low", "gemini-4-argon-low"],
    ["medium", "gemini-4-argon-medium"],
    ["high", "gemini-4-argon-high"],
  ]) {
    await call(executor, "gemini-4-argon", undefined, effort);
    assert.strictEqual(seen.body.model, upstream);
  }
  // Tanpa effort, default mengikuti agy: medium.
  await call(executor, "gemini-4-argon");
  assert.strictEqual(seen.body.model, "gemini-4-argon-medium");
  // Level yang tidak punya varian jatuh ke level terdekat, bukan dikirim apa adanya.
  await call(executor, "gemini-4-argon", undefined, "xhigh");
  assert.strictEqual(seen.body.model, "gemini-4-argon-high");
});

test("antigravity executor - keluarga *-tiered membawa tingkat sebagai thinkingLevel", async () => {
  const { executor, seen } = capture();
  for (const [effort, level] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"]]) {
    await call(executor, "gemini-3.8-flash", undefined, effort);
    assert.strictEqual(seen.body.model, "gemini-3.8-flash-tiered");
    assert.strictEqual(seen.body.request.generationConfig.thinkingConfig.thinkingLevel, level);
  }
});

test("antigravity executor - a client thinking choice wins over the model tier", async () => {
  const { executor, seen } = capture();
  await call(executor, "gemini-3.8-flash", {
    contents: [],
    generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
  }, "high");
  assert.strictEqual(seen.body.request.generationConfig.thinkingConfig.thinkingLevel, undefined);
  assert.strictEqual(seen.body.request.generationConfig.thinkingConfig.thinkingBudget, 512);
});

test("antigravity executor - keluarga gemini-3.5-flash dan keluarga satu runtime", async () => {
  const { executor, seen } = capture();
  await call(executor, "gemini-3.5-flash", undefined, "high");
  assert.strictEqual(seen.body.model, "gemini-3-flash-agent");
  await call(executor, "gemini-3.5-flash", undefined, "low");
  assert.strictEqual(seen.body.model, "gemini-3.5-flash-extra-low");
  await call(executor, "gemini-3.5-flash", undefined, "medium");
  assert.strictEqual(seen.body.model, "gemini-3.5-flash-low");
  // Keluarga dengan satu runtime mengabaikan tingkat.
  await call(executor, "claude-sonnet-4-6", undefined, "high");
  assert.strictEqual(seen.body.model, "claude-sonnet-4-6");
  // Id runtime mentah tetap diterima apa adanya.
  await call(executor, "gpt-oss-120b-medium");
  assert.strictEqual(seen.body.model, "gpt-oss-120b-medium");
});
