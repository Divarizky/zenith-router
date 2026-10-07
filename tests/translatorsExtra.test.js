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
