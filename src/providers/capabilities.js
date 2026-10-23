/**
 * Model capabilities: what a model can do beyond plain text. Today the router
 * only needs two of them — `vision` (reads images) and `reasoning` (thinking) —
 * plus the token limits published on /v1/models.
 *
 * Resolution, first match wins, merged over DEFAULT_CAPABILITIES:
 *   1. storedCaps — provider API data captured during model sync (Mistral sends
 *      capabilities.reasoning / capabilities.vision). Authoritative, always wins.
 *   2. PATTERN_CAPABILITIES — glob on the model id, ordered specific -> generic.
 *   3. nothing — no pattern matched and the provider sent no data. Resolved to
 *      null so the dashboard shows no icon and /v1/models omits the field
 *      instead of claiming a capability nobody verified.
 *
 * The pattern table is adapted from the upstream gateway reference
 * (attribution in NOTICE), trimmed to the fields Zenith uses.
 * Anything the reference keeps per gateway (context truncation, thinking wire format)
 * is left out on purpose: Zenith only publishes limits it can state as fact.
 */
export const DEFAULT_CAPABILITIES = {
  vision: false,
  reasoning: false,
  contextWindow: null,
  maxOutput: null,
};

export const PATTERN_CAPABILITIES = [
  // ── Claude ────────────────────────────────────────────────────────
  { pattern: "*claude*opus-5*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-5*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*fable*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  // Opus 4.6 and Sonnet 4.6 ship the full 1M window on the Claude Platform (GA notice).
  // Both spellings are listed: gateways name these models with dots or hyphens.
  { pattern: "*claude*opus-4.6*", caps: { vision: true, reasoning: true, contextWindow: 1000000 } },
  { pattern: "*claude*opus-4-6*", caps: { vision: true, reasoning: true, contextWindow: 1000000 } },
  { pattern: "*claude*opus-4.7*", caps: { vision: true, reasoning: true } },
  { pattern: "*claude*opus-4.8*", caps: { vision: true, reasoning: true } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, contextWindow: 1000000 } },
  { pattern: "*claude*sonnet-4-6*", caps: { vision: true, reasoning: true, contextWindow: 1000000 } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true } },
  { pattern: "*claude*haiku*", caps: { vision: true, reasoning: true } },
  { pattern: "*claude*opus*", caps: { vision: true, reasoning: true } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true } },
  { pattern: "*claude-3*", caps: { vision: true } },
  { pattern: "*claude*", caps: { vision: true, reasoning: true } },

  // ── Gemini / Gemma ────────────────────────────────────────────────
  { pattern: "*gemini*image*", caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-4*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.8*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.7*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.5*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.6*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*pro*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*", caps: { vision: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*", caps: { vision: true, contextWindow: 1048576 } },
  { pattern: "*gemma*", caps: { vision: true, contextWindow: 128000 } },

  // ── OpenAI GPT ────────────────────────────────────────────────────
  { pattern: "*gpt-6*", caps: { vision: true, reasoning: true, contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5*image*", caps: { imageOutput: true } },
  { pattern: "*gpt-5*codex*", caps: { reasoning: true, contextWindow: 400000, maxOutput: 128000 } },
  // gpt-5.4 is where the 1.05M window starts; the mini and nano tiers stayed at 400k.
  { pattern: "*gpt-5.4-mini*", caps: { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4-nano*", caps: { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4*", caps: { vision: true, reasoning: true, contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.5*", caps: { vision: true, reasoning: true, contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.6*", caps: { vision: true, reasoning: true, contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5*", caps: { vision: true, reasoning: true, contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*", caps: { vision: true, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4.1*", caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*", caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*", caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*", caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*o1-mini*", caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*o1*", caps: { vision: true, reasoning: true, contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*", caps: { vision: true, reasoning: true, contextWindow: 200000, maxOutput: 100000 } },

  // ── Mistral family ────────────────────────────────────────────────
  // Synced Mistral models prefer the API data; these entries cover the builtin
  // fallback list and any other gateway reselling the same model ids.
  { pattern: "*magistral*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 64000 } },
  { pattern: "*pixtral*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*ministral*", caps: { vision: true, contextWindow: 262144 } },
  { pattern: "*codestral*", caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral-small*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*voxtral*", caps: { contextWindow: 32768 } },
  { pattern: "*devstral*", caps: { contextWindow: 256000 } },
  { pattern: "*mistral*", caps: { contextWindow: 128000 } },

  // ── Qwen ──────────────────────────────────────────────────────────
  { pattern: "*qwen*vl*", caps: { vision: true, reasoning: true, contextWindow: 262144 } },
  { pattern: "*qwen*omni*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*max*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*coder*", caps: { reasoning: true, contextWindow: 1000000 } },
  { pattern: "*qwen3.5*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*", caps: { reasoning: true, contextWindow: 262144 } },
  { pattern: "*qwq*", caps: { reasoning: true, contextWindow: 131072 } },
  { pattern: "*qwen*", caps: { reasoning: true, contextWindow: 262144 } },

  // ── DeepSeek ──────────────────────────────────────────────────────
  { pattern: "*deepseek-v4.*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*deepseek-v4*", caps: { reasoning: true, contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*", caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*deepseek-r*", caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*", caps: { reasoning: true, contextWindow: 128000 } },

  // ── Kimi ──────────────────────────────────────────────────────────
  { pattern: "*kimi*k3*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*kimi*k2.7*code*", caps: { reasoning: true, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2*", caps: { vision: true, reasoning: true, contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*", caps: { reasoning: true, contextWindow: 262144 } },

  // ── GLM ───────────────────────────────────────────────────────────
  { pattern: "*glm-5.3*", caps: { reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm-5.2*", caps: { reasoning: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm-5*", caps: { reasoning: true, contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*", caps: { reasoning: true, contextWindow: 200000 } },
  { pattern: "*glm-4*", caps: { reasoning: true, contextWindow: 200000 } },
  { pattern: "*glm*", caps: { reasoning: true, contextWindow: 200000 } },

  // ── MiniMax ───────────────────────────────────────────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*", caps: { vision: true, reasoning: true, contextWindow: 1000000, maxOutput: 131072 } },
  { pattern: "*minimax-m2.7*", caps: { vision: true, reasoning: true, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax-m2.5*", caps: { vision: true, reasoning: true, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*", caps: { reasoning: true, contextWindow: 200000, maxOutput: 131072 } },

  // ── MiMo ──────────────────────────────────────────────────────────
  { pattern: "*mimo*v2.6*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*v2.5*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*", caps: { reasoning: true, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama ─────────────────────────────────────────────────────────
  { pattern: "*llama-4*", caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*", caps: { contextWindow: 128000 } },

  // ── Grok ──────────────────────────────────────────────────────────
  { pattern: "*grok*image*", caps: { imageOutput: true } },
  { pattern: "*grok-code*", caps: { reasoning: true, contextWindow: 256000 } },
  { pattern: "*grok-4.6*", caps: { vision: true, reasoning: true, contextWindow: 500000, maxOutput: 500000 } },
  { pattern: "*grok-4.5*", caps: { vision: true, reasoning: true, contextWindow: 500000, maxOutput: 64000 } },
  { pattern: "*grok-4*", caps: { vision: true, reasoning: true, contextWindow: 256000 } },
  { pattern: "*grok-3*", caps: { vision: true, reasoning: true, contextWindow: 131072 } },
  { pattern: "*grok*", caps: { vision: true, reasoning: true, contextWindow: 256000 } },

  // ── Cohere / Perplexity ───────────────────────────────────────────
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*", caps: { contextWindow: 128000 } },
  { pattern: "*sonar*", caps: { contextWindow: 128000 } },
  { pattern: "*perplexity*", caps: { contextWindow: 128000 } },

  // ── Poolside Laguna ───────────────────────────────────────────────
  { pattern: "*laguna-s-2.1*free*", caps: { reasoning: true, contextWindow: 200000, maxOutput: 32000 } },
  { pattern: "*laguna-s-2.1*", caps: { reasoning: true, contextWindow: 1000000, maxOutput: 32000 } },
  { pattern: "*laguna*", caps: { reasoning: true, contextWindow: 200000, maxOutput: 32000 } },

  // ── Muse (OpenCode Free / Cline) ──────────────────────────────────
  { pattern: "*muse*spark*", caps: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 } },

  // ── Lainnya ───────────────────────────────────────────────────────
  { pattern: "*hunyuan*", caps: { reasoning: true, contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*", caps: { reasoning: true, contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-*", caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*nemotron*", caps: { reasoning: true, contextWindow: 128000 } },
];

const COMPILED = PATTERN_CAPABILITIES.map(({ pattern, caps }) => ({
  re: new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")}$`, "i"),
  caps,
}));

function matchesAny(id, entries) {
  return entries.some((e) => e === id || id.endsWith(`/${e}`) || id.endsWith(`-${e}`));
}

/**
 * Read a capabilities blob out of a provider API payload. Only explicit
 * booleans are kept, so a provider that omits the field leaves that capability
 * to the pattern table instead of silently declaring it false.
 * Mistral shape: { capabilities: { reasoning: bool, vision: bool } }.
 */
export function capabilitiesFromApi(model) {
  const c = model?.capabilities;
  if (!c || typeof c !== "object") return null;
  const out = {};
  if (typeof c.vision === "boolean") out.vision = c.vision;
  if (typeof c.reasoning === "boolean") out.reasoning = c.reasoning;
  return Object.keys(out).length ? out : null;
}

/** Parse the JSON stored alongside a synced model; bad data is ignored. */
export function parseStoredCapabilities(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Capabilities of one model, or null when neither the provider nor the pattern
 * table knows. `storedCaps` comes from the provider API during model sync.
 */
export function resolveCapabilities(modelId, storedCaps = null) {
  if (!modelId) return null;
  const stored = parseStoredCapabilities(storedCaps);
  if (stored && matchesAny(String(modelId), Object.keys(stored))) return { ...DEFAULT_CAPABILITIES, ...stored };

  const hit = COMPILED.find((e) => e.re.test(String(modelId)));
  if (!hit) return stored ? { ...DEFAULT_CAPABILITIES, ...stored } : null;

  const merged = { ...DEFAULT_CAPABILITIES, ...hit.caps };
  if (stored) return { ...merged, ...stored };
  return merged;
}