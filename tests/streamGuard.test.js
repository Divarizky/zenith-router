import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";
import { getConsoleLogs, clearConsoleLogs } from "../src/services/logger.js";
import { describeStreamError, guardStream } from "../src/services/streamGuard.js";

const encoder = new TextEncoder();

function resetError() {
  return new TypeError("terminated", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
  });
}

/** Upstream body that emits `chunk`, then resets the connection. */
function resettingStream(chunk) {
  return new ReadableStream({
    start(controller) {
      if (chunk) controller.enqueue(encoder.encode(chunk));
    },
    pull(controller) {
      controller.error(resetError());
    },
  });
}

async function readAll(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test("describeStreamError - names the socket step", () => {
  assert.strictEqual(describeStreamError(resetError()), "terminated [ECONNRESET]");
  assert.strictEqual(describeStreamError(new Error("boom")), "boom");
});

test("guardStream - closes on reset, appends an error frame, logs to dashboard only", async () => {
  clearConsoleLogs();
  const res = guardStream(new Response(resettingStream('data: {"id":"1"}\n\n')), {
    label: "glm test-model",
    format: "openai",
  });

  const text = await readAll(res);

  assert.ok(text.includes('data: {"id":"1"}'), "bytes before the reset must survive");
  assert.ok(text.includes('"code":"upstream_stream_reset"'), "client must see an error frame");
  const logs = getConsoleLogs();
  assert.ok(
    logs.some((l) => l.includes("Stream reset from glm test-model: terminated [ECONNRESET]")),
    "reset must be logged for the dashboard"
  );
});

test("guardStream - a client hang-up is not logged as an upstream reset", async () => {
  clearConsoleLogs();
  const controller = new AbortController();
  controller.abort();
  const res = guardStream(new Response(resettingStream('data: {"id":"1"}\n\n')), {
    signal: controller.signal,
    label: "glm test-model",
  });

  const text = await readAll(res);

  assert.ok(!text.includes("upstream_stream_reset"), "nobody is left to read the error frame");
  assert.ok(!getConsoleLogs().some((l) => l.includes("Stream reset from glm test-model")));
});

test("POST /v1/chat/completions - upstream reset mid-stream ends SSE with an OpenAI error frame", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
  clearConsoleLogs();

  setCustomExecutor({
    async execute() {
      return new Response(resettingStream('data: {"id":"1","choices":[{"delta":{"content":"Hel"}}]}\n\n'), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  try {
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
    const text = await readAll(res);

    assert.ok(text.includes('"content":"Hel"'), "partial answer must reach the client");
    assert.ok(text.includes('"code":"upstream_stream_reset"'), "reset must be reported in-band");
    assert.ok(getConsoleLogs().some((l) => l.includes("Stream reset from glm glm-4-flash")));
  } finally {
    setCustomExecutor(null);
  }
});

test("POST /v1/messages - upstream reset mid-stream ends SSE with a Claude error event", async () => {
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  clearConsoleLogs();

  setCustomExecutor({
    async execute() {
      return new Response(resettingStream('event: message_start\ndata: {"type":"message_start"}\n\n'), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude/claude-3-7-sonnet",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    assert.strictEqual(res.status, 200);
    const text = await readAll(res);

    assert.ok(text.includes("event: message_start"), "partial answer must reach the client");
    assert.ok(text.includes("event: error"), "reset must be reported in-band");
    assert.ok(text.includes('"type":"api_error"'));
  } finally {
    setCustomExecutor(null);
  }
});
