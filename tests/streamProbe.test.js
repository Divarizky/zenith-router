import test from "node:test";
import assert from "node:assert";
import { isStreamErrorEvent, probeStreamError, streamErrorStatus } from "../src/services/streamProbe.js";

function sseResponse(parts, status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

test("streamProbe - error event shapes", () => {
  assert.ok(isStreamErrorEvent("", { error: { message: "limit" } }));
  assert.ok(isStreamErrorEvent("", { type: "error", error: { type: "overloaded_error" } }));
  assert.ok(isStreamErrorEvent("", { success: false }));
  assert.ok(isStreamErrorEvent("error", { message: "x" }));
  assert.ok(!isStreamErrorEvent("", { choices: [{ delta: { content: "hi" } }] }));
  assert.ok(!isStreamErrorEvent("", { error: null, choices: [] }));
  assert.ok(!isStreamErrorEvent("", { type: "message_start", message: {} }));
});

test("streamProbe - status mapping", () => {
  assert.strictEqual(streamErrorStatus({ error: { code: 402 } }), 402);
  assert.strictEqual(streamErrorStatus({ status: 503 }), 503);
  assert.strictEqual(streamErrorStatus({ error: { code: 200, message: "boom" } }), 502, "status sukses tidak dipakai");
  assert.strictEqual(streamErrorStatus({ error: { message: "Rate limit exceeded" } }), 429);
  assert.strictEqual(streamErrorStatus({ error: { code: "insufficient_quota", message: "x" } }), 429);
  assert.strictEqual(streamErrorStatus({ error: { type: "authentication_error", message: "x" } }), 401);
  assert.strictEqual(streamErrorStatus({ error: { message: "something broke" } }), 502);
});

test("streamProbe - an error split across chunks becomes an error response", async () => {
  const res = await probeStreamError(sseResponse([': ping\n\nda', 'ta: {"error":{"message":"quota habis"}}', "\n\n"]));
  assert.strictEqual(res.status, 429);
  const data = await res.json();
  assert.strictEqual(data.error.message, "quota habis");
});

test("streamProbe - a healthy stream is replayed byte for byte", async () => {
  const parts = [": ping\n\n", 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n', "data: [DONE]\n\n"];
  const res = await probeStreamError(sseResponse(parts));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), parts.join(""));
});

test("streamProbe - non-stream and failed responses are left alone", async () => {
  const json = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  assert.strictEqual(await probeStreamError(json), json);
  const failed = sseResponse(["data: {}\n\n"], 500);
  assert.strictEqual(await probeStreamError(failed), failed);
});

test("streamProbe - a stream that breaks before any event becomes a 502", async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error("socket reset"));
    },
  });
  const res = await probeStreamError(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  assert.strictEqual(res.status, 502);
  assert.match((await res.json()).error.message, /socket reset/);
});
