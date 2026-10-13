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

test("OPENCODE_UA - aligned to official release 1.19.0", () => {
  assert.strictEqual(OPENCODE_UA, "opencode/1.19.0");
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

test("opencodeRequestId - msg_ + exact ascending-timestamp prefix + 14 base62", () => {
  const ts = 1791901684000;
  const id = opencodeRequestId(ts);
  assert.ok(OPENCODE_REQUEST_RE.test(id), `id '${id}' harus sesuai ^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`);
  assert.strictEqual(id.length, 30);
  assert.strictEqual(id.slice(4, 16), expectedPrefix(ts, 1, false), "prefix = ts*4096+1, 48 bit terbawah");

  const later = opencodeRequestId(ts + 1000).slice(4, 16);
  assert.ok(later > id.slice(4, 16), "prefix request naik seiring waktu");
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
    await executor.execute({ url: "https://opencode.ai/zen/v1/chat/completions", body });
    assert.strictEqual(captured["User-Agent"], "opencode/1.19.0");
    assert.strictEqual(captured.Authorization, "Bearer public");
    assert.strictEqual(captured["x-opencode-client"], "desktop");
    assert.strictEqual(captured["x-opencode-project"], "global");
    assert.ok(OPENCODE_SESSION_RE.test(captured["x-opencode-session"]));
    assert.ok(OPENCODE_REQUEST_RE.test(captured["x-opencode-request"]));

    const canonical = opencodeSessionId();
    await executor.execute({ url: "https://opencode.ai/zen/v1/chat/completions", body, sessionKey: canonical });
    assert.strictEqual(captured["x-opencode-session"], canonical, "sessionKey kanonikal dipakai apa adanya");

    await executor.execute({
      url: "https://opencode.ai/zen/v1/chat/completions",
      body,
      headers: { "User-Agent": "opencode/1.18.31", "x-opencode-session": canonical },
    });
    assert.strictEqual(captured["User-Agent"], "opencode/1.19.0", "UA versi lama tidak pernah lolos ke upstream");
    assert.notStrictEqual(captured["x-opencode-session"], canonical, "sesi hanya ditentukan sessionKey, bukan header");
  } finally {
    proto.execute = origExecute;
  }
});
