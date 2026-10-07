import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import {
  addCustomModel,
  listCustomModels,
  deleteCustomModel,
  disableModel,
  disableModels,
  enableModel,
  enableModels,
  isModelDisabled,
} from "../src/services/modelOverrides.js";
import { app } from "../src/index.js";
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

test("bulk disable and enable models", async () => {
  initDb(":memory:");
  const disabledCount = disableModels("glm", ["glm-4-flash", "glm-5.2"]);
  assert.strictEqual(disabledCount, 2);
  assert.ok(isModelDisabled("glm", "glm-4-flash"));
  assert.ok(isModelDisabled("glm", "glm-5.2"));

  const enabledCount = enableModels("glm", ["glm-4-flash", "glm-5.2"]);
  assert.strictEqual(enabledCount, 2);
  assert.ok(!isModelDisabled("glm", "glm-4-flash"));
  assert.ok(!isModelDisabled("glm", "glm-5.2"));

  // Form POST with multiple model_ids
  const fdDisable = new FormData();
  fdDisable.append("provider", "glm");
  fdDisable.append("model_ids", "glm-4-flash");
  fdDisable.append("model_ids", "glm-5.2");
  const resDisable = await app.request("/dashboard/providers/models/disable", {
    method: "POST",
    body: fdDisable,
  });
  assert.strictEqual(resDisable.status, 302);
  assert.strictEqual(resDisable.headers.get("location"), "/dashboard/providers/glm?notice=model_disabled&count=2");
  assert.ok(isModelDisabled("glm", "glm-4-flash"));

  const html = await (await app.request(resDisable.headers.get("location"))).text();
  assert.ok(html.includes("2 model dinonaktifkan."));

  const fdEnable = new FormData();
  fdEnable.append("provider", "glm");
  fdEnable.append("model_ids", "glm-4-flash");
  fdEnable.append("model_ids", "glm-5.2");
  const resEnable = await app.request("/dashboard/providers/models/enable", {
    method: "POST",
    body: fdEnable,
  });
  assert.strictEqual(resEnable.status, 302);
  assert.strictEqual(resEnable.headers.get("location"), "/dashboard/providers/glm?notice=model_enabled&count=2");
  assert.ok(!isModelDisabled("glm", "glm-4-flash"));
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
