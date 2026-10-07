import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { getUsageStats } from "../src/services/usage.js";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("POST /v1/chat/completions - non-streaming records usage in SQLite", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "GLM User",
    credentials: { api_key: "k1" },
  });

  const mockResponse = {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "glm-4-flash",
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
  };

  const mockExecutor = {
    async execute() {
      return new Response(JSON.stringify(mockResponse), {
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
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    }),
  });

  assert.strictEqual(res.status, 200);

  // Check that usage was recorded in SQLite
  const stats = getUsageStats();
  assert.strictEqual(stats.summary.total_requests, 1);
  assert.strictEqual(stats.summary.total_input_tokens, 42);
  assert.strictEqual(stats.summary.total_output_tokens, 18);
  assert.strictEqual(stats.summary.total_tokens, 60);

  setCustomExecutor(null);
});

test("POST /v1/chat/completions - streaming records token usage after stream completes", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "codex",
    name: "Codex User",
    credentials: { api_key: "k2" },
  });

  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":25,"total_tokens":40}}\n\n',
    "data: [DONE]\n\n",
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const ch of sseChunks) {
        controller.enqueue(new TextEncoder().encode(ch));
      }
      controller.close();
    },
  });

  const mockExecutor = {
    async execute() {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  };
  setCustomExecutor(mockExecutor);

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "codex/gpt-4o",
      messages: [{ role: "user", content: "stream test" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 200);

  // Consume entire stream to trigger completion
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }

  // Allow next event tick for async usage recording
  await new Promise((r) => setTimeout(r, 50));

  const stats = getUsageStats();
  assert.strictEqual(stats.summary.total_requests, 1);
  assert.strictEqual(stats.summary.total_input_tokens, 15);
  assert.strictEqual(stats.summary.total_output_tokens, 25);
  assert.strictEqual(stats.summary.total_tokens, 40);

  setCustomExecutor(null);
});

test("POST /v1/chat/completions - streaming records estimated tokens when upstream omits usage chunk", async () => {
  initDb(":memory:");

  addConnection({
    provider: "glm",
    name: "GLM User",
    credentials: { api_key: "k3" },
  });

  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello world of coding"}}]}\n\n',
    "data: [DONE]\n\n",
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const ch of sseChunks) {
        controller.enqueue(new TextEncoder().encode(ch));
      }
      controller.close();
    },
  });

  setCustomExecutor({
    async execute() {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "Tell me something nice" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 200);

  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }

  await new Promise((r) => setTimeout(r, 50));

  const stats = getUsageStats();
  assert.strictEqual(stats.summary.total_requests, 1);
  assert.ok(stats.summary.total_input_tokens > 0, "Input tokens should be estimated > 0");
  assert.ok(stats.summary.total_output_tokens > 0, "Output tokens should be estimated > 0");
  assert.ok(stats.summary.total_tokens > 0, "Total tokens should be > 0");

  setCustomExecutor(null);
});
