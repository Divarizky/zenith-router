import test from "node:test";
import assert from "node:assert";
import { openaiToGeminiRequest, geminiToOpenAIResponse } from "../src/translator/gemini.js";

function toolRequest(name) {
  return {
    model: "gemini-x",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name, parameters: { type: "object", properties: {} } } }],
  };
}

function geminiCall(wireName) {
  return {
    candidates: [{ content: { parts: [{ functionCall: { name: wireName, args: {} } }] } }],
  };
}

// Dua request paralel: "a.b" dan "a-b" sama-sama disanitasi menjadi "a_b".
// Respons untuk tiap request harus memulihkan nama asli request itu sendiri.
test("F-06 gemini: nama tool dipulihkan per request, tidak tertukar antar request paralel", async () => {
  const reqA = openaiToGeminiRequest(toolRequest("a.b"), "gemini-x");
  const reqB = openaiToGeminiRequest(toolRequest("a-b"), "gemini-x");

  const resA = await geminiToOpenAIResponse(geminiCall("a_b"), "gemini-x", { toolNames: reqA.__toolNames });
  const resB = await geminiToOpenAIResponse(geminiCall("a_b"), "gemini-x", { toolNames: reqB.__toolNames });

  assert.strictEqual(resA.choices[0].message.tool_calls[0].function.name, "a.b");
  assert.strictEqual(resB.choices[0].message.tool_calls[0].function.name, "a-b");
});
