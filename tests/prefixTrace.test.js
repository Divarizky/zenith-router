import test from "node:test";
import assert from "node:assert";
import { createPrefixTracer, compareFingerprints, fingerprintRequest } from "../src/services/prefixTrace.js";

const msg = (text) => ({ role: "user", parts: [{ text }] });
const base = () => ({
  systemInstruction: { parts: [{ text: "SYS" }] },
  tools: [{ functionDeclarations: [{ name: "read" }] }],
  contents: [msg("a"), msg("b")],
});

test("prefix trace - giliran yang hanya menambah pesan tidak memutus prefix", () => {
  const seen = [];
  const tracer = createPrefixTracer({ enabled: true, log: (line) => seen.push(line) });
  tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: base() });
  const next = base();
  next.contents.push(msg("c"));
  const result = tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: next });

  assert.deepStrictEqual(
    { systemChanged: result.systemChanged, toolsChanged: result.toolsChanged, divergeAt: result.divergeAt },
    { systemChanged: false, toolsChanged: false, divergeAt: null }
  );
  assert.strictEqual(seen.length, 2);
});

test("prefix trace - riwayat yang ditulis ulang menunjuk indeks pertama yang berubah", () => {
  const tracer = createPrefixTracer({ enabled: true, log: () => {} });
  tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: base() });
  const edited = base();
  edited.contents[1] = msg("b-edited");
  edited.contents.push(msg("c"));
  const result = tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: edited });

  assert.strictEqual(result.divergeAt, 1);
  assert.strictEqual(result.prevLength, 2);
});

test("prefix trace - perubahan systemInstruction dan tools terdeteksi terpisah", () => {
  const tracer = createPrefixTracer({ enabled: true, log: () => {} });
  tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: base() });
  const changed = base();
  changed.systemInstruction = { parts: [{ text: "SYS v2" }] };
  const result = tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: changed });

  assert.strictEqual(result.systemChanged, true);
  assert.strictEqual(result.toolsChanged, false);
  assert.strictEqual(result.divergeAt, null);
});

test("prefix trace - riwayat yang dipotong dilaporkan sebagai divergensi di batas panjang baru", () => {
  const tracer = createPrefixTracer({ enabled: true, log: () => {} });
  tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: base() });
  const shorter = base();
  shorter.contents = [msg("a")];
  const result = tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: shorter });

  assert.strictEqual(result.divergeAt, 1);
  assert.strictEqual(result.length, 1);
});

test("prefix trace - sesi berbeda tidak saling dibandingkan", () => {
  const tracer = createPrefixTracer({ enabled: true, log: () => {} });
  tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: base() });
  const other = tracer.observe({ provider: "antigravity", sessionKey: "s2", model: "m", request: base() });
  assert.strictEqual(other, null);
});

test("prefix trace - sesi lama terusir saat melebihi batas dan log tidak memuat session key mentah", () => {
  const lines = [];
  const tracer = createPrefixTracer({ enabled: true, maxSessions: 1, log: (l) => lines.push(l) });
  tracer.observe({ provider: "antigravity", sessionKey: "apikey:secret-session-42", model: "m", request: base() });
  tracer.observe({ provider: "antigravity", sessionKey: "other", model: "m", request: base() });
  const again = tracer.observe({ provider: "antigravity", sessionKey: "apikey:secret-session-42", model: "m", request: base() });

  assert.strictEqual(again, null);
  assert.ok(lines.every((l) => !l.includes("secret-session-42")));
});

test("prefix trace - tracer nonaktif tidak mencatat apa pun", () => {
  const lines = [];
  const tracer = createPrefixTracer({ enabled: false, log: (l) => lines.push(l) });
  const result = tracer.observe({ provider: "antigravity", sessionKey: "s1", model: "m", request: base() });
  assert.strictEqual(result, null);
  assert.strictEqual(lines.length, 0);
});

test("prefix trace - fingerprint tidak berubah oleh urutan kunci objek", () => {
  const a = fingerprintRequest({ tools: [{ name: "x", parameters: { a: 1, b: 2 } }] });
  const b = fingerprintRequest({ tools: [{ parameters: { b: 2, a: 1 }, name: "x" }] });
  assert.strictEqual(a.tools, b.tools);
  assert.strictEqual(compareFingerprints(a, b).toolsChanged, false);
});
