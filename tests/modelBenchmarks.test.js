import test from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARKS_DATABASE,
  getBenchmarksDatabase,
  determineTier,
  isThinkingVariant,
  isSmartTierModel,
  normalizeModelIdentifier,
  findBenchmarkMatch,
  calculateCodingScore,
  sortModelsByCodingQuality,
} from "../src/services/modelBenchmarks.js";
import { QUOTA_LATENCY_SENTINEL } from "../src/services/modelHealth.js";

test("getBenchmarksDatabase - memuat dataset benchmark koding empiris lengkap", () => {
  const db = getBenchmarksDatabase();
  assert.ok(Array.isArray(db));
  assert.ok(db.length >= 25);

  const validTiers = new Set(["S", "A+", "A", "B+", "B", "C+"]);

  for (const item of db) {
    assert.ok(typeof item.id === "string" && item.id.length > 0, "id harus berupa string");
    assert.ok(typeof item.name === "string" && item.name.length > 0, "name harus berupa string");
    assert.ok(typeof item.score === "number" && item.score >= 0 && item.score <= 100, `skor ${item.name} harus 0-100`);
    assert.ok(typeof item.swe_bench === "number", `swe_bench ${item.name} harus number`);
    assert.ok(typeof item.livecodebench === "number", `livecodebench ${item.name} harus number`);
    assert.ok(validTiers.has(item.tier), `tier ${item.tier} pada ${item.name} tidak valid`);
  }
});

test("determineTier - memetakan skor ke tier S, A+, A, B+, B, C+", () => {
  assert.equal(determineTier(95), "S");
  assert.equal(determineTier(80), "S");
  assert.equal(determineTier(79.9), "A+");
  assert.equal(determineTier(70), "A+");
  assert.equal(determineTier(69), "A");
  assert.equal(determineTier(60), "A");
  assert.equal(determineTier(59), "B+");
  assert.equal(determineTier(50), "B+");
  assert.equal(determineTier(49), "B");
  assert.equal(determineTier(40), "B");
  assert.equal(determineTier(39), "C+");
  assert.equal(determineTier(0), "C+");
  assert.equal(determineTier(-5), "C+");
  assert.equal(determineTier("invalid"), "C+");
});

test("isThinkingVariant - mendeteksi varian thinking, reasoning, dan reasoner", () => {
  assert.equal(isThinkingVariant("claude-3-7-sonnet:thinking"), true);
  assert.equal(isThinkingVariant("ag/claude-3-7-sonnet-20250219:thinking"), true);
  assert.equal(isThinkingVariant("deepseek-reasoner"), true);
  assert.equal(isThinkingVariant("qwen-reasoning-model"), true);
  assert.equal(isThinkingVariant("DeepSeek-R1-Thinking"), true);

  assert.equal(isThinkingVariant("claude-3-5-sonnet"), false);
  assert.equal(isThinkingVariant("gpt-4o"), false);
  assert.equal(isThinkingVariant("gemini-2.5-pro"), false);
  assert.equal(isThinkingVariant(""), false);
  assert.equal(isThinkingVariant(null), false);
  assert.equal(isThinkingVariant(undefined), false);
});

test("normalizeModelIdentifier - membersihkan provider prefix, suffix free/beta, dan tanggal", () => {
  assert.equal(normalizeModelIdentifier("ag/claude-3-7-sonnet-20250219"), "claude-3-7-sonnet");
  assert.equal(normalizeModelIdentifier("cc/claude-3-5-sonnet-20241022"), "claude-3-5-sonnet");
  assert.equal(normalizeModelIdentifier("openai/gpt-4o-2024-08-06"), "gpt-4o");
  assert.equal(normalizeModelIdentifier("openrouter/deepseek/deepseek-r1:free"), "deepseek-r1");
  assert.equal(normalizeModelIdentifier("antigravity/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(normalizeModelIdentifier(""), "");
  assert.equal(normalizeModelIdentifier(null), "");
});

test("findBenchmarkMatch - menemukan benchmark dengan normalisasi dan alias", () => {
  // Claude Sonnet variants
  const c37t = findBenchmarkMatch("ag/claude-3-7-sonnet-20250219:thinking");
  assert.ok(c37t);
  assert.equal(c37t.id, "claude-3-7-sonnet-thinking");
  assert.equal(c37t.tier, "S");

  const c37 = findBenchmarkMatch("ag/claude-3-7-sonnet-20250219");
  assert.ok(c37);
  assert.equal(c37.id, "claude-3-7-sonnet");

  const c35 = findBenchmarkMatch("cc/claude-3-5-sonnet-20241022");
  assert.ok(c35);
  assert.equal(c35.id, "claude-3-5-sonnet");

  const c45 = findBenchmarkMatch("claude-sonnet-4.5");
  assert.ok(c45);
  assert.equal(c45.id, "claude-sonnet-4-5");

  // DeepSeek variants
  const r1 = findBenchmarkMatch("deepseek/deepseek-r1:free");
  assert.ok(r1);
  assert.equal(r1.id, "deepseek-r1");

  const v4 = findBenchmarkMatch("deepseek-v4");
  assert.ok(v4);
  assert.equal(v4.id, "deepseek-v4");

  const v3 = findBenchmarkMatch("openrouter/deepseek/deepseek-chat");
  assert.ok(v3);
  assert.equal(v3.id, "deepseek-v3");

  // Gemini variants
  const g31 = findBenchmarkMatch("gemini-3.1-pro");
  assert.ok(g31);
  assert.equal(g31.id, "gemini-3-1-pro");

  const g37 = findBenchmarkMatch("gemini-3.7-flash");
  assert.ok(g37);
  assert.equal(g37.id, "gemini-3-7-flash");

  // Model lainnya (GLM-5, Step 3.7, Qwen 3.7/2.5 Coder, GPT-4o, Nemotron Ultra, MiMo)
  const glm5 = findBenchmarkMatch("glm-5");
  assert.ok(glm5);
  assert.equal(glm5.id, "glm-5");

  const step = findBenchmarkMatch("step-3.7");
  assert.ok(step);
  assert.equal(step.id, "step-3-7");

  const qwen37 = findBenchmarkMatch("qwen-3.7-coder");
  assert.ok(qwen37);
  assert.equal(qwen37.id, "qwen-3-7-coder");

  const qwen25 = findBenchmarkMatch("qwen/qwen-2.5-coder-32b-instruct");
  assert.ok(qwen25);
  assert.equal(qwen25.id, "qwen-2-5-coder-32b");

  const gpt4o = findBenchmarkMatch("openai/gpt-4o-2024-08-06");
  assert.ok(gpt4o);
  assert.equal(gpt4o.id, "gpt-4o");

  const nemo = findBenchmarkMatch("nemotron-ultra");
  assert.ok(nemo);
  assert.equal(nemo.id, "nemotron-ultra");

  const mimo = findBenchmarkMatch("mimo-v2.6");
  assert.ok(mimo);
  assert.equal(mimo.id, "mimo-v2-6");

  // Model tidak dikenal
  assert.equal(findBenchmarkMatch("unknown-model-xyz"), null);
  assert.equal(findBenchmarkMatch(null), null);
  assert.equal(findBenchmarkMatch(""), null);
});

test("isSmartTierModel - mendeteksi model smart tier (skor >= 68 atau thinking variant)", () => {
  // Model dengan skor >= 68
  assert.equal(isSmartTierModel("claude-3-7-sonnet"), true);
  assert.equal(isSmartTierModel("deepseek-r1"), true);
  assert.equal(isSmartTierModel("gpt-4o"), true);
  assert.equal(isSmartTierModel("minimax-01"), true);

  // Varian thinking otomatis smart tier
  assert.equal(isSmartTierModel("custom-fast-model:thinking"), true);
  assert.equal(isSmartTierModel("some-reasoner"), true);

  // Model dengan skor < 68
  assert.equal(isSmartTierModel("gpt-4o-mini"), false);
  assert.equal(isSmartTierModel("llama-3-1-8b"), false);
  assert.equal(isSmartTierModel("gpt-3-5-turbo"), false);

  // Model tidak dikenal non-thinking
  assert.equal(isSmartTierModel("unknown-small-model"), false);
  assert.equal(isSmartTierModel(""), false);
  assert.equal(isSmartTierModel(null), false);
});

test("calculateCodingScore - formula Skor Akhir = Skor Benchmark - Penalti Latensi - Penalti Kegagalan", () => {
  // Baseline tanpa penalti
  const baseScore = calculateCodingScore("claude-3-7-sonnet");
  assert.equal(baseScore, 88);

  // Penalti latensi: misal 2000ms -> 4 poin
  const withLatency = calculateCodingScore("claude-3-7-sonnet", { latencyMs: 2000 });
  assert.equal(withLatency, 84);

  // Penalti kegagalan: misal failureRate 0.2 (20%) -> 10 poin
  const withFailure = calculateCodingScore("claude-3-7-sonnet", { failureRate: 0.2 });
  assert.equal(withFailure, 78);

  // Gabungan penalti latensi dan kegagalan
  const withBoth = calculateCodingScore("claude-3-7-sonnet", { latencyMs: 2500, failureRate: 0.1 });
  // base 88 - (2500 * 0.002 = 5) - (0.1 * 50 = 5) = 78
  assert.equal(withBoth, 78);

  // Latensi sentinel (model terkena rate limit / kuota habis dan diparkir)
  const parkedScore = calculateCodingScore("claude-3-7-sonnet", { latencyMs: QUOTA_LATENCY_SENTINEL });
  assert.ok(parkedScore <= -999999);
});

test("sortModelsByCodingQuality - mengurutkan model berdasarkan skor dan memarkir model quota di terbawah", () => {
  const models = [
    "gpt-4o-mini", // score ~56
    "claude-3-7-sonnet", // score ~88
    "qwen-2.5-coder-32b", // score ~76
    "gemini-3.1-pro", // score ~87
  ];

  // Tanpa latensi & failure
  const sorted = sortModelsByCodingQuality(models);
  assert.deepEqual(sorted, [
    "claude-3-7-sonnet",
    "gemini-3.1-pro",
    "qwen-2.5-coder-32b",
    "gpt-4o-mini",
  ]);

  // Model dengan latensi tinggi tergeser turun
  const sortedWithLatency = sortModelsByCodingQuality(models, {
    latencyMap: {
      "claude-3-7-sonnet": 6000, // penalti 12 poin -> skor 76
    },
  });
  // gemini (87) > claude (76) / qwen (76) > gpt-4o-mini (56)
  assert.equal(sortedWithLatency[0], "gemini-3.1-pro");

  // Model terkena quota / sentinel parkir selalu ditaruh di paling bawah
  const sortedWithQuota = sortModelsByCodingQuality(models, {
    latencyMap: {
      "claude-3-7-sonnet": QUOTA_LATENCY_SENTINEL,
    },
  });
  assert.equal(sortedWithQuota[sortedWithQuota.length - 1], "claude-3-7-sonnet");

  // Mendukung array of objects dengan status quota
  const objectModels = [
    { id: "gpt-4o-mini", status: "active" },
    { id: "claude-3-7-sonnet", status: "quota" },
    { id: "gemini-3.1-pro", status: "active" },
  ];
  const sortedObjects = sortModelsByCodingQuality(objectModels);
  assert.equal(sortedObjects[0].id, "gemini-3.1-pro");
  assert.equal(sortedObjects[1].id, "gpt-4o-mini");
  assert.equal(sortedObjects[2].id, "claude-3-7-sonnet");
});
