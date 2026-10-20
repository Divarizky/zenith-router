import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import { OpencodeExecutor, ensureAssistantReasoningContent } from "../src/executors/opencode.js";

test("ensureAssistantReasoningContent - mengisi reasoning_content kosong hanya untuk model DeepSeek", () => {
  const deepseekBody = {
    model: "deepseek-v4.1-flash-free",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "first", tool_calls: [] },
      { role: "assistant", content: "second", reasoning_content: "already here" },
      { role: "assistant", content: "third", reasoning_content: null },
    ],
  };
  ensureAssistantReasoningContent(deepseekBody, "deepseek-v4.1-flash-free");
  assert.strictEqual(deepseekBody.messages[1].reasoning_content, "");
  assert.strictEqual(deepseekBody.messages[2].reasoning_content, "already here");
  assert.strictEqual(deepseekBody.messages[3].reasoning_content, null);

  const nonDeepseekBody = {
    model: "nemotron-3-ultra-free",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "answer" },
    ],
  };
  ensureAssistantReasoningContent(nonDeepseekBody, "nemotron-3-ultra-free");
  assert.strictEqual(nonDeepseekBody.messages[1].reasoning_content, undefined);

  // Robust terhadap input tidak valid
  ensureAssistantReasoningContent(null, "deepseek-v4.1-flash-free");
  ensureAssistantReasoningContent({}, "deepseek-v4.1-flash-free");
  ensureAssistantReasoningContent({ messages: "not-an-array" }, "deepseek-v4.1-flash-free");
});

test("OpencodeExecutor - request chat multi-turn DeepSeek otomatis melengkapi reasoning_content pada pesan assistant", async () => {
  initDb(":memory:");
  let capturedBody = null;
  const proto = Object.getPrototypeOf(OpencodeExecutor.prototype);
  const origExecute = proto.execute;
  proto.execute = async function ({ body }) {
    capturedBody = typeof body === "string" ? JSON.parse(body) : body;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode/deepseek-v4.1-flash-free",
        stream: false,
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
        messages: [
          { role: "user", content: "call tool" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "file content" },
          { role: "assistant", content: "done", reasoning_content: "my reasoning" },
          { role: "user", content: "continue" },
        ],
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.ok(capturedBody, "payload terkirim ke upstream");
    const msgs = capturedBody.messages;
    const a1 = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    const a2 = msgs.find((m) => m.role === "assistant" && m.content === "done");
    assert.strictEqual(a1.reasoning_content, "", "turn assistant tanpa reasoning dilengkapi string kosong");
    assert.strictEqual(a2.reasoning_content, "my reasoning", "turn assistant yang sudah punya reasoning tidak ditimpa");
  } finally {
    proto.execute = origExecute;
  }
});

test("OpencodeExecutor - endpoint Claude /v1/messages ke DeepSeek tetap membawa reasoning_content ke upstream", async () => {
  initDb(":memory:");
  let capturedBody = null;
  const proto = Object.getPrototypeOf(OpencodeExecutor.prototype);
  const origExecute = proto.execute;
  proto.execute = async function ({ body }) {
    capturedBody = typeof body === "string" ? JSON.parse(body) : body;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode/deepseek-v4.1-flash-free",
        max_tokens: 100,
        stream: false,
        tools: [{ name: "read_file", input_schema: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: "call tool" },
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "content" }] },
        ],
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.ok(capturedBody);
    const msgs = capturedBody.messages;
    const a = msgs.find((m) => m.role === "assistant");
    assert.ok(a);
    assert.strictEqual(a.reasoning_content, "", "client claude yang tidak mengirim thinking tetap aman");
  } finally {
    proto.execute = origExecute;
  }
});
