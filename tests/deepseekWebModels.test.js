import test from "node:test";
import assert from "node:assert";
import { DEEPSEEK_WEB_MODELS, resolveDeepSeekModel } from "../src/services/deepseekWeb/models.js";

test("models - the catalog publishes chat as default and a reasoning mode", () => {
  assert.deepStrictEqual(
    DEEPSEEK_WEB_MODELS.map((model) => model.id),
    ["deepseek-chat", "deepseek-reasoner"]
  );
  assert.strictEqual(DEEPSEEK_WEB_MODELS[0].thinking, false);
  assert.strictEqual(DEEPSEEK_WEB_MODELS[1].thinking, true);
});

test("models - exact ids win, and unknown ids fall back to chat", () => {
  assert.strictEqual(resolveDeepSeekModel("deepseek-chat").thinking, false);
  assert.strictEqual(resolveDeepSeekModel("deepseek-reasoner").thinking, true);
  assert.strictEqual(resolveDeepSeekModel("DEEPSEEK-REASONER").thinking, true);
  assert.strictEqual(resolveDeepSeekModel("some-new-model").thinking, false);
  assert.strictEqual(resolveDeepSeekModel("").thinking, false);
  assert.strictEqual(resolveDeepSeekModel(null).thinking, false);
});

test("models - reasoning spellings still enable thinking", () => {
  for (const id of ["deepseek-r1", "deepseek-r1-distill", "r1", "thinking-model", "deepseek-reasoning"]) {
    assert.strictEqual(resolveDeepSeekModel(id).thinking, true, id);
  }
  // An "r1" glued to a version number is not a reasoning request.
  assert.strictEqual(resolveDeepSeekModel("deepseek-chat-3r1").thinking, false);
  assert.strictEqual(resolveDeepSeekModel("deepseek-v3.2").thinking, false);
});
