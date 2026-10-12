import test from "node:test";
import assert from "node:assert";
import { initDb, getDb } from "../src/db/index.js";
import {
  createCombo,
  updateCombo,
  renameCombo,
  setComboEnabled,
  deleteCombo,
  moveComboMember,
  getComboByName,
  getActiveComboByName,
  listCombos,
  canonicalizeMember,
} from "../src/services/combos.js";

initDb(":memory:");

test("combos - stores a combo with its members in canonical provider/model form", () => {
  const created = createCombo({
    name: "backup-pair",
    models: ["mistral:mistral-large-latest", "glm/glm-4-flash"],
  });

  assert.strictEqual(created.name, "backup-pair");
  assert.strictEqual(created.strategy, "fallback");
  assert.strictEqual(created.enabled, 1);
  assert.deepStrictEqual(created.models, [
    "mistral/mistral-large-latest",
    "glm/glm-4-flash",
  ]);

  const stored = getComboByName("backup-pair");
  assert.deepStrictEqual(stored.models, created.models);
  assert.strictEqual(listCombos().length, 1);
});

test("combos - keeps the order the user arranged", () => {
  createCombo({ name: "ordered", models: ["glm/glm-4-flash", "mistral/mistral-large-latest"] });
  assert.deepStrictEqual(getComboByName("ordered").models, [
    "glm/glm-4-flash",
    "mistral/mistral-large-latest",
  ]);
});

test("combos - rejects names that could shadow a provider guess", () => {
  for (const name of ["claude-fast", "gpt-4o", "o3-mini", "gemini-3-pro", "glm-4-flash", "codegeex-4"]) {
    assert.throws(() => createCombo({ name, models: ["glm/glm-4-flash"] }), /nama/i, name);
  }
});

test("combos - rejects malformed, oversized, and duplicate names", () => {
  assert.throws(() => createCombo({ name: "a/b", models: ["glm/glm-4-flash"] }), /nama/i);
  assert.throws(() => createCombo({ name: "foo:bar", models: ["glm/glm-4-flash"] }), /nama/i);
  assert.throws(() => createCombo({ name: "ada spasi", models: ["glm/glm-4-flash"] }), /nama/i);
  assert.throws(() => createCombo({ name: "x".repeat(65), models: ["glm/glm-4-flash"] }), /nama/i);
  assert.throws(() => createCombo({ name: "", models: ["glm/glm-4-flash"] }), /nama/i);

  createCombo({ name: "unique-one", models: ["glm/glm-4-flash"] });
  assert.throws(
    () => createCombo({ name: "unique-one", models: ["mistral/mistral-large-latest"] }),
    /dipakai/i
  );
});

test("combos - rejects an empty chain", () => {
  assert.throws(() => createCombo({ name: "empty", models: [] }), /minimal satu model/i);
});

test("combos - rejects a member that resolves to no provider", () => {
  assert.throws(
    () => createCombo({ name: "bad-member", models: ["glm/glm-4-flash", "tidak-ada-model"] }),
    /tidak-ada-model/
  );
});

test("combos - rejects a member that is another combo", () => {
  createCombo({ name: "inner", models: ["glm/glm-4-flash"] });
  assert.throws(
    () => createCombo({ name: "outer", models: ["inner"] }),
    /combo di dalam combo/i
  );
  assert.strictEqual(getComboByName("outer"), null);
});

test("combos - an active combo is returned by name and an unknown name is not", () => {
  createCombo({ name: "toggle-me", models: ["glm/glm-4-flash"] });
  assert.strictEqual(getActiveComboByName("toggle-me").name, "toggle-me");
  assert.strictEqual(getActiveComboByName("missing"), null);
});

function seedChain(name = "antai-utama") {
  initDb(":memory:");
  return createCombo({
    name,
    models: ["mistral/mistral-large-latest", "glm/glm-4-flash", "ollama/gpt-oss:20b"],
  });
}

test("combos - updateCombo stores the new member order and bumps updated_at", async () => {
  const created = seedChain();
  const before = created.updatedAt;
  await new Promise((r) => setTimeout(r, 2));

  const updated = updateCombo("antai-utama", {
    models: ["glm/glm-4-flash", "mistral/mistral-large-latest", "ollama/gpt-oss:20b"],
  });

  assert.deepStrictEqual(updated.models, [
    "glm/glm-4-flash",
    "mistral/mistral-large-latest",
    "ollama/gpt-oss:20b",
  ]);
  assert.deepStrictEqual(getComboByName("antai-utama").models, updated.models);
  assert.ok(updated.updatedAt > before, `updated_at harus maju, dapat ${updated.updatedAt} dari ${before}`);
});

test("combos - updateCombo rejects a duplicate name check against itself", () => {
  seedChain();
  // Nama yang sama harus lolos validasi nama; hanya nama LAIN yang bentrok.
  const updated = updateCombo("antai-utama", { models: ["ollama/gpt-oss:20b"] });
  assert.deepStrictEqual(updated.models, ["ollama/gpt-oss:20b"]);
});

test("combos - updateCombo keeps the definition untouched when validation fails", () => {
  seedChain();
  assert.throws(
    () => updateCombo("antai-utama", { models: ["glm/glm-4-flash", "model-hantu"] }),
    /model-hantu/
  );
  assert.deepStrictEqual(getComboByName("antai-utama").models, [
    "mistral/mistral-large-latest",
    "glm/glm-4-flash",
    "ollama/gpt-oss:20b",
  ]);
});

test("combos - updateCombo refuses a combo inside a combo", () => {
  seedChain("rantai-luar");
  createCombo({ name: "rantai-dalam", models: ["mistral/mistral-small-latest"] });

  assert.throws(
    () => updateCombo("rantai-luar", { models: ["rantai-dalam", "glm/glm-4-flash"] }),
    /combo di dalam combo/
  );
  assert.strictEqual(getComboByName("rantai-luar").models.length, 3);
});

test("combos - moveComboMember swaps one member and refuses to fall off the chain", () => {
  seedChain();

  const moved = moveComboMember("antai-utama", 2, "up");
  assert.deepStrictEqual(moved.models, ["mistral/mistral-large-latest", "ollama/gpt-oss:20b", "glm/glm-4-flash"]);

  assert.deepStrictEqual(moveComboMember("antai-utama", 0, "up").models, moved.models);
  assert.deepStrictEqual(
    moveComboMember("antai-utama", moved.models.length - 1, "down").models,
    moved.models
  );
});

test("combos - setComboEnabled takes a disabled combo out of routing but keeps it", () => {
  seedChain();

  const off = setComboEnabled("antai-utama", false);
  assert.strictEqual(off.enabled, 0);
  assert.strictEqual(getComboByName("antai-utama").enabled, 0, "definisi tetap ada");
  assert.strictEqual(getActiveComboByName("antai-utama"), null, "tidak lagi jadi target routing");
  assert.strictEqual(listCombos().length, 1, "masih tampil di daftar dashboard");

  assert.strictEqual(setComboEnabled("antai-utama", true).enabled, 1);
  assert.ok(getActiveComboByName("antai-utama"));
});

test("combos - deleteCombo removes the definition so the name stops routing", () => {
  seedChain();

  assert.strictEqual(deleteCombo("antai-utama"), true);
  assert.strictEqual(getComboByName("antai-utama"), null);
  assert.strictEqual(getActiveComboByName("antai-utama"), null);
  assert.strictEqual(listCombos().length, 0);
});

test("combos - updating an unknown combo reports the miss instead of creating one", () => {
  seedChain();
  assert.throws(() => updateCombo("tidak-ada", { models: ["glm/glm-4-flash"] }), /tidak-ada/);
  assert.throws(() => deleteCombo("tidak-ada"), /tidak-ada/);
  assert.strictEqual(listCombos().length, 1);
});

test("combos - moveComboMember treats a garbage index as a no-op", () => {
  seedChain();
  const original = getComboByName("antai-utama").models;

  for (const bad of [NaN, "abc", undefined, null, 1.9, -1, 99]) {
    assert.deepStrictEqual(
      moveComboMember("antai-utama", bad, "up").models,
      original,
      `indeks ${String(bad)} harus tidak mengubah apa pun`
    );
  }
  assert.deepStrictEqual(getComboByName("antai-utama").models, original);
  assert.throws(() => moveComboMember("antai-utama", 0, "sideways"), /tidak dikenal/);
  assert.deepStrictEqual(getComboByName("antai-utama").models, original, "arah buruk tidak boleh mengubah rantai");
});

test("combos - a strategy-only edit works even when a stored member no longer resolves", () => {
  seedChain();
  // Simulasikan anggota yang sudah tidak bisa dipetakan: providernya hilang dari
  // registry, atau modelnya masuk daftar nonaktif.
  getDb()
    .prepare(`UPDATE combos SET models = ?, strategy = 'fallback' WHERE name = 'antai-utama'`)
    .run(JSON.stringify(["tongtong/model-lama", "mistral/mistral-large-latest"]));

  const updated = updateCombo("antai-utama", { strategy: "fallback" });

  assert.strictEqual(updated.strategy, "fallback");
  assert.deepStrictEqual(updated.models, ["tongtong/model-lama", "mistral/mistral-large-latest"]);
});

test("combos - editing the chain still revalidates every submitted member", () => {
  seedChain();

  assert.throws(
    () => updateCombo("antai-utama", { models: ["tongtong/model-lama"] }),
    /tidak dikenal/
  );
  assert.deepStrictEqual(
    getComboByName("antai-utama").models,
    ["mistral/mistral-large-latest", "glm/glm-4-flash", "ollama/gpt-oss:20b"],
    " rantai lama harus utuh setelah penolakan"
  );
});

test("combos - a strategy-only edit still refuses an unknown strategy", () => {
  seedChain();
  assert.throws(() => updateCombo("antai-utama", { strategy: "acak" }), /"acak"/);
  assert.strictEqual(getComboByName("antai-utama").strategy, "fallback");
});

test("combos - canonicalizeMember refuses blank models and unknown provider prefixes", () => {
  seedChain();

  for (const bad of ["glm/", "glm/ glm-4-flash", "glm/glm 4-flash", "ollama/gpt oss:20b"]) {
    const { member, error } = canonicalizeMember(bad);
    assert.strictEqual(member, undefined, `${bad} harus ditolak`);
    assert.match(error, /kosong|spasi/, `${bad}: ${error}`);
  }

  const unknown = canonicalizeMember("gpt-oss:20b");
  assert.match(unknown.error, /gpt-oss/, "prefix provider tak dikenal harus disebut namanya");
  assert.match(unknown.error, /provider\/model/);

  const bare = canonicalizeMember("claude-sonnet-4-5");
  assert.match(bare.error, /provider\/model/);
});

test("combos - canonicalizeMember keeps an explicit provider prefix, guesses are off the table", () => {
  seedChain();

  // Pengguna Ollama yang menulis prefix dengan benar tetap diterima, lengkap
  // dengan dua titik di nama modelnya.
  assert.strictEqual(canonicalizeMember("ollama/gpt-oss:20b").member, "ollama/gpt-oss:20b");
  // Alias provider tetap bekerja.
  assert.strictEqual(canonicalizeMember("mis/mistral-code-latest").member, "mistral/mistral-code-latest");
});

test("combos - createCombo rejects a member that would die at the upstream", () => {
  seedChain();
  assert.throws(() => createCombo({ name: "rusak", models: ["glm/"] }), /kosong/);
  assert.throws(() => createCombo({ name: "rusak", models: ["gpt-oss:20b"] }), /gpt-oss/);
  assert.strictEqual(listCombos().length, 1, "combo gagal tidak boleh tersimpan");
});

test("combos - round-robin is a storable strategy both ways", () => {
  seedChain();

  const created = createCombo({
    name: "gilir",
    models: ["mistral/mistral-large-latest"],
    strategy: "round-robin",
  });
  assert.strictEqual(created.strategy, "round-robin");

  assert.strictEqual(updateCombo("gilir", { strategy: "fallback" }).strategy, "fallback");
  assert.strictEqual(updateCombo("gilir", { strategy: "round-robin" }).strategy, "round-robin");
  assert.throws(() => updateCombo("gilir", { strategy: "acak" }), /tidak dikenal/);
});

test("combos - rename keeps chain, strategy, and status under the new name", () => {
  createCombo({ name: "lama-satu", models: ["glm/glm-4-flash"], strategy: "round-robin" });
  setComboEnabled("lama-satu", false);

  const renamed = renameCombo("lama-satu", "baru-satu");

  assert.strictEqual(renamed.name, "baru-satu");
  assert.strictEqual(renamed.strategy, "round-robin");
  assert.deepStrictEqual(renamed.models, ["glm/glm-4-flash"]);
  assert.strictEqual(renamed.enabled, 0);
  assert.strictEqual(getComboByName("lama-satu"), null, "nama lama tidak boleh tersisa");
});

test("combos - rename to a name another combo owns is refused", () => {
  createCombo({ name: "lama-dua", models: ["glm/glm-4-flash"] });
  createCombo({ name: "terpakai-dua", models: ["mistral/mistral-large-latest"] });

  assert.throws(() => renameCombo("lama-dua", "terpakai-dua"), /sudah dipakai/);
  assert.strictEqual(getComboByName("lama-dua").models[0], "glm/glm-4-flash", "combo asli tak berubah");
  assert.strictEqual(getComboByName("terpakai-dua").models[0], "mistral/mistral-large-latest");
});

test("combos - renaming to its own name is a no-op, not an error", () => {
  createCombo({ name: "tetap-satu", models: ["glm/glm-4-flash"] });
  const same = renameCombo("tetap-satu", "tetap-satu");
  assert.strictEqual(same.name, "tetap-satu");
});

test("combos - rename validates the new name like a create does", () => {
  createCombo({ name: "lama-tiga", models: ["glm/glm-4-flash"] });

  assert.throws(() => renameCombo("lama-tiga", "gpt-5-mini"), /berawalan nama model/);
  assert.throws(() => renameCombo("lama-tiga", "nama aneh"), /hanya boleh/);
  assert.throws(() => renameCombo("lama-tiga", ""), /hanya boleh/);
  assert.throws(() => renameCombo("combo-hilang", "nama-baru"), /tidak ada/);
  assert.ok(getComboByName("lama-tiga"), "rename gagal tidak menghapus combo");
});
