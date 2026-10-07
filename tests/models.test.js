import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { getAvailableModels, getProvider } from "../src/providers/index.js";

test("Provider Registry - contains 8 core providers", () => {
  const providers = ["claude", "codex", "github", "kiro", "antigravity", "glm", "opencode", "kilocode"];
  for (const id of providers) {
    const p = getProvider(id);
    assert.ok(p, `Provider ${id} must exist in registry`);
    assert.strictEqual(p.id, id);
    assert.ok(Array.isArray(p.models), `Provider ${id} must have models array`);
    assert.ok(p.models.length > 0, `Provider ${id} must provide at least one model`);
  }
});

test("Provider Registry - getAvailableModels aggregates model list with provider prefixes", () => {
  const models = getAvailableModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);

  // Checks structure of each model item
  const first = models[0];
  assert.ok(first.id, "Model must have id");
  assert.strictEqual(first.object, "model");
  assert.ok(first.owned_by, "Model must have owned_by");

  // Check some expected models exist with alias or prefix
  const modelIds = models.map((m) => m.id);
  assert.ok(modelIds.some((id) => id.startsWith("glm/") || id.startsWith("glm:")), "Must contain GLM model");
  assert.ok(modelIds.some((id) => id.startsWith("claude/") || id.startsWith("cc/")), "Must contain Claude model");
});

test("GET /v1/models - returns OpenAI compatible model list", async () => {
  const res = await app.request("/v1/models");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.strictEqual(json.object, "list");
  assert.ok(Array.isArray(json.data));
  assert.ok(json.data.length > 0);

  const first = json.data[0];
  assert.ok(first.id);
  assert.strictEqual(first.object, "model");
  assert.ok(first.owned_by);
});
