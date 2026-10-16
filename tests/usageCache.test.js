import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { normalizeUsage, createUsageTapStream, getUsageStats, getRecentUsage, recordUsage } from "../src/services/usage.js";
import { createResponseTransformStream, openAIToClaudeResponse } from "../src/translator/response.js";

async function drain(chunks, tap) {
  const stream = new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(new TextEncoder().encode(ch));
      controller.close();
    },
  }).pipeThrough(tap);
  const reader = stream.getReader();
  while (!(await reader.read()).done);
  await new Promise((r) => setTimeout(r, 20));
}

test("normalizeUsage - OpenAI prompt_tokens already includes cached tokens", () => {
  const u = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 20 },
  });
  assert.deepStrictEqual(u, { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0, reasoningTokens: 20 });
});

test("normalizeUsage - Claude cache buckets are added back into input", () => {
  const u = normalizeUsage({ input_tokens: 10, output_tokens: 15, cache_read_input_tokens: 800, cache_creation_input_tokens: 40 });
  assert.deepStrictEqual(u, { inputTokens: 850, outputTokens: 15, cacheReadTokens: 800, cacheWriteTokens: 40, reasoningTokens: 0 });
});

test("normalizeUsage - Responses input_tokens already includes cached tokens", () => {
  const u = normalizeUsage({
    input_tokens: 500,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 300 },
    output_tokens_details: { reasoning_tokens: 12 },
  });
  assert.deepStrictEqual(u, { inputTokens: 500, outputTokens: 30, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 12 });
});

test("normalizeUsage - missing usage yields zeros", () => {
  assert.deepStrictEqual(normalizeUsage(null), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
});

test("usage tap - Claude stream merges message_start and message_delta usage", async () => {
  initDb(":memory:");
  await drain(
    [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":800,"cache_creation_input_tokens":40}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":15}}\n\n',
    ],
    createUsageTapStream({ model: "claude-x" })
  );
  const s = getUsageStats().summary;
  assert.strictEqual(s.total_input_tokens, 850, "a later zero input_tokens does not wipe message_start");
  assert.strictEqual(s.total_output_tokens, 15);
  assert.strictEqual(s.total_cache_read_tokens, 800);
  assert.strictEqual(s.total_cache_write_tokens, 40);
});

test("usage tap - OpenAI and Responses streams record cache and reasoning", async () => {
  initDb(":memory:");
  await drain(
    ['data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}\n\n', "data: [DONE]\n\n"],
    createUsageTapStream({ model: "gpt-x" })
  );
  await drain(
    ['event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":200,"output_tokens":9,"input_tokens_details":{"cached_tokens":150},"output_tokens_details":{"reasoning_tokens":4}}}}\n\n'],
    createUsageTapStream({ model: "codex-x" })
  );
  const s = getUsageStats().summary;
  assert.strictEqual(s.total_input_tokens, 300);
  assert.strictEqual(s.total_cache_read_tokens, 210);
  assert.strictEqual(s.total_reasoning_tokens, 4);
});

test("recent usage exposes cache_read_tokens", () => {
  initDb(":memory:");
  recordUsage({ model: "m", inputTokens: 100, outputTokens: 1, cacheReadTokens: 70 });
  assert.strictEqual(getRecentUsage(1)[0].cache_read_tokens, 70);
});

test("openai->claude translation moves cached tokens out of input_tokens", async () => {
  const out = openAIToClaudeResponse({
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } },
  });
  assert.deepStrictEqual(out.usage, { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900 });

  const chunks = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":900}}}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
      controller.close();
    },
  }).pipeThrough(createResponseTransformStream("openai", "claude", "m"));
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(dec.decode(r.value));
  const delta = chunks.join("").split("\n").find((l) => l.startsWith("data:") && l.includes('"message_delta"'));
  assert.deepStrictEqual(JSON.parse(delta.slice(5)).usage, { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900 });
});
