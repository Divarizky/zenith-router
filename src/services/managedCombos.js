import { getAvailableModels, getProvider } from "../providers/index.js";
import { resolveCapabilities } from "../providers/capabilities.js";
import {
  calculateCodingScore,
  isSmartTierModel,
  isThinkingVariant,
  sortModelsByCodingQuality,
} from "./modelBenchmarks.js";
import { resolveLiveScores } from "./benchmarkSync.js";
import { isParkedLatency, QUOTA_LATENCY_SENTINEL, testModelHealth } from "./modelHealth.js";
import { saveCombo } from "./combos.js";
import { getDb, getConnections } from "../db/index.js";
import { listSyncedModels } from "./modelOverrides.js";

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

function resolveCandidateProvider(modelMeta) {
  const id = toId(modelMeta);
  const ownerRaw =
    (typeof modelMeta === "object" && modelMeta !== null && modelMeta.owned_by) ||
    (typeof id === "string" && id.includes("/") ? id.slice(0, id.indexOf("/")) : "");
  const provider = ownerRaw ? getProvider(String(ownerRaw)) : null;
  return { id, ownerRaw, provider };
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

/**
 * Normalisasi metadata model secara terpusat untuk agentic gate, capabilities vision/reasoning,
 * dan context window dengan urutan fallback konsisten.
 */
export function normalizeCandidateMeta(id, candidate, metaMap = null) {
  const modelId = id || toId(candidate);
  const meta = getModelMeta(modelId, candidate, metaMap);

  let toolsRejected = false;
  let toolsVerified = false;
  if (typeof meta === "object" && meta !== null) {
    if (
      meta.toolsUnsupported === true ||
      meta.supportsTools === false ||
      meta.tools === false ||
      meta.capabilities?.tools === false ||
      meta.capabilities?.toolsUnsupported === true
    ) {
      toolsRejected = true;
    } else if (
      meta.supportsTools === true ||
      meta.tools === true ||
      meta.capabilities?.tools === true
    ) {
      toolsVerified = true;
    }
  }

  let ctx = null;
  if (typeof meta === "object" && meta !== null) {
    ctx =
      meta.contextLength ??
      meta.context_length ??
      meta.contextWindow ??
      meta.context_window ??
      meta.context ??
      meta.capabilities?.contextWindow;
  }
  if ((ctx === null || ctx === undefined) && modelId) {
    const caps = resolveCapabilities(modelId);
    if (caps && Number.isFinite(caps.contextWindow)) {
      ctx = caps.contextWindow;
    }
  }
  if ((ctx === null || ctx === undefined) && typeof meta === "object" && meta !== null) {
    ctx = meta.max_tokens;
  }

  const contextWindow =
    ctx !== null && ctx !== undefined && Number.isFinite(Number(ctx)) ? Number(ctx) : null;

  const vision = Boolean(
    meta &&
      typeof meta === "object" &&
      (meta.capabilities?.vision === true ||
        meta.supportsImages === true ||
        meta.supports_images === true ||
        meta.vision === true ||
        meta.multimodal === true)
  );

  const reasoning = Boolean(
    meta &&
      typeof meta === "object" &&
      (meta.capabilities?.reasoning === true ||
        meta.supports_thinking === 1 ||
        meta.supports_thinking === true ||
        meta.reasoning === true)
  );

  return {
    ...meta,
    id: modelId,
    toolsRejected,
    toolsVerified,
    contextWindow,
    vision,
    reasoning,
  };
}

/**
 * Menentukan apakah kandidat model termasuk model gratis.
 * Model dianggap gratis bila:
 * 1. ID-nya berakhiran `:free`, atau
 * 2. Provider pemiliknya (`owned_by`, atau prefix sebelum `/` pada ID) berkategori `free` atau `noAuth: true`.
 */
export function isFreeModel(modelMeta) {
  const { id, provider } = resolveCandidateProvider(modelMeta);
  if (!id) return false;
  if (id.toLowerCase().endsWith(":free")) return true;
  if (!provider) return false;
  return provider.category === "free" || provider.noAuth === true;
}

/**
 * Provider yang berkategori "free" tetapi tidak dimasukkan ke combo terkelola.
 * `kiro` (alias `kr`) menyajikan model Claude/GPT berbayar, bukan model gratis sejati.
 */
export const MANAGED_COMBO_EXCLUDED_PROVIDERS = Object.freeze(["kiro"]);

export function isExcludedFromManagedCombos(modelMeta) {
  const { id, provider } = resolveCandidateProvider(modelMeta);
  if (!id) return false;
  return Boolean(provider && MANAGED_COMBO_EXCLUDED_PROVIDERS.includes(provider.id));
}

/**
 * Memfilter apakah model memenuhi kriteria agentic gate:
 * 1. Memiliki dukungan tool calling terverifikasi (fail-closed: tanpa bukti
 *    dukungan tools, model ditolak dari tier agentic).
 * 2. Memiliki context length minimal 100.000 token (`AGENTIC_MIN_CONTEXT`).
 */
export function passesAgenticGate(modelMeta) {
  if (!modelMeta) return false;

  const norm =
    typeof modelMeta === "object" &&
    modelMeta !== null &&
    modelMeta.toolsRejected !== undefined &&
    modelMeta.toolsVerified !== undefined
      ? modelMeta
      : normalizeCandidateMeta(toId(modelMeta), modelMeta);

  if (norm.toolsRejected || !norm.toolsVerified) return false;

  if (norm.contextWindow !== null && norm.contextWindow !== undefined) {
    if (norm.contextWindow < AGENTIC_MIN_CONTEXT) {
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
export function deriveTierLists(rankedActiveModels, benchmarks = null, metaMap = null, liveScores = null) {
  if (!Array.isArray(rankedActiveModels)) {
    return { smart: [], fast: [] };
  }

  const smart = [];
  const fast = [];

  for (const m of rankedActiveModels) {
    const id = toId(m);
    if (!id) continue;

    const norm = normalizeCandidateMeta(id, m, metaMap);
    const isReasoning =
      norm.reasoning ||
      isThinkingVariant(id) ||
      isSmartTierModel(id, benchmarks, liveScores);

    if (isReasoning) {
      smart.push(id);
    } else {
      fast.push(id);
    }
  }

  const rankedIds = rankedActiveModels.map(toId).filter(Boolean);

  // Fallback aman: minimal 3 model per tier dari urutan pool aktif teratas
  if (smart.length < 3) {
    const smartSet = new Set(smart);
    for (const id of rankedIds) {
      if (!smartSet.has(id)) {
        smart.push(id);
        smartSet.add(id);
        if (smart.length >= 3) break;
      }
    }
  }

  if (fast.length < 3) {
    const fastSet = new Set(fast);
    for (const id of rankedIds) {
      if (!fastSet.has(id)) {
        fast.push(id);
        fastSet.add(id);
        if (fast.length >= 3) break;
      }
    }
  }

  return { smart, fast };
}

/**
 * Mendeteksi model yang menerima input gambar (vision). Sumber sinyal bisa
 * capabilities dari registry/DB, field supportsImages, atau flag vision eksplisit.
 */
function isVisionCapable(meta) {
  if (!meta) return false;
  if (typeof meta === "object" && meta.vision !== undefined) {
    return Boolean(meta.vision);
  }
  return Boolean(normalizeCandidateMeta(toId(meta), meta).vision);
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

const FAST_ARCH_REGEX = /(?:flash|mini|nano|lite|instant|small|haiku)/i;
const SMALL_PARAM_REGEX = /(?:^|[^\w])([1-9]|1[0-4])b(?:[^\w]|$)/i;

/**
 * Mengurutkan model fast tier (zenith-fast) dengan memprioritaskan latensi rendah,
 * rasio kegagalan minimal, dan arsitektur respons instan (flash/mini/nano).
 *
 * @param {string[]} fastIds - Daftar ID model fast tier
 * @param {object} [options]
 * @param {object|Map} [options.latencyMap]
 * @param {object|Map} [options.failureRateMap]
 * @param {Array|object} [options.benchmarks]
 * @param {object} [options.liveScores]
 * @returns {string[]}
 */
export function sortFastTierModels(
  fastIds,
  { latencyMap = {}, failureRateMap = {}, benchmarks = null, liveScores = null } = {}
) {
  if (!Array.isArray(fastIds) || fastIds.length <= 1) {
    return [...(fastIds || [])];
  }

  const items = fastIds.map((id, idx) => {
    const latRaw = latencyMap instanceof Map ? latencyMap.get(id) : latencyMap?.[id];
    const lat = typeof latRaw === "number" && Number.isFinite(latRaw) && latRaw > 0 ? latRaw : 0;

    const failRaw = failureRateMap instanceof Map ? failureRateMap.get(id) : failureRateMap?.[id];
    let failRate = 0;
    if (typeof failRaw === "number" && Number.isFinite(failRaw) && failRaw > 0) {
      failRate = failRaw > 1 ? failRaw / 100 : failRaw;
    }

    const hasFastArch = FAST_ARCH_REGEX.test(id);
    return { id, idx, lat, failRate, hasFastArch };
  });

  const hasLatencySignal = items.some((item) => item.lat > 0);
  const hasFailureSignal = items.some((item) => item.failRate > 0);
  const fastArchCount = items.filter((item) => item.hasFastArch).length;
  const hasArchSignal = fastArchCount > 0 && fastArchCount < items.length;

  if (!hasLatencySignal && !hasFailureSignal && !hasArchSignal) {
    return [...fastIds];
  }

  const scored = items.map((item) => {
    const baseCodingScore = calculateCodingScore(item.id, {
      latencyMs: 0,
      failureRate: 0,
      benchmarks,
      liveScores,
    });

    let fastScore = baseCodingScore;
    if (item.hasFastArch) {
      fastScore += 8;
    }
    if (SMALL_PARAM_REGEX.test(item.id)) {
      fastScore += 4;
    }
    if (item.lat > 0) {
      fastScore -= item.lat * 0.015;
      if (item.lat <= 500) {
        fastScore += 5;
      }
    }
    fastScore -= item.failRate * 60;

    return { ...item, fastScore };
  });

  scored.sort((a, b) => {
    if (b.fastScore !== a.fastScore) {
      return b.fastScore - a.fastScore;
    }
    return a.idx - b.idx;
  });

  return scored.map((item) => item.id);
}

/**
 * Menyusun 5 set combo terkelola dari kandidat model, status latensi, dan sinyal kesehatan:
 * 1. zenith-free: Seluruh model gratis aktif lolos agentic gate, terurut kualitas koding.
 * 2. zenith-smart: Model tier atas (coding score >= 68 / thinking) untuk tugas arsitektur.
 * 3. zenith-fast: Model instan non-thinking untuk autocomplete dan edit cepat.
 * 4. zenith-cooldown: Model yang terkena kuota / rate limit (429 / sentinel 999998).
 * 5. zenith-vision: Model gratis aktif yang mendukung input gambar (vision) terurut kualitas koding.
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
    const { id, provider } = resolveCandidateProvider(c);
    if (!id) continue;
    const isFree =
      id.toLowerCase().endsWith(":free") ||
      Boolean(provider && (provider.category === "free" || provider.noAuth === true));
    if (!isFree) continue;
    if (provider && MANAGED_COMBO_EXCLUDED_PROVIDERS.includes(provider.id)) continue;

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
    const meta = normalizeCandidateMeta(id, c, metaMap);
    if (passesAgenticGate(meta)) {
      passedAgentic.push(c);
    }
  }

  // Urutkan berdasarkan kualitas koding empiris & heuristik terpadu
  const sortOpts = {
    latencyMap,
    failureRateMap: signals?.failureRateMap,
    benchmarks: signals?.benchmarks,
    liveScores: signals?.liveScores,
  };
  const sortedActive = sortModelsByCodingQuality(passedAgentic, sortOpts);
  const zenithFree = [...new Set(sortedActive.map(toId).filter(Boolean))];

  // Combo vision: subset model gratis yang menerima input gambar, urut kualitas koding.
  // Tidak ada fallback non-vision: model tanpa kemampuan gambar merusak combo ini.
  const zenithVision = [
    ...new Set(
      sortedActive
        .filter((m) => {
          const id = toId(m);
          return isVisionCapable(normalizeCandidateMeta(id, m, metaMap));
        })
        .map(toId)
        .filter(Boolean),
    ),
  ];

  // Pisahkan ke tier smart dan fast
  const { smart: zenithSmart, fast: rawFast } = deriveTierLists(
    sortedActive,
    signals?.benchmarks,
    metaMap,
    signals?.liveScores,
  );

  const zenithFast = sortFastTierModels(rawFast, {
    latencyMap,
    failureRateMap: signals?.failureRateMap,
    benchmarks: signals?.benchmarks,
    liveScores: signals?.liveScores,
  });

  // Urutkan juga model cooldown
  const sortedCooldown = sortModelsByCodingQuality(cooldownCandidates, {
    latencyMap,
    failureRateMap: signals?.failureRateMap,
    benchmarks: signals?.benchmarks,
    liveScores: signals?.liveScores,
  });
  const zenithCooldown = [...new Set(sortedCooldown.map(toId).filter(Boolean))];

  return {
    "zenith-free": zenithFree,
    "zenith-smart": zenithSmart,
    "zenith-fast": zenithFast,
    "zenith-cooldown": zenithCooldown,
    "zenith-vision": zenithVision,
    zenithFree,
    zenithSmart,
    zenithFast,
    zenithCooldown,
    zenithVision,
  };
}

/**
 * Mengambil kandidat model dari database/katalog, mengevaluasi agentic gate & benchmark,
 * lalu menyimpan atau memperbarui combo zenith-free, zenith-smart, zenith-fast,
 * zenith-cooldown, dan zenith-vision.
 *
 * `options.probe` (default true ketika kandidat diambil otomatis) menjalankan
 * live health probe pada kandidat teratas tier smart: model yang gagal merespons
 * atau terkena latency sentinel di-degradasi ke urutan bawah, bukan dibiarkan
 * menempati posisi teratas zenith-smart.
 */
export async function syncManagedCombos(options = {}) {
  let candidates = options.candidates;
  let autoCandidates = false;

  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    try {
      candidates = getAvailableModels({ all: true });
      autoCandidates = true;
    } catch {
      candidates = [];
    }
  }

  if (autoCandidates && candidates.length > 0) {
    let activeProviders = new Set();
    try {
      for (const conn of getConnections()) {
        if (conn && (conn.is_active === 1 || conn.is_active === true)) {
          const p = getProvider(conn.provider);
          if (p) {
            activeProviders.add(p.id);
            const aliases = Array.isArray(p.alias) ? p.alias : [p.alias || p.id];
            for (const a of aliases) activeProviders.add(String(a).toLowerCase());
          } else if (conn.provider) {
            activeProviders.add(String(conn.provider).toLowerCase());
          }
        }
      }
    } catch {
      activeProviders = new Set();
    }

    let syncedProviders = new Set();
    try {
      const synced = listSyncedModels();
      for (const s of synced) {
        if (s?.provider) {
          syncedProviders.add(s.provider);
          const p = getProvider(s.provider);
          if (p) {
            syncedProviders.add(p.id);
            const aliases = Array.isArray(p.alias) ? p.alias : [p.alias || p.id];
            for (const a of aliases) syncedProviders.add(String(a).toLowerCase());
          } else {
            syncedProviders.add(String(s.provider).toLowerCase());
          }
        }
      }
    } catch {
      syncedProviders = new Set();
    }

    candidates = candidates.filter((c) => {
      const { ownerRaw, provider } = resolveCandidateProvider(c);
      if (!provider) return true;

      const isAccountProvider = !provider.noAuth && provider.category !== "free";
      if (!isAccountProvider) return true;

      const hasActiveConn =
        activeProviders.has(provider.id) ||
        activeProviders.has(String(ownerRaw).toLowerCase());
      const isImported = Boolean(c && typeof c === "object" && c.imported === true);
      const hasSynced =
        syncedProviders.has(provider.id) ||
        syncedProviders.has(String(ownerRaw).toLowerCase());

      return hasActiveConn || isImported || hasSynced;
    });
  }

  let signals = options.signals;
  if (!signals?.liveScores) {
    try {
      const ids = candidates.map(toId).filter(Boolean);
      const liveScores = resolveLiveScores(ids);
      signals = { ...(signals || {}), liveScores };
    } catch {
      // Benchmark live bersifat tambahan: gagal membaca snapshot tidak boleh menggagalkan sync combo.
    }
  }

  const assembled = assembleManagedCombos({
    candidates,
    latencyMap: options.latencyMap,
    metaMap: options.metaMap,
    signals,
  });

  // Live health probe: uji kandidat teratas smart tier sebelum combo disimpan.
  // Probe hanya berjalan untuk sync otomatis (scheduler/scheduler startup) atau
  // saat pemanggil memintanya eksplisit, agar unit test dan pemanggilan manual
  // tidak menembak upstream.
  let probed = assembled;
  const shouldProbe = options.probe ?? autoCandidates;
  if (shouldProbe) {
    probed = await probeSmartTier(assembled, options.probeOptions || {});
  }

  const db = getDb();
  let inTransaction = false;
  try {
    db.exec("BEGIN");
    inTransaction = true;

    const comboOptions = { strategy: options.strategy, enabled: options.enabled };
    const savedFree = saveCombo("zenith-free", probed["zenith-free"], comboOptions);
    const savedSmart = saveCombo("zenith-smart", probed["zenith-smart"], comboOptions);
    const savedFast = saveCombo("zenith-fast", probed["zenith-fast"], comboOptions);
    const savedCooldown = saveCombo("zenith-cooldown", probed["zenith-cooldown"], comboOptions);
    const savedVision = saveCombo("zenith-vision", probed["zenith-vision"], comboOptions);

    db.exec("COMMIT");
    inTransaction = false;

    return {
      ok: true,
      combos: {
        "zenith-free": savedFree,
        "zenith-smart": savedSmart,
        "zenith-fast": savedFast,
        "zenith-cooldown": savedCooldown,
        "zenith-vision": savedVision,
      },
      assembled: probed,
    };
  } catch (err) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback gagal jika koneksi/transaksi sudah terputus
      }
    }
    throw err;
  }
}

/**
 * Live health probe untuk kandidat teratas zenith-smart.
 *
 * Model teratas (maks `PROBE_TOP_N`) ditembak dengan prompt mini via
 * `testModelHealth`. Model yang gagal (dead) atau terparkir sentinel (quota)
 * dipindahkan ke urutan paling bawah tier smart, sehingga request klien
 * tidak langsung membentur model yang sedang tidak sehat. Kegagalan probe
 * itu sendiri (router belum siap, misalnya) bersifat non-fatal: urutan
 * awal dipertahankan.
 */
const PROBE_TOP_N = 3;
const PROBE_TIMEOUT_MS = 8000;

async function probeSmartTier(assembled, options = {}) {
  const smart = [...(assembled["zenith-smart"] || assembled.zenithSmart || [])];
  if (smart.length === 0) return assembled;

  const topN = smart.slice(0, PROBE_TOP_N);
  const rest = smart.slice(PROBE_TOP_N);

  const probeResults = await Promise.all(
    topN.map(async (id) => {
      try {
        const result = await testModelHealth(id, {
          timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
          ...(options.testOptions || {}),
        });
        const isTransportError =
          result.transportError === true ||
          (result.httpStatus === null &&
            /connection refused|econnrefused|fetch failed/i.test(result.error || ""));
        const isHealthy = isTransportError ? true : Boolean(result.ok || result.status === "active");
        const isQuota = result.status === "quota" || result.httpStatus === 429;
        return { id, isHealthy, isQuota, status: result.status, result };
      } catch {
        // Probe gagal total: jangan buang modelnya, pertahankan posisi.
        return { id, isHealthy: true, isQuota: false, status: "active" };
      }
    })
  );

  const healthy = probeResults.filter((r) => r.isHealthy).map((r) => r.id);
  const degraded = probeResults.filter((r) => !r.isHealthy).map((r) => r.id);
  const degradedSet = new Set(degraded);

  const reorderedSmart = [...healthy, ...rest, ...degraded];

  const free = [...(assembled["zenith-free"] || assembled.zenithFree || [])];
  const freeHealthy = free.filter((id) => !degradedSet.has(id));
  const freeDegraded = free.filter((id) => degradedSet.has(id));
  const reorderedFree = [...freeHealthy, ...freeDegraded];

  const cooldown = [...(assembled["zenith-cooldown"] || assembled.zenithCooldown || [])];
  const quotaProbeIds = probeResults
    .filter((r) => r.isQuota || r.status === "quota")
    .map((r) => r.id);

  for (const id of quotaProbeIds) {
    if (!cooldown.includes(id)) {
      cooldown.push(id);
    }
  }

  return {
    ...assembled,
    "zenith-free": reorderedFree,
    zenithFree: reorderedFree,
    "zenith-smart": reorderedSmart,
    zenithSmart: reorderedSmart,
    "zenith-cooldown": cooldown,
    zenithCooldown: cooldown,
  };
}

export { saveCombo };
