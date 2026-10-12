import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { prepareUpstreamRequest } from "../src/gateway/prepare.js";
import { FORMATS } from "../src/translator/index.js";

initDb(":memory:");

const CHAT_URL = (provider) =>
  provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";
const MESSAGES_URL = (provider, targetFormat) =>
  targetFormat === FORMATS.OPENAI
    ? provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions"
    : provider.transport?.messagesUrl ||
      provider.transport?.baseUrl ||
      "https://api.anthropic.com/v1/messages";

test("prepare - uses provider format and falls back to the endpoint default", () => {
  const explicit = prepareUpstreamRequest({
    provider: { id: "custom", format: FORMATS.CLAUDE },
    targetModel: "m",
    body: { messages: [] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  assert.strictEqual(explicit.targetFormat, FORMATS.CLAUDE);

  const fallback = prepareUpstreamRequest({
    provider: { id: "custom" },
    targetModel: "m",
    body: { messages: [] },
    sourceFormat: FORMATS.CLAUDE,
    defaultFormat: FORMATS.CLAUDE,
    baseUrlFor: MESSAGES_URL,
  });
  assert.strictEqual(fallback.targetFormat, FORMATS.CLAUDE);
});

test("prepare - routes an OpenCode responses model to the responses format", async () => {
  const { getProvider } = await import("../src/providers/index.js");
  const responsesModel = prepareUpstreamRequest({
    provider: getProvider("opencode"),
    targetModel: "muse-spark-1.3-contributor-free",
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  assert.strictEqual(responsesModel.targetFormat, FORMATS.OPENAI_RESPONSES);

  const messagesModel = prepareUpstreamRequest({
    provider: getProvider("opencode"),
    targetModel: "union-alpha",
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  assert.strictEqual(messagesModel.targetFormat, FORMATS.CLAUDE);

  const chatModel = prepareUpstreamRequest({
    provider: getProvider("opencode"),
    targetModel: "some-chat-model",
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  assert.strictEqual(chatModel.targetFormat, FORMATS.OPENAI);
});

test("prepare - forces upstream streaming when the transport requires it", () => {
  const prepared = prepareUpstreamRequest({
    provider: { id: "codex", transport: { forceStream: true } },
    targetModel: "gpt-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  assert.strictEqual(prepared.upstreamStream, true);
  assert.strictEqual(prepared.upstreamPayload.stream, true);
});

test("prepare - asks for the usage chunk only when the endpoint opts in", () => {
  const base = {
    provider: { id: "custom" },
    targetModel: "m",
    body: { messages: [{ role: "user", content: "hi" }], stream: true },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  };

  const plain = prepareUpstreamRequest({ ...base, withUsageChunk: true });
  assert.deepStrictEqual(plain.upstreamPayload.stream_options, { include_usage: true });

  const overridden = prepareUpstreamRequest({
    ...base,
    withUsageChunk: true,
    streamOptions: { include_usage: false },
  });
  assert.deepStrictEqual(overridden.upstreamPayload.stream_options, { include_usage: false });

  const withoutUsage = prepareUpstreamRequest({ ...base, withUsageChunk: false });
  assert.strictEqual("stream_options" in withoutUsage.upstreamPayload, false);

  const notStreaming = prepareUpstreamRequest({
    ...base,
    body: { messages: [{ role: "user", content: "hi" }] },
    withUsageChunk: true,
  });
  assert.strictEqual("stream_options" in notStreaming.upstreamPayload, false);

  const claudeTarget = prepareUpstreamRequest({
    ...base,
    provider: { id: "claude", format: FORMATS.CLAUDE },
    withUsageChunk: true,
    baseUrlFor: MESSAGES_URL,
  });
  assert.strictEqual("stream_options" in claudeTarget.upstreamPayload, false);
});

test("prepare - adds the Anthropic version header only for a Claude target", () => {
  const claudeTarget = prepareUpstreamRequest({
    provider: { id: "claude", format: FORMATS.CLAUDE },
    targetModel: "m",
    body: { messages: [] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: MESSAGES_URL,
  });
  assert.strictEqual(claudeTarget.baseHeaders["Anthropic-Version"], "2023-06-01");

  const openaiTarget = prepareUpstreamRequest({
    provider: { id: "custom" },
    targetModel: "m",
    body: { messages: [] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  assert.strictEqual("Anthropic-Version" in openaiTarget.baseHeaders, false);
});

test("prepare - keeps transport headers and lets the client beta header win", () => {
  const prepared = prepareUpstreamRequest({
    provider: { id: "custom", transport: { headers: { "X-Provider": "yes", "anthropic-beta": "stale" } } },
    targetModel: "m",
    body: { messages: [] },
    sourceFormat: FORMATS.CLAUDE,
    defaultFormat: FORMATS.CLAUDE,
    extraHeaders: { "anthropic-beta": "fresh" },
    baseUrlFor: MESSAGES_URL,
  });
  assert.strictEqual(prepared.baseHeaders["X-Provider"], "yes");
  assert.strictEqual(prepared.baseHeaders["anthropic-beta"], "fresh");
  assert.strictEqual(prepared.baseHeaders["Content-Type"], "application/json");
});

test("prepare - resolves the upstream url per endpoint and fills the account id", () => {
  const prepared = prepareUpstreamRequest({
    provider: { id: "kiro", transport: { baseUrl: "https://example.test/{accountId}/chat" } },
    targetModel: "m",
    body: { messages: [] },
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });

  assert.strictEqual(prepared.resolveUrl({ credentials: { account_id: "acc-1" } }), "https://example.test/acc-1/chat");
  assert.strictEqual(prepared.resolveUrl({ credentials: { accountId: "acc-2" } }), "https://example.test/acc-2/chat");
  assert.strictEqual(prepared.resolveUrl({ credentials: { api_key: "acc-3:secret" } }), "https://example.test/acc-3/chat");
  assert.strictEqual(prepared.resolveUrl({ credentials: { api_key: "plain" } }), "https://example.test//chat");
  assert.strictEqual(prepared.resolveUrl(null), "https://example.test/{accountId}/chat");
});

test("prepare - lets the per-request token saver header disable compaction", () => {
  const long = "const a = 1;\n".repeat(200);
  const body = { messages: [{ role: "user", content: long }] };

  const compacted = prepareUpstreamRequest({
    provider: { id: "custom" },
    targetModel: "m",
    body,
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: CHAT_URL,
  });
  const disabled = prepareUpstreamRequest({
    provider: { id: "custom" },
    targetModel: "m",
    body,
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    tokenSaverHeader: "false",
    baseUrlFor: CHAT_URL,
  });

  assert.notStrictEqual(
    JSON.stringify(compacted.upstreamPayload),
    JSON.stringify(disabled.upstreamPayload)
  );
});

test("POST /v1/messages - never asks the upstream for a usage chunk", async () => {  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });

  let capturedBody = null;
  setCustomExecutor({
    async execute({ body }) {
      capturedBody = JSON.parse(body);
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral/mistral-large-latest",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
      stream_options: { include_usage: true },
    }),
  });

  assert.strictEqual(res.status, 200);
  await res.text();
  assert.strictEqual(capturedBody.model, "mistral-large-latest");
  assert.strictEqual(capturedBody.stream, true);
  assert.strictEqual("stream_options" in capturedBody, false);
  setCustomExecutor(null);
});
