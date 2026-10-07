import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";

test("POST /v1/messages - returns 400 on missing or invalid payload", async () => {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.strictEqual(res.status, 400);
  const json = await res.json();
  assert.ok(json.error);
  assert.strictEqual(json.type, "error");
});

test("POST /v1/messages - intercepts Claude Code Warmup request instantly (<15ms)", async () => {
  const start = Date.now();
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/0.2.29",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Warmup" }],
      stream: false,
    }),
  });
  const duration = Date.now() - start;

  assert.strictEqual(res.status, 200);
  assert.ok(duration < 50, `Warmup must respond fast, took ${duration}ms`);

  const json = await res.json();
  assert.strictEqual(json.role, "assistant");
  assert.strictEqual(json.type, "message");
  assert.ok(Array.isArray(json.content));
  assert.strictEqual(json.content[0].type, "text");
});

test("POST /v1/messages - intercepts Claude Code Warmup in streaming mode", async () => {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/0.2.29",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Warmup" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }

  assert.ok(received.includes("message_start"));
  assert.ok(received.includes("content_block_delta"));
  assert.ok(received.includes("message_stop"));
});

test("POST /v1/messages - non-streaming relays upstream Anthropic response", async () => {
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  const mockAnthropicResponse = {
    id: "msg_12345",
    type: "message",
    role: "assistant",
    model: "claude-3-7-sonnet",
    content: [{ type: "text", text: "Hello from Claude upstream!" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 15 },
  };

  const mockExecutor = {
    async execute() {
      return new Response(JSON.stringify(mockAnthropicResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  setCustomExecutor(mockExecutor);

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude/claude-3-7-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      stream: false,
    }),
  });

  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.id, "msg_12345");
  assert.strictEqual(json.content[0].text, "Hello from Claude upstream!");

  setCustomExecutor(null);
});
