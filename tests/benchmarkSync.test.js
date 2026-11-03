import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import {
  canonId,
  calculateHeuristicScore,
  determineTier,
  parseLmarenaRows,
  parseZeroevalSwe,
  parseBenchlm,
  toPercentiles,
  refreshBenchmarkSnapshot,
  loadSnapshot,
  resolveLiveScores,
  MIN_SOURCE_MODELS,
  SNAPSHOT_KEY,
} from "../src/services/benchmarkSync.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import {
  assembleManagedCombos,
  isExcludedFromManagedCombos,
} from "../src/services/managedCombos.js";
import { findBenchmarkMatch, calculateCodingScore, sortModelsByCodingQuality } from "../src/services/modelBenchmarks.js";

function freshDb() {
  initDb(":memory:");
}

function mockFetch(routes) {
  return async (url) => {
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("{}", { status: 404 });
    const v = hit[1];
    if (v instanceof Error) throw v;
    if (typeof v === "string") {
      return new Response(v, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

function allSourcesOk() {
  const swe = Array.from({ length: MIN_SOURCE_MODELS + 2 }, (_, i) => ({
    model_id: `m${i}`,
    swe_bench_verified_score: (i + 1) / 50,
  }));
  const lma = {
    rows: Array.from({ length: MIN_SOURCE_MODELS + 2 }, (_, i) => ({
      row: { model_name: `m${i}`, category: "overall", score: (i + 1) / 100 },
    })),
  };
  const blmRows = Array.from({ length: MIN_SOURCE_MODELS + 2 }, (_, i) => {
    const row = new Array(31).fill(null);
    row[1] = `Model M${i}`;
    row[2] = `m${i}`;
    row[30] = [50 + i, 60 + i]; // [agentic, coding]
    return row;
  });
  const blmHtml = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { homepageData: { leaderboard: { rows: blmRows } } } },
  })}</script></html>`;

  return {
    "config=agent": lma,
    "zeroeval.com": swe,
    "benchlm.ai": blmHtml,
  };
}

// --- canonId tests ---

test("canonId: Claude Opus 4.5/4.7/4.8 tidak bertabrakan ke satu kunci", () => {
  const keys = new Set(["kr/claude-opus-4.5", "kr/claude-opus-4.7", "kr/claude-opus-4.8"].map(canonId));
  assert.strictEqual(keys.size, 3);
});

test("canonId: alias provider dan sufiks gratis menghasilkan kunci yang sama", () => {
  assert.strictEqual(canonId("oc/glm-5.3-flash-free"), canonId("llm7/GLM-5.3-Flash"));
  assert.strictEqual(canonId("xkr/qwen/qwen3.6-27b:free"), canonId("ovh/Qwen3.6-27B"));
  assert.strictEqual(canonId("Claude Opus 5.5 (Max)"), canonId("kr/claude-opus-5.5"));
});

test("canonId: menormalkan model path berjenjang dan titik versi", () => {
  assert.strictEqual(canonId("xkr/qwen/qwen3.8-max:free"), "qwen3-8-max");
  assert.strictEqual(canonId("kc/thinkingmachines/inkling-small:free"), "inkling-small");
  assert.strictEqual(canonId("oc/deepseek-v4.1-flash-free"), "deepseek-v4-1-flash");
});

// --- Heuristic tests (ala 9router) ---

test("calculateHeuristicScore: memberikan nilai dasar sesuai keluarga model", () => {
  assert.strictEqual(calculateHeuristicScore("claude-3-opus"), 75.0);
  assert.strictEqual(calculateHeuristicScore("generic-mini"), 48.0);
  assert.strictEqual(calculateHeuristicScore("deepseek-chat"), 62.0);
  assert.strictEqual(calculateHeuristicScore("unknown-generic-model"), 50.0);
});

test("calculateHeuristicScore: bonus reasoning/thinking dan ukuran parameter", () => {
  // Qwen (62) + thinking (+4) + 72b (+4) = 70.0
  assert.strictEqual(calculateHeuristicScore("qwen-72b-thinking"), 70.0);
  // Mistral (62) + 8b (-2) = 60.0
  assert.strictEqual(calculateHeuristicScore("mistral-8b-instruct"), 60.0);
});

test("calculateHeuristicScore: penalti berat untuk model non-coding / filter", () => {
  assert.strictEqual(calculateHeuristicScore("nvidia/nemotron-3.5-content-safety"), 10.0);
  assert.strictEqual(calculateHeuristicScore("openai/text-embedding-3"), 10.0);
  assert.strictEqual(calculateHeuristicScore("black-forest-flux-image"), 10.0);
});

// --- Parser tests ---

test("parseLmarenaRows: hanya kategori overall, 'Multiple' dibuang, ambil skor tertinggi per model", () => {
  const rows = [
    { model_name: "GLM-5.3-Flash", category: "overall", score: 0.1 },
    { model_name: "GLM-5.3-Flash", category: "overall", score: 0.3 },
    { model_name: "GLM-5.3-Flash", category: "webdev-react", score: 0.99 },
    { model_name: "Multiple", category: "overall", score: 0.9 },
    { model_name: "Tanpa Skor", category: "overall", score: null },
  ];
  const out = parseLmarenaRows(rows);
  assert.strictEqual(out.get("glm-5-3-flash"), 0.3);
});

test("parseZeroevalSwe: parsing skor swe-bench verified", () => {
  const models = [
    { model_id: "qwen/qwen3.6-plus", swe_bench_verified_score: 0.788 },
    { name: "GLM-5.3-Flash", swe_bench_verified_score: 0.778 },
  ];
  const out = parseZeroevalSwe(models);
  assert.strictEqual(out.get("qwen3-6-plus"), 0.788);
  assert.strictEqual(out.get("glm-5-3-flash"), 0.778);
});

test("parseBenchlm: mengekstrak skor coding dan agentic dari row BenchLM", () => {
  const rows = [
    [1, "DeepSeek V4.1 Flash", "deepseek-v4-1-flash", "deepseek", ...new Array(26).fill(null), [62.18, 62.91]],
    [2, "Empty Model", "empty-model", "other", ...new Array(26).fill(null), [null, null]],
  ];
  const { coding, agentic } = parseBenchlm(rows);
  assert.strictEqual(coding.get("deepseek-v4-1-flash"), 62.91);
  assert.strictEqual(agentic.get("deepseek-v4-1-flash"), 62.18);
  assert.strictEqual(coding.has("empty-model"), false);
});

test("toPercentiles: menghitung persentil rank 0-100", () => {
  const scores = new Map([
    ["low", 10],
    ["mid", 20],
    ["high", 30],
  ]);
  const p = toPercentiles(scores);
  assert.ok(p.low < p.mid);
  assert.ok(p.mid < p.high);
});

// --- Snapshot & refresh tests ---

test("refreshBenchmarkSnapshot: berhasil menyimpan snapshot saat sumber valid", async () => {
  freshDb();
  const res = await refreshBenchmarkSnapshot({ fetchImpl: mockFetch(allSourcesOk()), now: 1000, force: true });
  assert.strictEqual(res.ok, true);
  const snap = loadSnapshot();
  assert.ok(snap);
  assert.strictEqual(snap.fetchedAt, 1000);
  assert.ok("swe_verified" in snap.sources);
  assert.ok("blm_coding" in snap.sources);
});

test("refreshBenchmarkSnapshot: gagal mengambil tidak menimpa snapshot lama", async () => {
  freshDb();
  await refreshBenchmarkSnapshot({ fetchImpl: mockFetch(allSourcesOk()), now: 1000, force: true });
  const failFetch = mockFetch({
    "config=agent": new Error("500"),
    "zeroeval.com": new Error("500"),
    "benchlm.ai": new Error("500"),
  });
  const res = await refreshBenchmarkSnapshot({ fetchImpl: failFetch, now: 2000, force: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kept, true);
  assert.strictEqual(loadSnapshot().fetchedAt, 1000);
});

// --- resolveLiveScores tests ---

test("resolveLiveScores: memetakan model empiris ke rentang 35 - 80 dan model heuristik", () => {
  const snapshot = {
    version: 3,
    sources: {
      blm_coding: {
        "ling-3-1-flash": 80,
        "deepseek-v4-1-flash": 75,
        "low-model": 10,
      },
    },
  };
  // Isi pool sintetis agar MIN_SOURCE_MODELS terpenuhi
  for (let i = 0; i < 25; i++) {
    snapshot.sources.blm_coding[`m${i}`] = 20 + i;
  }

  const scores = resolveLiveScores(["oc/deepseek-v4.1-flash-free", "llm7/unknown-model-100b"], snapshot);
  assert.ok(scores["oc/deepseek-v4.1-flash-free"].score >= 60.0);
  assert.ok(scores["oc/deepseek-v4.1-flash-free"].source.includes("empirical"));
  assert.ok(scores["llm7/unknown-model-100b"].score >= 50.0); // heuristik 100b
  assert.ok(scores["llm7/unknown-model-100b"].source.includes("heuristic"));
});

// --- Nemotron & Excluded providers tests ---

test("findBenchmarkMatch: varian nemotron non-ultra tidak mewarisi skor Nemotron Ultra", () => {
  assert.strictEqual(findBenchmarkMatch("kc/nvidia/nemotron-3.5-content-safety:free"), null);
  assert.strictEqual(findBenchmarkMatch("oc/nemotron-3.5-lightning-free"), null);
  assert.strictEqual(findBenchmarkMatch("llm7/nemotron-3-nano:30b"), null);
  assert.strictEqual(findBenchmarkMatch("nemotron-ultra")?.id, "nemotron-ultra");
});

test("isExcludedFromManagedCombos: provider kiro (kr/) dikeluarkan", () => {
  assert.strictEqual(isExcludedFromManagedCombos("kr/claude-opus-5.5"), true);
  assert.strictEqual(isExcludedFromManagedCombos({ id: "claude-sonnet-5", owned_by: "kiro" }), true);
  assert.strictEqual(isExcludedFromManagedCombos("xkr/qwen/qwen3.6-plus:free"), false);
  assert.strictEqual(isExcludedFromManagedCombos("llm7/default"), false);
});

// --- assembleManagedCombos integration tests ---

test("assembleManagedCombos: model kr/ tidak muncul di combo mana pun dan model diurutkan sesuai skor terpadu", () => {
  const candidates = [
    { id: "kr/claude-opus-5.5", owned_by: "kiro", context_length: 200000 },
    { id: "oc/deepseek-v4.1-flash-free", owned_by: "opencode", context_length: 200000 },
    { id: "xkr/qwen/qwen3.8-max:free", owned_by: "xkiro", context_length: 200000 },
    { id: "kcf/inclusionai/ling-3.1-flash-1019-free", owned_by: "kilo-free", context_length: 200000 },
    { id: "llm7/GLM-5.3-Flash", owned_by: "llm7", context_length: 200000 },
    { id: "or/nvidia/nemotron-3.5-content-safety:free", owned_by: "openrouter", context_length: 200000 },
  ];

  const liveScores = {
    "oc/deepseek-v4.1-flash-free": { score: 75.2, tier: "A+" },
    "xkr/qwen/qwen3.8-max:free": { score: 70.8, tier: "A+" },
    "kcf/inclusionai/ling-3.1-flash-1019-free": { score: 78.4, tier: "A+" },
    "llm7/GLM-5.3-Flash": { score: 67.5, tier: "A" },
    "or/nvidia/nemotron-3.5-content-safety:free": { score: 10.0, tier: "C+" },
  };

  const out = assembleManagedCombos({
    candidates,
    signals: { liveScores },
  });

  // Pastikan kr/ sama sekali tidak ada
  assert.ok(!out["zenith-free"].includes("kr/claude-opus-5.5"));
  assert.ok(!out["zenith-smart"].includes("kr/claude-opus-5.5"));

  // Urutan kualitas: DeepSeek (86 statis) > GLM (84 statis) > Ling (78.4 live) > Qwen 3.8 (70.8 live) > Content Safety (10.0 heuristik)
  assert.strictEqual(out["zenith-free"][0], "oc/deepseek-v4.1-flash-free");
  assert.strictEqual(out["zenith-free"][1], "llm7/GLM-5.3-Flash");
  assert.strictEqual(out["zenith-free"][2], "kcf/inclusionai/ling-3.1-flash-1019-free");
  assert.strictEqual(out["zenith-free"][3], "xkr/qwen/qwen3.8-max:free");
  assert.strictEqual(out["zenith-free"][out["zenith-free"].length - 1], "or/nvidia/nemotron-3.5-content-safety:free");

  // Model-model dengan skor >= 68 masuk zenith-smart
  assert.ok(out["zenith-smart"].includes("kcf/inclusionai/ling-3.1-flash-1019-free"));
  assert.ok(out["zenith-smart"].includes("oc/deepseek-v4.1-flash-free"));
  assert.ok(out["zenith-smart"].includes("xkr/qwen/qwen3.8-max:free"));
  assert.ok(!out["zenith-smart"].includes("or/nvidia/nemotron-3.5-content-safety:free"));
});
