import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { BaseExecutor, setCustomExecutor } from "../src/executors/base.js";

test("BaseExecutor - executes fetch with timeout and headers", async () => {
  const mockFetch = async (url, options) => {
    return new Response(JSON.stringify({ mock: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const executor = new BaseExecutor({ fetchFn: mockFetch });
  const res = await executor.execute({
    url: "https://api.example.com/v1/chat",
    headers: { Authorization: "Bearer test" },
    body: JSON.stringify({ message: "hi" }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.ok, true);
  const json = await res.json();
  assert.strictEqual(json.mock, true);
});

test("POST /v1/chat/completions - returns 400 on missing or invalid payload", async () => {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.strictEqual(res.status, 400);
  const json = await res.json();
  assert.ok(json.error);
  assert.strictEqual(json.error.type, "invalid_request_error");
});

test("POST /v1/chat/completions - returns 404 when model is not recognized", async () => {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "unknown-provider/fake-model-123",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.strictEqual(res.status, 404);
  const json = await res.json();
  assert.ok(json.error);
  assert.strictEqual(json.error.code, "model_not_found");
});

test("POST /v1/chat/completions - non-streaming relays upstream completion", async () => {
  // Setup mock executor
  const mockResponse = {
    id: "chatcmpl-mock-1",
    object: "chat.completion",
    created: Date.now(),
    model: "glm-4-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello from zenroute!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
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
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
  });

  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.object, "chat.completion");
  assert.strictEqual(json.choices[0].message.content, "Hello from zenroute!");
});

test("POST /v1/chat/completions - streaming relays SSE events and completes with [DONE]", async () => {
  const sseChunks = [
    'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":" world"}}]}\n\n',
    "data: [DONE]\n\n",
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
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
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hi" }],
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

  assert.ok(received.includes("Hello"));
  assert.ok(received.includes(" world"));
  assert.ok(received.includes("[DONE]"));

  // Reset custom executor after test
  setCustomExecutor(null);
});

test("POST /v1/chat/completions - upstream failure returns standard OpenAI error", async () => {
  const mockExecutor = {
    async execute() {
      return new Response(
        JSON.stringify({
          error: { message: "Rate limit exceeded upstream", type: "rate_limit_error" },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  };
  setCustomExecutor(mockExecutor);

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.strictEqual(res.status, 429);
  const json = await res.json();
  assert.ok(json.error);
  assert.strictEqual(json.error.message, "Rate limit exceeded upstream");

  setCustomExecutor(null);
});
