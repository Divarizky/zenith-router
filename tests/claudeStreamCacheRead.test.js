import test from "node:test";
import assert from "node:assert";
import { createTransformStream, FORMATS } from "../src/translator/index.js";

async function runStream(events, includeUsage = true) {
  const sse = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  const out = input.pipeThrough(createTransformStream(FORMATS.CLAUDE, FORMATS.OPENAI, "glm-5.3-flash", { includeUsage }));
  const text = await new Response(out).text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice(6)))
    .find((chunk) => chunk.usage);
}

// Mengikuti bentuk nyata upstream Start-Plan: message_start membawa cache 0,
// message_delta membawa cache_read_input_tokens.
const START = ["message_start", { type: "message_start", message: { id: "m1", model: "glm-5.3-flash", usage: { input_tokens: 0, output_tokens: 0 } } }];
const BLOCK = ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
const DELTA_TEXT = ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }];
const STOP_BLOCK = ["content_block_stop", { type: "content_block_stop", index: 0 }];

test("stream Claude: cache_read dari message_delta terbaca sebagai cached_tokens", async () => {
  const usageChunk = await runStream([
    START,
    BLOCK,
    DELTA_TEXT,
    STOP_BLOCK,
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 54, output_tokens: 8, cache_read_input_tokens: 4992 },
    }],
    ["message_stop", { type: "message_stop" }],
  ]);
  assert.ok(usageChunk, "chunk usage harus dikirim saat include_usage aktif");
  assert.strictEqual(usageChunk.usage.prompt_tokens, 54 + 4992);
  assert.strictEqual(usageChunk.usage.completion_tokens, 8);
  assert.strictEqual(usageChunk.usage.prompt_tokens_details.cached_tokens, 4992);
});

test("stream Claude: cache di message_start tetap dipakai bila message_delta tidak membawanya", async () => {
  const usageChunk = await runStream([
    ["message_start", { type: "message_start", message: { id: "m2", model: "glm-5.3-flash", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 300 } } }],
    BLOCK,
    DELTA_TEXT,
    STOP_BLOCK,
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
  assert.strictEqual(usageChunk.usage.prompt_tokens_details.cached_tokens, 300);
  assert.strictEqual(usageChunk.usage.prompt_tokens, 10 + 300);
});
