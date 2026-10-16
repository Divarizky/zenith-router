import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { AntigravityExecutor } from "../src/executors/antigravity.js";
import { effortFromRequest, buildAntigravityFamilies, resolveFamilyRuntime, levelFromThinkingBudget } from "../src/services/antigravityCatalog.js";
import { prepareUpstreamRequest } from "../src/gateway/prepare.js";
import { getProvider } from "../src/providers/index.js";

function capture() {
  const seen = {};
  const executor = new AntigravityExecutor({
    fetchFn: async (url, init = {}) => {
      seen.body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    },
  });
  return { executor, seen };
}

test("effortFromRequest - setiap dialek klien dipetakan ke tingkat yang sama", () => {
  assert.strictEqual(effortFromRequest("openai", { reasoning_effort: "high" }), "high");
  // "none" dan "off" sama-sama berarti tingkat termurah, bukan default medium.
  assert.strictEqual(effortFromRequest("openai", { reasoning_effort: "none" }), "low");
  assert.strictEqual(effortFromRequest("openai-responses", { reasoning: { effort: "none" } }), "low");
  assert.strictEqual(effortFromRequest("openai", {}), undefined);
  assert.strictEqual(effortFromRequest("openai-responses", { reasoning: { effort: "medium" } }), "medium");
  assert.strictEqual(effortFromRequest("claude", { thinking: { type: "enabled", budget_tokens: 1024 } }), "low");
  assert.strictEqual(effortFromRequest("claude", { thinking: { type: "enabled", budget_tokens: 4096 } }), "medium");
  assert.strictEqual(effortFromRequest("claude", { thinking: { type: "enabled", budget_tokens: 32000 } }), "high");
  assert.strictEqual(effortFromRequest("claude", { thinking: { type: "disabled" } }), "low");
  assert.strictEqual(effortFromRequest("claude", {}), undefined);
  assert.strictEqual(effortFromRequest("antigravity", { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } }), "high");
  assert.strictEqual(effortFromRequest("gemini", { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }), "medium");
});

test("levelFromThinkingBudget - budget kosong atau dinamis tidak dipetakan ke tingkat", () => {
  assert.strictEqual(levelFromThinkingBudget(undefined), undefined);
  assert.strictEqual(levelFromThinkingBudget(NaN), undefined);
  // Gemini memakai -1 untuk "dinamis", bukan tingkat apa pun.
  assert.strictEqual(levelFromThinkingBudget(-1), undefined);
  // 0 adalah off eksplisit, jadi tingkat termurah.
  assert.strictEqual(levelFromThinkingBudget(0), "low");
  assert.strictEqual(levelFromThinkingBudget(16384), "high");
});

test("effortFromRequest - tanpa budget atau dinamis, default ikut berlaku", () => {
  assert.strictEqual(effortFromRequest("claude", { thinking: { type: "enabled" } }), undefined);
  assert.strictEqual(effortFromRequest("gemini", { generationConfig: { thinkingConfig: { includeThoughts: true } } }), undefined);
  assert.strictEqual(effortFromRequest("gemini", { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }), undefined);
  assert.strictEqual(effortFromRequest("gemini", { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }), "low");
});

test("buildAntigravityFamilies - pengelompokan id runtime", () => {
  const families = buildAntigravityFamilies({
    "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", supportsThinking: true },
    "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", supportsThinking: true },
    "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", supportsThinking: true },
    "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash" },
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
    "gemini-3-flash-agent": { displayName: "Gemini 3.5 Flash (High)" },
    "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite" },
    "chat_20706": { displayName: "internal" },
    "gemini-3.1-flash-image": { displayName: "image" },
  });
  assert.deepStrictEqual(
    [...families.keys()].sort(),
    ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-argon"]
  );
  assert.strictEqual(families.get("gemini-4-argon").variants.high, "gemini-4-argon-high");
  assert.strictEqual(families.get("gemini-3.8-flash").tiered, "gemini-3.8-flash-tiered");
  assert.strictEqual(families.get("gemini-3.5-flash").variants.high, "gemini-3-flash-agent", "alias agent masuk keluarga");
  assert.strictEqual(families.get("gemini-4-argon").supportsThinking, true);
});

test("resolveFamilyRuntime - rantai cadangan dan bucket tiered", () => {
  const families = buildAntigravityFamilies({
    "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash" },
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
  });
  const family = families.get("gemini-3.8-flash");
  // Varian eksplisit menang atas bucket tiered, seperti di extension.
  assert.deepStrictEqual(resolveFamilyRuntime(family, "high"), { id: "gemini-3.8-flash-high", thinkingLevel: undefined });
  // xhigh tidak punya varian sendiri dan jatuh ke high.
  assert.deepStrictEqual(resolveFamilyRuntime(family, "xhigh"), { id: "gemini-3.8-flash-high", thinkingLevel: undefined });
  // medium tidak punya varian di grup ini; rantainya (medium, low, high, minimal)
  // berhenti di low, sama seperti tabel routing extension.
  assert.deepStrictEqual(resolveFamilyRuntime(family, "medium"), { id: "gemini-3.8-flash-low", thinkingLevel: undefined });
  assert.deepStrictEqual(resolveFamilyRuntime(family, undefined), { id: "gemini-3.8-flash-low", thinkingLevel: undefined });
  assert.deepStrictEqual(resolveFamilyRuntime(family, "low"), { id: "gemini-3.8-flash-low", thinkingLevel: undefined });
  // Tanpa varian sama sekali, bucket tiered yang dipakai dan tingkat ikut dikirim.
  const onlyTiered = buildAntigravityFamilies({ "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash" } }).get("gemini-3.8-flash");
  assert.deepStrictEqual(resolveFamilyRuntime(onlyTiered, undefined), { id: "gemini-3.8-flash-tiered", thinkingLevel: "medium" });
});

test("prepareUpstreamRequest - effort ikut ke executor lewat prepared", () => {
  const prepared = prepareUpstreamRequest({
    provider: getProvider("antigravity"),
    targetModel: "gemini-4-argon",
    body: { model: "gemini-4-argon", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
    sourceFormat: "openai",
    baseUrlFor: (p) => p.transport.baseUrls[0],
  });
  assert.strictEqual(prepared.effort, "high");
  assert.ok(!("reasoning_effort" in prepared.upstreamPayload), "pivot tidak membawa reasoning_effort");
});

test("executor - effort dari Claude thinking memilih varian runtime", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  const { executor, seen } = capture();
  await executor.execute({
    url: "x",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: { contents: [] } }),
    targetModel: "gemini-4-argon",
    effort: "high",
    connection: { credentials: { project_id: "p" } },
  });
  assert.strictEqual(seen.body.model, "gemini-4-argon-high");
});
