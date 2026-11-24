import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, replaceAntigravityAccountModels } from "../src/db/index.js";
import { getAvailableModels } from "../src/providers/index.js";
import { app } from "../src/index.js";
import { AntigravityExecutor } from "../src/executors/antigravity.js";

function seedAccount(entries) {
  initDb(":memory:");
  const conn = addConnection({ provider: "antigravity", name: "pro", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(
    conn.id,
    "free-tier",
    entries.map(([modelId, displayName]) => ({ modelId, displayName, recommended: true, quotaRemaining: 1 }))
  );
}

function antigravityEntry(family) {
  return getAvailableModels().find((m) => m.id === `ag/${family}`);
}

test("thinking_levels Antigravity - family dengan varian xhigh mengumumkan xhigh", () => {
  seedAccount([
    ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
    ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
    ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ]);
  assert.deepStrictEqual(antigravityEntry("gemini-4-hydrogen").thinking_levels, ["low", "high", "xhigh"]);
});

test("thinking_levels Antigravity - family tanpa varian xhigh tidak mengumumkan xhigh", () => {
  // Pada family ini xhigh akan turun ke high. Mengumumkannya akan menampilkan opsi
  // yang sebenarnya tidak berbeda dari high.
  seedAccount([
    ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
    ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ]);
  const levels = antigravityEntry("gemini-3.8-flash").thinking_levels;
  assert.deepStrictEqual(levels, ["low", "medium", "high"]);
  assert.ok(!levels.includes("xhigh"));
});

test("thinking_levels Antigravity - bucket tiered saja tidak menghasilkan klaim level", () => {
  // Akun hanya melaporkan bucket -tiered. Level builtin low/medium tidak boleh
  // diumumkan karena discovery sudah menyatakan family ini tanpa varian.
  seedAccount([["gemini-3.8-flash-tiered", "Gemini 3.8 Flash"]]);
  assert.strictEqual(antigravityEntry("gemini-3.8-flash").thinking_levels, undefined);
});

test("thinking_levels Antigravity - level mengikuti urutan tampilan, bukan urutan input", () => {
  seedAccount([
    ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
    ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
    ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ]);
  assert.deepStrictEqual(antigravityEntry("gemini-4-hydrogen").thinking_levels, ["low", "high", "xhigh"]);
});

// --- HTTP: /v1/models dan payload dispatch Antigravity ---

function seedCarbon(levels) {
  seedAccount(levels.map((level) => [`gemini-4-carbon-${level}`, `Gemini 4 Carbon (${level[0].toUpperCase()}${level.slice(1)})`]));
}

async function listModels() {
  return JSON.parse(await (await app.request("/v1/models")).text());
}

async function listModels2All() {
  return JSON.parse(await (await app.request("/v1/models?all=true")).text());
}

async function dispatchedModel(effort) {
  const seen = {};
  const executor = new AntigravityExecutor({
    fetchFn: async (url, init = {}) => {
      seen.body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    },
  });
  await executor.execute({
    url: "x",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: { contents: [] } }),
    targetModel: "gemini-4-carbon",
    effort,
    connection: { credentials: { project_id: "p" } },
  });
  return seen.body.model;
}

test("HTTP /v1/models - ag/gemini-4-carbon mendaftar low/medium/high dari varian yang ditemukan", async () => {
  seedCarbon(["low", "medium", "high"]);
  const models = await listModels();
  const entry = models.data.find((m) => m.id === "ag/gemini-4-carbon");
  assert.ok(entry, "family carbon terdaftar");
  assert.deepStrictEqual(entry.capabilities.thinking_levels, ["low", "medium", "high"]);
  assert.deepStrictEqual(entry.thinking_levels, ["low", "medium", "high"], "alias top-level tetap ada");
});

test("HTTP /v1/models - setiap tier yang diiklankan dikirim ke runtime varian yang sesuai", async () => {
  seedCarbon(["low", "medium", "high"]);
  const models = await listModels();
  const advertised = models.data.find((m) => m.id === "ag/gemini-4-carbon").capabilities.thinking_levels;
  for (const level of advertised) {
    assert.strictEqual(await dispatchedModel(level), `gemini-4-carbon-${level}`, `tier ${level}`);
  }
});

test("HTTP /v1/models - [sintetis, tidak terverifikasi upstream] family dengan max mengiklankan dan merutekan max", async () => {
  seedCarbon(["low", "high", "max"]);
  const models = await listModels();
  const entry = models.data.find((m) => m.id === "ag/gemini-4-carbon");
  assert.deepStrictEqual(entry.capabilities.thinking_levels, ["low", "high", "max"]);
  for (const level of entry.thinking_levels) {
    assert.strictEqual(await dispatchedModel(level), `gemini-4-carbon-${level}`, `tier ${level}`);
  }
});

test("HTTP /v1/models - family tanpa varian xhigh tidak mengiklankan xhigh", async () => {
  seedAccount([
    ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ]);
  const models = await listModels();
  const levels = models.data.find((m) => m.id === "ag/gemini-3.8-flash").capabilities.thinking_levels;
  assert.deepStrictEqual(levels, ["low", "high"]);
  assert.ok(!levels.includes("xhigh"));
});

test("HTTP /v1/models - model Codex yang punya data level mengiklankan ladder-nya", async () => {
  initDb(":memory:");
  const models = await listModels2All();
  const cx = models.data.find((m) => m.id === "cx/gpt-6-luna");
  assert.ok(cx, "cx/gpt-6-luna ada");
  assert.deepStrictEqual(cx.capabilities.thinking_levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepStrictEqual(cx.thinking_levels, cx.capabilities.thinking_levels);
});

test("HTTP /v1/models - model Codex tanpa data level tidak mengklaim level", async () => {
  const models = await listModels2All();
  const cx = models.data.find((m) => m.id === "cx/gpt-5.5");
  assert.ok(cx, "cx/gpt-5.5 ada");
  assert.strictEqual(cx.capabilities?.thinking_levels, undefined);
  assert.strictEqual(cx.thinking_levels, undefined);
});

test("HTTP /v1/models - combo tidak mengumumkan thinking_levels walau anggotanya punya level", async () => {
  seedCarbon(["low", "medium", "high"]);
  const { createCombo } = await import("../src/services/combos.js");
  createCombo({ name: "combo-carbon", models: ["ag/gemini-4-carbon"] });
  const combo = (await listModels()).data.find((m) => m.id === "combo-carbon");
  assert.ok(combo, "combo terdaftar");
  assert.strictEqual(combo.thinking_levels, undefined);
  assert.strictEqual(combo.capabilities.thinking_levels, undefined);
});
