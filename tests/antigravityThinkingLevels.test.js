import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, replaceAntigravityAccountModels } from "../src/db/index.js";
import { getAvailableModels } from "../src/providers/index.js";

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
