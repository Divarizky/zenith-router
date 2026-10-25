import test from "node:test";
import assert from "node:assert";
import { applyClaudePromptCache } from "../src/services/claudePromptCache.js";
import { openaiToClaude } from "../src/translator/request.js";
import { translateRequest, createTransformStream, FORMATS } from "../src/translator/index.js";
import { claudeToOpenAIResponse } from "../src/translator/response.js";
import { normalizeUsage } from "../src/services/usage.js";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

const EPHEMERAL = { type: "ephemeral" };
const countMarkers = (value) => JSON.stringify(value).split('"cache_control"').length - 1;

test("applyClaudePromptCache menandai tools terakhir, system, dan pesan terakhir", () => {
  const body = {
    system: "Kamu asisten.",
    tools: [{ name: "a", input_schema: {} }, { name: "b", input_schema: {} }],
    messages: [
      { role: "user", content: "satu" },
      { role: "assistant", content: "dua" },
      { role: "user", content: "tiga" },
    ],
  };
  const out = applyClaudePromptCache(body);
  assert.deepStrictEqual(out.tools[1].cache_control, EPHEMERAL);
  assert.strictEqual(out.tools[0].cache_control, undefined);
  assert.deepStrictEqual(out.system, [{ type: "text", text: "Kamu asisten.", cache_control: EPHEMERAL }]);
  assert.deepStrictEqual(out.messages[2].content, [{ type: "text", text: "tiga", cache_control: EPHEMERAL }]);
  assert.strictEqual(out.messages[0].content, "satu");
});

test("applyClaudePromptCache membiarkan marker klien yang jumlahnya di bawah batas", () => {
  const body = {
    system: [{ type: "text", text: "x", cache_control: EPHEMERAL }],
    messages: [{ role: "user", content: "hi" }],
  };
  const out = applyClaudePromptCache(body);
  assert.deepStrictEqual(out, body);
  assert.notStrictEqual(out, body, "salinan, input tidak diubah");
});

test("applyClaudePromptCache membatasi marker klien ke empat, menyisakan yang terakhir", () => {
  const marked = (text) => ({ type: "text", text, cache_control: EPHEMERAL });
  const body = {
    tools: [{ name: "t", input_schema: {}, cache_control: EPHEMERAL }],
    system: [marked("s1")],
    messages: [
      { role: "user", content: [marked("u1")] },
      { role: "assistant", content: [marked("a1")] },
      { role: "user", content: [marked("u2")] },
    ],
  };
  const snapshot = JSON.stringify(body);
  const out = applyClaudePromptCache(body);
  assert.strictEqual(countMarkers(out), 4);
  assert.strictEqual(out.tools[0].cache_control, undefined, "marker paling awal dilepas");
  assert.deepStrictEqual(out.system[0].cache_control, EPHEMERAL);
  assert.deepStrictEqual(out.messages[2].content[0].cache_control, EPHEMERAL);
  assert.strictEqual(JSON.stringify(body), snapshot, "input tidak diubah");
});

test("openaiToClaude dengan marker klien di banyak tempat tetap maksimal empat breakpoint", () => {
  const m = () => ({ type: "text", text: "x", cache_control: EPHEMERAL });
  const translated = openaiToClaude(
    {
      messages: [
        { role: "system", content: [m()] },
        { role: "user", content: [m()] },
        { role: "assistant", content: [m()] },
        { role: "user", content: [m()] },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } }, cache_control: EPHEMERAL }],
    },
    "claude-haiku-5-5"
  );
  assert.strictEqual(countMarkers(applyClaudePromptCache(translated)), 4);
});

test("applyClaudePromptCache melewati blok thinking dan tidak mengubah input", () => {
  const body = {
    messages: [
      { role: "user", content: "tanya" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "jawab" },
          { type: "thinking", thinking: "hmm", signature: "sig" },
        ],
      },
    ],
  };
  const snapshot = JSON.stringify(body);
  const out = applyClaudePromptCache(body);
  assert.deepStrictEqual(out.messages[1].content[0].cache_control, EPHEMERAL);
  assert.strictEqual(out.messages[1].content[1].cache_control, undefined);
  assert.strictEqual(JSON.stringify(body), snapshot);
});

test("applyClaudePromptCache memasang paling banyak tiga breakpoint", () => {
  const out = applyClaudePromptCache({
    tools: [{ name: "t", input_schema: {} }],
    system: [{ type: "text", text: "s" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "tool_result", tool_use_id: "x", content: "r" },
        ],
      },
    ],
  });
  assert.strictEqual(countMarkers(out), 3);
  assert.deepStrictEqual(out.messages[0].content[1].cache_control, EPHEMERAL);
});

test("applyClaudePromptCache hanya memberi marker pada bagian yang ada", () => {
  const out = applyClaudePromptCache({ messages: [{ role: "user", content: "halo" }] });
  assert.strictEqual(out.tools, undefined);
  assert.strictEqual(out.system, undefined);
  assert.deepStrictEqual(out.messages[0].content, [{ type: "text", text: "halo", cache_control: EPHEMERAL }]);
});

test("openaiToClaude meneruskan cache_control dari klien ke system, tools, dan pesan", () => {
  const out = translateRequest(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      model: "x",
      messages: [
        { role: "system", content: [{ type: "text", text: "Aturan", cache_control: EPHEMERAL }] },
        { role: "user", content: [{ type: "text", text: "halo", cache_control: EPHEMERAL }] },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } }, cache_control: EPHEMERAL }],
    },
    "claude-sonnet-5-5"
  );
  assert.deepStrictEqual(out.system, [{ type: "text", text: "Aturan", cache_control: EPHEMERAL }]);
  assert.deepStrictEqual(out.messages[0].content, [{ type: "text", text: "halo", cache_control: EPHEMERAL }]);
  assert.deepStrictEqual(out.tools[0].cache_control, EPHEMERAL);
});

test("openaiToClaude memindahkan marker pesan tool ke tool_result", () => {
  const out = openaiToClaude(
    {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "hasil", cache_control: EPHEMERAL }] },
      ],
    },
    "claude-sonnet-5-5"
  );
  assert.deepStrictEqual(out.messages[1].content[0], {
    type: "tool_result",
    tool_use_id: "c1",
    content: "hasil",
    cache_control: EPHEMERAL,
  });
});

test("openaiToClaude mempertahankan teks assistant berbentuk array saat ada tool_calls", () => {
  const out = openaiToClaude(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "cek dulu", cache_control: EPHEMERAL }],
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ],
    },
    "claude-sonnet-5-5"
  );
  assert.deepStrictEqual(out.messages[0].content[0], { type: "text", text: "cek dulu", cache_control: EPHEMERAL });
  assert.strictEqual(out.messages[0].content[1].type, "tool_use");
});

test("openaiToClaude dengan marker pada system menghasilkan teks yang sama dengan jalur string", () => {
  const plain = openaiToClaude(
    { messages: [{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "hi" }] },
    "claude-haiku-5-5"
  ).system;
  const marked = openaiToClaude(
    {
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: [{ type: "text", text: "B", cache_control: EPHEMERAL }] },
        { role: "user", content: "hi" },
      ],
    },
    "claude-haiku-5-5"
  ).system;
  assert.strictEqual(plain, "A\n\nB");
  assert.strictEqual(marked.map((b) => b.text).join(""), plain);
  assert.ok(marked.every((b) => b.text.trim() !== ""), "tidak ada blok whitespace-only");
});

test("openaiToClaude: part gambar dan part kosong di system menghasilkan teks yang sama dengan jalur string", () => {
  const parts = [
    { type: "text", text: "a" },
    { type: "image_url", image_url: { url: "https://x/y.png" } },
    { type: "text", text: "" },
    { type: "text", text: "b" },
  ];
  const plain = openaiToClaude({ messages: [{ role: "system", content: parts }, { role: "user", content: "hi" }] }, "m").system;
  const marked = openaiToClaude(
    {
      messages: [
        { role: "system", content: parts.map((p, i) => (i === 3 ? { ...p, cache_control: EPHEMERAL } : p)) },
        { role: "user", content: "hi" },
      ],
    },
    "m"
  ).system;
  // Jalur string sudah ada sebelumnya: part gambar menjadi "" lalu di-join "\n".
  assert.strictEqual(plain, "a\n\n\nb");
  assert.strictEqual(marked[0].text, plain);
  assert.deepStrictEqual(marked[0].cache_control, EPHEMERAL);
});

test("openaiToClaude melewati system whitespace-only di jalur string dan blok", () => {
  const plain = openaiToClaude(
    { messages: [{ role: "system", content: "   " }, { role: "system", content: "B" }, { role: "user", content: "hi" }] },
    "m"
  ).system;
  assert.strictEqual(plain, "B");

  const marked = openaiToClaude(
    {
      messages: [
        { role: "system", content: [{ type: "text", text: "   ", cache_control: EPHEMERAL }] },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    },
    "m"
  ).system;
  // Hanya "B" yang tersisa dan tanpa marker, jadi bentuk string dipakai.
  assert.strictEqual(marked, "B");

  // Dengan dua pesan bermarker, bentuk array dipakai dan tetap tanpa blok whitespace.
  const arr = openaiToClaude(
    {
      messages: [
        { role: "system", content: [{ type: "text", text: "   ", cache_control: EPHEMERAL }] },
        { role: "system", content: [{ type: "text", text: "A", cache_control: EPHEMERAL }] },
        { role: "system", content: [{ type: "text", text: "B", cache_control: EPHEMERAL }] },
        { role: "user", content: "hi" },
      ],
    },
    "m"
  ).system;
  assert.ok(Array.isArray(arr));
  assert.ok(arr.every((b) => b.text.trim() !== ""), "tidak ada blok whitespace-only");
  assert.strictEqual(arr.map((b) => b.text).join(""), "A\n\nB");
});

test("openaiToClaude tetap memakai string untuk system tanpa marker", () => {
  const out = openaiToClaude(
    {
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    },
    "claude-sonnet-5-5"
  );
  assert.strictEqual(out.system, "A\n\nB");
});

test("claude->openai non-stream mencatat cache write terpisah dari cache read", () => {
  const out = claudeToOpenAIResponse(
    {
      id: "msg_1",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 200, cache_creation_input_tokens: 5000 },
    },
    "claude-sonnet-5-5"
  );
  assert.strictEqual(out.usage.prompt_tokens, 5210);
  assert.deepStrictEqual(out.usage.prompt_tokens_details, { cached_tokens: 200, cache_write_tokens: 5000 });
  const recorded = normalizeUsage(out.usage);
  assert.strictEqual(recorded.inputTokens, 5210);
  assert.strictEqual(recorded.cacheReadTokens, 200);
  assert.strictEqual(recorded.cacheWriteTokens, 5000);
});

test("claude->openai stream mencatat cache write dari message_start", async () => {
  const events = [
    {
      type: "message_start",
      message: {
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 5000 },
      },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "jawab" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const stream = createTransformStream(FORMATS.CLAUDE, FORMATS.OPENAI, "claude-sonnet-5-5", { includeUsage: true });
  const source = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(new TextEncoder().encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  const chunks = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
  const usageChunk = chunks.find((c) => c.usage);
  assert.ok(usageChunk, "usage chunk dikirim");
  assert.strictEqual(usageChunk.usage.prompt_tokens, 5210);
  assert.deepStrictEqual(usageChunk.usage.prompt_tokens_details, { cached_tokens: 200, cache_write_tokens: 5000 });
});

test("gateway memasang cache_control untuk koneksi Claude dari klien OpenAI", async () => {
  const captured = [];
  initDb(":memory:");
  addConnection({
    provider: "claude",
    name: "Claude API key",
    auth_type: "apikey",
    credentials: { api_key: "sk-ant-api03-test" },
  });
  setCustomExecutor({
    async execute({ body: sentBody }) {
      captured.push(typeof sentBody === "string" ? JSON.parse(sentBody) : sentBody);
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude/claude-sonnet-5-5",
        stream: false,
        messages: [
          { role: "system", content: "Kamu asisten." },
          { role: "user", content: "satu" },
          { role: "assistant", content: "dua" },
          { role: "user", content: "tiga" },
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(captured[0].system, [{ type: "text", text: "Kamu asisten.", cache_control: EPHEMERAL }]);
    assert.deepStrictEqual(captured[0].messages[2].content, [{ type: "text", text: "tiga", cache_control: EPHEMERAL }]);
  } finally {
    setCustomExecutor(null);
  }
});
