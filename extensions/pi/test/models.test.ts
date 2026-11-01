import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_MODEL_IDS,
  parseModelIds,
  parseModelInfos,
  readModelCache,
  selectModels,
  toProviderModel,
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

test("capabilities.reasoning=true menghasilkan model reasoning=true, dengan vision dan batas token dari gateway", () => {
  const infos = parseModelInfos({
    data: [
      {
        id: "cc/claude-haiku-5-5",
        capabilities: { vision: true, reasoning: true },
        context_length: 200_000,
        max_completion_tokens: 64_000,
      },
    ],
  });
  assert.ok(infos);
  const model = toProviderModel(infos[0].id, infos[0]);
  assert.equal(model.reasoning, true, "model yang didukung reasoning harus terdaftar reasoning=true");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 64_000);
});

test("capabilities.reasoning=false dan model tanpa metadata sama-sama memakai default konservatif", () => {
  const infos = parseModelInfos({
    data: [{ id: "tanpa-metadata" }, { id: "tanpa-reasoning", capabilities: { reasoning: false } }],
  });
  assert.ok(infos);
  const plain = toProviderModel(infos[0].id, infos[0]);
  assert.equal(plain.reasoning, false);
  assert.deepEqual(plain.input, ["text"]);
  assert.equal(plain.contextWindow, 128_000);
  assert.equal(plain.maxTokens, 8_192);
  assert.equal(toProviderModel("tanpa-info").reasoning, false);
  assert.equal(toProviderModel(infos[1].id, infos[1]).reasoning, false);
});

test("nilai metadata yang tidak valid diabaikan, bukan diteruskan ke Pi", () => {
  const infos = parseModelInfos({
    data: [{ id: "rusak", capabilities: { reasoning: "ya" }, context_length: -1, max_completion_tokens: "banyak" }],
  });
  assert.ok(infos);
  const model = toProviderModel(infos[0].id, infos[0]);
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 8_192);
});

test("cache lama yang hanya berisi ids tetap terbaca, dengan models kosong", () => {
  const file = path.join(tempDir(), "models.json");
  fs.writeFileSync(file, JSON.stringify({ savedAt: "2026-10-30T00:00:00.000Z", ids: ["lama-a", "lama-b"] }));
  const read = readModelCache(file);
  assert.deepEqual(read?.ids, ["lama-a", "lama-b"]);
  assert.deepEqual(read?.models, []);
  assert.equal(toProviderModel("lama-a").reasoning, false, "cache lama harus tetap memakai default konservatif");
});

test("metadata model tersimpan di cache dan terbaca kembali bersama id-nya", () => {
  const file = path.join(tempDir(), "models.json");
  const models = [{ id: "m1", reasoning: true, contextWindow: 200_000 }];
  writeModelCache(file, ["m1"], new Date(), models);
  const read = readModelCache(file);
  assert.deepEqual(read?.ids, ["m1"]);
  assert.equal(toProviderModel("m1", read?.models[0]).reasoning, true);
});

test("thinking_levels dari gateway mengisi thinkingLevelMap, xhigh dan max hanya bila diumumkan", () => {
  const infos = parseModelInfos({
    data: [{ id: "cc/claude-opus-5-5", capabilities: { reasoning: true }, thinking_levels: ["low", "medium", "high", "xhigh", "max"] }],
  });
  assert.ok(infos);
  const model = toProviderModel(infos[0].id, infos[0]);
  assert.deepEqual(model.thinkingLevelMap, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
});

test("model tanpa thinking_levels tidak mendapat thinkingLevelMap, dan level yang tidak dikenal diabaikan", () => {
  const infos = parseModelInfos({
    data: [
      { id: "tanpa-field", capabilities: { reasoning: true } },
      { id: "level-asing", capabilities: { reasoning: true }, thinking_levels: ["turbo", "xhigh"] },
    ],
  });
  assert.ok(infos);
  assert.equal(toProviderModel(infos[0].id, infos[0]).thinkingLevelMap, undefined);
  assert.deepEqual(toProviderModel(infos[1].id, infos[1]).thinkingLevelMap, { xhigh: "xhigh" });
});

test("cache menyimpan thinkingLevels dan membacanya kembali", () => {
  const file = path.join(tempDir(), "models.json");
  const infos = parseModelInfos({
    data: [{ id: "cc/claude-sonnet-5-5", capabilities: { reasoning: true }, thinking_levels: ["low", "max"] }],
  });
  assert.ok(infos);
  assert.equal(writeModelCache(file, [infos[0].id], new Date(0), infos), true);
  const read = readModelCache(file);
  assert.deepEqual(read?.models[0]?.thinkingLevels, ["low", "max"]);
  assert.deepEqual(toProviderModel(read!.models[0].id, read!.models[0]).thinkingLevelMap, { low: "low", max: "max" });
});
