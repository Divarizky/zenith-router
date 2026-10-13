import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import opencodeProvider from "../src/providers/registry/opencode.js";
import { prepareUpstreamRequest } from "../src/gateway/prepare.js";
import { OpencodeExecutor } from "../src/executors/opencode.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("Registry - opencode transport defines forceStream: true", () => {
  assert.strictEqual(
    opencodeProvider.transport?.forceStream,
    true,
    "opencode harus memaksa streaming ke upstream untuk mencegah 403 FreeTierError"
  );
});

test("Prepare - client stream: false produces upstreamStream: true for opencode", () => {
  const prepared = prepareUpstreamRequest({
    provider: opencodeProvider,
    modelId: "opencode/big-pickle",
    body: {
      model: "opencode/big-pickle",
      messages: [{ role: "user", content: "halo" }],
      stream: false,
    },
    defaultFormat: "openai",
    baseUrlFor: () => "https://opencode.ai/zen/v1/chat/completions",
  });

  assert.strictEqual(prepared.upstreamStream, true, "upstreamStream harus true");
  assert.strictEqual(prepared.upstreamPayload.stream, true, "upstreamPayload.stream harus true");
});

test("OpencodeExecutor - body sent upstream always forces stream: true", async () => {
  const executor = new OpencodeExecutor();
  let capturedBody = null;
  let capturedAccept = null;

  const origExecute = Object.getPrototypeOf(OpencodeExecutor.prototype).execute;
  try {
    Object.getPrototypeOf(OpencodeExecutor.prototype).execute = async function ({ body, headers }) {
      capturedBody = JSON.parse(body);
      capturedAccept = headers.Accept;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await executor.execute({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      body: JSON.stringify({
        model: "big-pickle",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      }),
    });

    assert.ok(capturedBody, "body harus dikirim");
    assert.strictEqual(capturedBody.stream, true, "stream di body upstream harus dipaksa true");
    assert.strictEqual(capturedAccept, "text/event-stream", "upstream diminta membalas sebagai event-stream");
  } finally {
    Object.getPrototypeOf(OpencodeExecutor.prototype).execute = origExecute;
  }
});

test("Gateway integration - non-streaming client request to opencode receives aggregated JSON", async () => {
  initDb(":memory:");

  let upstreamReceivedStream = null;
  setCustomExecutor({
    async execute({ body }) {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      upstreamReceivedStream = parsed?.stream;

      // Kembalikan stream SSE tiruan dari OpenCode Zen
      const sseBody =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Jawaban"}}]}\n\n' +
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" lengkap"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";

      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode/big-pickle",
        messages: [{ role: "user", content: "halo" }],
        stream: false,
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(upstreamReceivedStream, true, "upstream harus menerima stream: true");

    const json = await res.json();
    assert.strictEqual(json.object, "chat.completion");
    assert.strictEqual(json.choices[0].message.content, "Jawaban lengkap");
  } finally {
    setCustomExecutor(null);
  }
});
