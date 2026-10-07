import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import {
  addCustomModel,
  listCustomModels,
  deleteCustomModel,
  disableModel,
  enableModel,
  isModelDisabled,
} from "../src/services/modelOverrides.js";
import { getAvailableModels, resolveModel } from "../src/providers/index.js";

test("custom models merge into model route table", () => {
  initDb(":memory:");
  addCustomModel({ provider: "glm", model_id: "glm-4-thinking", name: "GLM 4 Thinking" });
  const models = getAvailableModels();
  const found = models.find((m) => m.id === "glm/glm-4-thinking");
  assert.ok(found, "custom model should appear in /v1/models");
  assert.strictEqual(found.custom, true);
  deleteCustomModel(listCustomModels()[0].id);
  assert.ok(!getAvailableModels().find((m) => m.id === "glm/glm-4-thinking"));
});

test("disabled models are filtered from route table and resolveModel", () => {
  initDb(":memory:");
  disableModel("glm", "glm-4-flash");
  assert.ok(isModelDisabled("glm", "glm-4-flash"));
  assert.strictEqual(resolveModel("glm/glm-4-flash"), null);
  assert.ok(!getAvailableModels().find((m) => m.id === "glm/glm-4-flash"));
  enableModel("glm", "glm-4-flash");
  assert.ok(resolveModel("glm/glm-4-flash"));
});

test("live model catalogs from modelsFetcher merge into route table", async () => {
  initDb(":memory:");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    json: async () => ({ object: "list", data: [{ id: "claude-fable-5", object: "model" }] }),
  });
  try {
    const { refreshModelFetchers } = await import("../src/services/modelFetchers.js");
    await refreshModelFetchers();
    const models = getAvailableModels();
    assert.ok(models.find((m) => m.id === "oc/claude-fable-5"), "live model should appear");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("free tier catalog mirrors Omni shape", async () => {
  const { FREE_TIER_BUDGETS, FREE_TIER_TOS, computeFreeTierTotals } = await import(
    "../src/config/freeTierCatalog.js"
  );
  assert.ok(FREE_TIER_BUDGETS.kiro > 0);
  assert.strictEqual(FREE_TIER_TOS.kiro, "avoid");
  const totals = computeFreeTierTotals();
  assert.ok(totals.providers >= 1);
  assert.ok(totals.monthlyTokens > 0);
});
