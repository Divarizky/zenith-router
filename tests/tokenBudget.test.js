import test from "node:test";
import assert from "node:assert";
import {
  isReasoningModel,
  isReasoningRequest,
  effectiveMaxTokens,
  MIN_ANSWER_TOKENS,
  THINKING_BUDGET,
  MIN_PLAIN_TOKENS,
  MAX_OUTPUT_TOKENS,
} from "../src/utils/tokenBudget.js";

test("isReasoningModel - recognizes documented thinking families", () => {
  assert.strictEqual(isReasoningModel("muse-spark-1.3-contributor-free"), true);
  assert.strictEqual(isReasoningModel("big-pickle"), true);
  assert.strictEqual(isReasoningModel("mimo-v2.6-flash-free"), true);
  assert.strictEqual(isReasoningModel("nemotron-3.5-lightning-free"), true);
  assert.strictEqual(isReasoningModel("longcat-2.5-preview-free"), true);
  assert.strictEqual(isReasoningModel("cat-jam-free"), true);
  assert.strictEqual(isReasoningModel("step-5-preview-free"), true);
  assert.strictEqual(isReasoningModel("deepseek-v4.1-flash-free"), true);

  assert.strictEqual(isReasoningModel("exo-free"), false);
  assert.strictEqual(isReasoningModel("jev-1.13-free"), false);
});

test("isReasoningRequest - respects reasoning_effort on non-reasoning models", () => {
  assert.strictEqual(isReasoningRequest({ reasoning_effort: "medium" }, "jev-1.13-free"), true);
  assert.strictEqual(isReasoningRequest({ reasoning_effort: "none" }, "jev-1.13-free"), false);
  assert.strictEqual(isReasoningRequest({}, "big-pickle"), true);
});

test("effectiveMaxTokens - additive formula max(requested, 1024) + 4096 for reasoning models", () => {
  // Small requested budget (e.g. probe of 50 tokens)
  assert.strictEqual(effectiveMaxTokens(50, "big-pickle"), 1024 + 4096);
  // Requested budget above floor
  assert.strictEqual(effectiveMaxTokens(2000, "big-pickle"), 2000 + 4096);
  // Clamped at MAX_OUTPUT_TOKENS
  assert.strictEqual(effectiveMaxTokens(130000, "big-pickle"), MAX_OUTPUT_TOKENS);
});

test("effectiveMaxTokens - floor max(requested, 512) for plain models", () => {
  assert.strictEqual(effectiveMaxTokens(100, "jev-1.13-free"), 512);
  assert.strictEqual(effectiveMaxTokens(1000, "jev-1.13-free"), 1000);
});

test("effectiveMaxTokens - handles missing or invalid inputs cleanly", () => {
  assert.strictEqual(effectiveMaxTokens(undefined, "big-pickle"), MAX_OUTPUT_TOKENS);
  assert.strictEqual(effectiveMaxTokens(null, "big-pickle"), MAX_OUTPUT_TOKENS);
  assert.strictEqual(effectiveMaxTokens("invalid", "big-pickle"), MAX_OUTPUT_TOKENS);
  assert.strictEqual(effectiveMaxTokens("2048", "big-pickle"), 2048 + 4096);
});

test("effectiveMaxTokens - lane clamp /responses 65536 via parameter maxOutput", () => {
  // Nilai besar di-clamp ke batas lane, bukan batas chat
  assert.strictEqual(effectiveMaxTokens(200000, "big-pickle", {}, 65536), 65536);
  // Nilai kecil tetap dapat headroom reasoning
  assert.strictEqual(effectiveMaxTokens(5, "big-pickle", {}, 65536), 5120);
  // Tanpa parameter, default tetap 131072
  assert.strictEqual(effectiveMaxTokens(200000, "big-pickle"), MAX_OUTPUT_TOKENS);
});

test("restoreResponsesToolNames - normalizes delta.reasoning to delta.reasoning_content in SSE stream", async () => {
  const { restoreResponsesToolNames } = await import("../src/executors/opencodeResponses.js");

  const sseChunk = 'data: {"id":"1","choices":[{"delta":{"reasoning":"Thinking step 1..."}}]}\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk));
      controller.close();
    },
  });

  const origResponse = new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });

  const restored = await restoreResponsesToolNames(origResponse, null);
  const text = await restored.text();

  assert.ok(text.includes('"reasoning_content":"Thinking step 1..."'), `reasoning_content harus dinormalisasi, didapat: ${text}`);
});
