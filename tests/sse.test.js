import test from "node:test";
import assert from "node:assert";
import { parseSSEBlocks, parseSSEEvents } from "../src/utils/sse.js";
import { aggregateResponsesStream, responsesToOpenAIResponse } from "../src/translator/responses.js";

test("sse - events are framed by a blank line and CRLF is accepted", () => {
  const text = 'data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n';
  assert.deepStrictEqual(parseSSEEvents(text), [{ a: 1 }, { a: 2 }]);
});

test("sse - several data lines in one event are joined with a newline", () => {
  const text = 'data: {"a":\ndata: 1}\n\n';
  assert.deepStrictEqual(parseSSEEvents(text), [{ a: 1 }]);
});

test("sse - [DONE], pings and unparsable payloads are skipped", () => {
  const text = ": ping\n\ndata: [DONE]\n\ndata: {oops\n\ndata: {\"ok\":true}\n\n";
  assert.deepStrictEqual(parseSSEEvents(text), [{ ok: true }]);
});

test("sse - the event name is reported next to its data", () => {
  const text = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  assert.deepStrictEqual(parseSSEBlocks(text), [
    { event: "message_start", data: '{"type":"message_start"}' },
  ]);
});

test("sse - an incomplete tail block is dropped only when asked", () => {
  const text = 'data: {"a":1}\n\ndata: {"a":2}';
  assert.strictEqual(parseSSEEvents(text).length, 2, "the trailing block still parses");
  assert.strictEqual(parseSSEEvents(text, { dropIncompleteTail: true }).length, 1, "a caller that must not act on a half-written frame drops it");
  assert.strictEqual(parseSSEEvents('data: {"a":1}\n\ndata: {"a":2}\n\n').length, 2);
});

test("sse - a refusal delta reaches the aggregated Responses output", () => {
  const text = [
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"Saya tidak bisa "}',
    'data: {"type":"response.refusal.delta","output_index":0,"delta":"membantu itu."}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}',
  ].join("\n\n") + "\n\n";

  const agg = aggregateResponsesStream(text, "muse");
  const message = agg.output.find((item) => item.type === "message");
  assert.strictEqual(message.content[0].text, "Saya tidak bisa membantu itu.");
  assert.strictEqual(agg.usage.input_tokens, 7);
});

test("sse - responsesToOpenAIResponse folds a stream handed in directly", async () => {
  const text = [
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"halo"}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}',
  ].join("\n\n") + "\n\n";

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

  const out = await responsesToOpenAIResponse(stream, "muse");
  assert.strictEqual(out.choices[0].message.content, "halo");
  assert.strictEqual(out.usage.prompt_tokens, 5);
  assert.match(out.id, /^chatcmpl-/, "the streamed shape keeps its chatcmpl id");
});
