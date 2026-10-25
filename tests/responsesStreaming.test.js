import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("POST /v1/responses - streams Responses API events from OpenAI upstream SSE", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM account",
    credentials: { api_key: "test-key" },
  });

  setCustomExecutor({
    async execute() {
      const chunks = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Halo "},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"dunia"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        input: "hi",
        stream: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const text = await res.text();
    assert.ok(text.includes("event: response.created"), "Must emit response.created");
    assert.ok(text.includes("event: response.output_item.added"), "Must emit response.output_item.added");
    assert.ok(text.includes("event: response.output_text.delta"), "Must emit response.output_text.delta");
    assert.ok(text.includes("Halo "), "Must carry stream text delta 1");
    assert.ok(text.includes("dunia"), "Must carry stream text delta 2");
    assert.ok(text.includes("event: response.completed"), "Must emit response.completed");
  } finally {
    setCustomExecutor(null);
  }
});

test("POST /v1/responses - mid-stream error event emits response.failed and error event", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM account",
    credentials: { api_key: "test-key" },
  });

  setCustomExecutor({
    async execute() {
      const chunks = [
        'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Awal teks "},"finish_reason":null}]}\n\n',
        'data: {"error":{"code":"context_length_exceeded","message":"Context limit reached"}}\n\n',
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        input: "hi",
        stream: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("event: response.failed"), "Must emit response.failed");
    assert.ok(text.includes("event: error"), "Must emit error event");
    assert.ok(text.includes("Context limit reached"), "Carries error message");
    assert.ok(!text.includes("event: response.completed"), "Must not emit response.completed on error");
  } finally {
    setCustomExecutor(null);
  }
});
