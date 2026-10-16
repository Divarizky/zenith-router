import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, replaceAntigravityAccountModels } from "../src/db/index.js";
import { listAvailableConnections } from "../src/services/fallback.js";

function seed() {
  initDb(":memory:");
  const pro = addConnection({ provider: "antigravity", name: "pro", auth_type: "oauth", credentials: {} });
  const free = addConnection({ provider: "antigravity", name: "free", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(pro.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 1, quotaResetAt: Date.now() + 3600_000 },
    { modelId: "claude-opus-5-5-high", displayName: "Opus 5.5", recommended: true, quotaRemaining: 0, quotaResetAt: Date.now() + 3600_000 },
    { modelId: "gemini-3.8-flash-tiered", displayName: "Flash", recommended: true, quotaRemaining: 1 },
  ]);
  replaceAntigravityAccountModels(free.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 1 },
    { modelId: "gemini-3.8-flash-tiered", displayName: "Flash", recommended: true, quotaRemaining: 1 },
  ]);
  return { pro, free };
}

test("Routing Antigravity - akun tanpa model dilewati", () => {
  const { pro } = seed();
  // Hanya Pro punya Opus 5.5, dan kuotanya habis. Akun berkuota habis memang
  // dilewati, tanpa upaya terakhir.
  const ids = listAvailableConnections("antigravity", { model: "claude-opus-5-5-high" }).map((c) => c.id);
  assert.deepStrictEqual(ids, [], "akun habis kuota tidak dipilih walau tidak ada alternatif");
  const argon = listAvailableConnections("antigravity", { model: "gemini-4-argon-medium" }).map((c) => c.id);
  assert.strictEqual(argon.length, 2, "Argon tersedia di kedua akun");
  assert.ok(listAvailableConnections("antigravity", { model: "claude-sonnet-4-6" }).length === 0, "model yang tidak dimiliki akun mana pun tidak dilayani");
});

test("Routing Antigravity - kuota habis dilewati selama masih ada akun sehat", () => {
  initDb(":memory:");
  const habis = addConnection({ provider: "antigravity", name: "habis", auth_type: "oauth", credentials: {} });
  const sehat = addConnection({ provider: "antigravity", name: "sehat", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(habis.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 0, quotaResetAt: Date.now() + 60_000 },
  ]);
  replaceAntigravityAccountModels(sehat.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 0.5 },
  ]);
  const ids = listAvailableConnections("antigravity", { model: "gemini-4-argon-medium" }).map((c) => c.id);
  assert.deepStrictEqual(ids, [sehat.id], "akun habis dilewati, sisa kuota pecahan tetap dilayani");
});

test("Routing Antigravity - quota_remaining null tidak dianggap habis", () => {
  initDb(":memory:");
  const c = addConnection({ provider: "antigravity", name: "tanpa-angka", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(c.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaResetAt: Date.now() + 60_000 },
  ]);
  const ids = listAvailableConnections("antigravity", { model: "gemini-4-argon-medium" }).map((x) => x.id);
  assert.deepStrictEqual(ids, [c.id], "null berarti tidak diketahui, bukan nol");
});

test("Routing Antigravity - reset time ISO dari sinkron kuota tersimpan sebagai epoch ms", async () => {
  initDb(":memory:");
  const { getAntigravityAccountModels } = await import("../src/db/index.js");
  const { parseResetTime } = await import("../src/services/quota/shared.js");
  const c = addConnection({ provider: "antigravity", name: "iso", auth_type: "oauth", credentials: {} });
  const resetAt = Date.now() + 3600_000;
  replaceAntigravityAccountModels(c.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 0, quotaResetAt: parseResetTime(resetAt) },
  ]);
  const row = getAntigravityAccountModels(c.id).get("gemini-4-argon-medium");
  assert.strictEqual(typeof row.quota_reset_at, "number", "kolom INTEGER tidak boleh menerima ISO mentah");
  assert.ok(Math.abs(row.quota_reset_at - resetAt) < 1000);
  // Gate memakai kolom itu, jadi rantai inilah yang membuat filter kuota aktif:
  // dengan satu akun sehat tersedia, akun ISO yang habis harus dilewati. Kalau
  // reset tersimpan NULL, keduanya akan ikut terpilih.
  const sehat = addConnection({ provider: "antigravity", name: "sehat", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(sehat.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 1 },
  ]);
  const ids = listAvailableConnections("antigravity", { model: "gemini-4-argon-medium" }).map((x) => x.id);
  assert.deepStrictEqual(ids, [sehat.id], "akun dengan reset ISO di masa depan dilewati");
});

test("Routing Antigravity - alias katalog dicocokkan ke upstream id", () => {
  seed();
  const ids = listAvailableConnections("antigravity", { model: "gemini-3.8-flash" }).map((c) => c.id);
  assert.strictEqual(ids.length, 2, "gemini-3.8-flash memakai bucket -tiered yang ada di inventaris");
});

test("Routing Antigravity - akun yang belum pernah sinkron tetap dilayani", () => {
  initDb(":memory:");
  const brandNew = addConnection({ provider: "antigravity", name: "baru", auth_type: "oauth", credentials: {} });
  const ids = listAvailableConnections("antigravity", { model: "gemini-4-argon-medium" }).map((c) => c.id);
  assert.deepStrictEqual(ids, [brandNew.id], "gagal-terbuka: tanpa inventaris akun tidak diblokir");
});

test("Routing Antigravity - kuota habis tapi reset sudah lewat tidak diblokir", () => {
  initDb(":memory:");
  const c = addConnection({ provider: "antigravity", name: "reset", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(c.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Argon", recommended: true, quotaRemaining: 0, quotaResetAt: Date.now() - 1000 },
  ]);
  const ids = listAvailableConnections("antigravity", { model: "gemini-4-argon-medium" }).map((x) => x.id);
  assert.deepStrictEqual(ids, [c.id]);
});

test("Routing Antigravity - effort turun dalam batas varian akun, tidak melompat ke id yang tidak dimiliki", async () => {
  initDb(":memory:");
  const { resolveProviderRuntime, getProvider } = await import("../src/providers/index.js");
  const { getAntigravityAccountModels } = await import("../src/db/index.js");
  const pro = addConnection({ provider: "antigravity", name: "pro", auth_type: "oauth", credentials: {} });
  const plus = addConnection({ provider: "antigravity", name: "plus", auth_type: "oauth", credentials: {} });
  // Akun Pro punya semua tingkat Argon; akun Plus hanya medium.
  replaceAntigravityAccountModels(pro.id, "free-tier", [
    { modelId: "gemini-4-argon-low", displayName: "Gemini 4 Argon (Low)", recommended: true, quotaRemaining: 1 },
    { modelId: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)", recommended: true, quotaRemaining: 1 },
    { modelId: "gemini-4-argon-high", displayName: "Gemini 4 Argon (High)", recommended: true, quotaRemaining: 1 },
  ]);
  replaceAntigravityAccountModels(plus.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)", recommended: true, quotaRemaining: 1 },
  ]);

  // Gate dan executor memakai resolusi yang sama: di akun Plus, high turun ke medium.
  const provider = getProvider("antigravity");
  const plusRows = getAntigravityAccountModels(plus.id);
  assert.strictEqual(resolveProviderRuntime(provider, "gemini-4-argon", "high", plusRows).id, "gemini-4-argon-medium");
  assert.strictEqual(resolveProviderRuntime(provider, "gemini-4-argon", "high", getAntigravityAccountModels(pro.id)).id, "gemini-4-argon-high");

  for (const effort of ["high", "medium", "low"]) {
    const ids = listAvailableConnections("antigravity", { model: "gemini-4-argon", effort }).map((c) => c.id);
    assert.deepStrictEqual([...ids].sort(), [pro.id, plus.id].sort(), `effort ${effort} dilayani kedua akun`);
  }
});

test("Routing Antigravity - gate dan executor memakai id runtime yang sama", async () => {
  initDb(":memory:");
  const { resolveProviderRuntime, getProvider } = await import("../src/providers/index.js");
  const { getAntigravityAccountModels } = await import("../src/db/index.js");
  const acc = addConnection({ provider: "antigravity", name: "acc", auth_type: "oauth", credentials: {} });
  // Akun hanya membawa -high dan -low, tanpa -medium dan tanpa bucket -tiered.
  replaceAntigravityAccountModels(acc.id, "free-tier", [
    { modelId: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", recommended: true, quotaRemaining: 1 },
    { modelId: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)", recommended: true, quotaRemaining: 1 },
  ]);
  const provider = getProvider("antigravity");
  const rows = getAntigravityAccountModels(acc.id);
  // Medium tidak ada di akun ini; turun ke low, bukan ditolak.
  assert.strictEqual(resolveProviderRuntime(provider, "gemini-3.8-flash", "medium", rows).id, "gemini-3.8-flash-low");
  for (const [effort, expected] of [["high", "gemini-3.8-flash-high"], ["medium", "gemini-3.8-flash-low"], ["low", "gemini-3.8-flash-low"]]) {
    const runtime = resolveProviderRuntime(provider, "gemini-3.8-flash", effort, rows);
    assert.strictEqual(runtime.id, expected);
    const gate = listAvailableConnections("antigravity", { model: "gemini-3.8-flash", effort }).map((c) => c.id);
    assert.deepStrictEqual(gate, [acc.id], `effort ${effort} (${runtime.id}) harus lolos gate`);
  }
});
