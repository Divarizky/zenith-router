import test from "node:test";
import assert from "node:assert";
import { restoreResponsesToolNames } from "../src/executors/opencodeResponses.js";

// A JSON body that delivers one chunk and then never closes, the way a stalled upstream does.
function stalledJsonResponse(status, firstChunk) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

test("restoreResponsesToolNames - a non-2xx JSON error with a stalled body returns the same response without reading it", async () => {
  const res = stalledJsonResponse(400, JSON.stringify({ error: { message: "bad request" } }));
  const nameMap = new Map([["zr_read", "read"]]);
  // A live timer keeps the event loop busy, so a hung read fails as an assertion instead of a cancellation.
  const guard = new Promise((resolve) => setTimeout(() => resolve("HUNG"), 3000));
  const started = Date.now();
  const out = await Promise.race([restoreResponsesToolNames(res, nameMap), guard]);
  const elapsed = Date.now() - started;
  assert.notStrictEqual(out, "HUNG", "the helper must not await the stalled error body");
  assert.strictEqual(out, res, "the error response object is passed through unchanged");
  assert.strictEqual(res.bodyUsed, false, "the helper does not consume the error body");
  assert.ok(elapsed < 1000, `the helper returned in ${elapsed} ms`);
});

test("restoreResponsesToolNames - a 2xx JSON payload still has its tool names restored", async () => {
  const payload = { output: [{ type: "function_call", name: "zr_read" }] };
  const res = new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  const nameMap = new Map([["zr_read", "read"]]);
  const out = await restoreResponsesToolNames(res, nameMap);
  const parsed = await out.json();
  assert.strictEqual(out.status, 200);
  assert.strictEqual(parsed.output[0].name, "read", "a successful payload is normalized as before");
});

test("restoreResponsesToolNames - a 2xx response with no aliases and a JSON type passes through normalized", async () => {
  const res = new Response(JSON.stringify({ output: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  const out = await restoreResponsesToolNames(res, new Map());
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(await out.json(), { output: [] });
});
