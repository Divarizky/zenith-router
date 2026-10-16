import test from "node:test";
import assert from "node:assert";
import { AntigravityExecutor } from "../src/executors/antigravity.js";
import { openaiToGeminiRequest, flattenToolUnionsForClaude } from "../src/translator/gemini.js";

const unionTool = {
  type: "function",
  function: {
    name: "question",
    parameters: {
      type: "object",
      properties: {
        option: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              description: "Option with label",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          ],
        },
        mode: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
        count: { oneOf: [{ type: "integer" }, { type: "null" }] },
        items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
      },
      required: ["option"],
    },
  },
};

function declarationParams(request) {
  return request.tools[0].functionDeclarations[0].parameters;
}

test("flattenToolUnionsForClaude - tidak ada anyOf/oneOf tersisa di schema", () => {
  const req = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [unionTool] }, "m");
  const flat = flattenToolUnionsForClaude(req);
  const text = JSON.stringify(declarationParams(flat));
  assert.ok(!text.includes("anyOf"), "anyOf dihapus");
  assert.ok(!text.includes("oneOf"), "oneOf dihapus");
});

test("flattenToolUnionsForClaude - union object memilih cabang object dan memberi hint", () => {
  const req = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [unionTool] }, "m");
  const params = declarationParams(flattenToolUnionsForClaude(req));
  assert.strictEqual(params.properties.option.type, "object");
  assert.deepStrictEqual(Object.keys(params.properties.option.properties), ["label", "description"]);
  assert.match(params.properties.option.description, /Option with label Accepts string or object\./);
});

test("flattenToolUnionsForClaude - null dibuang, enum dan tipe tunggal dipertahankan", () => {
  const req = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [unionTool] }, "m");
  const params = declarationParams(flattenToolUnionsForClaude(req));
  assert.strictEqual(params.properties.mode.type, "string");
  assert.deepStrictEqual(params.properties.mode.enum, ["a", "b"]);
  assert.strictEqual(params.properties.count.type, "integer");
  assert.strictEqual(params.properties.items.items.type, "string");
  assert.match(params.properties.items.items.description, /Accepts string or number\./);
});

test("flattenToolUnionsForClaude - input tidak diubah dan request tanpa tools dikembalikan apa adanya", () => {
  const req = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [unionTool] }, "m");
  const before = JSON.stringify(req);
  flattenToolUnionsForClaude(req);
  assert.strictEqual(JSON.stringify(req), before);
  const noTools = { contents: [] };
  assert.strictEqual(flattenToolUnionsForClaude(noTools), noTools);
});

function captureExecutor() {
  const seen = {};
  const executor = new AntigravityExecutor({
    fetchFn: async (url, init = {}) => {
      seen.body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    },
  });
  return { executor, seen };
}

test("Antigravity executor - model Claude mendapat schema rata, model Gemini tidak berubah", async () => {
  const req = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [unionTool] }, "m");
  const body = JSON.stringify({ project: "p", request: req });
  const conn = { credentials: { project_id: "p" } };

  const { executor: claudeExec, seen: claudeSeen } = captureExecutor();
  await claudeExec.execute({ body, targetModel: "claude-sonnet-4-6", connection: conn });
  assert.ok(!JSON.stringify(claudeSeen.body.request.tools).includes("anyOf"));

  const { executor: geminiExec, seen: geminiSeen } = captureExecutor();
  await geminiExec.execute({ body, targetModel: "gemini-3.6-flash-high", connection: conn });
  assert.ok(JSON.stringify(geminiSeen.body.request.tools).includes("anyOf"), "Gemini tetap menerima anyOf");
});

const toolHistory = {
  model: "m",
  messages: [
    { role: "user", content: "baca file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "toolu_01ABC", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }],
    },
    { role: "tool", tool_call_id: "toolu_01ABC", content: "isi file" },
  ],
};

function callAndResponse(request) {
  const call = request.contents.flatMap((c) => c.parts).find((p) => p.functionCall).functionCall;
  const resp = request.contents.flatMap((c) => c.parts).find((p) => p.functionResponse).functionResponse;
  return { call, resp };
}

test("Gemini request - functionCall dan functionResponse membawa id tool_call yang sama", () => {
  const { call, resp } = callAndResponse(openaiToGeminiRequest(toolHistory, "m"));
  assert.strictEqual(call.id, "toolu_01ABC");
  assert.strictEqual(resp.id, "toolu_01ABC");
});

test("Gemini request - id tanpa klien dibuat pengganti dan dipasangkan berurutan", () => {
  const body = structuredClone(toolHistory);
  delete body.messages[1].tool_calls[0].id;
  delete body.messages[2].tool_call_id;
  const { call, resp } = callAndResponse(openaiToGeminiRequest(body, "m"));
  assert.match(call.id, /^[a-zA-Z0-9_-]+$/);
  assert.strictEqual(resp.id, call.id);
});

test("Gemini request - karakter id yang tidak sah untuk Claude disanitasi konsisten", () => {
  const body = structuredClone(toolHistory);
  body.messages[1].tool_calls[0].id = "call:1/x";
  body.messages[2].tool_call_id = "call:1/x";
  const { call, resp } = callAndResponse(openaiToGeminiRequest(body, "m"));
  assert.strictEqual(call.id, "call_1_x");
  assert.strictEqual(resp.id, "call_1_x");
});

test("Antigravity executor - id tool dikirim ke Claude dan dibuang untuk Gemini", async () => {
  const req = openaiToGeminiRequest(toolHistory, "m");
  const body = JSON.stringify({ project: "p", request: req });
  const conn = { credentials: { project_id: "p" } };

  const { executor: claudeExec, seen: claudeSeen } = captureExecutor();
  await claudeExec.execute({ body, targetModel: "claude-sonnet-4-6", connection: conn });
  const claudeParts = callAndResponse(claudeSeen.body.request);
  assert.strictEqual(claudeParts.call.id, "toolu_01ABC");
  assert.strictEqual(claudeParts.resp.id, "toolu_01ABC");

  const { executor: geminiExec, seen: geminiSeen } = captureExecutor();
  await geminiExec.execute({ body, targetModel: "gemini-3.6-flash-high", connection: conn });
  const geminiParts = callAndResponse(geminiSeen.body.request);
  assert.ok(!("id" in geminiParts.call));
  assert.ok(!("id" in geminiParts.resp));
});

test("Gemini response - id functionCall dari upstream diteruskan ke klien", async () => {
  const { geminiToOpenAIResponse } = await import("../src/translator/gemini.js");
  const res = await geminiToOpenAIResponse(
    { response: { candidates: [{ content: { parts: [{ functionCall: { id: "toolu_up_1", name: "read_file", args: {} } }] } }] } },
    "m"
  );
  assert.strictEqual(res.choices[0].message.tool_calls[0].id, "toolu_up_1");
});

test("Gemini response - thoughtSignature level Part disimpan dan dipakai lagi di request berikutnya", async () => {
  const { geminiToOpenAIResponse, resetGeminiTranslatorState } = await import("../src/translator/gemini.js");
  resetGeminiTranslatorState();
  const res = await geminiToOpenAIResponse(
    {
      response: {
        candidates: [{ content: { parts: [{ functionCall: { id: "toolu_sig", name: "read_file", args: {} }, thoughtSignature: "sigPart" }] } }],
      },
    },
    "m"
  );
  const call = res.choices[0].message.tool_calls[0];
  const next = openaiToGeminiRequest(
    {
      model: "m",
      messages: [
        { role: "user", content: "baca" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "isi" },
      ],
    },
    "m"
  );
  const part = next.contents.flatMap((c) => c.parts).find((p) => p.functionCall);
  assert.strictEqual(part.thoughtSignature, "sigPart");
  assert.ok(!("thoughtSignature" in part.functionCall));
  resetGeminiTranslatorState();
});
