/**
 * Matriks Benchmark Kualitas Koding Empiris & Pemeringkatan Model.
 *
 * Mengadopsi data benchmark empiris (SWE-bench, LiveCodeBench, LMSYS coding Elo)
 * dari 9router-auto-free untuk menentukan kualitas coding model AI dan
 * menghitung skor terbobot dinamis berdasarkan latensi dan tingkat kegagalan.
 */

import { QUOTA_LATENCY_SENTINEL, isParkedLatency } from "./modelHealth.js";

/**
 * Baseline Database Benchmark Empiris.
 * Menyimpan metrik evaluasi coding: score (0-100), swe_bench, livecodebench, tier.
 */
export const BENCHMARKS_DATABASE = [
  {
    id: "claude-3-7-sonnet-thinking",
    name: "Claude 3.7 Sonnet (Thinking)",
    score: 92,
    swe_bench: 70.3,
    livecodebench: 65.4,
    tier: "S",
    patterns: ["*claude*3*7*sonnet*thinking*", "*claude*3*7*sonnet*reasoning*", "*claude*3.7*sonnet*thinking*"],
    aliases: ["claude-3-7-sonnet:thinking", "claude-3-7-sonnet-thinking", "claude-3.7-sonnet:thinking", "claude-3.7-sonnet-thinking"]
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    score: 90,
    swe_bench: 68.5,
    livecodebench: 63.2,
    tier: "S",
    patterns: ["*claude*sonnet*4*5*", "*claude*sonnet*4.5*", "*claude*4*5*sonnet*", "*claude*4.5*sonnet*"],
    aliases: ["claude-sonnet-4.5", "claude-sonnet-4-5", "claude-4.5-sonnet", "claude-4-5-sonnet"]
  },
  {
    id: "deepseek-r1",
    name: "DeepSeek-R1",
    score: 89,
    swe_bench: 49.2,
    livecodebench: 65.8,
    tier: "S",
    patterns: ["*deepseek*r1*", "*deepseek*reasoner*"],
    aliases: ["deepseek-r1", "deepseek-reasoner", "deepseek-r1:free"]
  },
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    score: 88,
    swe_bench: 62.3,
    livecodebench: 58.7,
    tier: "S",
    patterns: ["*claude*3*7*sonnet*", "*claude*3.7*sonnet*"],
    aliases: ["claude-3-7-sonnet", "claude-3.7-sonnet", "claude-3-7-sonnet-20250219"]
  },
  {
    id: "o3-mini",
    name: "OpenAI o3-mini",
    score: 88,
    swe_bench: 49.0,
    livecodebench: 64.2,
    tier: "S",
    patterns: ["*o3*mini*"],
    aliases: ["o3-mini", "openai/o3-mini"]
  },
  {
    id: "gemini-3-1-pro",
    name: "Gemini 3.1 Pro",
    score: 87,
    swe_bench: 60.5,
    livecodebench: 62.0,
    tier: "S",
    patterns: ["*gemini*3*1*pro*", "*gemini*3.1*pro*"],
    aliases: ["gemini-3.1-pro", "gemini-3-1-pro", "gemini-3.1-pro-preview"]
  },
  {
    id: "deepseek-v4",
    name: "DeepSeek-V4",
    score: 86,
    swe_bench: 58.0,
    livecodebench: 61.5,
    tier: "S",
    patterns: ["*deepseek*v4*"],
    aliases: ["deepseek-v4", "deepseek-v4-chat"]
  },
  {
    id: "o1",
    name: "OpenAI o1",
    score: 86,
    swe_bench: 48.9,
    livecodebench: 61.7,
    tier: "S",
    patterns: ["*o1", "*o1-preview*", "*o1-2024*"],
    aliases: ["o1", "openai/o1", "o1-preview"]
  },
  {
    id: "qwen-3-7-coder",
    name: "Qwen 3.7 Coder",
    score: 85,
    swe_bench: 57.2,
    livecodebench: 59.8,
    tier: "S",
    patterns: ["*qwen*3*7*coder*", "*qwen*3.7*coder*"],
    aliases: ["qwen-3.7-coder", "qwen-3-7-coder"]
  },
  {
    id: "glm-5",
    name: "GLM-5",
    score: 84,
    swe_bench: 55.4,
    livecodebench: 57.2,
    tier: "S",
    patterns: ["*glm*5*"],
    aliases: ["glm-5", "glm-5.3", "glm-5.2"]
  },
  {
    id: "gemini-2-5-pro",
    name: "Gemini 2.5 Pro",
    score: 83,
    swe_bench: 52.8,
    livecodebench: 55.0,
    tier: "S",
    patterns: ["*gemini*2*5*pro*", "*gemini*2.5*pro*"],
    aliases: ["gemini-2.5-pro", "gemini-2-5-pro"]
  },
  {
    id: "step-3-7",
    name: "Step 3.7",
    score: 83,
    swe_bench: 53.0,
    livecodebench: 54.5,
    tier: "S",
    patterns: ["*step*3*7*", "*step*3.7*"],
    aliases: ["step-3.7", "step-3-7"]
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    score: 82,
    swe_bench: 49.0,
    livecodebench: 53.7,
    tier: "S",
    patterns: ["*claude*3*5*sonnet*", "*claude*3.5*sonnet*"],
    aliases: ["claude-3-5-sonnet", "claude-3.5-sonnet", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620"]
  },
  {
    id: "gemini-3-7-flash",
    name: "Gemini 3.7 Flash",
    score: 81,
    swe_bench: 54.0,
    livecodebench: 56.5,
    tier: "S",
    patterns: ["*gemini*3*7*flash*", "*gemini*3.7*flash*"],
    aliases: ["gemini-3.7-flash", "gemini-3-7-flash"]
  },
  {
    id: "kimi-k2-7",
    name: "Kimi k2.7",
    score: 79,
    swe_bench: 45.0,
    livecodebench: 50.0,
    tier: "A+",
    patterns: ["*kimi*k2*7*", "*kimi*k2.7*"],
    aliases: ["kimi-k2.7", "kimi-k2-7", "kimi-k2.7-code"]
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek-V3",
    score: 78,
    swe_bench: 42.0,
    livecodebench: 48.9,
    tier: "A+",
    patterns: ["*deepseek*v3*", "*deepseek*chat*"],
    aliases: ["deepseek-v3", "deepseek-chat"]
  },
  {
    id: "grok-code",
    name: "Grok-Code",
    score: 77,
    swe_bench: 43.5,
    livecodebench: 49.0,
    tier: "A+",
    patterns: ["*grok*code*"],
    aliases: ["grok-code", "grok-code-preview"]
  },
  {
    id: "qwen-2-5-coder-32b",
    "name": "Qwen 2.5 Coder 32B",
    score: 76,
    swe_bench: 44.8,
    livecodebench: 51.2,
    tier: "A+",
    patterns: ["*qwen*2*5*coder*32b*", "*qwen*2.5*coder*32b*"],
    aliases: ["qwen-2.5-coder-32b", "qwen-2.5-coder-32b-instruct", "qwen-2-5-coder-32b"]
  },
  {
    id: "nemotron-ultra",
    name: "Nemotron Ultra",
    score: 75,
    swe_bench: 43.0,
    livecodebench: 47.5,
    tier: "A+",
    patterns: ["*nemotron*ultra*", "*nemotron*70b*ultra*", "*nemotron*"],
    aliases: ["nemotron-ultra", "llama-3.1-nemotron-70b-ultra"]
  },
  {
    id: "mimo-v2-6",
    name: "MiMo v2.6",
    score: 74,
    swe_bench: 41.5,
    livecodebench: 45.0,
    tier: "A+",
    patterns: ["*mimo*v2*6*", "*mimo*v2.6*"],
    aliases: ["mimo-v2.6", "mimo-v2-6"]
  },
  {
    id: "mimo-v2-5",
    name: "MiMo v2.5",
    score: 70,
    swe_bench: 38.0,
    livecodebench: 41.5,
    tier: "A+",
    patterns: ["*mimo*v2*5*", "*mimo*v2.5*", "*mimo*"],
    aliases: ["mimo-v2.5", "mimo-v2-5", "mimo"]
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    score: 73,
    swe_bench: 38.8,
    livecodebench: 44.0,
    tier: "A+",
    patterns: ["*gpt*4o*"],
    aliases: ["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-05-13"]
  },
  {
    id: "glm-4-plus",
    name: "GLM-4-Plus",
    score: 72,
    swe_bench: 38.5,
    livecodebench: 42.0,
    tier: "A+",
    patterns: ["*glm*4*plus*", "*glm*4*0520*"],
    aliases: ["glm-4-plus", "glm-4"]
  },
  {
    id: "gemini-2-0-flash",
    name: "Gemini 2.0 Flash",
    score: 71,
    swe_bench: 36.2,
    livecodebench: 43.1,
    tier: "A+",
    patterns: ["*gemini*2*0*flash*", "*gemini*2.0*flash*"],
    aliases: ["gemini-2.0-flash", "gemini-2-0-flash", "gemini-2.0-flash-exp"]
  },
  {
    id: "llama-3-3-70b",
    name: "Llama 3.3 70B Instruct",
    score: 71,
    swe_bench: 37.5,
    livecodebench: 42.5,
    tier: "A+",
    patterns: ["*llama*3*3*70b*", "*llama*3.3*70b*"],
    aliases: ["llama-3.3-70b-instruct", "llama-3.3-70b"]
  },
  {
    id: "minimax-01",
    name: "MiniMax-01",
    score: 70,
    swe_bench: 37.0,
    livecodebench: 41.0,
    tier: "A+",
    patterns: ["*minimax*01*", "*minimax*m2*"],
    aliases: ["minimax-01", "minimax-m2.5", "minimax-m2.7"]
  },
  {
    id: "step-2",
    name: "Step 2",
    score: 65,
    swe_bench: 35.0,
    livecodebench: 38.0,
    tier: "A",
    patterns: ["*step*2*"],
    aliases: ["step-2", "step-2-16k"]
  },
  {
    id: "claude-3-5-haiku",
    name: "Claude 3.5 Haiku",
    score: 64,
    swe_bench: 40.6,
    livecodebench: 41.2,
    tier: "A",
    patterns: ["*claude*3*5*haiku*", "*claude*3.5*haiku*"],
    aliases: ["claude-3-5-haiku", "claude-3.5-haiku"]
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o-mini",
    score: 56,
    swe_bench: 23.5,
    livecodebench: 31.4,
    tier: "B+",
    patterns: ["*gpt*4o*mini*"],
    aliases: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"]
  },
  {
    id: "llama-3-1-8b",
    name: "Llama 3.1 8B Instruct",
    score: 48,
    swe_bench: 18.0,
    livecodebench: 24.0,
    tier: "B",
    patterns: ["*llama*3*1*8b*", "*llama*3.1*8b*"],
    aliases: ["llama-3.1-8b-instruct", "llama-3.1-8b"]
  },
  {
    id: "gpt-3-5-turbo",
    name: "GPT-3.5 Turbo",
    score: 38,
    swe_bench: 12.0,
    livecodebench: 18.5,
    tier: "C+",
    patterns: ["*gpt*3*5*turbo*", "*gpt*3.5*turbo*"],
    aliases: ["gpt-3.5-turbo", "gpt-3.5-turbo-0125"]
  }
];

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`, "i");
}

const COMPILED_BENCHMARKS = BENCHMARKS_DATABASE.map((entry) => ({
  ...entry,
  compiledPatterns: (entry.patterns || []).map(globToRegex),
}));

/**
 * Membaca database benchmark kualitas coding.
 *
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   score: number,
 *   swe_bench: number,
 *   livecodebench: number,
 *   tier: 'S'|'A+'|'A'|'B+'|'B'|'C+',
 *   patterns?: string[],
 *   aliases?: string[]
 * }>}
 */
export function getBenchmarksDatabase() {
  return [...BENCHMARKS_DATABASE];
}

/**
 * Menentukan tier model berdasarkan skor kualitas coding.
 * - S: >= 80
 * - A+: >= 70
 * - A: >= 60
 * - B+: >= 50
 * - B: >= 40
 * - C+: < 40
 *
 * @param {number|unknown} score
 * @returns {'S'|'A+'|'A'|'B+'|'B'|'C+'}
 */
export function determineTier(score) {
  const num = typeof score === "number" ? score : Number(score);
  if (Number.isNaN(num) || num < 0) return "C+";
  if (num >= 80) return "S";
  if (num >= 70) return "A+";
  if (num >= 60) return "A";
  if (num >= 50) return "B+";
  if (num >= 40) return "B";
  return "C+";
}

/**
 * Mendeteksi apakah model merupakan varian reasoning/thinking.
 * Memeriksa keyword 'thinking', 'reasoning', atau 'reasoner'.
 *
 * @param {string|unknown} modelIdentifier
 * @returns {boolean}
 */
export function isThinkingVariant(modelIdentifier) {
  if (!modelIdentifier || typeof modelIdentifier !== "string") {
    return false;
  }
  return /thinking|reasoning|reasoner/i.test(modelIdentifier);
}

/**
 * Menormalkan nama/identifier model untuk pencocokan benchmark.
 * Menghilangkan provider prefix (ag/, cc/, openrouter/, dll), suffix (:free, :beta, dll),
 * serta varian tanggal (-20241022, dll).
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeModelIdentifier(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.toLowerCase().trim();

  // Strip prefix provider (misal ag/, cc/, antigravity/, openrouter/deepseek/, dll)
  s = s.replace(/^(?:ag|cc|antigravity|commandcode|openrouter|openai|anthropic|google|deepseek|qwen|zhipu|meta-llama|cohere|mistral|github)\//g, "");
  if (s.includes("/")) {
    const parts = s.split("/");
    s = parts[parts.length - 1];
  }

  // Strip suffix umum :free, :beta, :default, :preview, :online
  s = s.replace(/:(?:free|beta|preview|default|online|nitro)$/i, "");

  // Strip timestamp / tanggal pada model ID (misal -20250219, -2024-08-06, -0613)
  s = s.replace(/[-_@](?:20\d{2}[-_]?\d{2}[-_]?\d{2}|\d{4})\b/g, "");

  return s;
}

/**
 * Menemukan data benchmark yang cocok berdasarkan normalisasi nama/alias model.
 *
 * @param {string} modelIdentifier - Nama atau ID model (misal 'ag/claude-3-7-sonnet-20250219')
 * @param {Array|object} [benchmarks] - Dataset benchmark kustom (default BENCHMARKS_DATABASE)
 * @returns {object|null} Data benchmark model yang cocok atau null jika tidak ditemukan
 */
export function findBenchmarkMatch(modelIdentifier, benchmarks = null) {
  if (!modelIdentifier || typeof modelIdentifier !== "string") {
    return null;
  }

  const list = Array.isArray(benchmarks)
    ? benchmarks
    : benchmarks && typeof benchmarks === "object"
      ? Object.values(benchmarks)
      : COMPILED_BENCHMARKS;

  const rawLower = modelIdentifier.toLowerCase().trim();
  const normalized = normalizeModelIdentifier(modelIdentifier);
  const isThinking = isThinkingVariant(modelIdentifier);

  // 1. Jika ini varian thinking, utamakan entry thinking
  if (isThinking) {
    for (const item of list) {
      if (
        item.id.includes("thinking") ||
        item.name.toLowerCase().includes("thinking") ||
        item.aliases?.some((a) => a.includes("thinking") && (a === rawLower || a === normalized))
      ) {
        if (
          item.id === normalized ||
          item.name.toLowerCase() === normalized ||
          item.aliases?.includes(rawLower) ||
          item.aliases?.includes(normalized) ||
          (item.compiledPatterns && item.compiledPatterns.some((re) => re.test(rawLower) || re.test(normalized)))
        ) {
          return item;
        }
      }
    }
  }

  // 2. Pencocokan langsung pada id, aliases, atau name
  for (const item of list) {
    if (
      item.id === normalized ||
      item.id === rawLower ||
      item.name.toLowerCase() === normalized ||
      item.name.toLowerCase() === rawLower ||
      item.aliases?.includes(rawLower) ||
      item.aliases?.includes(normalized)
    ) {
      return item;
    }
  }

  // 3. Pencocokan pola regex (glob)
  for (const item of list) {
    const patterns = item.compiledPatterns || (item.patterns || []).map(globToRegex);
    if (patterns.some((re) => re.test(rawLower) || re.test(normalized))) {
      return item;
    }
  }

  // 4. Pencocokan token parsial / fuzzy
  // Bersihkan pemisah untuk perbandingan longgar
  const cleanNorm = normalized.replace(/[^a-z0-9]/g, "");
  for (const item of list) {
    const cleanId = item.id.replace(/[^a-z0-9]/g, "");
    if (cleanNorm && cleanId && (cleanNorm === cleanId || cleanNorm.startsWith(cleanId) || cleanId.startsWith(cleanNorm))) {
      return item;
    }
    if (item.aliases) {
      for (const alias of item.aliases) {
        const cleanAlias = alias.replace(/[^a-z0-9]/g, "");
        if (cleanNorm && cleanAlias && cleanNorm === cleanAlias) {
          return item;
        }
      }
    }
  }

  return null;
}

/**
 * Mengecek apakah model masuk kategori smart tier (skor >= 68 atau varian thinking).
 *
 * @param {string} modelIdentifier
 * @param {Array|object} [benchmarks]
 * @returns {boolean}
 */
export function isSmartTierModel(modelIdentifier, benchmarks = null) {
  if (!modelIdentifier || typeof modelIdentifier !== "string") {
    return false;
  }
  if (isThinkingVariant(modelIdentifier)) {
    return true;
  }
  const match = findBenchmarkMatch(modelIdentifier, benchmarks);
  if (match && typeof match.score === "number") {
    return match.score >= 68;
  }
  return false;
}

/**
 * Menghitung skor terbobot akhir kualitas koding suatu model:
 * Skor Akhir = Skor Benchmark - (Penalti Latensi) - (Penalti Kegagalan)
 *
 * Model berstatus quota/parkir (latensi >= QUOTA_LATENCY_SENTINEL) diberi penalti maksimal.
 *
 * @param {string} modelIdentifier - ID model
 * @param {object} [options]
 * @param {number} [options.latencyMs] - Latensi dalam milidetik
 * @param {number} [options.failureRate] - Rasio kegagalan (0-1 atau 0-100%)
 * @param {Array|object} [options.benchmarks] - Dataset benchmark kustom
 * @returns {number} Skor akhir terbobot
 */
export function calculateCodingScore(modelIdentifier, { latencyMs = 0, failureRate = 0, benchmarks } = {}) {
  const match = findBenchmarkMatch(modelIdentifier, benchmarks);
  let baseScore = match?.score;

  if (baseScore === undefined || baseScore === null) {
    baseScore = isThinkingVariant(modelIdentifier) ? 75 : 50;
  }

  // Model terkena quota / rate limit dan diparkir
  if (isParkedLatency(latencyMs)) {
    return -999999;
  }

  // Penalti latensi: 2 poin per 1000ms (0.002 per ms)
  const safeLatency = Math.max(0, typeof latencyMs === "number" ? latencyMs : 0);
  const latencyPenalty = safeLatency * 0.002;

  // Penalti kegagalan: skala bobot hingga 50 poin
  const safeFailure = Math.max(0, typeof failureRate === "number" ? failureRate : 0);
  const normalizedFailureRate = safeFailure > 1 ? safeFailure / 100 : safeFailure;
  const failurePenalty = normalizedFailureRate * 50;

  const finalScore = baseScore - latencyPenalty - failurePenalty;
  return Math.round(finalScore * 100) / 100;
}

/**
 * Mengurutkan daftar model berdasarkan kualitas koding.
 * Memposisikan model berstatus quota/parkir di urutan paling bawah.
 *
 * @param {Array<string|object>} models - Daftar nama model atau objek model
 * @param {object} [options]
 * @param {Map|object} [options.latencyMap] - Peta latensi model
 * @param {Map|object} [options.failureRateMap] - Peta kegagalan model
 * @param {Array|object} [options.benchmarks] - Dataset benchmark kustom
 * @returns {Array<string|object>} Daftar model yang telah diurutkan
 */
export function sortModelsByCodingQuality(models, { latencyMap = {}, failureRateMap = {}, benchmarks } = {}) {
  if (!Array.isArray(models)) return [];

  const getModelId = (m) => (typeof m === "string" ? m : (m?.id || m?.model || m?.name || ""));

  const getLatency = (modelId, item) => {
    if (latencyMap instanceof Map) {
      if (latencyMap.has(modelId)) return latencyMap.get(modelId);
    } else if (latencyMap && latencyMap[modelId] !== undefined) {
      return latencyMap[modelId];
    }
    if (typeof item === "object" && item !== null) {
      if (typeof item.latencyMs === "number") return item.latencyMs;
      if (typeof item.latency === "number") return item.latency;
    }
    return 0;
  };

  const getFailureRate = (modelId, item) => {
    if (failureRateMap instanceof Map) {
      if (failureRateMap.has(modelId)) return failureRateMap.get(modelId);
    } else if (failureRateMap && failureRateMap[modelId] !== undefined) {
      return failureRateMap[modelId];
    }
    if (typeof item === "object" && item !== null) {
      if (typeof item.failureRate === "number") return item.failureRate;
    }
    return 0;
  };

  return [...models].sort((a, b) => {
    const idA = getModelId(a);
    const idB = getModelId(b);

    const latA = getLatency(idA, a);
    const latB = getLatency(idB, b);

    const isParkedA = isParkedLatency(latA) || (typeof a === "object" && (a?.status === "quota" || a?.isParked === true));
    const isParkedB = isParkedLatency(latB) || (typeof b === "object" && (b?.status === "quota" || b?.isParked === true));

    // 1. Model yang diparkir (quota limit) diposisikan di paling bawah
    if (isParkedA && !isParkedB) return 1;
    if (!isParkedA && isParkedB) return -1;

    // 2. Jika keduanya aktif atau keduanya parkir, urutkan berdasarkan coding score terbobot
    const failA = getFailureRate(idA, a);
    const failB = getFailureRate(idB, b);

    const scoreA = isParkedA ? -999999 : calculateCodingScore(idA, { latencyMs: latA, failureRate: failA, benchmarks });
    const scoreB = isParkedB ? -999999 : calculateCodingScore(idB, { latencyMs: latB, failureRate: failB, benchmarks });

    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }

    return idA.localeCompare(idB);
  });
}
