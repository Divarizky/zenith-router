import test from "node:test";
import assert from "node:assert";
import { createGeminiToOpenAITransformStream } from "../src/translator/gemini.js";
import { getConsoleLogs, clearConsoleLogs } from "../src/services/logger.js";

// Regresi diagnostik: stream Gemini yang berakhir tanpa finishReason membuat
// pi melempar "Stream ended without finish_reason". Trace opt-in harus mencatat
// bentuk event non-candidate dan ketiadaan finishReason, tanpa mengubah output.

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

const thoughtOnly = { response: { candidates: [{ content: { parts: [{ thought: true, text: "berpikir" }] } }] } };

async function withTrace(value, fn) {
  const prev = process.env.ZENITH_STREAM_TRACE;
  if (value === undefined) delete process.env.ZENITH_STREAM_TRACE;
  else process.env.ZENITH_STREAM_TRACE = value;
  clearConsoleLogs();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ZENITH_STREAM_TRACE;
    else process.env.ZENITH_STREAM_TRACE = prev;
  }
}

test("ZENITH_STREAM_TRACE=1 mencatat stream yang berakhir tanpa finishReason", () =>
  withTrace("1", async () => {
    await run([ev(thoughtOnly)]);
    const traced = getConsoleLogs().filter((l) => l.includes("[stream-trace]"));
    assert.strictEqual(traced.length, 1);
    assert.match(traced[0], /model=gemini-4-hydrogen/);
    assert.match(traced[0], /finish=none/);
  }));

test("ZENITH_STREAM_TRACE=1 mencatat event error upstream yang dibuang", () =>
  withTrace("1", async () => {
    await run([ev(thoughtOnly), ev({ error: { code: 500, message: "internal", status: "INTERNAL" } })]);
    const traced = getConsoleLogs().filter((l) => l.includes("[stream-trace]"));
    assert.strictEqual(traced.length, 1);
    assert.match(traced[0], /dropped=1/);
    assert.match(traced[0], /error_event=1/);
  }));

test("ZENITH_STREAM_TRACE tidak aktif: tidak ada log dan output tidak berubah", () =>
  withTrace(undefined, async () => {
    const out = await run([ev(thoughtOnly)]);
    assert.strictEqual(getConsoleLogs().filter((l) => l.includes("[stream-trace]")).length, 0);
    assert.ok(!out.includes('"finish_reason":"stop"'));
  }));

test("trace tidak mengubah stream normal: finish tetap dikirim sekali", () =>
  withTrace("1", async () => {
    const finished = { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } };
    const out = await run([ev(thoughtOnly), ev(finished)]);
    assert.strictEqual([...out.matchAll(/"finish_reason":"stop"/g)].length, 1);
    const traced = getConsoleLogs().filter((l) => l.includes("[stream-trace]"));
    assert.strictEqual(traced.length, 1);
    assert.match(traced[0], /finish=seen/);
    assert.match(traced[0], /dropped=0/);
  }));
