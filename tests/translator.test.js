import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import {
  translateRequest,
  translateResponse,
  createTransformStream,
} from "../src/translator/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";

test("Translator Request - converts OpenAI payload to Claude format", () => {
  const openAIBody = {
    model: "claude-3-7-sonnet",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Write a hello world program." },
    ],
    temperature: 0.7,
    max_tokens: 1024,
    stream: true,
  };

  const claudePayload = translateRequest("openai", "claude", openAIBody, "claude-3-7-sonnet");

  assert.strictEqual(claudePayload.model, "claude-3-7-sonnet");
  assert.strictEqual(claudePayload.system, "You are a coding assistant.");
  assert.strictEqual(claudePayload.messages.length, 1);
  assert.strictEqual(claudePayload.messages[0].role, "user");
  assert.strictEqual(claudePayload.messages[0].content, "Write a hello world program.");
  assert.strictEqual(claudePayload.max_tokens, 1024);
  assert.strictEqual(claudePayload.stream, true);
});

test("Translator Request - converts Claude payload to OpenAI format", () => {
  const claudeBody = {
    model: "gpt-4o",
    system: "You are an AI assistant.",
    messages: [{ role: "user", content: "Hello there!" }],
    max_tokens: 500,
  };

  const openAIPayload = translateRequest("claude", "openai", claudeBody, "gpt-4o");

  assert.strictEqual(openAIPayload.model, "gpt-4o");
  assert.strictEqual(openAIPayload.messages.length, 2);
  assert.strictEqual(openAIPayload.messages[0].role, "system");
  assert.strictEqual(openAIPayload.messages[0].content, "You are an AI assistant.");
  assert.strictEqual(openAIPayload.messages[1].role, "user");
  assert.strictEqual(openAIPayload.messages[1].content, "Hello there!");
});

test("Translator Response - converts Claude message to OpenAI completion", () => {
  const claudeMessage = {
    id: "msg_abc123",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet",
    content: [{ type: "text", text: "Here is your code." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 10 },
  };

  const openAIResponse = translateResponse("claude", "openai", claudeMessage);

  assert.strictEqual(openAIResponse.object, "chat.completion");
  assert.strictEqual(openAIResponse.choices[0].message.content, "Here is your code.");
  assert.strictEqual(openAIResponse.choices[0].finish_reason, "stop");
  assert.strictEqual(openAIResponse.usage.prompt_tokens, 20);
  assert.strictEqual(openAIResponse.usage.completion_tokens, 10);
});

test("Translator Stream - converts Claude SSE events to OpenAI SSE stream", async () => {
  const claudeSSEEvents = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-3"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  const inputStream = new ReadableStream({
    start(controller) {
      for (const ev of claudeSSEEvents) {
        controller.enqueue(new TextEncoder().encode(ev));
      }
      controller.close();
    },
  });

  const transformStream = createTransformStream("claude", "openai", "claude-3");
  const outputStream = inputStream.pipeThrough(transformStream);

  const reader = outputStream.getReader();
  const decoder = new TextDecoder();
  let received = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }

  assert.ok(received.includes("chat.completion.chunk"));
  assert.ok(received.includes("Hello"));
  assert.ok(received.includes(" world"));
  assert.ok(received.includes("[DONE]"));
});

test("POST /v1/chat/completions - cross-vendor routing to Claude upstream with translation", async () => {
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  // Client sends OpenAI request to Claude model. Upstream returns Claude format.
  const mockClaudeResponse = {
    id: "msg_cross_1",
    type: "message",
    role: "assistant",
    model: "claude-3-7-sonnet",
    content: [{ type: "text", text: "Generated via translated Claude upstream" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 15, output_tokens: 25 },
  };

  let capturedUpstreamBody = null;
  const mockExecutor = {
    async execute({ body }) {
      capturedUpstreamBody = JSON.parse(body);
      return new Response(JSON.stringify(mockClaudeResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  setCustomExecutor(mockExecutor);

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cc/claude-3-7-sonnet",
      messages: [
        { role: "system", content: "System rule" },
        { role: "user", content: "Tell me a joke" },
      ],
      stream: false,
    }),
  });

  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.object, "chat.completion");
  assert.strictEqual(json.choices[0].message.content, "Generated via translated Claude upstream");

  // Verify that upstream request was translated to Claude format (system extracted)
  assert.ok(capturedUpstreamBody.system.startsWith("System rule"));
  assert.strictEqual(capturedUpstreamBody.messages.length, 1);
  assert.strictEqual(capturedUpstreamBody.messages[0].role, "user");

  setCustomExecutor(null);
});

test("Translator Request - maps role developer to system for OpenAI-compatible upstreams", () => {
  const body = {
    model: "mis/mistral-large-latest",
    messages: [
      { role: "developer", content: "You are a coding assistant." },
      { role: "user", content: "Hi" },
    ],
  };

  const passthrough = translateRequest("openai", "openai", body, "mistral-large-latest");
  assert.deepStrictEqual(passthrough.messages.map((m) => m.role), ["system", "user"]);
  assert.strictEqual(passthrough.messages[0].content, "You are a coding assistant.");
  assert.strictEqual(body.messages[0].role, "developer", "input body is not mutated");

  const claude = translateRequest("openai", "claude", body, "claude-sonnet-4-5");
  assert.ok(String(JSON.stringify(claude.system)).includes("You are a coding assistant."), "developer prompt becomes Claude system");
  assert.ok(claude.messages.every((m) => m.role !== "developer"));
});
