import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { getAvailableModels, resolveModel } from "../src/providers/index.js";
import { codexThinkingLevelsFor, codexReasoningEffort, CODEX_THINKING_LEVELS } from "../src/providers/codexTiers.js";
import { translateRequest } from "../src/translator/index.js";

const FULL = ["low", "medium", "high", "xhigh", "max"];

function catalog() {
  initDb(":memory:");
  return Object.fromEntries(getAvailableModels({ all: true }).map((m) => [m.id, m]));
}

// Jalur dispatch yang sebenarnya: gateway/prepare.js memanggil translateRequest dengan
// targetModel dari resolveModel (id tanpa prefix), dan codex: true untuk provider codex.
function dispatchReasoning(rawModel, body) {
  initDb(":memory:");
  const { targetModel, provider } = resolveModel(rawModel);
  assert.strictEqual(provider.id, "codex", `${rawModel} harus ke provider codex`);
  const out = translateRequest(
    "openai",
    "openai-responses",
    { model: rawModel, messages: [{ role: "user", content: "hi" }], ...body },
    targetModel,
    { codex: provider.id === "codex" }
  );
  return out.reasoning;
}

test("/v1/models - model ladder mengiklankan tier di capabilities dan alias top-level", () => {
  const byId = catalog();
  for (const id of ["cx/gpt-6-luna", "cx/gpt-6.1-sol", "cx/gpt-5.6-terra"]) {
    assert.deepStrictEqual(byId[id]?.capabilities?.thinking_levels, FULL, `${id} capabilities`);
    assert.deepStrictEqual(byId[id]?.thinking_levels, FULL, `${id} alias top-level`);
  }
});

test("/v1/models - cx/gpt-5.5 (di luar ladder) tidak mengiklankan tier", () => {
  const m = catalog()["cx/gpt-5.5"];
  assert.ok(m, "cx/gpt-5.5 terdaftar");
  assert.strictEqual(m.thinking_levels, undefined);
  assert.strictEqual(m.capabilities?.thinking_levels, undefined);
  assert.strictEqual(codexThinkingLevelsFor("gpt-5.5"), null);
});

test("katalog - daftar tier berasal dari codexThinkingLevelsFor, tanpa none/minimal/off", () => {
  const byId = catalog();
  assert.deepStrictEqual(codexThinkingLevelsFor("gpt-6-luna"), [...CODEX_THINKING_LEVELS]);
  assert.deepStrictEqual(byId["cx/gpt-6-luna"].capabilities.thinking_levels, codexThinkingLevelsFor("gpt-6-luna"));
  for (const hidden of ["none", "minimal", "off"]) {
    assert.ok(!CODEX_THINKING_LEVELS.includes(hidden), `${hidden} tidak diiklankan sebagai tier`);
  }
});

test("dispatch - setiap tier ladder sampai ke reasoning.effort yang sama (model id tanpa prefix)", () => {
  for (const level of FULL) {
    const reasoning = dispatchReasoning("cx/gpt-6-luna", { reasoning_effort: level });
    assert.strictEqual(reasoning?.effort, level, `tier ${level}`);
  }
});

test("dispatch - gpt-5.5 (di luar ladder) meneruskan low, xhigh, dan max apa adanya", () => {
  for (const level of ["low", "xhigh", "max"]) {
    const reasoning = dispatchReasoning("cx/gpt-5.5", { reasoning_effort: level });
    assert.strictEqual(reasoning?.effort, level, `gpt-5.5 ${level} diteruskan`);
  }
  assert.strictEqual(catalog()["cx/gpt-5.5"].thinking_levels, undefined, "katalog tetap kosong");
});

test("dispatch - minimal dipetakan ke low, none diteruskan tanpa summary", () => {
  assert.strictEqual(dispatchReasoning("cx/gpt-6-luna", { reasoning_effort: "minimal" })?.effort, "low");
  assert.deepStrictEqual(dispatchReasoning("cx/gpt-6-luna", { reasoning_effort: "none" }), { effort: "none" });
});

test("dispatch - effort tidak dikenal tidak dikirim, dan reasoning.effort klien dibaca bila reasoning_effort kosong", () => {
  assert.strictEqual(dispatchReasoning("cx/gpt-5.5", { reasoning_effort: "turbo" }), undefined);
  assert.strictEqual(dispatchReasoning("cx/gpt-5.5", { reasoning: { effort: "max", summary: "detailed" } })?.summary, "detailed");
});

test("codexReasoningEffort - nama properti prototipe tidak dianggap effort", () => {
  for (const raw of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.strictEqual(codexReasoningEffort(raw), undefined, raw);
  }
});
