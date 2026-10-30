import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import { clientSessionKey } from "../src/gateway/session.js";
import {
  translateOpencodeSession,
  resetOpencodeSessionCache,
  getOpencodeSessionCacheSize,
  OPENCODE_SESSION_RE,
  OpencodeExecutor,
} from "../src/executors/opencode.js";

test("translateOpencodeSession - valid canonical session returned as-is", () => {
  resetOpencodeSessionCache();
  const canonical = "ses_eca564ef7ffelQtnupb7jxVPkW";
  assert.strictEqual(translateOpencodeSession(canonical), canonical);
  assert.strictEqual(translateOpencodeSession(`  ${canonical}  `), canonical);
  assert.strictEqual(getOpencodeSessionCacheSize(), 0, "canonical valid tidak perlu masuk cache");
});

test("translateOpencodeSession - arbitrary key returns stable canonical session ID across calls", () => {
  resetOpencodeSessionCache();
  const key = "conv_thread_abc123";

  const first = translateOpencodeSession(key, "claude");
  assert.ok(OPENCODE_SESSION_RE.test(first), "harus menghasilkan ID sesi kanonikal");
  assert.strictEqual(getOpencodeSessionCacheSize(), 1);

  // Panggilan kedua dengan kunci yang sama harus mengembalikan ID yang sama
  const second = translateOpencodeSession(key, "claude");
  assert.strictEqual(second, first, "kunci yang sama harus menghasilkan sesi yang sama");

  // Kunci berbeda menghasilkan sesi berbeda
  const other = translateOpencodeSession("conv_thread_xyz999", "claude");
  assert.ok(OPENCODE_SESSION_RE.test(other));
  assert.notStrictEqual(other, first, "kunci berbeda harus menghasilkan sesi berbeda");
  assert.strictEqual(getOpencodeSessionCacheSize(), 2);
});

test("translateOpencodeSession - expired session is renewed after TTL", () => {
  resetOpencodeSessionCache();
  const key = "user_expiring_session";

  // Sesi dibuat pada t0
  const t0 = 1791900000000;
  const first = translateOpencodeSession(key, "generic", { now: t0, ttlMs: 60000 });
  assert.ok(first);

  // Akses pada t0 + 30s (masih aktif) -> ID sama, lastUsed diperbarui
  const t1 = t0 + 30000;
  const same = translateOpencodeSession(key, "generic", { now: t1, ttlMs: 60000 });
  assert.strictEqual(same, first, "sesi dalam jendela TTL harus tetap dipakai");

  // Akses pada t1 + 65s (sudah lewat TTL dari t1) -> dibuat sesi baru
  const t2 = t1 + 65000;
  const renewed = translateOpencodeSession(key, "generic", { now: t2, ttlMs: 60000 });
  assert.notStrictEqual(renewed, first, "sesi setelah melewati TTL harus diperbarui");
  assert.ok(OPENCODE_SESSION_RE.test(renewed));
});

test("translateOpencodeSession - LRU eviction when reaching capacity limit", () => {
  resetOpencodeSessionCache();
  const maxCapacity = 5;

  // Isi sampai kapasitas penuh
  const sessions = [];
  for (let i = 0; i < maxCapacity; i++) {
    sessions.push(translateOpencodeSession(`key_${i}`, "generic", { maxSessions: maxCapacity }));
  }
  assert.strictEqual(getOpencodeSessionCacheSize(), maxCapacity);

  // Akses ulang key_0 agar posisinya segar (paling baru)
  translateOpencodeSession("key_0", "generic", { maxSessions: maxCapacity });

  // Masukkan entri baru key_new -> key_1 (yang terlama tidak dipakai) harus terdepak
  const newSession = translateOpencodeSession("key_new", "generic", { maxSessions: maxCapacity });
  assert.ok(OPENCODE_SESSION_RE.test(newSession));
  assert.strictEqual(getOpencodeSessionCacheSize(), maxCapacity, "ukuran cache tidak boleh melebihi batas");

  // key_0 masih ada (sesinya sama)
  const key0Session = translateOpencodeSession("key_0", "generic", { maxSessions: maxCapacity });
  assert.strictEqual(key0Session, sessions[0], "key_0 yang baru diakses harus tetap bertahan");

  // key_1 sudah terdepak -> mendapat sesi baru
  const key1Session = translateOpencodeSession("key_1", "generic", { maxSessions: maxCapacity });
  assert.notStrictEqual(key1Session, sessions[1], "key_1 yang terdepak harus mendapat sesi baru");
});

test("clientSessionKey - session header first, then body markers, then the gateway key; auth is never used", () => {
  const headers = (map) => (name) => map[name];

  assert.strictEqual(
    clientSessionKey({ header: headers({ "x-session-id": "s-1", "x-conversation-id": "c-1" }), body: { user: "u" } }),
    "s-1",
    "header sesi eksplisit menang"
  );
  assert.strictEqual(
    clientSessionKey({ header: headers({}), body: { metadata: { user_id: "user_x_session_abc" }, user: "u" } }),
    "user_x_session_abc",
    "metadata.user_id Claude Code dipakai bila tidak ada header"
  );
  assert.strictEqual(clientSessionKey({ header: headers({}), body: { prompt_cache_key: "pck-9" } }), "pck-9");
  assert.strictEqual(clientSessionKey({ header: headers({}), body: {}, apiKeyId: 7 }), "apikey:7");
  assert.strictEqual(
    clientSessionKey({ header: headers({ authorization: "Bearer zr_secret" }), body: {} }),
    null,
    "header authorization tidak pernah dijadikan kunci sesi"
  );
  assert.strictEqual(
    clientSessionKey({ header: headers({ "x-session-id": "x".repeat(500) }) }).length,
    256,
    "kunci dibatasi 256 karakter"
  );
});

test("OpencodeExecutor - the gateway sessionKey decides the upstream session", async () => {
  resetOpencodeSessionCache();
  const executor = new OpencodeExecutor();
  const sessions = [];
  const proto = Object.getPrototypeOf(OpencodeExecutor.prototype);
  const origExecute = proto.execute;
  proto.execute = async function ({ headers }) {
    sessions.push(headers["x-opencode-session"]);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const call = (sessionKey) =>
    executor.execute({
      url: "https://opencode.ai/zen/v1/chat/completions",
      body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "x" }] }),
      sessionKey,
    });
  try {
    await call("thread-42");
    await call("thread-42");
    await call("thread-99");
  } finally {
    proto.execute = origExecute;
  }
  assert.ok(OPENCODE_SESSION_RE.test(sessions[0]), "sesi upstream harus kanonikal");
  assert.strictEqual(sessions[1], sessions[0], "kunci yang sama memakai sesi upstream yang sama");
  assert.notStrictEqual(sessions[2], sessions[0], "kunci berbeda memakai sesi upstream berbeda");
});

test("Gateway - different client conversations reach OpenCode as different sessions", async () => {
  initDb(":memory:");
  resetOpencodeSessionCache();
  const sessions = [];
  const proto = Object.getPrototypeOf(OpencodeExecutor.prototype);
  const origExecute = proto.execute;
  proto.execute = async function ({ headers }) {
    sessions.push(headers["x-opencode-session"]);
    const sse =
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const chat = (extraHeaders) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    await chat({ "x-session-id": "klien-A" });
    await chat({ "x-session-id": "klien-A" });
    await chat({ "x-session-id": "klien-B" });
    for (const userId of ["user_abc_session_claude-1", "user_abc_session_claude-2"]) {
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "opencode/big-pickle",
          max_tokens: 64,
          metadata: { user_id: userId },
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    }
  } finally {
    proto.execute = origExecute;
  }
  assert.strictEqual(sessions.length, 5);
  assert.strictEqual(sessions[1], sessions[0], "percakapan yang sama tetap di satu sesi");
  assert.notStrictEqual(sessions[2], sessions[0], "klien lain tidak berbagi sesi");
  assert.notStrictEqual(sessions[4], sessions[3], "dua sesi Claude Code (metadata.user_id) tidak berbagi sesi");
});

// Port dari 9router PR #4791: Zen menolak `ses_` yang 12 karakter hex-nya bukan
// ~(Date.now()*4096+n) dengan 403 FreeTierError. ID hasil translasi karena itu
// wajib memuat timestamp asli, bukan bit hash dari ID sesi klien.
const SESSION_PREFIX_MASK = 0xffffffffffffn;
const decodedUnits = (id) => SESSION_PREFIX_MASK - BigInt(`0x${id.slice(4, 16)}`);

test("translateOpencodeSession - ID translasi memuat timestamp asli, bukan bit hash", () => {
  resetOpencodeSessionCache();
  const key = "claude:550e8400-e29b-41d4-a716-446655440000";

  const id = translateOpencodeSession(key, "claude");
  assert.ok(OPENCODE_SESSION_RE.test(id), `'${id}' harus berupa ses_ kanonikal`);

  const nowUnits = (BigInt(Date.now()) * 0x1000n) & SESSION_PREFIX_MASK;
  const diffMs = Number((decodedUnits(id) - nowUnits) / 0x1000n);
  assert.ok(Math.abs(diffMs) < 60_000, `prefix harus mendekode ke waktu sekarang, selisih ${diffMs} ms`);

  const otherTool = translateOpencodeSession(key, "codex");
  assert.notStrictEqual(otherTool, id, "klien berbeda tidak berbagi ID sesi");
});
