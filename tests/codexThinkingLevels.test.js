import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { getAvailableModels } from "../src/providers/index.js";

test("/v1/models mengumumkan xhigh dan max untuk model Codex gpt-6 dan gpt-5.6, tidak untuk gpt-5.5", () => {
  initDb(":memory:");
  const byId = Object.fromEntries(getAvailableModels({ all: true }).map((m) => [m.id, m]));

  for (const id of ["cx/gpt-6-luna", "cx/gpt-6.1-sol", "cx/gpt-5.6-terra"]) {
    assert.deepStrictEqual(byId[id]?.thinking_levels, ["low", "medium", "high", "xhigh", "max"], id);
  }
  assert.strictEqual(byId["cx/gpt-5.5"]?.thinking_levels, undefined, "model tanpa data level tidak diberi klaim");
});
