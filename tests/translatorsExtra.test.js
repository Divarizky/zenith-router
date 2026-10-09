import test from "node:test";
import assert from "node:assert";
import {
  openaiToResponsesRequest,
  responsesToOpenAIResponse,
  createResponsesToOpenAITransformStream,
} from "../src/translator/responses.js";
import {
  openaiToGeminiRequest,
  geminiToOpenAIResponse,
  createGeminiToOpenAITransformStream,
} from "../src/translator/gemini.js";
import {
  openaiToKiroRequest,
  createKiroToOpenAITransformStream,
} from "../src/translator/kiro.js";
import { decodeEventStreamBuffer } from "../src/utils/eventstream.js";
import { translateRequest, translateResponse, createTransformStream, FORMATS } from "../src/translator/index.js";

test("Responses Translator - maps OpenAI request to Responses API format", () => {
  const req = {
    model: "gpt-5.2-codex",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Write a quicksort in JS." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "run_test",
          description: "Runs tests",
          parameters: { type: "object", properties: { file: { type: "string" } } },
        },
      },
    ],
  };

  const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, req, "gpt-5.2-codex");
  assert.strictEqual(translated.model, "gpt-5.2-codex");
  assert.strictEqual(translated.instructions, "You are a coding assistant.");
  assert.strictEqual(translated.input.length, 1);
  assert.strictEqual(translated.input[0].role, "user");
  assert.strictEqual(translated.tools.length, 1);
  assert.strictEqual(translated.tools[0].name, "run_test");
  assert.strictEqual(translated.stream, true);
});

test("Responses Translator - converts Responses stream chunks to OpenAI SSE format", async () => {
  const stream = createTransformStream(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-5.2-codex");

  const mockChunks = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "function quicksort() {}" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { prompt_tokens: 15, completion_tokens: 5 } } })}\n\n`,
    `data: [DONE]\n\n`,
  ];

  const source = new ReadableStream({
    start(controller) {
      for (const c of mockChunks) {
        controller.enqueue(new TextEncoder().encode(c));
      }
      controller.close();
    },
  });

  const response = new Response(source.pipeThrough(stream));
  const received = await response.text();

  assert.ok(received.includes("function quicksort() {}"));
  assert.ok(received.includes("chat.completion.chunk"));
  assert.ok(received.includes("[DONE]"));
});

test("Gemini Translator - maps OpenAI request to Gemini contents and sanitizes tool schema", () => {
  const req = {
    model: "gemini-2.5-pro",
    messages: [
      { role: "system", content: "You are Gemini." },
      { role: "user", content: "Hello!" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "fetch-weather",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { location: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
    ],
  };

  const translated = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, req, "gemini-2.5-pro");
  assert.ok(translated.contents);
  assert.strictEqual(translated.contents[0].role, "user");
  assert.strictEqual(translated.systemInstruction.parts[0].text, "You are Gemini.");
  assert.ok(translated.tools);
  // Tool name sanitized to valid identifier
  assert.strictEqual(translated.tools[0].functionDeclarations[0].name, "fetch_weather");
  // $schema and additionalProperties stripped for Gemini API compatibility
  assert.strictEqual(translated.tools[0].functionDeclarations[0].parameters.$schema, undefined);
  assert.strictEqual(translated.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
});

test("Kiro EventStream - translates OpenAI request to CodeWhisperer conversationState", () => {
  const req = {
    model: "claude-3-7-sonnet",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Create a web server." },
    ],
  };

  const translated = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, req, "claude-3-7-sonnet");
  assert.ok(translated.conversationState);
  assert.strictEqual(translated.conversationState.chatTriggerType, "MANUAL");
  assert.ok(translated.conversationState.currentMessage.userInputMessage.content.includes("Be concise."));
  assert.ok(translated.conversationState.currentMessage.userInputMessage.content.includes("Create a web server."));
});

test("Responses Translator - tool call history uses call_id, not id", () => {
  const req = {
    model: "muse-spark-1.3-contributor-free",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "list files" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "call_abc", content: "a.txt" },
    ],
  };
  const out = openaiToResponsesRequest(req, "muse-spark-1.3-contributor-free");
  const call = out.input.find((i) => i.type === "function_call");
  const result = out.input.find((i) => i.type === "function_call_output");
  assert.strictEqual(call.call_id, "call_abc");
  assert.strictEqual(call.id, undefined, "id must be omitted; upstream requires fc_ prefix");
  assert.strictEqual(result.call_id, call.call_id);
});

test("Responses Translator - stream exposes upstream call_id as the tool_call id", async () => {
  const stream = createTransformStream(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "muse");
  const chunks = [
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_xyz", name: "bash" } },
    { type: "response.function_call_arguments.delta", delta: '{"command":"ls"}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_xyz" } },
    { type: "response.completed", response: { usage: {} } },
  ];
  const source = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  assert.ok(text.includes('"id":"call_xyz"'));
  assert.ok(!text.includes('"id":"fc_1"'));
});

test("Responses Translator - argument deltas never leak into message content", async () => {
  const stream = createTransformStream(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "muse");
  const chunks = [
    { type: "response.output_text.delta", delta: "let me search" },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_9", name: "findCustomer" } },
    { type: "response.function_call_arguments.delta", delta: '{"limit":80,"offset":1,"path":"C:\\DMS\\CustomerRepository.kt"}' },
    { type: "response.function_call_arguments.delta", delta: "" },
    { type: "response.completed", response: { usage: {} } },
  ];
  const source = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  const events = text.split("\n\n").filter(Boolean).map((l) => l.replace("data: ", ""));
  const contents = events.filter((e) => e.startsWith("{")).map((e) => JSON.parse(e))
    .flatMap((p) => p.choices || [])
    .map((c) => c.delta?.content)
    .filter(Boolean);
  assert.deepStrictEqual(contents, ["let me search"], "only real text may reach content");
  const argText = events.filter((e) => e.startsWith("{")).map((e) => JSON.parse(e))
    .flatMap((p) => p.choices || [])
    .flatMap((c) => c.delta?.tool_calls || [])
    .map((t) => t.function?.arguments)
    .join("");
  assert.ok(argText.includes("CustomerRepository"), "arguments must reach tool_calls, not content");
});
