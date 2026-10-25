import test from "node:test";
import assert from "node:assert";
import { openaiToGeminiRequest } from "../src/translator/gemini.js";

test("Gemini schema - strips const/patternProperties inside anyOf", () => {
  const out = openaiToGeminiRequest({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "t", parameters: {
      type: "object",
      properties: {
        mode: { anyOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }] },
        map: { type: "object", patternProperties: { "^x": { type: "string" } } },
      },
    } } }],
  }, "gemini-3-pro");
  const json = JSON.stringify(out);
  assert.ok(!json.includes('"const"'));
  assert.ok(!json.includes("patternProperties"));
  assert.ok(json.includes('"enum":["a"]'));
});

test("Gemini thinkingConfig - translates reasoning_effort into thinkingConfig", () => {
  const withEffort = openaiToGeminiRequest({
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
  }, "gemini-3.8-flash");
  assert.deepStrictEqual(withEffort.generationConfig.thinkingConfig, { includeThoughts: true });

  const disabledEffort = openaiToGeminiRequest({
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "none",
  }, "gemini-3.8-flash");
  assert.deepStrictEqual(disabledEffort.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

