import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, setConnectionCooldown, getModelLockUntil, replaceAntigravityAccountModels, MODEL_LOCK_MAX_MS } from "../src/db/index.js";

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

// Mencegah: inventory Antigravity yang sync sebelum lock dibuat ikut membebaskan lock
// (lock tetap berlaku sampai sync yang benar-benar terjadi setelahnya).
test("model lock Antigravity - sync sebelum lock tidak membebaskan lock", () => {
  initDb(":memory:");
  const a = addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-3.8-flash-high", displayName: "Flash", recommended: true, quotaRemaining: 1 },
  ]);
  setConnectionCooldown(a.id, Date.now() + 5 * 60_000, "gemini-3.8-flash");
  assert.ok(getModelLockUntil(a.id, "gemini-3.8-flash") > Date.now());
});

// Mencegah: sync sesudah lock dengan quota varian masih tersisa tidak membebaskan lock
// jika sync itu tidak menyentuh model yang dikunci (sibling model tidak boleh membebaskan).
test("model lock Antigravity - quota model lain tidak membebaskan lock", () => {
  initDb(":memory:");
  const a = addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  setConnectionCooldown(a.id, Date.now() + 5 * 60_000, "gemini-3.8-flash");
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "claude-opus-5-5-high", displayName: "Opus", recommended: true, quotaRemaining: 1 },
  ]);
  assert.ok(getModelLockUntil(a.id, "gemini-3.8-flash") > Date.now());
});

// Mencegah: lock terus berlaku setelah quota model yang dikunci pulih dan inventory
// sudah tersinkron ulang sesudah lock dibuat. Ini kasus dari akun divrzky.
test("model lock Antigravity - sync sesudah lock dengan quota tersisa membebaskan lock", async () => {
  initDb(":memory:");
  const a = addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-3.8-flash-high", displayName: "Flash", recommended: true, quotaRemaining: 0 },
  ]);
  setConnectionCooldown(a.id, Date.now() + 5 * 60_000, "gemini-3.8-flash");
  await new Promise((r) => setTimeout(r, 5));
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-3.8-flash-high", displayName: "Flash", recommended: true, quotaRemaining: 1 },
  ]);
  assert.strictEqual(getModelLockUntil(a.id, "gemini-3.8-flash"), null);
});

// Mencegah: provider non-Antigravity ikut dibebaskan oleh pola inventory yang sama.
test("model lock - provider tanpa inventory tidak dibebaskan", () => {
  initDb(":memory:");
  const c = addConnection({ provider: "glm", name: "glm", credentials: { api_key: "x" } });
  setConnectionCooldown(c.id, Date.now() + 5 * 60_000, "glm-4-flash");
  assert.ok(getModelLockUntil(c.id, "glm-4-flash") > Date.now());
});

// Mencegah: 429 baru setelah sync tidak dianggap sebagai lock lama, sehingga
// lock baru langsung dibebaskan dan model dicoba lagi tanpa jeda.
test("model lock Antigravity - 429 baru setelah sync tetap mengunci", async () => {
  initDb(":memory:");
  const a = addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-3.8-flash-high", displayName: "Flash", recommended: true, quotaRemaining: 0 },
  ]);
  setConnectionCooldown(a.id, Date.now() + 5 * 60_000, "gemini-3.8-flash");
  await new Promise((r) => setTimeout(r, 5));
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-3.8-flash-high", displayName: "Flash", recommended: true, quotaRemaining: 1 },
  ]);
  setConnectionCooldown(a.id, Date.now() + 5 * 60_000, "gemini-3.8-flash");
  assert.ok(getModelLockUntil(a.id, "gemini-3.8-flash") > Date.now());
});

// Mencegah: varian -lite (berbagi bucket dengan model lain) ikut membebaskan lock
// model dasar, sehingga lock dicabut tanpa quota model itu sendiri pulih.
test("model lock Antigravity - varian -lite tidak membebaskan lock", async () => {
  initDb(":memory:");
  const a = addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  setConnectionCooldown(a.id, Date.now() + 5 * 60_000, "gemini-3.8-flash");
  await new Promise((r) => setTimeout(r, 5));
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-3.8-flash-lite", displayName: "Lite", recommended: true, quotaRemaining: 1 },
  ]);
  assert.ok(getModelLockUntil(a.id, "gemini-3.8-flash") > Date.now());
});
