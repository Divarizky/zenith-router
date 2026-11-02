import { getAvailableModels, getProvider, resolveModel } from "../providers/index.js";
import { resolveCapabilities } from "../providers/capabilities.js";
import {
  isSmartTierModel,
  isThinkingVariant,
  sortModelsByCodingQuality,
} from "./modelBenchmarks.js";
import { isParkedLatency, QUOTA_LATENCY_SENTINEL } from "./modelHealth.js";
import { saveCombo } from "./combos.js";

/**
 * Floor minimum panjang context token untuk model agentic koding.
 * Model dengan konteks di bawah 100k token dianggap tidak memadai untuk
 * workspace context / agent multi-file coding loop.
 */
export const AGENTIC_MIN_CONTEXT = 100000;

function toId(m) {
  if (typeof m === "string") return m;
  return m?.id || m?.model_id || m?.model || m?.name || "";
}

/**
 * Menentukan apakah kandidat model termasuk model gratis.
 * Model dianggap gratis bila:
 * 1. ID-nya berakhiran `:free`, atau
 * 2. Provider pemiliknya (`owned_by`, atau prefix sebelum `/` pada ID) berkategori `free` atau `noAuth: true`.
 */
export function isFreeModel(modelMeta) {
  const id = toId(modelMeta);
  if (!id) return false;
  if (id.toLowerCase().endsWith(":free")) return true;

  const ownerRaw =
    (typeof modelMeta === "object" && modelMeta !== null && modelMeta.owned_by) ||
    (id.includes("/") ? id.slice(0, id.indexOf("/")) : "");
  const provider = getProvider(String(ownerRaw));
  if (!provider) return false;
  return provider.category === "free" || provider.noAuth === true;
}

/**
 * Memfilter apakah model memenuhi kriteria agentic gate:
 * 1. Mendukung function / tool calling (`toolsUnsupported !== true`).
 * 2. Memiliki context length minimal 100.000 token (`AGENTIC_MIN_CONTEXT`).
 */
export function passesAgenticGate(modelMeta) {
  if (!modelMeta) return false;

  const id = toId(modelMeta);

  // 1. Evaluasi Tool Support
  if (typeof modelMeta === "object") {
    if (modelMeta.toolsUnsupported === true) return false;
    if (modelMeta.supportsTools === false) return false;
    if (modelMeta.tools === false) return false;
    if (modelMeta.capabilities?.tools === false || modelMeta.capabilities?.toolsUnsupported === true) {
      return false;
    }
  }

  // 2. Evaluasi Context Length
  let ctx = null;
  if (typeof modelMeta === "object") {
    ctx =
      modelMeta.contextLength ??
      modelMeta.context_length ??
      modelMeta.contextWindow ??
      modelMeta.context_window ??
      modelMeta.max_tokens ??
      modelMeta.context ??
      modelMeta.capabilities?.contextWindow;
  }

  // Jika context belum ditemukan di object atau modelMeta berupa string, cek pattern capabilities
  if ((ctx === null || ctx === undefined) && id) {
    const caps = resolveCapabilities(id);
    if (caps && Number.isFinite(caps.contextWindow)) {
      ctx = caps.contextWindow;
    }
  }

  if (ctx !== null && ctx !== undefined) {
    const num = Number(ctx);
    if (Number.isFinite(num) && num < AGENTIC_MIN_CONTEXT) {
      return false;
    }
  }

  return true;
}

/**
 * Membagi pool model aktif yang sudah diurutkan ke dalam dua tier:
 * - smart: Model dengan benchmark koding tinggi (skor >= 68) atau varian reasoning/thinking.
 * - fast: Model ringan non-thinking dengan respon instan.
 * - Fallback: Jika model per tier kurang dari 3, ambil model teratas dari pool aktif
 *   sebagai cadangan aman agar router tidak pernah kehabisan model.
 */
export function deriveTierLists(rankedActiveModels, benchmarks = null, metaMap = null) {
  if (!Array.isArray(rankedActiveModels)) {
    return { smart: [], fast: [] };
  }

  const smart = [];
  const fast = [];

  for (const m of rankedActiveModels) {
    const id = toId(m);
    if (!id) continue;

    let meta = typeof m === "object" && m !== null ? m : null;
    if (!meta && metaMap) {
      meta = metaMap instanceof Map ? metaMap.get(id) : metaMap[id];
    }

    const hasReasoningCap =
      meta?.capabilities?.reasoning === true ||
      meta?.supports_thinking === 1 ||
      meta?.supports_thinking === true ||
      meta?.reasoning === true;

    const isReasoning =
      hasReasoningCap ||
      isThinkingVariant(id) ||
      isSmartTierModel(id, benchmarks);

    if (isReasoning) {
      smart.push(id);
    } else {
      fast.push(id);
    }
  }

  const rankedIds = rankedActiveModels.map(toId).filter(Boolean);

  // Fallback aman: minimal 3 model per tier dari urutan pool aktif teratas
  if (smart.length < 3) {
    for (const id of rankedIds) {
      if (!smart.includes(id)) {
        smart.push(id);
        if (smart.length >= 3) break;
      }
    }
  }

  if (fast.length < 3) {
    for (const id of rankedIds) {
      if (!fast.includes(id)) {
        fast.push(id);
        if (fast.length >= 3) break;
      }
    }
  }

  return { smart, fast };
}

function getModelLatency(id, candidate, latencyMap) {
  if (latencyMap instanceof Map && latencyMap.has(id)) return latencyMap.get(id);
  if (latencyMap && latencyMap[id] !== undefined) return latencyMap[id];
  if (typeof candidate === "object" && candidate !== null) {
    if (typeof candidate.latencyMs === "number") return candidate.latencyMs;
    if (typeof candidate.latency === "number") return candidate.latency;
  }
  return 0;
}

function getModelMeta(id, candidate, metaMap) {
  let fromMap = null;
  if (metaMap instanceof Map && metaMap.has(id)) fromMap = metaMap.get(id);
  else if (metaMap && metaMap[id] !== undefined) fromMap = metaMap[id];

  if (typeof candidate === "object" && candidate !== null) {
    return { ...candidate, ...(fromMap || {}) };
  }
  return fromMap || { id };
}

function isModelInCooldown(id, candidate, latency, signals) {
  if (isParkedLatency(latency) || latency >= QUOTA_LATENCY_SENTINEL) return true;

  if (typeof candidate === "object" && candidate !== null) {
    if (
      candidate.isParked === true ||
      candidate.quota === true ||
      candidate.status === "quota" ||
      candidate.status === 429 ||
      candidate.statusCode === 429
    ) {
      return true;
    }
  }

  if (signals) {
    if (Array.isArray(signals.quotaModels) && signals.quotaModels.includes(id)) return true;
    if (Array.isArray(signals.cooldownModels) && signals.cooldownModels.includes(id)) return true;
    if (signals.statusMap) {
      const s = signals.statusMap instanceof Map ? signals.statusMap.get(id) : signals.statusMap[id];
      if (s === "quota" || s === 429 || s?.status === "quota" || s?.status === 429 || s?.isParked) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Menyusun 4 set combo terkelola dari kandidat model, status latensi, dan sinyal kesehatan:
 * 1. zenith-free: Seluruh model gratis aktif lolos agentic gate, terurut kualitas koding.
 * 2. zenith-smart: Model tier atas (coding score >= 68 / thinking) untuk tugas arsitektur.
 * 3. zenith-fast: Model instan non-thinking untuk autocomplete dan edit cepat.
 * 4. zenith-cooldown: Model yang terkena kuota / rate limit (429 / sentinel 999998).
 */
export function assembleManagedCombos({
  candidates = [],
  latencyMap = {},
  metaMap = {},
  signals = {},
} = {}) {
  const activeCandidates = [];
  const cooldownCandidates = [];

  // Seluruh super-combo hanya boleh berisi model gratis.
  for (const c of candidates) {
    const id = toId(c);
    if (!id || !isFreeModel(c)) continue;
    const latency = getModelLatency(id, c, latencyMap);
    if (isModelInCooldown(id, c, latency, signals)) {
      cooldownCandidates.push(c);
    } else {
      activeCandidates.push(c);
    }
  }

  // Filter agentic gate untuk kandidat aktif
  const passedAgentic = [];
  for (const c of activeCandidates) {
    const id = toId(c);
    const meta = getModelMeta(id, c, metaMap);
    if (passesAgenticGate(meta)) {
      passedAgentic.push(c);
    }
  }

  // Urutkan berdasarkan kualitas koding empiris
  const sortedActive = sortModelsByCodingQuality(passedAgentic, {
    latencyMap,
    failureRateMap: signals?.failureRateMap,
    benchmarks: signals?.benchmarks,
  });

  const zenithFree = [...new Set(sortedActive.map(toId).filter(Boolean))];

  // Pisahkan ke tier smart dan fast
  const { smart: zenithSmart, fast: zenithFast } = deriveTierLists(sortedActive, signals?.benchmarks, metaMap);

  // Urutkan juga model cooldown
  const sortedCooldown = sortModelsByCodingQuality(cooldownCandidates, {
    latencyMap,
    failureRateMap: signals?.failureRateMap,
    benchmarks: signals?.benchmarks,
  });
  const zenithCooldown = [...new Set(sortedCooldown.map(toId).filter(Boolean))];

  return {
    "zenith-free": zenithFree,
    "zenith-smart": zenithSmart,
    "zenith-fast": zenithFast,
    "zenith-cooldown": zenithCooldown,
    zenithFree,
    zenithSmart,
    zenithFast,
    zenithCooldown,
  };
}

/**
 * Mengambil kandidat model dari database/katalog, mengevaluasi agentic gate & benchmark,
 * lalu menyimpan atau memperbarui combo zenith-free, zenith-smart, zenith-fast, dan zenith-cooldown.
 */
export async function syncManagedCombos(options = {}) {
  let candidates = options.candidates;

  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    try {
      candidates = getAvailableModels({ all: true });
    } catch {
      candidates = [];
    }
  }

  const assembled = assembleManagedCombos({
    candidates,
    latencyMap: options.latencyMap,
    metaMap: options.metaMap,
    signals: options.signals,
  });

  const strategy = options.strategy || "fallback";

  const savedFree = saveCombo("zenith-free", assembled["zenith-free"], { strategy, enabled: 1 });
  const savedSmart = saveCombo("zenith-smart", assembled["zenith-smart"], { strategy, enabled: 1 });
  const savedFast = saveCombo("zenith-fast", assembled["zenith-fast"], { strategy, enabled: 1 });
  const savedCooldown = saveCombo("zenith-cooldown", assembled["zenith-cooldown"], { strategy, enabled: 1 });

  return {
    ok: true,
    combos: {
      "zenith-free": savedFree,
      "zenith-smart": savedSmart,
      "zenith-fast": savedFast,
      "zenith-cooldown": savedCooldown,
    },
    assembled,
  };
}

export { saveCombo };
