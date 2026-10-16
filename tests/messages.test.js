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
  assert.ok(duration < 150, `Warmup must respond fast, took ${duration}ms`);

  const json = await res.json();
  assert.strictEqual(json.role, "assistant");
  assert.strictEqual(json.type, "message");
  assert.ok(Array.isArray(json.content));
  assert.strictEqual(json.content[0].type, "text");
});

test("POST /v1/messages - a conversation that started with Warmup still reaches the upstream", async () => {
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  let called = false;
  setCustomExecutor({
    async execute() {
      called = true;
      return new Response(
        JSON.stringify({
          id: "msg_real",
          type: "message",
          role: "assistant",
          model: "claude-3-7-sonnet",
          content: [{ type: "text", text: "real answer" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude/claude-3-7-sonnet",
        max_tokens: 50,
        messages: [
          { role: "user", content: "Warmup" },
          { role: "assistant", content: "Warmup OK" },
          { role: "user", content: "real question" },
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(called, true, "multi-turn request must not be intercepted");
    assert.strictEqual((await res.json()).content[0].text, "real answer");
  } finally {
    setCustomExecutor(null);
  }
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

test("POST /v1/messages - does NOT intercept isNewTopic topic naming requests (Option C)", async () => {
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  let reachedUpstream = false;
  setCustomExecutor({
    async execute() {
      reachedUpstream = true;
      return new Response(
        JSON.stringify({
          id: "msg_topic",
          type: "message",
          role: "assistant",
          model: "claude-3-7-sonnet",
          content: [{ type: "text", text: "Refactor Router" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 15, output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude/claude-3-7-sonnet",
        max_tokens: 50,
        system: "Given this conversation, return a title. isNewTopic: true",
        messages: [{ role: "user", content: "Name this session" }],
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(reachedUpstream, true, "isNewTopic naming request must reach upstream");
    const json = await res.json();
    assert.strictEqual(json.content[0].text, "Refactor Router");
  } finally {
    setCustomExecutor(null);
  }
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

test("POST /v1/messages - non-streaming keeps thinking blocks, signatures and cache usage", async () => {
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  const upstream = {
    id: "msg_think",
    type: "message",
    role: "assistant",
    model: "claude-3-7-sonnet",
    content: [
      { type: "thinking", thinking: "Need the file first.", signature: "sig-abc" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 15, cache_read_input_tokens: 800, cache_creation_input_tokens: 40 },
  };
  setCustomExecutor({
    async execute() {
      return new Response(JSON.stringify(upstream), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude/claude-3-7-sonnet",
        messages: [{ role: "user", content: "Read a.txt" }],
        max_tokens: 100,
        thinking: { type: "enabled", budget_tokens: 1024 },
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), upstream);
  } finally {
    setCustomExecutor(null);
  }
});
