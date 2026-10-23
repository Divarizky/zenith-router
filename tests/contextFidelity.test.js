import test from "node:test";
import assert from "node:assert";
import { translateRequest, createTransformStream, FORMATS } from "../src/translator/index.js";
import { responsesToOpenAIResponse } from "../src/translator/responses.js";
import { claudeToOpenAIResponse } from "../src/translator/response.js";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

// Matriks fidelitas konteks. Tiap jalur sumber -> target
// memakai fixture payload nyata (Claude Code, Codex CLI, klien OpenAI) dan
// mengunci perilaku yang benar. Jalur yang bocor konteks akan merah sampai
// task perbaikannya dikerjakan.

const geminiMod = await import("../src/translator/gemini.js");
const resetGeminiState = () => geminiMod.resetGeminiTranslatorState?.();

// ── Fixtures ──────────────────────────────────────────────────────────────

function claudeCodePayload() {
  return {
    model: "claude-opus-5",
    max_tokens: 32000,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 8000 },
    stop_sequences: ["STOP"],
    metadata: { user_id: "cc-user-1" },
    system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "baca file ini" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "user minta membaca file", signature: "sig1" },
          { type: "text", text: "membaca file" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "isi a.txt" },
          { type: "text", text: "lanjut" },
        ],
      },
    ],
  };
}

function codexPayload() {
  return {
    model: "gpt-5-codex",
    stream: true,
    store: false,
    instructions: "You are Codex.",
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "sess-1",
    text: { verbosity: "low" },
    tools: [
      {
        type: "function",
        name: "shell",
        description: "run",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
      { type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } },
    ],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "perbaiki bug" }] },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "perlu cek file" }],
        encrypted_content: "ENC1",
      },
      { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "c1", output: "a.txt" },
      {
        type: "custom_tool_call",
        call_id: "c2",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
      },
      { type: "custom_tool_call_output", call_id: "c2", output: "applied" },
    ],
  };
}

function openaiClientPayload() {
  return {
    model: "glm-4.6",
    max_completion_tokens: 20000,
    reasoning_effort: "high",
    stop: ["END"],
    temperature: 1.5,
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "lihat gambar" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
        ],
      },
      {
        role: "assistant",
        content: "oke",
        tool_calls: [
          { id: "c9", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c9", content: "isi a.txt" },
    ],
  };
}

function chatForGemini() {
  return {
    model: "gemini-3.1-pro",
    messages: [
      { role: "system", content: "Kamu agent." },
      { role: "system", content: "Jawab ringkas." },
      { role: "user", content: "baca file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "mcp__custom-tools__bash", arguments: '{"command":"ls"}' },
          },
          {
            id: "t2",
            type: "function",
            function: { name: "Read", arguments: '{"file_path":"a.txt"}' },
            extra_content: { google: { thought_signature: "sigX" } },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "a.txt" },
      { role: "tool", tool_call_id: "t2", content: "isi" },
      { role: "user", content: "lanjut" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "mcp__custom-tools__bash",
          description: "shell",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: { name: "Read", description: "read", parameters: { type: "object", properties: {} } },
      },
    ],
  };
}

// ── Baseline: jalur yang tidak boleh berubah ──────────────────────────────

test("baseline - claude ke claude diteruskan apa adanya", () => {
  const body = claudeCodePayload();
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, body, body.model);
  assert.deepStrictEqual(out, body);
});

test("baseline - openai ke openai hanya ganti model", () => {
  const body = openaiClientPayload();
  const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, body, body.model);
  assert.deepStrictEqual(out, { ...body, model: body.model });
});

// ── Responses -> Responses passthrough ───────────────────────────

test("translateRequest responses->responses mempertahankan seluruh body", () => {
  const body = codexPayload();
  const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, body, body.model);
  assert.deepStrictEqual(out, body);
});

test("stream responses->responses identik byte per byte", async () => {
  const stream = createTransformStream(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "gpt-5-codex");
  const raw = 'data: {"type":"response.output_text.delta","delta":"halo"}\n\ndata: [DONE]\n\n';
  const source = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(raw));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  assert.strictEqual(text, raw);
});

test("REGRESI - gateway /responses non-stream mengagregasi SSE upstream", async () => {
  initDb(":memory:");
  addConnection({ provider: "codex", name: "Codex account", credentials: { api_key: "sk-test" } });

  setCustomExecutor({
    async execute() {
      const events = [
        'data: {"type":"response.created","response":{"id":"resp_9"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"ha"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_9","status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      ];
      return new Response(
        new ReadableStream({
          start(c) {
            for (const ev of events) c.enqueue(new TextEncoder().encode(ev));
            c.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-5-codex", input: "hi", stream: false }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.object, "response");
    assert.strictEqual(data.output[0].content[0].text, "halo");
    assert.strictEqual(data.usage.input_tokens, 3);
  } finally {
    setCustomExecutor(null);
  }
});

test("gateway /responses meneruskan body Responses mentah ke upstream Responses", async () => {
  initDb(":memory:");
  addConnection({
    provider: "codex",
    name: "Codex account",
    credentials: { api_key: "sk-test" },
  });

  let capturedBody = null;
  setCustomExecutor({
    async execute({ body }) {
      capturedBody = JSON.parse(body);
      const events = [
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
      ];
      return new Response(
        new ReadableStream({
          start(c) {
            for (const ev of events) c.enqueue(new TextEncoder().encode(ev));
            c.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(codexPayload()),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(capturedBody, "executor harus dipanggil");
    // Body Responses mentah: reasoning, prompt_cache_key, dan input items
    // harus tampil di upstream apa adanya.
    assert.deepStrictEqual(capturedBody.input, codexPayload().input);
    assert.strictEqual(capturedBody.prompt_cache_key, "sess-1");
    assert.deepStrictEqual(capturedBody.reasoning, { effort: "high", summary: "auto" });
    assert.deepStrictEqual(capturedBody.include, ["reasoning.encrypted_content"]);
    const text = await res.text();
    assert.ok(text.includes('"type":"response.completed"'), "stream Responses diteruskan");
  } finally {
    setCustomExecutor(null);
  }
});

// ── Responses -> OpenAI pivot tetap memegang tool ─────────────

test("responses->openai: pairing tool call dan custom tool tetap utuh", () => {
  const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, codexPayload(), "glm-4.6");
  const messages = out.messages;

  const sysIdx = messages.findIndex((m) => m.role === "system");
  assert.ok(sysIdx >= 0 && messages[sysIdx].content.includes("You are Codex."), "instructions -> system");

  const asstTurns = messages.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(asstTurns.length > 0, "ada assistant dengan tool_calls");

  const allCalls = asstTurns.flatMap((m) => m.tool_calls);
  const fn = allCalls.find((t) => t.function.name === "shell");
  assert.strictEqual(fn.id, "c1");
  const patch = allCalls.find((t) => t.function.name === "apply_patch");
  assert.ok(patch, "custom_tool_call menjadi tool_call");
  const parsedPatch = JSON.parse(patch.function.arguments);
  assert.ok(parsedPatch.input.includes("Begin Patch"), "isi patch tidak hilang");

  const toolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "c1");
  assert.ok(toolMsg && toolMsg.content.includes("a.txt"), "function_call_output -> tool message");

  // Custom tool dideklarasikan sebagai function dengan satu parameter string.
  const patchDecl = out.tools.find((t) => t.function?.name === "apply_patch");
  assert.ok(patchDecl, "custom tool dideklarasikan di chat");
  assert.strictEqual(patchDecl.function.parameters.properties.input.type, "string");
});

test("respons chat ke klien Responses: custom tool kembali via set gateway", async () => {
  // Daftarkan nama custom lewat pivot agar state deterministik.
  translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, codexPayload(), "glm-4.6");

  // Simulasi Codex CLI -> GLM non-stream: upstream chat menjawab function_call
  // untuk apply_patch; gateway mem-thread set custom dari rawBody Responses.
  const { openAIMessageToResponsesOutput } = await import("../src/translator/responses.js");
  const message = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c2", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch" }) } }],
  };
  const customNames = new Set(["apply_patch"]);
  const output = openAIMessageToResponsesOutput(message, { customToolNames: customNames });
  const call = output.find((i) => i.type === "custom_tool_call");
  assert.ok(call, "custom tool kembali sebagai custom_tool_call");
  assert.strictEqual(call.call_id, "c2");
  assert.strictEqual(call.input, "*** Begin Patch", "input mentah, bukan JSON wrapper");

  // Tanpa set (klien chat): tetap function_call.
  const plain = openAIMessageToResponsesOutput(message);
  assert.ok(plain.some((i) => i.type === "function_call" && i.name === "apply_patch"));
  assert.ok(!plain.some((i) => i.type === "custom_tool_call"));
});

test("REGRESI - registry custom tool tidak bocor ke klien chat lain", () => {
  // Codex CLI mendaftarkan apply_patch sebagai custom (registry global terisi).
  translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, codexPayload(), "glm-4.6");

  // Klien chat lain kebetulan punya function tool bernama sama dengan skema
  // dan argumen yang berbeda — harus tetap function_call.
  const chatBody = {
    model: "gpt-5-codex",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ id: "z1", type: "function", function: { name: "apply_patch", arguments: '{"patchText":"diff"}' } }] },
      { role: "tool", tool_call_id: "z1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "apply_patch", parameters: { type: "object", properties: { patchText: { type: "string" } } } } }],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, chatBody, "gpt-5-codex");
  assert.ok(out.input.some((i) => i.type === "function_call" && i.name === "apply_patch"), "tetap function_call");
  assert.ok(!out.input.some((i) => i.type === "custom_tool_call"), "tidak salah label custom_tool_call");

  // Stream: klien chat tanpa deklarasi custom tidak pernah menerima custom_tool_call.
  const stream = createTransformStream(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-5-codex", { customToolNames: new Set() });
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "z9", function: { name: "apply_patch", arguments: "" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"patchText":"d"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ].map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
  const src = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunks)); c.close(); } });
  return new Response(src.pipeThrough(stream)).text().then((text) => {
    assert.ok(!text.includes("custom_tool_call"), "stream chat tidak menghasilkan custom_tool_call");
    assert.ok(text.includes("function_call"));
  });
});

test("REGRESI - codex executor strip field tak didukung dan default store", async () => {
  const { stripUnsupportedFields } = await import("../src/executors/codex.js");
  const out = JSON.parse(stripUnsupportedFields(JSON.stringify({
    model: "gpt-5-codex",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    temperature: 0.4,
    top_p: 0.9,
    max_output_tokens: 512,
  })));
  assert.strictEqual(out.temperature, undefined, "temperature dibuang oleh codex backend");
  assert.strictEqual(out.top_p, undefined, "top_p dibuang");
  assert.strictEqual(out.max_output_tokens, undefined, "max_output_tokens dibuang");
  assert.strictEqual(out.store, false, "store default false untuk backend ChatGPT");
  // Klien yang eksplisit mengirim store dipertahankan.
  const explicit = JSON.parse(stripUnsupportedFields(JSON.stringify({ input: "x", store: true })));
  assert.strictEqual(explicit.store, true);
  // Body non-Responses (pivot chat) tidak diberi default store.
  const chat = JSON.parse(stripUnsupportedFields(JSON.stringify({ model: "m", messages: [] })));
  assert.strictEqual(chat.store, undefined);
});

test("REGRESI - reasoning terenkripsi dibuang saat failover pindah akun", async () => {
  initDb(":memory:");
  addConnection({ provider: "codex", name: "Codex A", credentials: { api_key: "sk-a" } });
  addConnection({ provider: "codex", name: "Codex B", credentials: { api_key: "sk-b" } });
  const bodies = [];
  let call = 0;
  setCustomExecutor({
    async execute({ body, connection }) {
      bodies.push({ conn: connection?.name, parsed: JSON.parse(body) });
      call++;
      if (call === 1) return new Response("upstream down", { status: 500 });
      const sse = 'data: {"type":"response.completed","response":{"id":"r2","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex/gpt-5-codex",
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "reasoning", encrypted_content: "ENC-ORG-A", summary: [] },
          { type: "reasoning", summary: [{ type: "summary_text", text: "plain" }] },
        ],
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(bodies.length, 2, "dua percobaan");
    assert.ok(bodies[0].parsed.input.some((i) => i.encrypted_content === "ENC-ORG-A"), "percobaan pertama utuh");
    const retryInput = bodies[1].parsed.input;
    assert.ok(!retryInput.some((i) => i.encrypted_content), "reasoning terenkripsi dibuang di akun kedua");
    assert.ok(retryInput.some((i) => i.type === "reasoning"), "reasoning tanpa encrypted_content dipertahankan");
    assert.ok(retryInput.some((i) => i.type === "message"), "pesan user utuh");
  } finally {
    setCustomExecutor(null);
  }
});

// ── Claude -> OpenAI ─────────────────────────────────────────────

test("claude->openai: tool_use, gambar, urutan, dan parameter", () => {
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, claudeCodePayload(), "glm-4.6");
  const messages = out.messages;

  assert.strictEqual(out.max_tokens, 32000, "max_tokens klien dipertahankan");
  assert.deepStrictEqual(out.stop, ["STOP"], "stop_sequences -> stop");
  assert.strictEqual(out.user, undefined, "metadata.user_id tidak diteruskan ke pihak ketiga");
  assert.strictEqual(out.thinking, undefined, "thinking Claude tidak dikirim ke upstream chat");

  // Assistant: teks + tool_calls terpisah; thinking hidup di reasoning_content
  // (dibutuhkan model reasoning-replay), bukan di content.
  const asst = messages.find((m) => m.role === "assistant");
  assert.strictEqual(asst.content, "membaca file");
  assert.strictEqual(asst.reasoning_content, "user minta membaca file", "thinking Claude jadi reasoning_content");
  assert.strictEqual(asst.tool_calls.length, 1);
  assert.strictEqual(asst.tool_calls[0].id, "toolu_1");
  assert.strictEqual(asst.tool_calls[0].function.name, "Read");
  assert.deepStrictEqual(JSON.parse(asst.tool_calls[0].function.arguments), { file_path: "a.txt" });
  assert.ok(!asst.content.includes("user minta membaca file"), "thinking tidak bocor ke content");

  // User: gambar -> image_url.
  const user1 = messages[1];
  assert.strictEqual(user1.role, "user");
  const img = user1.content.find((p) => p.type === "image_url");
  assert.strictEqual(img.image_url.url, "data:image/png;base64,aW1n");

  // Urutan: tool message langsung setelah assistant, sebelum teks user terakhir.
  const asstIdx = messages.findIndex((m) => m.role === "assistant");
  const toolIdx = messages.findIndex((m) => m.role === "tool");
  const lastUserIdx = messages.length - 1;
  assert.strictEqual(toolIdx, asstIdx + 1, "tool message langsung setelah assistant");
  assert.strictEqual(messages[toolIdx].tool_call_id, "toolu_1");
  assert.strictEqual(messages[toolIdx].content, "isi a.txt", "tool_result string tanpa double stringify");
  assert.ok(toolIdx < lastUserIdx, "tool sebelum user terakhir");
  assert.deepStrictEqual(messages[lastUserIdx], { role: "user", content: "lanjut" });
});

// ── OpenAI -> Claude ─────────────────────────────────────────────

test("openai->claude: max_tokens, gambar, stop, thinking, suhu", () => {
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, openaiClientPayload(), "claude-opus-5");
  assert.strictEqual(out.max_tokens, 20000, "max_completion_tokens dipakai");
  assert.deepStrictEqual(out.stop_sequences, ["END"], "stop -> stop_sequences");
  // Thinking aktif -> sampling dikunci (temperature 1, tanpa top_p).
  assert.strictEqual(out.temperature, 1, "temperature dikunci 1 saat thinking");
  assert.strictEqual(out.top_p, undefined, "top_p dibuang saat thinking");
  assert.ok(out.thinking && out.thinking.type === "enabled", "reasoning_effort -> thinking aktif");
  assert.ok(out.thinking.budget_tokens >= 1024, "budget_tokens wajar");

  const imgMsg = out.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image")
  );
  assert.ok(imgMsg, "image_url -> blok image");
  const img = imgMsg.content.find((p) => p.type === "image");
  assert.strictEqual(img.source.type, "base64");
  assert.strictEqual(img.source.media_type, "image/png");
  assert.strictEqual(img.source.data, "aW1n");

  const asst = out.messages.find((m) => m.role === "assistant");
  const tu = asst.content.find((p) => p.type === "tool_use");
  assert.deepStrictEqual(tu.input, { file_path: "a.txt" }, "argumen tool ter-parse");

  const tr = out.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  assert.ok(tr, "tool message -> tool_result");
  assert.strictEqual(tr.content[0].tool_use_id, "c9");
});

test("openai->claude: budget thinking di-clamp ke max_tokens kecil", () => {
  const body = { model: "m", max_tokens: 4000, reasoning_effort: "high", messages: [{ role: "user", content: "x" }] };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body, "claude-opus-5");
  assert.ok(out.thinking.budget_tokens < 4000, "budget tidak boleh >= max_tokens");
  assert.strictEqual(out.temperature, 1);
});

test("REGRESI - max_tokens <= 1024 mematikan thinking, bukan budget ilegal", () => {
  const body = { model: "m", max_tokens: 1000, reasoning_effort: "high", messages: [{ role: "user", content: "x" }] };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body, "claude-opus-5");
  assert.strictEqual(out.thinking, undefined, "thinking tidak boleh aktif tanpa ruang budget");
  assert.ok(out.max_tokens >= 1000, "max_tokens dipertahankan");
});

test("REGRESI - tool_result Claude ber-image jadi tool message text-only", () => {
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "lihat" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }, { type: "text", text: "hasil" }] },
          { type: "text", text: "lanjut" },
        ],
      },
    ],
    tools: [{ name: "shot", input_schema: { type: "object" } }],
  };
  const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, body, "m");
  const toolMsg = out.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool message ada");
  assert.strictEqual(typeof toolMsg.content, "string", "content tool message string");
  assert.ok(!JSON.stringify(toolMsg.content).includes("image_url"), "tanpa image_url di tool message");
  assert.ok(toolMsg.content.includes("hasil"), "teks tool result dipertahankan");
});

test("REGRESI - assistant OpenAI ber-array content tetap role assistant", () => {
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "text", text: "sudah dicek" }] },
      { role: "user", content: "y" },
    ],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body, "m");
  const asst = out.messages.find((m) => m.role === "assistant");
  assert.ok(asst, "assistant dipertahankan");
  assert.strictEqual(asst.content, "sudah dicek");
});

test("openai->claude: gambar URL http dan tool_choice required", () => {
  const body = {
    model: "m",
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", properties: {} } } }],
    messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "https://e.com/a.png" } }] }],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body, "claude-opus-5");
  assert.deepStrictEqual(out.tool_choice, { type: "any" }, "required -> any");
  const img = out.messages[0].content.find((p) => p.type === "image");
  assert.deepStrictEqual(img.source, { type: "url", url: "https://e.com/a.png" });
});

test("openai->claude: default max_tokens dari capabilities model", () => {
  const body = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body, "claude-opus-5");
  assert.strictEqual(out.max_tokens, 128000, "bukan dipaksa 4096");

  const unknown = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, { model: "mystery-model", messages: [{ role: "user", content: "hi" }] }, "mystery-model");
  assert.strictEqual(unknown.max_tokens, 4096, "fallback terakhir tetap 4096");
});

test("openai->claude: argumen tool JSON rusak tidak melempar", () => {
  const body = {
    model: "m",
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "Bash", arguments: "{rusak" } }] },
      { role: "tool", tool_call_id: "x", content: "ok" },
    ],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, body, "claude-opus-5");
  const tu = out.messages[0].content.find((p) => p.type === "tool_use");
  assert.deepStrictEqual(tu.input, {}, "argumen rusak -> objek kosong");
});

// ── Kiro ─────────────────────────────────────────────────────────

test("kiro: riwayat tool dan system prompt di giliran yang benar", () => {
  const body = {
    model: "claude-3-7-sonnet",
    messages: [
      { role: "system", content: "You are a CLI." },
      { role: "user", content: "baca file" },
      { role: "assistant", content: null, tool_calls: [{ id: "tk1", type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tk1", content: "isi" },
      { role: "user", content: "lanjut" },
    ],
    tools: [
      { type: "function", function: { name: "Read", description: "read", parameters: { type: "object", properties: {} } } },
    ],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, body, "claude-3-7-sonnet");
  const cs = out.conversationState;

  assert.strictEqual(cs.currentMessage.userInputMessage.content, "lanjut", "current text = user terakhir");
  assert.ok(!JSON.stringify(cs).includes("Hello"), "tanpa pesan user palsu");

  const h = cs.history || [];
  assert.strictEqual(h.length, 2, "history: user, assistant");
  assert.ok(h[0].userInputMessage.content.includes("You are a CLI."), "system prompt di giliran user pertama");
  assert.ok(h[0].userInputMessage.content.includes("baca file"));

  // toolUses membawa input agar upstream bisa memvalidasi dan model
  // mengingat argumen panggilan sebelumnya.
  assert.deepStrictEqual(h[1].assistantResponseMessage.toolUses, [{ toolUseId: "tk1", name: "Read", input: {} }]);

  // Tool result menempel di user turn yang menjawab assistant, di dalam
  // userInputMessage (bukan sejajar), bergabung dengan teks user berikut.
  const curCtx = cs.currentMessage.userInputMessage.userInputMessageContext;
  assert.ok(curCtx?.toolResults, "tool result di current turn yang menjawab");
  assert.strictEqual(curCtx.toolResults[0].toolUseId, "tk1");
});

test("kiro stream: fragmen toolUseEvent satu id digabung", async () => {
  const { createKiroToOpenAITransformStream } = await import("../src/translator/kiro.js");
  const { crc32 } = await import("../src/utils/eventstream.js");
  const enc = new TextEncoder();

  function frame(obj) {
    const payload = enc.encode(JSON.stringify(obj));
    const headers = [];
    const pushHeader = (name, val) => {
      const n = enc.encode(name);
      const v = enc.encode(val);
      headers.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
    };
    pushHeader(":message-type", "event");
    pushHeader(":event-type", "TestEvent");
    const hlen = headers.length;
    const total = 12 + hlen + payload.length + 4;
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    view.setUint32(0, total, false);
    view.setUint32(4, hlen, false);
    buf.set(headers, 12);
    buf.set(payload, 12 + hlen);
    view.setUint32(8, crc32(buf.subarray(0, 8)), false);
    view.setUint32(total - 4, crc32(buf.subarray(0, total - 4)), false);
    return buf;
  }

  const stream = createKiroToOpenAITransformStream("m");
  const source = new ReadableStream({
    start(c) {
      c.enqueue(frame({ toolUseEvent: { toolUseId: "u1", name: "Bash", input: '{"cmd":"' } }));
      c.enqueue(frame({ toolUseEvent: { toolUseId: "u1", name: "Bash", input: 'ls"}' } }));
      c.enqueue(frame({ toolUseEvent: { toolUseId: "u2", name: "Read", input: "{}" } }));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  const calls = text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(5)))
    .flatMap((p) => p.choices || [])
    .flatMap((c) => c.delta?.tool_calls || []);
  const byId = {};
  for (const t of calls) {
    if (t.id) byId[t.id] = t;
  }
  // u1 muncul sekali sebagai pembuka (index sama di semua fragmennya).
  const u1chunks = calls.filter((t) => t.id === "u1" || (!t.id && t.index === byId.u1?.index));
  assert.ok(u1chunks.length >= 2, "fragmen u1 digabung dalam satu tool call");
  assert.strictEqual(byId.u2.function.name, "Read");
  assert.ok(text.includes('"finish_reason":"tool_calls"'));
});

test("kiro: history selang-seling user/assistant", () => {
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "t1" },
      { role: "assistant", content: null, tool_calls: [{ id: "k1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "k1", content: "out" },
      { role: "user", content: "b" },
    ],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.KIRO, body, "m");
  const h = out.conversationState.history || [];
  const kinds = h.map((e) => (e.userInputMessage ? "user" : "assistant"));
  for (let i = 1; i < kinds.length; i++) {
    assert.notStrictEqual(kinds[i], kinds[i - 1], `giliran ${i} selang-seling`);
  }
  const asst = h.find((e) => e.assistantResponseMessage?.toolUses);
  assert.ok(asst.assistantResponseMessage.content.includes("t1"), "assistant berurutan digabung");
});

// ── Gemini / Antigravity ─────────────────────────────────────────

test("gemini: nama tool, system gabung, dan functionResponse", () => {
  resetGeminiState?.();
  const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, chatForGemini(), "gemini-3.1-pro");

  assert.strictEqual(out.systemInstruction.parts.length, 2, "semua system message digabung");
  assert.strictEqual(out.systemInstruction.parts[0].text, "Kamu agent.");

  const modelStep = out.contents.find((c) => c.role === "model");
  const fcNames = modelStep.parts.filter((p) => p.functionCall).map((p) => p.functionCall.name);
  assert.deepStrictEqual(fcNames, ["mcp__custom_tools__bash", "Read"]);

  const frContents = out.contents.filter((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
  assert.strictEqual(frContents.length, 1, "functionResponse satu step digabung jadi satu content");
  const frNames = frContents[0].parts.map((p) => p.functionResponse.name);
  assert.deepStrictEqual(frNames, ["mcp__custom_tools__bash", "Read"], "nama dari lookup tool_call_id");
});

test("gemini: extra_content signature dihormati, turn lama tanpa dummy", () => {
  resetGeminiState?.();
  const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, chatForGemini(), "gemini-3.1-pro");
  const modelStep = out.contents.find((c) => c.role === "model");
  const fcs = modelStep.parts.filter((p) => p.functionCall);

  // Tool turn ini diikuti user text "lanjut", jadi bukan giliran kini: tidak
  // ada dummy. Signature klien (extra_content) tetap dihormati kapan pun ada.
  assert.strictEqual(fcs[0].thoughtSignature, undefined);
  assert.strictEqual(fcs[1].thoughtSignature, "sigX", "extra_content klien dipakai apa adanya");
  assert.ok(fcs.every((p) => !("thoughtSignature" in p.functionCall)), "signature di level Part, bukan di functionCall");
});

test("gemini: current turn (berakhir di tool result) dapat dummy signature", () => {
  resetGeminiState?.();
  const body = {
    model: "gemini-3.1-pro",
    messages: [
      { role: "user", content: "baca" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "n1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "n2", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "n1", content: "a" },
      { role: "tool", tool_call_id: "n2", content: "b" },
    ],
    tools: [
      { type: "function", function: { name: "bash", description: "", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "Read", description: "", parameters: { type: "object", properties: {} } } },
    ],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, body, "gemini-3.1-pro");
  const modelStep = out.contents.find((c) => c.role === "model");
  const fcs = modelStep.parts.filter((p) => p.functionCall);

  // FunctionCall pertama tiap step di giliran kini wajib membawa signature.
  assert.strictEqual(fcs[0].thoughtSignature, "skip_thought_signature_validator");
  assert.ok(!("thoughtSignature" in fcs[0].functionCall), "proto menolak thoughtSignature di dalam functionCall");

  // functionResponse satu step digabung jadi satu content user, sesudah
  // seluruh functionCall (tidak diselang-seling).
  const frContents = out.contents.filter((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
  assert.strictEqual(frContents.length, 1, "functionResponse satu step digabung");
  assert.deepStrictEqual(frContents[0].parts.map((p) => p.functionResponse.name), ["bash", "Read"]);

  // Seluruh functionCall mendahului functionResponse dalam urutan contents.
  const modelIdx = out.contents.indexOf(modelStep);
  const frIdx = out.contents.indexOf(frContents[0]);
  assert.ok(modelIdx < frIdx, "model step sebelum functionResponse");
});

test("gemini: tool turn lama tidak diberi dummy signature", () => {
  resetGeminiState?.();
  const body = {
    model: "gemini-3.1-pro",
    messages: [
      { role: "user", content: "baca" },
      { role: "assistant", content: null, tool_calls: [{ id: "old1", type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old1", content: "isi" },
      { role: "user", content: "lanjut" },
    ],
    tools: [{ type: "function", function: { name: "Read", description: "", parameters: { type: "object", properties: {} } } }],
  };
  const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, body, "gemini-3.1-pro");
  const oldStep = out.contents.find((c) => c.role === "model");
  const fc = oldStep.parts.find((p) => p.functionCall);
  assert.strictEqual(fc.thoughtSignature, undefined, "turn lama tidak divalidasi upstream");
});

test("gemini: nama tool dikembalikan di respons stream", async () => {
  resetGeminiState?.();
  // Deklarasikan dulu agar peta nama terisi.
  translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, chatForGemini(), "gemini-3.1-pro");

  const stream = createTransformStream(FORMATS.GEMINI, FORMATS.OPENAI, "gemini-3.1-pro");
  const chunk = {
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { name: "mcp__custom_tools__bash", args: { command: "ls" }, thoughtSignature: "ts1" } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
  const source = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: chunk })}\n\n`));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  const calls = text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(5)))
    .flatMap((p) => p.choices || [])
    .flatMap((c) => c.delta?.tool_calls || []);
  assert.strictEqual(calls[0].function.name, "mcp__custom-tools__bash", "nama asli klien dipulihkan");
  resetGeminiState?.();
});

// ── stream Responses -> OpenAI ────────────────────────────────

async function collectChatChunks(stream, events) {
  const source = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(5)));
}

test("stream responses: hanya output_text yang menjadi content", async () => {
  const stream = createTransformStream(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "muse");
  const chunks = await collectChatChunks(stream, [
    { type: "response.output_text.delta", delta: "jawaban" },
    { type: "response.reasoning_summary_text.delta", delta: "alasan internal" },
    { type: "response.output_item.added", item: { type: "custom_tool_call", call_id: "cc1", name: "apply_patch" } },
    { type: "response.custom_tool_call_input.delta", delta: "*** Begin Patch" },
    { type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "cc1", name: "apply_patch", input: "*** Begin Patch" } },
    { type: "response.completed", response: { usage: {} } },
  ]);

  const contents = chunks.flatMap((p) => p.choices || []).map((c) => c.delta?.content).filter(Boolean);
  assert.deepStrictEqual(contents, ["jawaban"], "hanya teks jawaban");

  const reasoning = chunks.flatMap((p) => p.choices || []).map((c) => c.delta?.reasoning_content).filter(Boolean);
  assert.deepStrictEqual(reasoning, ["alasan internal"], "reasoning summary -> reasoning_content");

  const args = chunks
    .flatMap((p) => p.choices || [])
    .flatMap((c) => c.delta?.tool_calls || [])
    .map((t) => t.function?.arguments || "")
    .join("");
  assert.ok(args.includes("Begin Patch"), "input custom tool -> arguments tool_call");
  const names = chunks.flatMap((p) => p.choices || []).flatMap((c) => c.delta?.tool_calls || []).map((t) => t.function?.name);
  assert.ok(names.includes("apply_patch"), "custom tool call memakai nama tool");
});

// ── CommandCode ─────────────────────────────────────────

test("commandcode: tanpa default paksa, toolName dari lookup, workingDir netral", async () => {
  const { translateOpenAIToCommandCode } = await import("../src/executors/commandcode.js");

  // Klien tidak mengirim temperature/max_tokens -> tidak boleh dipaksa.
  const bare = translateOpenAIToCommandCode({ model: "m", messages: [{ role: "user", content: "hi" }] }, "m");
  assert.strictEqual(bare.params.temperature, undefined, "temperature tidak dipaksa 0.3");
  assert.strictEqual(bare.params.max_tokens, undefined, "max_tokens tidak dipaksa 8192");
  assert.notStrictEqual(bare.config.workingDir, process.cwd(), "workingDir tidak membocorkan path lokal");

  // Klien memberi parameter -> diteruskan apa adanya.
  const given = translateOpenAIToCommandCode({ model: "m", temperature: 0.7, max_tokens: 1234, messages: [] }, "m");
  assert.strictEqual(given.params.temperature, 0.7);
  assert.strictEqual(given.params.max_tokens, 1234);

  // toolName diambil dari tool_calls terkait, bukan selalu kosong.
  const withTools = translateOpenAIToCommandCode(
    {
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "cc_1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "cc_1", content: "ok" },
      ],
    },
    "m"
  );
  const toolMsg = withTools.params.messages.find((m) => m.role === "tool");
  assert.strictEqual(toolMsg.content[0].toolName, "Bash", "toolName diisi dari tool_call");
});

// ── reasoning dan usage cache di respons ─────────────────────────

test("openai->claude stream: satu thinking block dengan urutan benar", async () => {
  const stream = createTransformStream(FORMATS.OPENAI, FORMATS.CLAUDE, "glm");
  const ev = (o) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: o }] })}\n\n`;
  const source = new ReadableStream({
    start(c) {
      const e = new TextEncoder();
      c.enqueue(e.encode(ev({ reasoning_content: "a" })));
      c.enqueue(e.encode(ev({ reasoning_content: "b" })));
      c.enqueue(e.encode(ev({ content: "hi" })));
      c.enqueue(e.encode(ev({ reasoning_content: "late" })));
      c.enqueue(e.encode(ev({ content: "!" })));
      c.close();
    },
  });
  const text = await new Response(source.pipeThrough(stream)).text();
  const lines = text.split("\n");
  const starts = lines.filter((l) => l.startsWith("data: ") && l.includes("content_block_start")).map((l) => JSON.parse(l.slice(6)));
  const thinkingStarts = starts.filter((s) => s.content_block.type === "thinking");
  assert.ok(thinkingStarts.length >= 1, "reasoning diteruskan sebagai thinking");
  // Tidak pernah ada dua blok terbuka bersamaan: setiap start diikuti stop
  // sebelum start berikutnya (blok sekuensial, bukan interleave).
  const seq = lines.filter((l) => l.startsWith("event:")).map((l) => l.slice(7));
  let open = 0;
  let maxOpen = 0;
  for (const e of seq) {
    if (e === "content_block_start") { open++; maxOpen = Math.max(maxOpen, open); }
    if (e === "content_block_stop") { open--; }
    assert.ok(open >= 0, "stop tanpa start");
  }
  assert.strictEqual(maxOpen, 1, "maksimal satu blok terbuka");
  assert.strictEqual(open, 0, "semua blok ditutup");
  // Dua delta reasoning pertama berbagi blok yang sama.
  const deltas = lines
    .filter((l) => l.startsWith("data: ") && l.includes("thinking_delta"))
    .map((l) => JSON.parse(l.slice(6)));
  assert.strictEqual(deltas[0].index, deltas[1].index, "delta berurutan satu blok");
});

test("claude->openai stream: thinking dan cache usage", async () => {
  const events = [
    { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 } } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "jawab" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const run = async (opts) => {
    const stream = createTransformStream(FORMATS.CLAUDE, FORMATS.OPENAI, "claude-opus-5", opts);
    const source = new ReadableStream({
      start(c) {
        for (const ev of events) c.enqueue(new TextEncoder().encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        c.close();
      },
    });
    const text = await new Response(source.pipeThrough(stream)).text();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
  };

  const payloads = await run({});
  const reasoning = payloads.flatMap((p) => p.choices || []).map((c) => c.delta?.reasoning_content).filter(Boolean);
  assert.deepStrictEqual(reasoning, ["hmm"], "thinking_delta -> reasoning_content");

  // Tanpa include_usage tidak ada chunk usage (spec OpenAI).
  assert.ok(!payloads.some((p) => p.usage), "usage chunk hanya saat include_usage");
  // Chunk finish_reason tetap terakhir sebelum [DONE].
  const finishIdx = payloads.map((p) => p.choices?.[0]?.finish_reason).lastIndexOf("stop");
  assert.ok(finishIdx >= 0 && finishIdx === payloads.length - 1, "finish_reason menutup stream");

  const withUsage = await run({ includeUsage: true });
  const usage = withUsage.find((p) => p.usage)?.usage;
  assert.ok(usage, "ada chunk usage");
  assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 500, "cache_read -> cached_tokens");
  const finishIdx2 = withUsage.map((p) => p.choices?.[0]?.finish_reason).lastIndexOf("stop");
  const usageIdx = withUsage.findIndex((p) => p.usage);
  assert.ok(usageIdx > finishIdx2, "usage chunk setelah finish_reason");
});

test("responses->openai non-stream: cached_tokens", async () => {
  const out = await responsesToOpenAIResponse(
    {
      id: "resp_1",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "halo" }] }],
      usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } },
    },
    "muse"
  );
  assert.strictEqual(out.usage.prompt_tokens, 100);
  assert.strictEqual(out.usage.prompt_tokens_details?.cached_tokens, 80, "input_tokens_details -> prompt_tokens_details");
});

test("claude->openai non-stream: cache_read -> cached_tokens", () => {
  const out = claudeToOpenAIResponse(
    { id: "msg_1", model: "claude-opus-5", content: [{ type: "text", text: "halo" }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 200 } },
    "claude-opus-5"
  );
  assert.strictEqual(out.usage.prompt_tokens_details?.cached_tokens, 200);
});
