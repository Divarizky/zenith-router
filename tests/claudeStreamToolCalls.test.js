import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { createTransformStream } from "../src/translator/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Stream Claude asli: teks, lalu dua blok tool_use dengan argumen yang dipecah
// ke beberapa input_json_delta, ditutup stop_reason tool_use.
const CLAUDE_TOOL_STREAM = [
  sse("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Saya baca file dulu." } }),
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_A", name: "read", input: {} } }),
  sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }),
  sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
  sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"src/a.js"}' } }),
  sse("content_block_stop", { type: "content_block_stop", index: 1 }),
  sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_B", name: "bash", input: {} } }),
  sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
  sse("content_block_stop", { type: "content_block_stop", index: 2 }),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } }),
  sse("message_stop", { type: "message_stop" }),
];

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

function sourceStream(events) {
  return new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(new TextEncoder().encode(ev));
      controller.close();
    },
  });
}

function parseChunks(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l.trim() !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

// Gabungkan delta tool_calls per index, seperti yang dilakukan klien OpenAI.
function collectToolCalls(chunks) {
  const calls = [];
  for (const c of chunks) {
    for (const tc of c.choices?.[0]?.delta?.tool_calls || []) {
      const slot = (calls[tc.index] ||= { id: "", name: "", arguments: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") slot.arguments += tc.function.arguments;
    }
  }
  return calls;
}

test("stream claude->openai - blok tool_use diteruskan sebagai delta tool_calls", async () => {
  const out = await readAll(sourceStream(CLAUDE_TOOL_STREAM).pipeThrough(createTransformStream("claude", "openai", "claude-opus-5-5")));
  const chunks = parseChunks(out);

  const calls = collectToolCalls(chunks);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(
    calls.map((c) => ({ id: c.id, name: c.name, args: JSON.parse(c.arguments) })),
    [
      { id: "toolu_A", name: "read", args: { path: "src/a.js" } },
      { id: "toolu_B", name: "bash", args: { command: "ls" } },
    ]
  );

  const firstToolChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
  assert.strictEqual(firstToolChunk.choices[0].delta.tool_calls[0].type, "function");

  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
  assert.strictEqual(text, "Saya baca file dulu.");

  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean);
  assert.deepStrictEqual(finish, ["tool_calls"]);
  assert.ok(out.trim().endsWith("data: [DONE]"));
});

test("stream claude->openai - input tool_use yang sudah terisi di content_block_start tidak hilang", async () => {
  const events = [
    sse("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_C", name: "ls", input: { path: "." } } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
    sse("message_stop", { type: "message_stop" }),
  ];
  const out = await readAll(sourceStream(events).pipeThrough(createTransformStream("claude", "openai", "claude-opus-5-5")));
  const calls = collectToolCalls(parseChunks(out));
  assert.deepStrictEqual(calls.map((c) => ({ id: c.id, name: c.name, args: JSON.parse(c.arguments) })), [
    { id: "toolu_C", name: "ls", args: { path: "." } },
  ]);
});

test("POST /v1/chat/completions stream ke provider claude - klien OpenAI menerima tool_calls", async (t) => {
  t.after(() => setCustomExecutor(null));
  initDb(":memory:");
  addConnection({ provider: "claude", name: "Claude test", credentials: { api_key: "sk-ant-test" } });
  setCustomExecutor({
    async execute() {
      return new Response(CLAUDE_TOOL_STREAM.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cc/claude-opus-5-5",
      stream: true,
      messages: [{ role: "user", content: "baca src/a.js" }],
      tools: [
        { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
        { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
      ],
    }),
  });

  assert.strictEqual(res.status, 200);
  const chunks = parseChunks(await res.text());
  const calls = collectToolCalls(chunks);
  assert.deepStrictEqual(calls.map((c) => c.name), ["read", "bash"]);
  assert.deepStrictEqual(JSON.parse(calls[0].arguments), { path: "src/a.js" });
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"));
});
