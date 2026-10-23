import test from "node:test";
import assert from "node:assert";
import { claudeToOpenAI } from "../src/translator/request.js";
import { responsesToOpenAIRequest } from "../src/translator/responses.js";
import { ClineExecutor, clineExecutorInstance } from "../src/executors/cline.js";
import { registerExecutor, setCustomExecutor } from "../src/executors/base.js";

registerExecutor("cline", clineExecutorInstance);

function lastAssistant(messages) {
  return [...messages].reverse().find((m) => m.role === "assistant");
}

test("claudeToOpenAI - blok thinking jadi reasoning_content, bukan dibuang", () => {
  const out = claudeToOpenAI({
    max_tokens: 100,
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "alasan internal" },
        { type: "text", text: "jawaban" },
      ],
    }],
  });
  const a = lastAssistant(out.messages);
  assert.strictEqual(a.content, "jawaban");
  assert.strictEqual(a.reasoning_content, "alasan internal");
});

test("claudeToOpenAI - turn thinking-only tetap membawa reasoning_content", () => {
  const out = claudeToOpenAI({
    max_tokens: 100,
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "hanya renungan" }],
    }],
  });
  const a = lastAssistant(out.messages);
  assert.strictEqual(a.reasoning_content, "hanya renungan");
  assert.strictEqual(a.content, null);
});

test("claudeToOpenAI - tool_use + thinking sama-sama dipertahankan", () => {
  const out = claudeToOpenAI({
    max_tokens: 100,
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pikir" },
        { type: "text", text: "pakai tool" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.js" } },
      ],
    }],
  });
  const a = lastAssistant(out.messages);
  assert.strictEqual(a.reasoning_content, "pikir");
  assert.strictEqual(a.content, "pakai tool");
  assert.strictEqual(a.tool_calls.length, 1);
});

test("responsesToOpenAIRequest - item reasoning menempel ke assistant berikutnya", () => {
  const out = responsesToOpenAIRequest({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "ringkasan alasan" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "jawaban" }] },
    ],
  });
  const a = lastAssistant(out.messages);
  assert.strictEqual(a.content, "jawaban");
  assert.strictEqual(a.reasoning_content, "ringkasan alasan");
});

test("responsesToOpenAIRequest - reasoning sebelum function_call menempel ke turn tool_calls", () => {
  const out = responsesToOpenAIRequest({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "lihat file" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "perlu baca" }] },
      { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
    ],
  });
  const a = lastAssistant(out.messages);
  assert.ok(Array.isArray(a.tool_calls));
  assert.strictEqual(a.reasoning_content, "perlu baca");
});

test("responsesToOpenAIRequest - reasoning tidak bocor ke user berikutnya", () => {
  const out = responsesToOpenAIRequest({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "renungan" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
    ],
  });
  // tidak ada assistant turn, jadi reasoning hilang — tidak boleh nempel di user
  const userWithReasoning = out.messages.find((m) => m.role === "user" && m.reasoning_content !== undefined);
  assert.strictEqual(userWithReasoning, undefined);
});

test("executor cline - payload upstream diisi reasoning_content pada assistant tanpa reasoning", async () => {
  let capturedBody = null;
  const fetchFn = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    void url;
    return new Response(
      JSON.stringify({
        id: "ch1", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new ClineExecutor({ fetchFn });

  try {
    await executor.execute({
      url: "https://api.cline.bot/api/v1/chat/completions",
      method: "POST",
      headers: {},
      signal: undefined,
      connection: {},
      targetFormat: "openai",
      body: JSON.stringify({
        model: "reflection/beam-free",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "pertanyaan" },
          { role: "assistant", content: "jawaban awal", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "isi file" },
          { role: "user", content: "lanjut" },
        ],
      }),
      stream: false,
    });

    const a = capturedBody.messages.find((m) => m.role === "assistant");
    assert.strictEqual(a.reasoning_content, " ", "placeholder satu spasi harus disisipkan");
    assert.strictEqual(capturedBody.messages[3].role, "tool");
    assert.strictEqual(capturedBody.messages[3].reasoning_content, undefined, "pesan tool tidak boleh diisi");
  } finally {
    setCustomExecutor(null);
  }
});

test("executor cline - mengekstrak reasoning_details, menghapus tag <|...|>, dan membuang reasoning_details", async () => {
  let capturedBody = null;
  const fetchFn = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    void url;
    return new Response(
      JSON.stringify({
        id: "ch2", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new ClineExecutor({ fetchFn });

  await executor.execute({
    url: "https://api.cline.bot/api/v1/chat/completions",
    method: "POST",
    headers: {},
    signal: undefined,
    connection: {},
    targetFormat: "openai",
    body: JSON.stringify({
      model: "reflection/beam-free",
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: null,
          reasoning_details: [
            {
              type: "reasoning.text",
              text: " <|constrain|><|constrain|>assistant<|channel|>final<|message|>Hi! Ada yang bisa saya bantu?",
              format: "unknown",
              index: 0,
            },
          ],
          tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    }),
    stream: true,
  });

  const asst = capturedBody.messages.find((m) => m.role === "assistant");
  assert.strictEqual(asst.reasoning_details, undefined, "reasoning_details harus dihapus agar tidak bentrok dengan reasoning_content");
  assert.strictEqual(asst.reasoning_content, "Hi! Ada yang bisa saya bantu?", "teks bersih diekstrak tanpa tag <|...|>");
});

test("executor cline - token Harmony literal di content assistant dinetralkan", async () => {
  let capturedBody = null;
  const fetchFn = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    void url;
    return new Response(
      JSON.stringify({
        id: "ch3", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new ClineExecutor({ fetchFn });
  const quoted = "contoh: <|constrain|>assistant<|channel|>final<|message|>Hi";

  await executor.execute({
    url: "https://api.cline.bot/api/v1/chat/completions",
    method: "POST",
    headers: {},
    signal: undefined,
    connection: {},
    targetFormat: "openai",
    body: JSON.stringify({
      model: "reflection/beam-free",
      messages: [
        { role: "user", content: quoted },
        { role: "assistant", content: quoted },
        { role: "assistant", content: [{ type: "text", text: quoted }] },
        { role: "user", content: "lanjut" },
      ],
    }),
    stream: true,
  });

  const [user, asstString, asstParts] = capturedBody.messages;
  assert.strictEqual(user.content, quoted, "pesan user tidak diubah");
  assert.ok(!/<\|[^|>]+\|>/.test(asstString.content), "tidak ada token <|...|> utuh di content string");
  assert.strictEqual(asstString.content.replace(/\u200b/g, ""), quoted, "teks tetap sama selain zero-width space");
  assert.ok(!/<\|[^|>]+\|>/.test(asstParts.content[0].text), "tidak ada token <|...|> utuh di text part");
});
