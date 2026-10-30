import test from "node:test";
import assert from "node:assert";
import {
  createTransformStream,
  FORMATS,
  translateResponse,
  translateRequest,
} from "../src/translator/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function mk(delta, finish_reason = null) {
  return sse({
    id: "chunk_test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }],
  });
}

async function runOpenAIToClaudeStream(chunks, model = "test-model", opts = {}) {
  const ts = createTransformStream(FORMATS.OPENAI, FORMATS.CLAUDE, model, opts);
  const w = ts.writable.getWriter();
  const r = ts.readable.getReader();
  const out = [];
  const pump = (async () => {
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      out.push(dec.decode(value));
    }
  })();
  for (const c of chunks) {
    await w.write(enc.encode(c));
  }
  await w.close();
  await pump;
  return out.join("");
}

function parseClaudeSSE(raw) {
  const lines = raw.split("\n");
  const events = [];
  let curEvent = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("event:")) {
      curEvent = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("data:")) {
      events.push({ event: curEvent, data: JSON.parse(trimmed.slice(5).trim()) });
    }
  }
  return events;
}

function assertValidClaudeEventSequence(events) {
  assert.strictEqual(events[0]?.event, "message_start", "Event pertama harus message_start");
  assert.strictEqual(events.at(-1)?.event, "message_stop", "Event terakhir harus message_stop");
  const deltaIdx = events.findIndex((e) => e.event === "message_delta");
  assert.ok(deltaIdx > 0 && deltaIdx === events.length - 2, "message_delta harus tepat sebelum message_stop");

  const openStarts = [];
  let expectedIndex = 0;
  for (const ev of events) {
    if (ev.event === "content_block_start") {
      assert.strictEqual(ev.data.index, expectedIndex, `Index blok start harus berurutan (expected ${expectedIndex})`);
      expectedIndex++;
      openStarts.push(ev.data.index);
    } else if (ev.event === "content_block_stop") {
      const last = openStarts.pop();
      assert.strictEqual(ev.data.index, last, "content_block_stop harus berpasangan dengan start terdekat");
    }
  }
  assert.strictEqual(openStarts.length, 0, "Semua content_block harus tertutup");
}

// ── STREAM TESTS ──────────────────────────────────────────────────

test("stream openai->claude: hanya delta.reasoning menghasilkan thinking dan teks fallback", async () => {
  const chunks = [
    mk({ role: "assistant", reasoning: "jawaban dari reasoning saja" }),
    mk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const raw = await runOpenAIToClaudeStream(chunks);
  const events = parseClaudeSSE(raw);

  assertValidClaudeEventSequence(events);

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.strictEqual(starts.length, 2, "Harus ada 2 blok konten (thinking dan text)");
  assert.strictEqual(starts[0].data.content_block.type, "thinking");
  assert.strictEqual(starts[1].data.content_block.type, "text");

  const thinkingDeltas = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta")
    .map((e) => e.data.delta.thinking)
    .join("");
  assert.strictEqual(thinkingDeltas, "jawaban dari reasoning saja");

  const textDeltas = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert.strictEqual(textDeltas, "jawaban dari reasoning saja", "Blok teks fallback harus memuat teks reasoning");
});

test("stream openai->claude: hanya delta.reasoning_content tanpa content menghasilkan thinking dan teks fallback", async () => {
  const chunks = [
    mk({ role: "assistant", reasoning_content: "jawaban dari reasoning_content" }),
    mk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const raw = await runOpenAIToClaudeStream(chunks);
  const events = parseClaudeSSE(raw);

  assertValidClaudeEventSequence(events);

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.strictEqual(starts.length, 2, "Harus ada 2 blok konten (thinking dan text)");
  assert.strictEqual(starts[0].data.content_block.type, "thinking");
  assert.strictEqual(starts[1].data.content_block.type, "text");

  const textDeltas = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert.strictEqual(textDeltas, "jawaban dari reasoning_content");
});

test("stream openai->claude: penutupan via flush() tanpa finish_reason (hanya [DONE]) tetap mengirim teks fallback", async () => {
  const chunks = [
    mk({ role: "assistant", reasoning_content: "alasan via flush" }),
    "data: [DONE]\n\n",
  ];
  const raw = await runOpenAIToClaudeStream(chunks);
  const events = parseClaudeSSE(raw);

  assertValidClaudeEventSequence(events);

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.strictEqual(starts.length, 2);
  assert.strictEqual(starts[1].data.content_block.type, "text");

  const textDeltas = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert.strictEqual(textDeltas, "alasan via flush");
});

test("stream openai->claude: ada content dan reasoning -> TIDAK ada blok teks tambahan", async () => {
  const chunks = [
    mk({ role: "assistant", reasoning_content: "berpikir...", content: "jawaban nyata" }),
    mk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const raw = await runOpenAIToClaudeStream(chunks);
  const events = parseClaudeSSE(raw);

  assertValidClaudeEventSequence(events);

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.strictEqual(starts.length, 2);
  assert.strictEqual(starts[0].data.content_block.type, "thinking");
  assert.strictEqual(starts[1].data.content_block.type, "text");

  const textDeltas = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert.strictEqual(textDeltas, "jawaban nyata", "Teks harus sama persis dengan delta content");
});

test("stream openai->claude: ada tool_calls dan reasoning tanpa content -> TIDAK ada teks fallback", async () => {
  const chunks = [
    mk({
      role: "assistant",
      reasoning_content: "harus baca file",
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "readFile", arguments: "{}" } }],
    }),
    mk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ];
  const raw = await runOpenAIToClaudeStream(chunks);
  const events = parseClaudeSSE(raw);

  assertValidClaudeEventSequence(events);

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.strictEqual(starts.length, 2, "Hanya thinking dan tool_use, tanpa teks fallback");
  assert.strictEqual(starts[0].data.content_block.type, "thinking");
  assert.strictEqual(starts[1].data.content_block.type, "tool_use");

  const msgDelta = events.find((e) => e.event === "message_delta");
  assert.strictEqual(msgDelta.data.delta.stop_reason, "tool_use");
});

test("stream openai->claude: kedua field reasoning dan reasoning_content pada delta yang sama -> tidak terduplikasi", async () => {
  const chunks = [
    mk({ role: "assistant", reasoning_content: "teks_rc", reasoning: "teks_r_duplikat" }),
    mk({}, "stop"),
    "data: [DONE]\n\n",
  ];
  const raw = await runOpenAIToClaudeStream(chunks);
  const events = parseClaudeSSE(raw);

  assertValidClaudeEventSequence(events);

  const thinkingDeltas = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta")
    .map((e) => e.data.delta.thinking)
    .join("");
  assert.strictEqual(thinkingDeltas, "teks_rc", "reasoning_content harus mengabaikan reasoning pada delta yang sama");
});

// ── NON-STREAM TESTS ──────────────────────────────────────────────

test("non-stream openai->claude: message.reasoning saja menghasilkan thinking dan teks fallback", () => {
  const res = translateResponse(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      id: "res_1",
      choices: [{ message: { role: "assistant", content: "", reasoning: "jawaban di reasoning" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    },
    "test-model"
  );

  assert.strictEqual(res.content.length, 2);
  assert.deepStrictEqual(res.content[0], { type: "thinking", thinking: "jawaban di reasoning" });
  assert.deepStrictEqual(res.content[1], { type: "text", text: "jawaban di reasoning" });
});

test("non-stream openai->claude: message.reasoning_content saja menghasilkan thinking dan teks fallback", () => {
  const res = translateResponse(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      id: "res_2",
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "jawaban di reasoning_content" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    },
    "test-model"
  );

  assert.strictEqual(res.content.length, 2);
  assert.deepStrictEqual(res.content[0], { type: "thinking", thinking: "jawaban di reasoning_content" });
  assert.deepStrictEqual(res.content[1], { type: "text", text: "jawaban di reasoning_content" });
});

test("non-stream openai->claude: kedua field reasoning dan reasoning_content -> reasoning_content menang", () => {
  const res = translateResponse(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      id: "res_3",
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "rc_utama", reasoning: "r_duplikat" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    },
    "test-model"
  );

  assert.strictEqual(res.content.length, 2);
  assert.deepStrictEqual(res.content[0], { type: "thinking", thinking: "rc_utama" });
  assert.deepStrictEqual(res.content[1], { type: "text", text: "rc_utama" });
});

test("non-stream openai->claude: respons dengan content biasa identik dengan sebelum perubahan", () => {
  const res = translateResponse(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      id: "res_norm",
      choices: [{ message: { role: "assistant", content: "halo dunia" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
    "test-model"
  );

  assert.deepStrictEqual(res.content, [{ type: "text", text: "halo dunia" }]);
});

test("non-stream openai->claude: respons tanpa reasoning dan content kosong tetap identik", () => {
  const res = translateResponse(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      id: "res_empty",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    },
    "test-model"
  );

  assert.deepStrictEqual(res.content, [{ type: "text", text: "" }]);
});

test("non-stream openai->claude: reasoning dengan tool_calls tanpa content -> thinking ada, teks kosong tetap", () => {
  const res = translateResponse(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    {
      id: "res_tc",
      choices: [{
        message: {
          role: "assistant",
          content: "",
          reasoning: "mencari data",
          tool_calls: [{ id: "c1", type: "function", function: { name: "get", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    },
    "test-model"
  );

  assert.strictEqual(res.content[0].type, "thinking");
  assert.strictEqual(res.content[0].thinking, "mencari data");
  assert.strictEqual(res.content[1].type, "text");
  assert.strictEqual(res.content[1].text, "", "Teks tidak boleh diisi fallback bila ada tool_calls");
  assert.strictEqual(res.content[2].type, "tool_use");
});

// ── REQUEST CLAUDE -> OPENAI (tool_result is_error) ───────────────

test("request claude->openai: tool_result is_error: true diberi awalan Error:", () => {
  const body = {
    model: "claude-test",
    max_tokens: 100,
    messages: [
      { role: "user", content: "jalankan" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "exec", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "File tidak ditemukan" },
        ],
      },
    ],
  };
  const req = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, body, "gpt-4o");
  const toolMsg = req.messages.find((m) => m.role === "tool");

  assert.strictEqual(toolMsg.tool_call_id, "t1", "tool_call_id harus tetap");
  assert.strictEqual(toolMsg.content, "Error: File tidak ditemukan");
});

test("request claude->openai: tool_result is_error: true dengan content kosong menghasilkan 'Error:'", () => {
  const body = {
    model: "claude-test",
    max_tokens: 100,
    messages: [
      { role: "user", content: "jalankan" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "exec", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "" },
        ],
      },
    ],
  };
  const req = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, body, "gpt-4o");
  const toolMsg = req.messages.find((m) => m.role === "tool");

  assert.strictEqual(toolMsg.tool_call_id, "t1");
  assert.strictEqual(toolMsg.content, "Error:");
});

test("request claude->openai: tool_result is_error: false atau tanpa is_error tidak diberi awalan Error:", () => {
  const body = {
    model: "claude-test",
    max_tokens: 100,
    messages: [
      { role: "user", content: "jalankan" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "exec", input: {} },
          { type: "tool_use", id: "t2", name: "exec", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: false, content: "berhasil 1" },
          { type: "tool_result", tool_use_id: "t2", content: "berhasil 2" },
        ],
      },
    ],
  };
  const req = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, body, "gpt-4o");
  const toolMsgs = req.messages.filter((m) => m.role === "tool");

  assert.strictEqual(toolMsgs.length, 2);
  assert.strictEqual(toolMsgs[0].content, "berhasil 1");
  assert.strictEqual(toolMsgs[1].content, "berhasil 2");
});
