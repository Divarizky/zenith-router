import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_MODEL_IDS,
  parseModelIds,
  readModelCache,
  selectModels,
  writeModelCache,
} from "../src/models.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zr-pi-models-"));
}

test("daftar live menang atas cache, dan cache menang atas fallback", () => {
  const cached = ["cache-a"];
  assert.deepEqual(selectModels(["live-a", "live-b"], cached), { source: "live", ids: ["live-a", "live-b"] });
  assert.deepEqual(selectModels(null, cached), { source: "cache", ids: ["cache-a"] });
  assert.deepEqual(selectModels(null, []), { source: "fallback", ids: FALLBACK_MODEL_IDS });
});

test("daftar live kosong tidak menimpa cache yang masih berisi", () => {
  // Gateway yang hidup tetapi tanpa model tidak boleh membuat daftar kosong di Pi.
  assert.deepEqual(selectModels([], ["cache-a"]), { source: "cache", ids: ["cache-a"] });
  assert.equal(selectModels([], []).source, "fallback");
});

test("parseModelIds mengambil id unik dan menolak bentuk respons yang salah", () => {
  assert.deepEqual(parseModelIds({ object: "list", data: [{ id: "a" }, { id: "b" }, { id: "a" }] }), ["a", "b"]);
  assert.deepEqual(parseModelIds({ data: [{ id: "  x  " }, { name: "tanpa-id" }, null] }), ["x"]);
  assert.equal(parseModelIds({ error: "bukan daftar" }), null, "tanpa data array harus ditolak");
  assert.equal(parseModelIds("teks biasa"), null);
});

test("cache rusak dibaca sebagai tidak ada, bukan error", () => {
  const dir = tempDir();
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, "{ potongan json");
  assert.equal(readModelCache(file), null, "JSON rusak tidak boleh melempar");
  assert.equal(readModelCache(path.join(dir, "tidak-ada.json")), null);
});

test("writeModelCache menyimpan daftar lalu readModelCache membacanya kembali", () => {
  const file = path.join(tempDir(), "nested", "models.json");
  const now = new Date("2026-10-31T00:00:00.000Z");
  assert.equal(writeModelCache(file, ["m1", "m2"], now), true);
  const read = readModelCache(file);
  assert.deepEqual(read?.ids, ["m1", "m2"]);
  assert.equal(read?.savedAt, "2026-10-31T00:00:00.000Z");
});

test("writeModelCache menolak daftar kosong sehingga cache berisi tidak tertimpa", () => {
  const file = path.join(tempDir(), "models.json");
  writeModelCache(file, ["m1"], new Date());
  assert.equal(writeModelCache(file, [], new Date()), false);
  assert.deepEqual(readModelCache(file)?.ids, ["m1"]);
});
