import test from "node:test";
import assert from "node:assert";
import {
  opencodeSessionId,
  opencodeRequestId,
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  OPENCODE_UA,
  OpencodeExecutor,
} from "../src/executors/opencode.js";

// Independent re-derivation of the OpenCode CLI id prefix: the low 48 bits of
// (timestamp * 4096 + counter), inverted for sessions, as 12 hex characters.
function expectedPrefix(timestamp, counter, inverted) {
  let value = BigInt(timestamp) * 0x1000n + BigInt(counter);
  if (inverted) value = ~value;
  return (value & 0xffffffffffffn).toString(16).padStart(12, "0");
}

test("OPENCODE_UA - aligned to official release v2 CLI", () => {
  assert.strictEqual(OPENCODE_UA, "opencode/latest/2.1.2/cli");
});

test("opencodeSessionId - ses_ + exact inverted-timestamp prefix + 14 base62", () => {
  const ts = 1791901681000;
  const id = opencodeSessionId(ts);
  assert.ok(OPENCODE_SESSION_RE.test(id), `id '${id}' harus sesuai ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`);
  assert.strictEqual(id.length, 30);
  assert.strictEqual(id.slice(4, 16), expectedPrefix(ts, 1, true), "prefix = ~(ts*4096+1), 48 bit terbawah");

  // The counter keeps ids in the same millisecond distinct and descending.
  const second = opencodeSessionId(ts);
  assert.strictEqual(second.slice(4, 16), expectedPrefix(ts, 2, true));
  assert.ok(second.slice(4, 16) < id.slice(4, 16), "id kedua di milidetik yang sama lebih kecil");
});

test("opencodeSessionId - a later timestamp gives a smaller prefix (newest sorts first)", () => {
  const earlier = opencodeSessionId(1791901682000).slice(4, 16);
  const later = opencodeSessionId(1791901683000).slice(4, 16);
  assert.ok(later < earlier, `prefix sesi menurun seiring waktu: ${later} < ${earlier}`);
  assert.strictEqual(later, expectedPrefix(1791901683000, 1, true), "milidetik baru mulai lagi dari counter 1");
});

test("opencodeSessionId - counter wraps cleanly at 16 without overflowing into timestamp", () => {
  const ts = 1791901685000;
  const ids = [];
  for (let i = 0; i < 20; i++) {
    ids.push(opencodeSessionId(ts));
  }
  // All 20 ids are valid 30-char session ids
  for (const id of ids) {
    assert.ok(OPENCODE_SESSION_RE.test(id));
    assert.strictEqual(id.length, 30);
  }
  // The first 16 have extraMs = 0, counter 1..16
  assert.strictEqual(ids[0].slice(4, 16), expectedPrefix(ts, 1, true));
  assert.strictEqual(ids[15].slice(4, 16), expectedPrefix(ts, 16, true));
  // The 17th has extraMs = 1, counter 1
  assert.strictEqual(ids[16].slice(4, 16), expectedPrefix(ts + 1, 1, true));
});

test("OpencodeExecutor - canonical headers; a canonical sessionKey passes through, request headers do not", async () => {
  const executor = new OpencodeExecutor();
  let captured = null;
  const proto = Object.getPrototypeOf(OpencodeExecutor.prototype);
  const origExecute = proto.execute;
  proto.execute = async function ({ headers }) {
    captured = headers;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const body = JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "test" }] });
  try {
    await executor.execute({ url: "https://opencode.ai/inference/v1/chat/completions", body });
    assert.strictEqual(captured["User-Agent"], "opencode/latest/2.1.2/cli");
    assert.strictEqual(captured.Authorization, "Bearer public");
    assert.strictEqual(captured["x-opencode-client"], "cli");
    assert.strictEqual(captured["x-opencode-project"], "global");
    assert.ok(OPENCODE_SESSION_RE.test(captured["x-opencode-session"]));
    assert.strictEqual(captured["x-opencode-session-id"], captured["x-opencode-session"]);
    assert.strictEqual(captured["x-session-affinity"], captured["x-opencode-session"]);
    assert.strictEqual(captured["x-session-id"], captured["x-opencode-session"]);
    assert.strictEqual(captured["x-opencode-request"], undefined);

    const canonical = opencodeSessionId();
    await executor.execute({ url: "https://opencode.ai/inference/v1/chat/completions", body, sessionKey: canonical });
    assert.strictEqual(captured["x-opencode-session"], canonical, "sessionKey kanonikal dipakai apa adanya");

    await executor.execute({
      url: "https://opencode.ai/inference/v1/chat/completions",
      body,
      headers: { "User-Agent": "opencode/1.18.31", "x-opencode-session": canonical },
    });
    assert.strictEqual(captured["User-Agent"], "opencode/latest/2.1.2/cli", "UA versi lama tidak pernah lolos ke upstream");
    assert.notStrictEqual(captured["x-opencode-session"], canonical, "sesi hanya ditentukan sessionKey, bukan header");
  } finally {
    proto.execute = origExecute;
  }
});
