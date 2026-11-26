import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, setConnectionCooldown, getModelLockUntil, MODEL_LOCK_MAX_MS } from "../src/db/index.js";

// Mencegah: upstream mengirim durasi berjam-jam (mis. Retry-After besar) lalu model
// terkunci penuh sampai durasi itu habis, walau reset quota lokal sudah lewat.
test("model lock - durasi di atas batas dipotong ke MODEL_LOCK_MAX_MS", () => {
  initDb(":memory:");
  const c = addConnection({ provider: "glm", name: "glm", credentials: { api_key: "x" } });
  const before = Date.now();
  setConnectionCooldown(c.id, before + 26 * 3600_000, "glm-4-flash");
  const until = getModelLockUntil(c.id, "glm-4-flash");
  assert.ok(until <= Date.now() + MODEL_LOCK_MAX_MS, "tidak lebih dari batas");
  assert.ok(until >= before + MODEL_LOCK_MAX_MS - 5000, "tetap diberi batas penuh, bukan dipersempit");
});

// Mencegah: lock yang lebih pendek dari batas ikut terpotong atau berubah.
test("model lock - durasi di bawah batas tidak diubah", () => {
  initDb(":memory:");
  const c = addConnection({ provider: "glm", name: "glm", credentials: { api_key: "x" } });
  const deadline = Date.now() + 5 * 60_000;
  setConnectionCooldown(c.id, deadline, "glm-4-flash");
  assert.strictEqual(getModelLockUntil(c.id, "glm-4-flash"), deadline);
});

// Mencegah: lock model dibebaskan lebih awal tanpa alasan; lock hanya habis oleh
// batas atau jam.
test("model lock - provider tanpa inventory tidak dibebaskan", () => {
  initDb(":memory:");
  const c = addConnection({ provider: "glm", name: "glm", credentials: { api_key: "x" } });
  setConnectionCooldown(c.id, Date.now() + 5 * 60_000, "glm-4-flash");
  assert.ok(getModelLockUntil(c.id, "glm-4-flash") > Date.now());
});
