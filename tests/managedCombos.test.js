import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTIC_MIN_CONTEXT,
  passesAgenticGate,
  deriveTierLists,
  assembleManagedCombos,
  syncManagedCombos,
  saveCombo,
  isFreeModel,
} from "../src/services/managedCombos.js";
import { getComboByName, listCombos } from "../src/services/combos.js";
import { QUOTA_LATENCY_SENTINEL } from "../src/services/modelHealth.js";
import { getDb } from "../src/db/index.js";

test("AGENTIC_MIN_CONTEXT bernilai 100000 (100k token floor)", () => {
  assert.equal(AGENTIC_MIN_CONTEXT, 100000);
});

test("passesAgenticGate - memfilter model dengan context < 100k token atau tools unsupported", () => {
  // Model dengan context memadai (>= 100k) dan dukungan tools terverifikasi
  assert.equal(passesAgenticGate({ id: "model-a", contextLength: 128000, tools: true }), true);
  assert.equal(passesAgenticGate({ id: "model-b", context_length: 100000, tools: true }), true);
  assert.equal(passesAgenticGate({ id: "model-c", contextWindow: 1000000, supportsTools: true }), true);
  assert.equal(
    passesAgenticGate({ id: "model-caps", contextWindow: 1000000, capabilities: { tools: true } }),
    true
  );

  // Fail-closed: tanpa bukti dukungan tools, model ditolak meski context besar
  assert.equal(passesAgenticGate({ id: "model-unverified", context_length: 100000 }), false);
  assert.equal(passesAgenticGate({ id: "model-unknown-family", contextWindow: 1000000 }), false);

  // Model dengan context < 100k token wajib ditolak
  assert.equal(passesAgenticGate({ id: "model-small-1", contextLength: 32768 }), false);
  assert.equal(passesAgenticGate({ id: "model-small-2", context_length: 64000 }), false);
  assert.equal(passesAgenticGate({ id: "model-small-3", contextWindow: 8192 }), false);
  assert.equal(passesAgenticGate({ id: "model-small-4", max_tokens: 16384 }), false);

  // Model dengan tools unsupported wajib ditolak meskipun context besar
  assert.equal(passesAgenticGate({ id: "model-no-tools-1", contextLength: 200000, toolsUnsupported: true }), false);
  assert.equal(passesAgenticGate({ id: "model-no-tools-2", contextLength: 200000, supportsTools: false }), false);
  assert.equal(passesAgenticGate({ id: "model-no-tools-3", contextLength: 200000, tools: false }), false);
  assert.equal(
    passesAgenticGate({ id: "model-no-tools-4", contextLength: 200000, capabilities: { tools: false } }),
    false
  );

  // Resolusi via pattern capabilities bawaan
  assert.equal(passesAgenticGate("gpt-3.5-turbo"), false); // context ~16k < 100k
  // String id tanpa metadata tools tidak punya bukti tools: fail-closed menolak.
  assert.equal(passesAgenticGate("claude-3-7-sonnet"), false);

  // Input falsy
  assert.equal(passesAgenticGate(null), false);
  assert.equal(passesAgenticGate(undefined), false);
  assert.equal(passesAgenticGate(""), false);
});

test("deriveTierLists - mempartisi pool model ke smart dan fast dengan fallback minimal 3 model", () => {
  // Pool dengan campuran smart (score >= 68 / thinking) dan fast (< 68 non-thinking)
  const activePool = [
    "claude-3-7-sonnet", // Smart (skor ~88)
    "gemini-3.1-pro", // Smart (skor ~87)
    "qwen-2.5-coder-32b", // Smart (skor ~76)
    "deepseek-r1", // Smart (thinking variant / skor ~89)
    "gpt-4o-mini", // Fast (non-thinking, skor ~56)
    "llama-3-1-8b", // Fast (non-thinking, skor ~42)
    "mimo-v2.6", // Fast (skor ~65)
  ];

  const { smart, fast } = deriveTierLists(activePool);

  // Smart tier harus memuat model dengan koding tinggi / thinking
  assert.ok(smart.includes("claude-3-7-sonnet"));
  assert.ok(smart.includes("gemini-3.1-pro"));
  assert.ok(smart.includes("deepseek-r1"));
  assert.ok(smart.length >= 3);

  // Fast tier harus memuat model non-thinking berlatensi cepat
  assert.ok(fast.includes("gpt-4o-mini"));
  assert.ok(fast.includes("llama-3-1-8b"));
  assert.ok(fast.length >= 3);
});

test("deriveTierLists - fallback aman menambahkan model dari pool aktif jika tier < 3", () => {
  // Kasus 1: Hanya ada 1 model smart dan 4 model fast
  const mostlyFastPool = [
    "claude-3-7-sonnet", // Smart
    "gpt-4o-mini", // Fast (skor 56)
    "llama-3-1-8b", // Fast (skor 48)
    "gpt-3-5-turbo", // Fast (skor 36)
    "codegeex-4", // Fast (skor 58)
  ];

  const res1 = deriveTierLists(mostlyFastPool);
  // Smart awalnya hanya 1, fallback harus melengkapi hingga minimal 3
  assert.equal(res1.smart.length >= 3, true);
  assert.equal(res1.smart[0], "claude-3-7-sonnet");
  // Model teratas pool aktif masuk sebagai fallback cadangan
  assert.equal(res1.smart.includes("gpt-4o-mini"), true);
  assert.equal(res1.smart.includes("llama-3-1-8b"), true);

  // Kasus 2: Hanya ada model smart (tidak ada fast murni)
  const allSmartPool = [
    "claude-3-7-sonnet", // Smart
    "gemini-3.1-pro", // Smart
    "deepseek-r1", // Smart
    "qwen-2.5-coder-32b", // Smart
  ];

  const res2 = deriveTierLists(allSmartPool);
  // Fast awalnya 0, fallback harus melengkapi hingga minimal 3 dari pool aktif
  assert.equal(res2.fast.length >= 3, true);
  assert.deepEqual(res2.fast.slice(0, 3), [
    "claude-3-7-sonnet",
    "gemini-3.1-pro",
    "deepseek-r1",
  ]);
});

test("assembleManagedCombos - merakit zenith-free, zenith-smart, zenith-fast, zenith-cooldown, dan zenith-vision", () => {
  const candidates = [
    { id: "ag/claude-3-7-sonnet", owned_by: "llm7", contextLength: 1000000, capabilities: { vision: true, tools: true } },
    { id: "ag/gemini-3.1-pro", owned_by: "llm7", contextLength: 1048576, capabilities: { vision: true, tools: true } },
    { id: "fb/gpt-4o-mini", owned_by: "llm7", contextLength: 128000, capabilities: { vision: true, tools: true } },
    { id: "fb/llama-3-1-8b", owned_by: "llm7", contextLength: 128000, capabilities: { vision: false, tools: true } },
    { id: "ag/qwen-2.5-coder-32b", owned_by: "llm7", contextLength: 1000000, capabilities: { vision: false, tools: true } },
    // Model context kecil (tidak lolos agentic gate)
    { id: "provider/old-small-model", owned_by: "llm7", contextLength: 32000 },
    // Model tanpa tools (tidak lolos agentic gate)
    { id: "provider/raw-text-model", owned_by: "llm7", contextLength: 200000, toolsUnsupported: true },
    // Model terkena kuota / rate limit
    { id: "ag/claude-3-5-sonnet", owned_by: "llm7", contextLength: 200000, capabilities: { tools: true } },
  ];

  const latencyMap = {
    "ag/claude-3-7-sonnet": 1200,
    "ag/gemini-3.1-pro": 800,
    "fb/gpt-4o-mini": 300,
    "fb/llama-3-1-8b": 400,
    "ag/qwen-2.5-coder-32b": 900,
    // Cooldown via sentinel latency
    "ag/claude-3-5-sonnet": QUOTA_LATENCY_SENTINEL,
  };

  const result = assembleManagedCombos({
    candidates,
    latencyMap,
  });

  // 1. zenith-cooldown harus memuat model yang terkena sentinel quota
  assert.ok(result["zenith-cooldown"].includes("ag/claude-3-5-sonnet"));
  assert.equal(result["zenith-free"].includes("ag/claude-3-5-sonnet"), false);

  // 2. Model non-agentic (context kecil atau no-tools) tidak boleh ada di combo aktif
  assert.equal(result["zenith-free"].includes("provider/old-small-model"), false);
  assert.equal(result["zenith-free"].includes("provider/raw-text-model"), false);
  assert.equal(result["zenith-smart"].includes("provider/old-small-model"), false);
  assert.equal(result["zenith-fast"].includes("provider/old-small-model"), false);

  // 3. zenith-free memuat seluruh model aktif yang lolos gate
  assert.ok(result["zenith-free"].includes("ag/claude-3-7-sonnet"));
  assert.ok(result["zenith-free"].includes("ag/gemini-3.1-pro"));
  assert.ok(result["zenith-free"].includes("fb/gpt-4o-mini"));
  assert.ok(result["zenith-free"].includes("fb/llama-3-1-8b"));

  // 4. zenith-smart memuat model kualitas koding tinggi
  assert.ok(result["zenith-smart"].includes("ag/claude-3-7-sonnet"));
  assert.ok(result["zenith-smart"].includes("ag/gemini-3.1-pro"));

  // 5. zenith-fast memuat model non-thinking berlatensi cepat
  assert.ok(result["zenith-fast"].includes("fb/gpt-4o-mini"));
  assert.ok(result["zenith-fast"].includes("fb/llama-3-1-8b"));

  // 6. zenith-vision hanya memuat model dengan capabilities.vision = true
  assert.ok(result["zenith-vision"].includes("ag/claude-3-7-sonnet"));
  assert.ok(result["zenith-vision"].includes("ag/gemini-3.1-pro"));
  assert.ok(result["zenith-vision"].includes("fb/gpt-4o-mini"));
  assert.equal(result["zenith-vision"].includes("fb/llama-3-1-8b"), false);
  assert.equal(result["zenith-vision"].includes("ag/qwen-2.5-coder-32b"), false);
});

test("assembleManagedCombos - zenith-vision menerima sinyal vision dari metaMap dan supportsImages", () => {
  const candidates = [
    { id: "m/vision-via-metaMap", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
    { id: "m/vision-via-supportsImages", owned_by: "llm7", contextLength: 128000, tools: true, supportsImages: true },
    { id: "m/text-only", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
  ];

  const result = assembleManagedCombos({
    candidates,
    metaMap: new Map([
      ["m/vision-via-metaMap", { id: "m/vision-via-metaMap", capabilities: { tools: true, vision: true } }],
    ]),
  });

  assert.ok(result["zenith-vision"].includes("m/vision-via-metaMap"));
  assert.ok(result["zenith-vision"].includes("m/vision-via-supportsImages"));
  assert.equal(result["zenith-vision"].includes("m/text-only"), false);
});

test("assembleManagedCombos - mendeteksi cooldown dari signals 429 atau quotaModels", () => {
  const candidates = [
    { id: "model-active-1", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
    { id: "model-active-2", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
    { id: "model-quota-1", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
    { id: "model-quota-2", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
  ];

  const result = assembleManagedCombos({
    candidates,
    signals: {
      quotaModels: ["model-quota-1"],
      statusMap: {
        "model-quota-2": 429,
      },
    },
  });

  assert.deepEqual(result["zenith-cooldown"].sort(), ["model-quota-1", "model-quota-2"].sort());
  assert.ok(result["zenith-free"].includes("model-active-1"));
  assert.ok(result["zenith-free"].includes("model-active-2"));
  assert.equal(result["zenith-free"].includes("model-quota-1"), false);
  assert.equal(result["zenith-free"].includes("model-quota-2"), false);
});

test("saveCombo dan syncManagedCombos - menyimpan dan memperbarui 5 combo ke SQLite", async () => {
  const candidates = [
    { id: "test-smart-1", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "test-smart-2", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "test-fast-1", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
    { id: "test-fast-2", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true } },
    { id: "test-vision-1", owned_by: "llm7", contextLength: 128000, capabilities: { vision: true, tools: true } },
    { id: "test-cooldown-1", owned_by: "llm7", contextLength: 128000, capabilities: { tools: true }, status: "quota" },
  ];

  const syncResult = await syncManagedCombos({ candidates });
  assert.equal(syncResult.ok, true);

  // Verifikasi ke tabel combos SQLite via getComboByName
  const freeCombo = getComboByName("zenith-free");
  assert.ok(freeCombo);
  assert.equal(freeCombo.enabled, 1);
  assert.ok(Array.isArray(freeCombo.models));
  assert.ok(freeCombo.models.includes("test-smart-1"));
  assert.ok(freeCombo.models.includes("test-fast-1"));
  assert.equal(freeCombo.models.includes("test-cooldown-1"), false);

  const smartCombo = getComboByName("zenith-smart");
  assert.ok(smartCombo);
  assert.equal(smartCombo.enabled, 1);
  assert.ok(smartCombo.models.includes("test-smart-1"));
  assert.ok(smartCombo.models.includes("test-smart-2"));

  const fastCombo = getComboByName("zenith-fast");
  assert.ok(fastCombo);
  assert.equal(fastCombo.enabled, 1);
  assert.ok(fastCombo.models.includes("test-fast-1"));
  assert.ok(fastCombo.models.includes("test-fast-2"));

  const cooldownCombo = getComboByName("zenith-cooldown");
  assert.ok(cooldownCombo);
  assert.equal(cooldownCombo.enabled, 1);
  assert.ok(cooldownCombo.models.includes("test-cooldown-1"));

  const visionCombo = getComboByName("zenith-vision");
  assert.ok(visionCombo);
  assert.equal(visionCombo.enabled, 1);
  assert.ok(visionCombo.models.includes("test-vision-1"));
  assert.equal(visionCombo.models.includes("test-fast-1"), false);

  // Verifikasi direct upsert via saveCombo
  saveCombo("zenith-free", ["updated-model-1", "updated-model-2"]);
  const updatedFree = getComboByName("zenith-free");
  assert.deepEqual(updatedFree.models, ["updated-model-1", "updated-model-2"]);
});

test("isFreeModel - hanya model dari provider gratis atau berakhiran :free yang dianggap gratis", () => {
  // Provider gratis keyless (noAuth / category free) lewat owned_by atau prefix ID
  assert.equal(isFreeModel({ id: "kcf/ling-3.1", owned_by: "kilo-free" }), true);
  assert.equal(isFreeModel("llm7/default"), true);
  // Model berbayar / berbasis akun tidak boleh lolos
  assert.equal(isFreeModel({ id: "claude-3-7-sonnet", owned_by: "claude" }), false);
  assert.equal(isFreeModel("openrouter/gpt-4o"), false);
  // Suffix :free menandai model gratis walaupun owner tidak dikenal
  assert.equal(isFreeModel({ id: "vendor/some-model:free" }), true);
  // Input kosong / owner tidak dikenal ditolak
  assert.equal(isFreeModel(null), false);
  assert.equal(isFreeModel({ id: "unknown-provider/model-x" }), false);
});

test("assembleManagedCombos - super-combo hanya memuat model gratis", () => {
  const candidates = [
    { id: "kcf/ling-3.1", owned_by: "kilo-free", contextLength: 128000, capabilities: { tools: true } },
    { id: "claude-3-7-sonnet", owned_by: "claude", contextLength: 200000, capabilities: { tools: true } },
  ];
  const result = assembleManagedCombos({ candidates });
  for (const name of ["zenith-free", "zenith-smart", "zenith-fast", "zenith-cooldown"]) {
    assert.equal(result[name].includes("claude-3-7-sonnet"), false, `${name} tidak boleh memuat model berbayar`);
  }
  assert.ok(result["zenith-free"].includes("kcf/ling-3.1"));
});

test("passesAgenticGate - fail-closed saat bukti tools tidak ada (mencegah lolos dari context besar saja)", () => {
  // Mencegah regresi: model context besar tanpa bukti tools tidak boleh masuk tier agentic.
  assert.equal(passesAgenticGate({ id: "no-flag", contextLength: 1000000 }), false);
  // Sinyal eksplisit tools: false selalu menolak, meski flag positif lain ada.
  assert.equal(passesAgenticGate({ id: "explicit-no", contextLength: 1000000, tools: true, supportsTools: false }), false);
});

test("syncManagedCombos - probe mendegradasi model smart yang gagal ke urutan bawah", async () => {
  const candidates = [
    { id: "probe-ok-1", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "probe-dead-1", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "probe-ok-2", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "probe-ok-3", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
  ];
  // Mock upstream: model "probe-dead-1" menjawab 404 (dead), sisanya 200.
  const fetch = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === "probe-dead-1") {
      return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
    }
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };

  const result = await syncManagedCombos({
    candidates,
    probe: true,
    probeOptions: { testOptions: { fetch } },
  });

  const smart = result.assembled["zenith-smart"];
  assert.ok(smart.includes("probe-dead-1"), "model dead tetap ada di tier, hanya diturunkan");
  // Di dalam top-N, model dead harus berada setelah model sehat.
  assert.ok(smart.indexOf("probe-dead-1") > smart.indexOf("probe-ok-1"));
  assert.ok(smart.indexOf("probe-dead-1") > smart.indexOf("probe-ok-2"));
});

test("combo terkelola terisi dari katalog nyata: klaim tools per provider lolos gate", async () => {
  const { getAvailableModels } = await import("../src/providers/index.js");
  const { initDb } = await import("../src/db/index.js");
  initDb(":memory:");
  const candidates = getAvailableModels({ all: true });

  // Regresi: gate agentic fail-closed pernah mengosongkan semua combo karena
  // tidak ada satu pun sumber data yang menerbitkan sinyal tools.
  assert.ok(candidates.length > 0, "katalog punya model");

  const out = assembleManagedCombos({ candidates });
  assert.ok(out["zenith-free"].length > 0, "zenith-free tidak boleh kosong");
  assert.ok(out["zenith-smart"].length > 0, "zenith-smart tidak boleh kosong");

  // Semua model yang lolos harus dari provider yang mengklaim tools, dan
  // model dari provider tanpa klaim tidak ikut terpilih diam-diam.
  const { getProvider } = await import("../src/providers/index.js");
  for (const id of out["zenith-free"]) {
    const owned = candidates.find((c) => c.id === id)?.owned_by;
    assert.equal(getProvider(owned)?.supportsTools, true, `${id} harus dari provider berklaim tools`);
  }
});

test("probeSmartTier - mempertahankan urutan ranking kualitas meski model peringkat bawah merespons lebih cepat", async () => {
  const candidates = [
    { id: "probe-a", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "probe-b", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
    { id: "probe-c", owned_by: "llm7", contextLength: 200000, capabilities: { reasoning: true, tools: true } },
  ];

  // Model peringkat pertama (probe-a) sengaja merespons lebih lambat (60ms) daripada model peringkat kedua/ketiga (5ms)
  const fetch = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === "probe-a") {
      await new Promise((r) => setTimeout(r, 60));
    } else {
      await new Promise((r) => setTimeout(r, 5));
    }
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };

  const result = await syncManagedCombos({
    candidates,
    probe: true,
    probeOptions: { testOptions: { fetch } },
  });

  const smart = result.assembled["zenith-smart"];
  const idxA = smart.indexOf("probe-a");
  const idxB = smart.indexOf("probe-b");
  const idxC = smart.indexOf("probe-c");

  assert.ok(idxA < idxB, "model ranking 1 (probe-a) harus tetap sebelum ranking 2 (probe-b) meski probe lebih lambat");
  assert.ok(idxB < idxC, "model ranking 2 (probe-b) harus tetap sebelum ranking 3 (probe-c)");
});
