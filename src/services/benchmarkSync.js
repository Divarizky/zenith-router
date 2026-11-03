import { getSetting, setSetting } from "./settings.js";

/**
 * Sinkronisasi benchmark live dan kalkulasi skor empiris/heuristik ala 9router.
 *
 * Sumber empiris:
 * 1. BenchLM Coding & Agentic (https://benchlm.ai)
 * 2. SWE-bench Verified (https://api.zeroeval.com / llm-stats.com)
 * 3. LMArena Coding/Agent (HuggingFace datasets-server)
 *
 * Model yang belum terdaftar di leaderboard publik dinilai menggunakan rumus
 * Heuristik Family & Parameter Size (sama seperti 9router).
 * Model non-coding / filter safety diberi skor 10.0.
 */

export const SNAPSHOT_KEY = "benchmark_live_snapshot";
export const REFRESH_INTERVAL_MS = 7 * 24 * 3_600_000;
export const MIN_SOURCE_MODELS = 20;
export const MIN_VALID_SOURCES = 2;
const SNAPSHOT_VERSION = 3;
const FETCH_TIMEOUT_MS = 30_000;

const LMARENA_ROWS = "https://datasets-server.huggingface.co/rows";
const LMARENA_DATASET = "lmarena-ai/leaderboard-dataset";
const ZEROEVAL_FULL = "https://api.zeroeval.com/leaderboard/models/full";
const BENCHLM_URL = "https://benchlm.ai";

/**
 * Menyeragamkan ID model dari provider maupun leaderboard menjadi satu kunci inti.
 * Membuang prefix provider/organisasi, sufiks :free/-free, serta menormalkan titik versi.
 */
export function canonId(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  let s = raw.toLowerCase().replace(/\s*\((max|high|medium|low|thinking|reasoning|preview|default|xhigh)[^)]*\)/g, "");
  if (s.includes("/")) {
    s = s.split("/").pop();
  }
  s = s
    .replace(/:free$/, "")
    .replace(/-free$/, "")
    .replace(/:beta$/, "")
    .replace(/-preview$/, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/(\d+)\.(\d+)/g, "$1-$2")
    .replace(/[.:_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/^claude-(\d+-\d+)-(opus|sonnet|haiku)$/, "claude-$2-$1")
    .replace(/^claude-(\d)-(opus|sonnet|haiku)$/, "claude-$2-$1")
    .replace(/^-+|-+$/g, "");
  return s;
}

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Heuristik family dan ukuran parameter untuk model tanpa data leaderboard empiris.
 * Mengadopsi formula 9router, diskalakan ke rentang 10 - 75.
 */
export function calculateHeuristicScore(modelIdentifier) {
  const id = String(modelIdentifier || "").toLowerCase();
  let score = 50.0;

  if (/(?:claude|sonnet|opus)/.test(id)) score = 75.0;
  else if (/(?:gemini|gpt-4|o1|o3|r1\b)/.test(id)) score = 70.0;
  else if (/(?:qwen|deepseek|codestral|mistral|devin|glm)/.test(id)) score = 62.0;
  else if (/(?:coder|code|instruct)/.test(id)) score = 56.0;
  else if (/(?:flash|mini|small|lite|nano)/.test(id)) score = 48.0;

  if (/(?:preview|thinking|reasoner|reasoning)/.test(id)) score += 4.0;

  const paramMatch = id.match(/(?:^|[^\w])(\d+)b(?:[^\w]|$)/);
  if (paramMatch) {
    const size = parseInt(paramMatch[1], 10);
    if (size >= 100) score += 6.0;
    else if (size >= 65) score += 4.0;
    else if (size >= 30) score += 2.5;
    else if (size >= 14) score += 1.0;
    else if (size <= 8) score -= 2.0;
  }

  // Model non-coding, media, atau safety filter
  if (/(?:embed|image|vision|audio|tts|whisper|flux|diffusion|content-safety)/.test(id)) {
    score = 10.0;
  }

  return Math.round(score * 10) / 10;
}

export function determineTier(score) {
  if (score >= 80) return "S";
  if (score >= 70) return "A+";
  if (score >= 60) return "A";
  if (score >= 50) return "B+";
  if (score >= 45) return "B";
  return "C+";
}

function collectBest(pairs) {
  const best = new Map();
  for (const [name, value] of pairs) {
    if (!isNum(value)) continue;
    if (/^multiple$/i.test(String(name).trim())) continue;
    const key = canonId(String(name));
    if (!key) continue;
    if (!best.has(key) || value > best.get(key)) best.set(key, value);
  }
  return best;
}

export function parseLmarenaRows(rows) {
  if (!Array.isArray(rows)) return new Map();
  return collectBest(
    rows
      .filter((r) => r && (r.category === undefined || r.category === "overall"))
      .map((r) => [r.model_name, isNum(r.score) ? r.score : r.rating]),
  );
}

export function parseZeroevalSwe(models) {
  if (!Array.isArray(models)) return new Map();
  return collectBest(models.map((m) => [m.model_id || m.name, m.swe_bench_verified_score]));
}

export function parseBenchlm(rows) {
  const coding = new Map();
  const agentic = new Map();
  if (!Array.isArray(rows)) return { coding, agentic };

  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 31) continue;
    const name = r[2] || r[1];
    const scores = r[30];
    if (!Array.isArray(scores)) continue;
    const key = canonId(name);
    if (!key) continue;

    if (isNum(scores[1]) && scores[1] > 0) {
      if (!coding.has(key) || scores[1] > coding.get(key)) {
        coding.set(key, scores[1]);
      }
    }
    if (isNum(scores[0]) && scores[0] > 0) {
      if (!agentic.has(key) || scores[0] > agentic.get(key)) {
        agentic.set(key, scores[0]);
      }
    }
  }
  return { coding, agentic };
}

/** Skor mentah -> persentil 0-100 di dalam leaderboard masing-masing */
export function toPercentiles(scores) {
  const map = scores instanceof Map ? scores : new Map(Object.entries(scores || {}));
  const values = [...map.values()].filter(isNum).sort((a, b) => a - b);
  const out = {};
  if (!values.length) return out;
  for (const [key, v] of map) {
    if (!isNum(v)) continue;
    let below = 0;
    let equal = 0;
    for (const x of values) {
      if (x < v) below++;
      else if (x === v) equal++;
    }
    out[key] = Math.round(((below + equal / 2) / values.length) * 1000) / 10;
  }
  return out;
}

async function getJson(url, fetchImpl, init) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { accept: "application/json", "user-agent": "zenith-router/1.0", ...(init?.headers || {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLmarenaAgent(fetchImpl) {
  const rows = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const url = `${LMARENA_ROWS}?dataset=${LMARENA_DATASET}&config=agent&split=latest&offset=${offset}&length=100`;
    const json = await getJson(url, fetchImpl);
    const page = (json.rows || []).map((r) => r.row);
    rows.push(...page);
    if (page.length < 100) break;
  }
  return parseLmarenaRows(rows);
}

async function fetchBenchlm(fetchImpl) {
  const res = await fetchImpl(BENCHLM_URL, {
    headers: { "user-agent": "zenith-router/1.0", accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("BenchLM: __NEXT_DATA__ not found");
  const data = JSON.parse(match[1]);
  const rows = data?.props?.pageProps?.homepageData?.leaderboard?.rows || [];
  return parseBenchlm(rows);
}

const SOURCE_FETCHERS = {
  swe_verified: async (f) => parseZeroevalSwe(await getJson(ZEROEVAL_FULL, f)),
  lma_agent: (f) => fetchLmarenaAgent(f),
  benchlm: (f) => fetchBenchlm(f),
};

export function loadSnapshot() {
  try {
    const raw = getSetting(SNAPSHOT_KEY, "");
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object" || snap.version !== SNAPSHOT_VERSION || !snap.sources || !isNum(snap.fetchedAt)) {
      return null;
    }
    return snap;
  } catch {
    return null;
  }
}

/**
 * Mengambil semua sumber leaderboard lalu menyimpan snapshot skor mentah.
 * Membutuhkan minimal MIN_VALID_SOURCES sumber berhasil.
 */
export async function refreshBenchmarkSnapshot({ fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const existing = loadSnapshot();
  if (!force && existing && now - existing.fetchedAt < REFRESH_INTERVAL_MS) {
    return { ok: true, skipped: true, fetchedAt: existing.fetchedAt };
  }

  const sources = {};
  const errors = {};

  for (const [name, run] of Object.entries(SOURCE_FETCHERS)) {
    try {
      const res = await run(fetchImpl);
      if (name === "benchlm") {
        if (res.coding.size >= MIN_SOURCE_MODELS) {
          sources.blm_coding = Object.fromEntries(res.coding);
        }
        if (res.agentic.size >= MIN_SOURCE_MODELS) {
          sources.blm_agent = Object.fromEntries(res.agentic);
        }
      } else {
        if (res.size < MIN_SOURCE_MODELS) {
          errors[name] = `hanya ${res.size} model (minimum ${MIN_SOURCE_MODELS})`;
          continue;
        }
        sources[name] = Object.fromEntries(res);
      }
    } catch (err) {
      errors[name] = err?.message || String(err);
    }
  }

  if (Object.keys(sources).length < MIN_VALID_SOURCES) {
    return { ok: false, kept: Boolean(existing), errors };
  }

  setSetting(SNAPSHOT_KEY, JSON.stringify({ version: SNAPSHOT_VERSION, fetchedAt: now, sources }));
  return { ok: true, fetchedAt: now, sources: Object.keys(sources), errors };
}

/**
 * Menghitung skor terpadu untuk daftar model kandidat.
 * 1. Jika ada di data leaderboard (BenchLM, SWE, LMArena), hitung persentil empiris (skala 35 - 80).
 * 2. Jika tidak ada, gunakan formula Heuristik Family & Parameter Size ala 9router.
 *
 * @param {string[]} candidateIds - Daftar ID model
 * @param {object} [snapshot] - Snapshot leaderboard (opsional, default loadSnapshot)
 * @returns {Record<string, { score: number, tier: string, source: string, empiricalCount: number }>}
 */
export function resolveLiveScores(candidateIds = [], snapshot = null) {
  const snap = snapshot || loadSnapshot();
  const result = {};
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return result;

  const percentilesBySource = {};
  if (snap?.sources) {
    for (const [srcName, board] of Object.entries(snap.sources)) {
      if (!board || typeof board !== "object") continue;
      const scoresMap = new Map();
      for (const [k, v] of Object.entries(board)) {
        if (isNum(v)) scoresMap.set(k, v);
      }
      if (scoresMap.size >= MIN_SOURCE_MODELS) {
        percentilesBySource[srcName] = toPercentiles(scoresMap);
      }
    }
  }

  for (const id of candidateIds) {
    if (!id || typeof id !== "string") continue;
    const key = canonId(id);
    const foundValues = [];
    const sourcesFound = [];

    if (key) {
      for (const [srcName, pMap] of Object.entries(percentilesBySource)) {
        let p = pMap[key];
        if (p === undefined && key.length > 5) {
          for (const [pk, val] of Object.entries(pMap)) {
            if (pk === key || pk.includes(key) || key.includes(pk)) {
              p = val;
              break;
            }
          }
        }
        if (isNum(p)) {
          foundValues.push(p);
          sourcesFound.push(srcName);
        }
      }
    }

    let finalScore;
    let source;
    if (foundValues.length > 0) {
      const avgPct = foundValues.reduce((a, b) => a + b, 0) / foundValues.length;
      finalScore = Math.round((35.0 + (avgPct / 100.0) * 45.0) * 10) / 10;
      source = `empirical (${sourcesFound.join(",")})`;
    } else {
      finalScore = calculateHeuristicScore(id);
      source = "heuristic (family+params)";
    }

    result[id] = {
      score: finalScore,
      tier: determineTier(finalScore),
      source,
      empiricalCount: foundValues.length,
    };
  }

  return result;
}
