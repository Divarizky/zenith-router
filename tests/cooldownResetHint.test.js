import test from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  initDb,
  addConnection,
  closeDb,
  getConnectionById,
  getModelLockUntil,
  setConnectionCooldown,
  MODEL_LOCK_MAX_MS,
  QUOTA_LOCK_MAX_MS,
} from "../src/db/index.js";
import { extractRetryHint, extractQuotaCooldownMs } from "../src/services/fallback.js";
import { readErrorText } from "../src/utils/errorBody.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const headers = (map = {}) => ({ headers: { get: (k) => map[k.toLowerCase()] ?? null } });
const json = (payload) => JSON.stringify(payload);

function freshConnection(name = "akun") {
  initDb(":memory:");
  return addConnection({ provider: "glm", name, credentials: { api_key: "key" } });
}

// ---------- parser: urutan, otoritatif, kompatibilitas ----------

test("retry hint - Retry-After 86400 is authoritative and wins over a body reset", () => {
  const hint = extractRetryHint(headers({ "retry-after": "86400" }), json({ reset_at: NOW + HOUR }), NOW);
  assert.deepStrictEqual(hint, { ms: DAY, authoritative: true, source: "retry-after" });
});

test("retry hint - reset_at epoch seconds and epoch milliseconds are both read", () => {
  const sec = extractRetryHint(headers(), json({ reset_at: Math.floor((NOW + 2 * HOUR) / 1000) }), NOW);
  assert.strictEqual(sec.ms, 2 * HOUR);
  const ms = extractRetryHint(headers(), json({ error: { reset_at: NOW + 3 * HOUR } }), NOW);
  assert.strictEqual(ms.ms, 3 * HOUR);
  assert.strictEqual(ms.source, "reset_at");
});

test("retry hint - reset_at ISO-8601 is read", () => {
  const hint = extractRetryHint(headers(), json({ reset_at: new Date(NOW + 5 * 60 * 1000).toISOString() }), NOW);
  assert.strictEqual(hint.ms, 5 * 60 * 1000);
  assert.strictEqual(hint.authoritative, true);
});

test("retry hint - a reset_at already in the past yields no hint", () => {
  assert.strictEqual(extractRetryHint(headers(), json({ reset_at: NOW - 1000 }), NOW), null);
});

test("retry hint - structured retry_after is read after reset_at and before Google details", () => {
  const body = json({
    retry_after: 8,
    error: { details: [{ retryDelay: "500s" }] },
  });
  assert.deepStrictEqual(extractRetryHint(headers(), body, NOW), { ms: 8000, authoritative: true, source: "retry_after" });

  const withReset = json({ reset_at: NOW + 90_000, retry_after: 8, error: { details: [{ retryDelay: "500s" }] } });
  assert.strictEqual(extractRetryHint(headers(), withReset, NOW).source, "reset_at");
});

test("retry hint - Google RetryInfo still works after the new fields", () => {
  const body = json({ error: { details: [{ retryDelay: "497880.5s" }] } });
  const hint = extractRetryHint(headers(), body, NOW);
  assert.strictEqual(hint.source, "google-retry-info");
  assert.strictEqual(hint.ms, 497880500, "retryDelay 497880.5s dikonversi ke ms tanpa pembulatan salah");
});

test("retry hint - a default (no upstream hint) is not authoritative", () => {
  assert.strictEqual(extractRetryHint(headers(), "", NOW), null, "tanpa hint, pemanggil memakai default");
});

test("retry hint - a truncated JSON body yields no hint instead of throwing", () => {
  const full = json({ error: { message: "rate limited", details: [{ retryDelay: "120s" }] } });
  const cut = full.slice(0, 20);
  assert.strictEqual(extractRetryHint(headers(), cut, NOW), null);
});

test("retry hint - a body larger than the 64 KiB cap is cut, and the reset inside the kept prefix still parses", async () => {
  const body = json({ reset_at: NOW + 2 * HOUR, padding: "x".repeat(200_000) });
  const res = new Response(body, { status: 429 });
  const kept = await readErrorText(res);
  assert.ok(kept.length <= 64 * 1024 + 64, "body dipotong ke cap");
  // reset_at ada di depan body, sehingga tetap terbaca dari prefix yang dipertahankan.
  assert.strictEqual(extractRetryHint(headers(), kept, NOW), null, "prefix terpotong tidak valid JSON, jadi tidak ada hint");
  assert.strictEqual(extractRetryHint(headers({ "retry-after": "7200" }), kept, NOW).ms, 2 * HOUR, "header tetap dibaca walau body terpotong");
});

test("retry hint - extractQuotaCooldownMs keeps the numeric contract with its default", () => {
  assert.strictEqual(extractQuotaCooldownMs(headers({ "retry-after": "120" }), "", 60_000, NOW), 120_000);
  assert.strictEqual(extractQuotaCooldownMs(headers(), "", 45_000, NOW), 45_000);
  assert.strictEqual(extractQuotaCooldownMs(headers(), json({ retry_after: 8 }), 60_000, NOW), 8_000);
});

// ---------- cap per kelas lock ----------

test("lock cap - a transient model lock is capped to one hour", () => {
  const conn = freshConnection();
  const until = Date.now() + 24 * HOUR;
  setConnectionCooldown(conn.id, until, "m", { lockClass: "transient" });
  const got = getModelLockUntil(conn.id, "m");
  assert.ok(got <= Date.now() + MODEL_LOCK_MAX_MS + 1000, "transient dipotong 1 jam");
});

test("lock cap - a quota-window model lock keeps 24 hours", () => {
  const conn = freshConnection();
  setConnectionCooldown(conn.id, Date.now() + DAY, "m", { lockClass: "quota" });
  const got = getModelLockUntil(conn.id, "m");
  assert.ok(got > Date.now() + 23 * HOUR, "kuota 24 jam tidak dipotong ke 1 jam");
  assert.ok(got <= Date.now() + QUOTA_LOCK_MAX_MS, "tetap dalam batas 30 hari");
});

test("lock cap - an epoch-like 1e13 deadline does not throw and is capped to 30 days", () => {
  const conn = freshConnection();
  assert.doesNotThrow(() => setConnectionCooldown(conn.id, 1e13, "m", { lockClass: "quota" }));
  const got = getModelLockUntil(conn.id, "m");
  assert.ok(got <= Date.now() + QUOTA_LOCK_MAX_MS + 1000, "1e13 dicap 30 hari");
});

test("lock cap - an epoch-like 1e13 account deadline does not throw and is capped to 30 days", () => {
  const conn = freshConnection();
  assert.doesNotThrow(() => setConnectionCooldown(conn.id, 1e13));
  const stored = getConnectionById(conn.id).cooldown_until;
  assert.ok(stored <= Date.now() + QUOTA_LOCK_MAX_MS + 1000, "cooldown akun 1e13 dicap 30 hari");
  assert.ok(stored > Date.now() + 29 * DAY, "cap tetap 30 hari, bukan nilai default lain");
});

test("lock cap - the account deadline keeps 30 days for a real quota reset", () => {
  const conn = freshConnection();
  setConnectionCooldown(conn.id, Date.now() + 10 * DAY);
  const stored = getConnectionById(conn.id).cooldown_until;
  assert.ok(stored > Date.now() + 9 * DAY, "reset 10 hari tidak dipotong");
});

// ---------- #1: extend, bukan shorten ----------

test("regression #1 - a longer deadline extends an active account-wide lock", () => {
  const conn = freshConnection();
  setConnectionCooldown(conn.id, Date.now() + HOUR);
  setConnectionCooldown(conn.id, Date.now() + 3 * HOUR);
  const stored = getConnectionById(conn.id).cooldown_until;
  assert.ok(stored > Date.now() + 2 * HOUR, "akun diperpanjang");
});

test("regression #1 - a shorter deadline never shortens an account lock (default)", () => {
  const conn = freshConnection();
  const longUntil = Date.now() + 3 * HOUR;
  setConnectionCooldown(conn.id, longUntil);
  setConnectionCooldown(conn.id, Date.now() + 60_000);
  assert.strictEqual(getConnectionById(conn.id).cooldown_until, longUntil);
});

test("regression #1 - a shorter authoritative reset does not shorten a model lock by default", () => {
  const conn = freshConnection();
  const longUntil = Date.now() + 5 * HOUR;
  setConnectionCooldown(conn.id, longUntil, "m", { lockClass: "quota" });
  setConnectionCooldown(conn.id, Date.now() + 60_000, "m", { lockClass: "quota", authoritative: true });
  const got = getModelLockUntil(conn.id, "m");
  assert.ok(got >= longUntil - 1000, "default ZENITH_COOLDOWN_SHORTEN_ON_RESET=0 tidak memendekkan");
});

test("shorten flag - ZENITH_COOLDOWN_SHORTEN_ON_RESET=1 lets an authoritative reset shorten a model lock", () => {
  const conn = freshConnection();
  const previous = process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET;
  process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET = "1";
  try {
    setConnectionCooldown(conn.id, Date.now() + 5 * HOUR, "m", { lockClass: "quota" });
    const shorter = Date.now() + 10 * 60 * 1000;
    setConnectionCooldown(conn.id, shorter, "m", { lockClass: "quota", authoritative: true });
    assert.ok(getModelLockUntil(conn.id, "m") <= shorter + 1000, "reset otoritatif memendekkan saat flag aktif");
  } finally {
    if (previous === undefined) delete process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET;
    else process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET = previous;
  }
});

test("shorten flag - an authoritative reset with the flag on still never shortens an account lock", () => {
  const conn = freshConnection();
  const previous = process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET;
  process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET = "1";
  try {
    const longUntil = Date.now() + 3 * HOUR;
    setConnectionCooldown(conn.id, longUntil);
    setConnectionCooldown(conn.id, Date.now() + 60_000, null, { authoritative: true });
    assert.strictEqual(getConnectionById(conn.id).cooldown_until, longUntil, "akun tetap tidak dipendekkan");
  } finally {
    if (previous === undefined) delete process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET;
    else process.env.ZENITH_COOLDOWN_SHORTEN_ON_RESET = previous;
  }
});

test("restart - a 24-hour quota lock survives a database reopen", () => {
  const file = join(tmpdir(), `zenith-cooldown-${process.pid}-${Date.now()}.db`);
  try {
    initDb(file);
    const conn = addConnection({ provider: "glm", name: "restart", credentials: { api_key: "key" } });
    setConnectionCooldown(conn.id, Date.now() + DAY, "m", { lockClass: "quota" });
    initDb(file);
    const got = getModelLockUntil(conn.id, "m");
    assert.ok(got > Date.now() + 23 * HOUR, "lock 24 jam tetap ada setelah restart");
  } finally {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
  }
});
