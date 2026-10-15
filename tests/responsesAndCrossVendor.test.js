import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("POST /v1/messages - translates Anthropic request to GLM/OpenAI upstream and formats response as Anthropic", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });

  let capturedBody = null;
  let capturedHeaders = null;

  setCustomExecutor({
    async execute({ body, headers }) {
      capturedBody = JSON.parse(body);
      capturedHeaders = headers;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_mock_1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Response from OpenAI-format upstream" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      max_tokens: 1024,
      system: "You are a helpful coder.",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.type, "message");
  assert.strictEqual(data.role, "assistant");
  assert.strictEqual(data.content[0].type, "text");
  assert.strictEqual(data.content[0].text, "Response from OpenAI-format upstream");
  assert.strictEqual(data.stop_reason, "end_turn");
  assert.strictEqual(data.usage.input_tokens, 12);
  assert.strictEqual(data.usage.output_tokens, 8);

  // Verify that upstream request received translated OpenAI format
  assert.strictEqual(capturedBody.messages[0].role, "system");
  assert.strictEqual(capturedBody.messages[0].content, "You are a helpful coder.");
  assert.strictEqual(capturedBody.messages[1].role, "user");
  assert.strictEqual(capturedBody.messages[1].content, "Hello");

  // Verify anthropic-beta header was forwarded
  assert.strictEqual(capturedHeaders["anthropic-beta"], "prompt-caching-2024-07-31");

  setCustomExecutor(null);
});

test("POST /v1/responses - handles OpenAI Responses API format", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });

  setCustomExecutor({
    async execute() {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_resp_1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Codex responses output" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  });

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      instructions: "Follow instructions carefully.",
      input: "Write code",
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.object, "response");
  assert.strictEqual(data.status, "completed");
  assert.ok(Array.isArray(data.output));
  assert.strictEqual(data.output[0].type, "message");
  assert.strictEqual(data.output[0].role, "assistant");
  assert.strictEqual(data.output[0].content[0].text, "Codex responses output");
  assert.strictEqual(data.usage.input_tokens, 25);
  assert.strictEqual(data.usage.output_tokens, 15);

  setCustomExecutor(null);
});

test("POST /v1/responses - a tool cycle and images reach a chat upstream intact", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });

  let upstreamBody = null;
  setCustomExecutor({
    async execute(opts) {
      upstreamBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          id: "chatcmpl_tools",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: '{"p":"b.txt"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "read a.txt" },
              { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            ],
          },
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "function_call", call_id: "call_1", name: "read", arguments: '{"p":"a.txt"}' },
          { type: "function_call_output", call_id: "call_1", output: "FILE CONTENT" },
        ],
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "read" },
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(upstreamBody.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "read a.txt" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"p":"a.txt"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "FILE CONTENT" },
    ]);
    assert.deepStrictEqual(upstreamBody.tools, [
      { type: "function", function: { name: "read", parameters: { type: "object" } } },
    ]);
    assert.deepStrictEqual(upstreamBody.tool_choice, { type: "function", function: { name: "read" } });

    const data = await res.json();
    assert.strictEqual(data.output.length, 1);
    assert.strictEqual(data.output[0].type, "function_call");
    assert.strictEqual(data.output[0].call_id, "call_2");
    assert.strictEqual(data.output[0].name, "read");
    assert.strictEqual(data.output[0].arguments, '{"p":"b.txt"}');
  } finally {
    setCustomExecutor(null);
  }
});
