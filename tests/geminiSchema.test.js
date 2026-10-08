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
