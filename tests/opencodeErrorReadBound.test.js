import test from "node:test";
import assert from "node:assert";
import {
  OpencodeExecutor,
  resetOpencodeProtocolLanes,
} from "../src/executors/opencode.js";
import { ERROR_BODY_MAX_BYTES, ERROR_BODY_TRUNCATED_MARKER } from "../src/utils/errorBody.js";
import { resetOpencodeGate } from "../src/services/opencodeGate.js";

// A stalled upstream error body: the first `text` arrives, the stream never closes.
function stalledErrorResponse(status, text, headers = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
}

function requestBody(model) {
  return JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: false });
}

const TARGET = "https://opencode.ai/inference/v1/chat/completions";

test("OpenCode 400 protocol probe reads a stalled error body within the deadline", async () => {
  resetOpencodeProtocolLanes();
  resetOpencodeGate();
  let calls = 0;
  const executor = new OpencodeExecutor({
    fetchFn: async (url) => {
      calls += 1;
      if (url.includes("/chat/completions")) {
        return stalledErrorResponse(400, JSON.stringify({ error: { type: "ModelProtocolUnsupported", message: "use /responses" } }));
      }
      return new Response(JSON.stringify({ id: "r", choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const started = Date.now();
  await executor.execute({ url: TARGET, method: "POST", body: requestBody("protocol-probe-model"), timeoutMs: 20000, stream: false });
  const elapsed = Date.now() - started;
  // The contract is a 5 s total read deadline. A stalled body must end near it, never beyond.
  assert.ok(elapsed < 8000, `protocol probe ran ${elapsed} ms; the stalled body must hit the 5 s deadline`);
  assert.ok(calls >= 1);
});

test("OpenCode 429 quota gate reads a stalled error body once and returns within the deadline", async () => {
  resetOpencodeProtocolLanes();
  resetOpencodeGate();
  const quotaText = JSON.stringify({ error: { type: "FreeUsageLimitError", message: "Free usage limit reached" } });
  const big = quotaText + "x".repeat(ERROR_BODY_MAX_BYTES);
  let calls = 0;
  const executor = new OpencodeExecutor({
    fetchFn: async () => {
      calls += 1;
      return stalledErrorResponse(429, big);
    },
  });
  const started = Date.now();
  const res = await executor.execute({ url: TARGET, method: "POST", body: requestBody("gate-quota-model"), timeoutMs: 20000, stream: false });
  assert.ok(Date.now() - started < 8000, "the gate peek must not stack a second deadline");
  assert.strictEqual(calls, 1, "a quota limit does not trigger a second upstream request");
  assert.ok(res, "executor returns a response");
  const text = await res.text();
  assert.ok(text.includes(ERROR_BODY_TRUNCATED_MARKER), "the returned body carries the truncation marker");
});

test("OpenCode 200 success path is not capped or re-read", async () => {
  resetOpencodeProtocolLanes();
  resetOpencodeGate();
  const payload = JSON.stringify({ id: "ok", choices: [{ message: { content: "y".repeat(ERROR_BODY_MAX_BYTES + 500) } }] });
  const executor = new OpencodeExecutor({
    fetchFn: async () => new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  const res = await executor.execute({ url: TARGET, method: "POST", body: requestBody("success-model"), timeoutMs: 20000, stream: false });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.strictEqual(text, payload, "a successful body is passed through unchanged");
});
