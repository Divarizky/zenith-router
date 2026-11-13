import test from "node:test";
import assert from "node:assert";
import { createGeminiToOpenAITransformStream } from "../src/translator/gemini.js";

// Regresi: upstream Antigravity kadang menutup SSE tanpa finishReason. Klien
// OpenAI (pi) melempar "Stream ended without finish_reason" bila stream selesai
// tanpa finish_reason. Zenith harus menyintesis finish_reason hanya bila jawaban
// pasti utuh (tool call), dan selain itu melaporkan error eksplisit, bukan sukses.

const enc = new TextEncoder();
const dec = new TextDecoder();
const ev = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function run(sse) {
  const src = new ReadableStream({
    start(c) {
      for (const part of sse) c.enqueue(enc.encode(part));
      c.close();
    },
  });
  let out = "";
  for await (const chunk of src.pipeThrough(createGeminiToOpenAITransformStream("gemini-4-hydrogen"))) {
    out += dec.decode(chunk);
  }
  return out;
}

const frames = (out) =>
  out
    .split("\n\n")
    .filter((f) => f.startsWith("data:") && !f.includes("[DONE]"))
    .map((f) => JSON.parse(f.slice(5)));

const text = (t) => ({ response: { candidates: [{ content: { parts: [{ text: t }] } }] } });
const toolCall = {
  response: { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] } }] },
};

test("EOF tanpa finishReason setelah teks: error eksplisit, bukan [DONE] sukses", async () => {
  const out = await run([ev(text("jawaban terpotong"))]);
  const parsed = frames(out);
  const last = parsed[parsed.length - 1];
  assert.ok(last.error, "frame terakhir harus error");
  assert.strictEqual(last.error.code, "upstream_stream_reset");
  assert.match(last.error.message, /without finishReason/);
  assert.ok(!out.includes("[DONE]"));
  assert.ok(!out.includes('"finish_reason":"stop"'));
});

test("EOF tanpa finishReason setelah tool call: finish_reason tool_calls disintesis", async () => {
  const out = await run([ev(toolCall)]);
  const parsed = frames(out);
  const last = parsed[parsed.length - 1];
  assert.strictEqual(last.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(parsed.filter((p) => p.choices?.[0]?.finish_reason).length, 1);
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

test("event error upstream ikut dilaporkan dalam pesan error", async () => {
  const out = await run([ev(text("sebagian")), ev({ error: { code: 500, message: "internal failure", status: "INTERNAL" } })]);
  const last = frames(out).pop();
  assert.match(last.error.message, /internal failure/);
});

test("stream normal dengan finishReason tidak berubah: satu finish_reason dan [DONE]", async () => {
  const finished = { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } };
  const out = await run([ev(text("utuh")), ev(finished)]);
  assert.strictEqual([...out.matchAll(/"finish_reason":"stop"/g)].length, 1);
  assert.ok(!out.includes('"error"'));
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});
