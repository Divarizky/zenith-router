import test from "node:test";
import assert from "node:assert";
import {
  readErrorBody,
  readErrorText,
  ERROR_BODY_MAX_BYTES,
  ERROR_BODY_TRUNCATED_MARKER,
} from "../src/utils/errorBody.js";

// A body that delivers its chunks and then never closes, the way a stalled upstream does.
function stalledResponse(firstChunk) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
    },
  });
  return new Response(body, { status: 429 });
}

// A body that streams far more than the cap, then closes.
function endlessResponse(chunkText, count) {
  const encoder = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(encoder.encode(chunkText));
    },
  });
  return new Response(body, { status: 429 });
}

test("readErrorBody returns a small complete body untouched", async () => {
  const res = new Response('{"error":{"message":"rate limit"}}', { status: 429 });
  const result = await readErrorBody(res);
  assert.strictEqual(result.text, '{"error":{"message":"rate limit"}}');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.timedOut, false);
});

test("readErrorBody truncates a body larger than the byte cap and adds the marker", async () => {
  const res = endlessResponse("x".repeat(1024), 200); // 200 KiB total
  const result = await readErrorBody(res, { maxBytes: 4096, timeoutMs: 2000 });
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.timedOut, false);
  assert.ok(result.text.endsWith(ERROR_BODY_TRUNCATED_MARKER));
  const payload = result.text.slice(0, -ERROR_BODY_TRUNCATED_MARKER.length);
  assert.strictEqual(new TextEncoder().encode(payload).byteLength, 4096);
});

test("readErrorBody keeps the first 64 KiB by default", async () => {
  const res = endlessResponse("a".repeat(4096), 64); // 256 KiB total
  const result = await readErrorBody(res);
  assert.strictEqual(result.truncated, true);
  const payload = result.text.slice(0, -ERROR_BODY_TRUNCATED_MARKER.length);
  assert.strictEqual(payload.length, ERROR_BODY_MAX_BYTES);
});

test("readErrorBody marks an exact-size body as complete, not truncated", async () => {
  const res = new Response("y".repeat(100), { status: 429 });
  const result = await readErrorBody(res, { maxBytes: 100, timeoutMs: 2000 });
  assert.strictEqual(result.text, "y".repeat(100));
  assert.strictEqual(result.truncated, false);
});

test("readErrorBody gives up on a stalled body within the timeout", async () => {
  const res = stalledResponse("partial");
  const started = Date.now();
  const result = await readErrorBody(res, { maxBytes: 65536, timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.text.startsWith("partial"));
  assert.ok(elapsed < 1000, `read took ${elapsed}ms, expected close to the 200ms timeout`);
});

test("readErrorBody returns empty text without throwing when there is no body", async () => {
  const result = await readErrorBody({ status: 500 });
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.truncated, false);
});

test("readErrorText keeps the classifier-visible prefix of a huge body", async () => {
  const head = '{"error":{"message":"You have exceeded your quota"}}';
  const res = new Response(head + "z".repeat(200 * 1024), { status: 429 });
  const text = await readErrorText(res);
  assert.ok(text.startsWith(head));
  assert.ok(text.endsWith(ERROR_BODY_TRUNCATED_MARKER));
});

test("readErrorBody returns promptly at exactly 64 KiB even when the stream hangs after the cap", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("z".repeat(ERROR_BODY_MAX_BYTES)));
      // never closed: the stream stalls right after the cap
    },
  });
  const res = new Response(body, { status: 429 });
  const started = Date.now();
  const result = await readErrorBody(res, { timeoutMs: 4000 });
  assert.ok(Date.now() - started < 1000, "must not wait for the 5 s deadline past the cap");
  assert.strictEqual(result.truncated, true);
  assert.ok(result.text.endsWith(ERROR_BODY_TRUNCATED_MARKER));
});

test("readErrorBody reads a shared response once: a second caller gets the cached result", async () => {
  let pulls = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(encoder.encode("quota exhausted"));
      controller.close();
    },
  });
  const res = new Response(body, { status: 429 });
  const first = await readErrorText(res);
  const second = await readErrorText(res);
  assert.strictEqual(first, "quota exhausted");
  assert.strictEqual(second, first);
  assert.strictEqual(pulls, 1, "the stream is pulled once for both callers");
});

test("readErrorBody leaves the caller's response unconsumed", async () => {
  const res = new Response("kept", { status: 503 });
  await readErrorText(res);
  assert.strictEqual(res.bodyUsed, false);
  assert.strictEqual(await res.text(), "kept");
});

test("route classification reads the original response, so a second caller shares the first read", async () => {
  const { shouldAdvanceToNextMember } = await import("../src/gateway/route.js");
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"error":{"code":"context_length_exceeded"}}'));
      controller.close();
    },
  });
  const res = new Response(body, { status: 400 });
  // Count clones made on the original object. The classifier may clone once inside
  // readErrorBody; a caller that clones before reading would add another.
  let clones = 0;
  const realClone = res.clone.bind(res);
  res.clone = () => {
    clones += 1;
    return realClone();
  };
  const first = await shouldAdvanceToNextMember({ status: 400, response: res });
  const clonesAfterFirst = clones;
  const second = await shouldAdvanceToNextMember({ status: 400, response: res });
  assert.strictEqual(first, true, "the classifier sees the context-limit error");
  assert.strictEqual(second, true, "a second classification of the same response agrees");
  assert.strictEqual(clones, clonesAfterFirst, "the second classification reuses the cached read and makes no new clone");
  assert.strictEqual(res.bodyUsed, false, "the caller response stays unconsumed");
});
