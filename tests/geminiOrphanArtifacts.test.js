import test from "node:test";
import assert from "node:assert";
import {
  stripOrphanBracketArtifacts,
  createGeminiToOpenAITransformStream,
  geminiToOpenAIResponse,
} from "../src/translator/gemini.js";
import { getConsoleLogs, clearConsoleLogs } from "../src/services/logger.js";

// Regresi: model upstream Gemini menempelkan `!]`, `$]`, `*]` setelah tanda baca
// penutup kalimat. Penghapusan harus tepat sasaran; teks kode/regex tidak boleh rusak.

test("artefak .!] di akhir string dihapus, tanda baca tetap", () => {
  assert.strictEqual(stripOrphanBracketArtifacts("Sudah sesuai.!]"), "Sudah sesuai.");
});

test("artefak .$] di tengah paragraf dihapus saat diikuti spasi", () => {
  assert.strictEqual(
    stripOrphanBracketArtifacts("Tunggu TASK-0108.$] Perlu saya..."),
    "Tunggu TASK-0108. Perlu saya...",
  );
});

test("artefak ?*] sebelum newline dihapus, newline tetap", () => {
  assert.strictEqual(stripOrphanBracketArtifacts("Lanjut ke Issue #10?*]\n"), "Lanjut ke Issue #10?\n");
});

test("teks sah dengan kurung siku tidak diubah", () => {
  const samples = [
    "[!]",
    "[$]",
    "arr[i!]",
    "regex /[^$]/",
    "[kalimat.!]",
    "Teks normal tanpa artefak.",
    "",
  ];
  for (const s of samples) {
    assert.strictEqual(stripOrphanBracketArtifacts(s), s, `berubah: ${JSON.stringify(s)}`);
  }
});

test("kurung siku yang sudah tertutup di baris sama tetap dihapus artefaknya", () => {
  // `[a]` sudah seimbang, sehingga `.!]` setelahnya adalah artefak yatim.
  assert.strictEqual(stripOrphanBracketArtifacts("lihat [a].!]"), "lihat [a].");
});

test("streaming SSE: content dibersihkan, reasoning_content dan tool_calls tidak disentuh", async () => {
  const ts = createGeminiToOpenAITransformStream("m");
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const drain = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  })();

  const chunks = [
    { response: { candidates: [{ content: { parts: [{ text: "pikir [x].!] tetap", thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: "Sudah sesuai.!]" }] } }] } },
    {
      response: {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "f", args: { q: "a[!]" } } }],
            },
            finishReason: "STOP",
          },
        ],
      },
    },
  ];
  for (const c of chunks) await writer.write(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
  await writer.close();
  const out = await drain;

  const parsed = out
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));

  const reasoning = parsed.filter((p) => p.choices[0].delta.reasoning_content !== undefined);
  assert.strictEqual(reasoning.length, 1);
  assert.strictEqual(reasoning[0].choices[0].delta.reasoning_content, "pikir [x].!] tetap");

  const content = parsed.filter((p) => p.choices[0].delta.content !== undefined);
  assert.deepStrictEqual(
    content.map((p) => p.choices[0].delta.content),
    ["Sudah sesuai."],
    "chunk content kosong setelah sanitasi harus dilewati",
  );

  const calls = parsed.flatMap((p) => p.choices[0].delta.tool_calls || []);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, "f");
  assert.strictEqual(calls[0].function.arguments, JSON.stringify({ q: "a[!]" }));
});

test("non-streaming: content dibersihkan, reasoning_content dan tool_calls tidak disentuh", async () => {
  const res = await geminiToOpenAIResponse(
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "rencana [a].!]", thought: true },
              { text: "Lanjut ke Issue #10?*]\n" },
              { text: "Tunggu TASK-0108.$] Perlu saya..." },
              { functionCall: { name: "g", args: { pat: "[$]" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    "gemini-x",
  );

  const message = res.choices[0].message;
  assert.strictEqual(message.content, "Lanjut ke Issue #10?\nTunggu TASK-0108. Perlu saya...");
  assert.strictEqual(message.reasoning_content, "rencana [a].!]");
  assert.strictEqual(message.tool_calls.length, 1);
  assert.strictEqual(message.tool_calls[0].function.name, "g");
  assert.strictEqual(message.tool_calls[0].function.arguments, JSON.stringify({ pat: "[$]" }));
});

test("ZENITH_ARTIFACT_TRACE=1 mencatat penghapusan ke log dengan cuplikan terbatas", () => {
  const prev = process.env.ZENITH_ARTIFACT_TRACE;
  process.env.ZENITH_ARTIFACT_TRACE = "1";
  clearConsoleLogs();
  try {
    assert.strictEqual(stripOrphanBracketArtifacts("Sudah sesuai.!]", "gemini-x"), "Sudah sesuai.");
    const traced = getConsoleLogs().filter((l) => l.includes("[artifact-trace]"));
    assert.strictEqual(traced.length, 1);
    assert.match(traced[0], /model=gemini-x/);
    assert.match(traced[0], /stripped="!\]"/);
  } finally {
    if (prev === undefined) delete process.env.ZENITH_ARTIFACT_TRACE;
    else process.env.ZENITH_ARTIFACT_TRACE = prev;
    clearConsoleLogs();
  }
});

test("ZENITH_ARTIFACT_TRACE tidak aktif: teks sah tidak mencatat log", () => {
  const prev = process.env.ZENITH_ARTIFACT_TRACE;
  delete process.env.ZENITH_ARTIFACT_TRACE;
  clearConsoleLogs();
  try {
    stripOrphanBracketArtifacts("Sudah sesuai.!]");
    assert.strictEqual(getConsoleLogs().filter((l) => l.includes("[artifact-trace]")).length, 0);
  } finally {
    if (prev !== undefined) process.env.ZENITH_ARTIFACT_TRACE = prev;
    clearConsoleLogs();
  }
});
