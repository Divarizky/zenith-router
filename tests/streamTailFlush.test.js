import test from "node:test";
import assert from "node:assert";
import { createResponseTransformStream } from "../src/translator/response.js";
import { createGeminiToOpenAITransformStream } from "../src/translator/gemini.js";
import { createResponsesToOpenAITransformStream } from "../src/translator/responses.js";

// Jalankan stream dengan potongan input, kumpulkan semua output sebagai teks.
async function run(stream, parts) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const enc = new TextEncoder();
  const out = [];
  const drain = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(new TextDecoder().decode(value));
    }
  })();
  for (const p of parts) await writer.write(enc.encode(p));
  await writer.close();
  await drain;
  return out.join("");
}

test("F-05 gemini: event terakhir tanpa newline di akhir stream tetap diterjemahkan", async () => {
  // Tidak ada "\n" penutup: baris terakhir masih tertahan di buffer.
  const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: "halo-akhir" }] } }] });
  const text = await run(createGeminiToOpenAITransformStream("gemini-x"), [`data: ${payload}`]);
  assert.match(text, /halo-akhir/, "teks dari sisa buffer harus keluar");
});

test("F-05 responses: delta teks terakhir tanpa newline tidak hilang", async () => {
  const payload = JSON.stringify({ type: "response.output_text.delta", delta: "ekor-teks" });
  const text = await run(createResponsesToOpenAITransformStream("codex"), [`data: ${payload}`]);
  assert.match(text, /ekor-teks/, "delta terakhir harus keluar");
});

test("F-05 claude->openai: delta teks terakhir tanpa newline tidak hilang", async () => {
  const ev = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ekor-claude" } });
  const text = await run(createResponseTransformStream("claude", "openai", "claude-x"), [
    "event: content_block_delta\n",
    `data: ${ev}`,
  ]);
  assert.match(text, /ekor-claude/, "delta teks terakhir harus keluar dari sisa buffer");
});
