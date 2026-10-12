import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { createCombo } from "../src/services/combos.js";
import { addCustomModel } from "../src/services/modelOverrides.js";
import { app } from "../src/index.js";

test("GET /api/models - the picker payload groups connected providers", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Key", credentials: { api_key: "k1" } });

  const res = await app.request("/api/models");
  assert.strictEqual(res.status, 200);
  const { providers } = JSON.parse(await res.text());
  assert.ok(Array.isArray(providers), "payload punya daftar provider");

  const glm = providers.find((p) => p.id === "glm");
  assert.ok(glm, "provider terhubung ikut tampil");
  assert.strictEqual(typeof glm.name, "string");
  assert.ok(glm.icon, "ikon provider disertakan bila file-nya ada");
  const flash = glm.models.find((m) => m.id === "glm/glm-4-flash");
  assert.ok(flash, `model provider terhubung ikut tampil, dapat ${JSON.stringify(glm.models.slice(0, 3))}`);
  assert.strictEqual(typeof flash.capabilities.vision, "boolean");

  const codex = providers.find((p) => p.id === "codex");
  assert.ok(!codex, "provider berbayar tanpa koneksi tidak tampil");
});

test("GET /api/models - combos do not leak into the picker payload", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Key", credentials: { api_key: "k1" } });
  createCombo({ name: "antai-utama", models: ["glm/glm-4-flash"] });

  const { providers } = JSON.parse(await (await app.request("/api/models")).text());
  const ids = providers.flatMap((p) => p.models.map((m) => m.id));
  assert.ok(!ids.includes("antai-utama"), "combo bukan anggota pilihan model");
});

test("GET /api/models - a custom model rides along with its provider group", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Key", credentials: { api_key: "k1" } });
  addCustomModel({ provider: "glm", model_id: "glm-ku-local" });

  const { providers } = JSON.parse(await (await app.request("/api/models")).text());
  const glm = providers.find((p) => p.id === "glm");
  const custom = glm.models.find((m) => m.id === "glm/glm-ku-local");
  assert.ok(custom, "model custom ikut serta");
  assert.strictEqual(custom.custom, true);
});
