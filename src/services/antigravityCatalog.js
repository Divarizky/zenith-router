/**
 * Antigravity model families.
 *
 * The upstream catalog ships one runtime id per thinking level
 * (`gemini-4-argon-low`, `-medium`, `-high`), which used to surface in Zenith as
 * one catalog entry each. Clients that can only pick a model cannot express the
 * level that way, and the same family then appears five times in `/v1/models`.
 * Here a family is one public id plus a level -> runtime map, so the level comes
 * from the request instead of from the model name.
 *
 * Same concept as the provider-gateway extension's antigravity bridge, which is
 * the reference implementation: runtime discovery is grouped into families, the
 * requested reasoning effort selects the variant, and a missing effort falls
 * back down the chain rather than reaching upstream unpicked.
 */

/** Order matters: the first matching suffix wins for ids like `-flash-extra-low`. */
const SUFFIXES = [
  { suffix: "extra-low", level: "low" },
  { suffix: "extra-high", level: "xhigh" },
  { suffix: "thinking", level: "high" },
  { suffix: "minimal", level: "minimal" },
  { suffix: "medium", level: "medium" },
  { suffix: "high", level: "high" },
  { suffix: "low", level: "low" },
];

/** Display name wins over the id suffix: `gemini-3.5-flash-low` is "Flash (Medium)". */
const DISPLAY_LEVELS = [
  { pattern: /\(\s*extra\s*low\s*\)/i, level: "low" },
  { pattern: /\(\s*extra\s*high\s*\)/i, level: "xhigh" },
  { pattern: /\(\s*thinking\s*\)/i, level: "high" },
  { pattern: /\(\s*minimal\s*\)/i, level: "minimal" },
  { pattern: /\(\s*medium\s*\)/i, level: "medium" },
  { pattern: /\(\s*high\s*\)/i, level: "high" },
  { pattern: /\(\s*low\s*\)/i, level: "low" },
];

/** Runtime ids whose family cannot be derived from the id itself. */
const RUNTIME_ALIASES = {
  "gemini-3-flash-agent": { family: "gemini-3.5-flash", level: "high" },
  "gemini-pro-agent": { family: "gemini-3.1-pro", level: "high" },
};

/** agy's own default (defaultAgentModelId) is the medium variant. */
export const DEFAULT_EFFORT = "medium";

/** Fallback order per level, mirroring the extension's routing table. */
const EFFORT_CHAIN = {
  minimal: ["minimal", "low", "medium", "high"],
  low: ["low", "minimal", "medium", "high"],
  medium: ["medium", "low", "high", "minimal"],
  high: ["high", "medium", "low", "minimal"],
  xhigh: ["xhigh", "high", "medium", "low", "minimal"],
};

const KNOWN_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

/** `max` is a Pi-level that the upstream has no bucket for. */
const EFFORT_ALIASES = { max: "xhigh", none: "off", off: "off", disabled: "off" };

/**
 * Only chat models belong in the catalog: internal `chat_*`/`tab_*` entries and
 * image models are not callable through the chat endpoints.
 */
export function isSelectableRuntimeModelId(id) {
  if (typeof id !== "string" || !/^(gemini-|claude-|gpt-oss-)/i.test(id)) return false;
  if (/^(chat_|tab_)/i.test(id)) return false;
  if (/image/i.test(id)) return false;
  return true;
}

function levelFromSuffix(runtimeId) {
  const lower = runtimeId.toLowerCase();
  for (const { suffix, level } of SUFFIXES) {
    if (lower.endsWith(`-${suffix}`)) {
      return { family: runtimeId.slice(0, -(suffix.length + 1)), level };
    }
  }
  return undefined;
}

function levelFromDisplayName(displayName) {
  if (typeof displayName !== "string") return undefined;
  for (const { pattern, level } of DISPLAY_LEVELS) {
    if (pattern.test(displayName)) return level;
  }
  return undefined;
}

function familyFromDisplayName(displayName) {
  if (typeof displayName !== "string") return undefined;
  return displayName.replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "").trim();
}

/**
 * Group runtime ids into families.
 *
 * `models` maps a runtime id to its metadata (display name and capability flags
 * straight from fetchAvailableModels, or a simpler object for the builtin list).
 * Returns a Map keyed by public family id; each value carries the level ->
 * runtime map, the unsuffixed runtime (a `-tiered` bucket), and capabilities.
 */
export function buildAntigravityFamilies(models) {
  const families = new Map();
  const ensure = (family) => {
    if (!families.has(family)) {
      families.set(family, { family, variants: {}, thinkingLevels: {}, unsuffixed: undefined, displayName: undefined });
    }
    return families.get(family);
  };

  for (const [runtimeId, info] of Object.entries(models || {})) {
    if (!isSelectableRuntimeModelId(runtimeId)) continue;
    const displayName = info?.displayName || info?.name;
    const familyName = familyFromDisplayName(displayName);

    if (runtimeId.endsWith("-tiered")) {
      const family = ensure(runtimeId.slice(0, -"-tiered".length));
      family.unsuffixed = family.unsuffixed || runtimeId;
      family.tiered = family.tiered || runtimeId;
      family.displayName = family.displayName || familyName;
      absorbCapabilities(family, info);
      continue;
    }

    const alias = RUNTIME_ALIASES[runtimeId];
    const suffix = alias ? undefined : levelFromSuffix(runtimeId);
    const family = ensure(alias?.family || suffix?.family || runtimeId);
    family.displayName = family.displayName || familyName;
    absorbCapabilities(family, info);

    const level = alias?.level || levelFromDisplayName(displayName) || suffix?.level;
    if (level && level !== "off") family.variants[level] = runtimeId;
    else family.unsuffixed = family.unsuffixed || runtimeId;
  }

  return families;
}

function absorbCapabilities(family, info) {
  if (!info) return;
  if (info.supportsImages === true) family.supportsImages = true;
  else if (info.supportsImages === false && family.supportsImages === undefined) family.supportsImages = false;
  if (info.supportsThinking === true) family.supportsThinking = true;
  else if (info.supportsThinking === false && family.supportsThinking !== true) family.supportsThinking = false;
  if (typeof info.maxTokens === "number" && family.maxTokens === undefined) family.maxTokens = info.maxTokens;
  if (typeof info.maxOutputTokens === "number" && family.maxOutputTokens === undefined) {
    family.maxOutputTokens = info.maxOutputTokens;
  }
}

export function normalizeEffort(effort) {
  if (typeof effort !== "string") return undefined;
  const value = effort.toLowerCase();
  if (value in EFFORT_ALIASES) return EFFORT_ALIASES[value];
  return KNOWN_EFFORTS.has(value) ? value : undefined;
}

/**
 * Claude has no effort enum, only a thinking budget, so the budget is bucketed
 * into the nearest level instead of inventing a separate scale. `0` is an
 * explicit off and maps to the cheapest level. A missing or negative budget is
 * not a level at all (Gemini's `-1` means "dynamic"), so it stays undefined and
 * the caller's default applies.
 */
export function levelFromThinkingBudget(budgetTokens) {
  if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens < 0) return undefined;
  if (budgetTokens <= 2048) return "low";
  if (budgetTokens <= 8192) return "medium";
  return "high";
}

/**
 * A client's effort value, with "off" turned into the cheapest level. An explicit
 * off still needs a model that answers, so it does not fall through to default.
 */
function clientEffort(value) {
  const level = normalizeEffort(value);
  return level === "off" ? "low" : level;
}

/**
 * The effort a client asked for, in its own dialect. A Claude `thinking.disabled`
 * and an explicit OpenAI "none" both mean the cheapest level, not "no model".
 */
export function effortFromRequest(sourceFormat, body) {
  const format = String(sourceFormat || "").toLowerCase();
  if (format === "claude" || format === "anthropic") {
    const thinking = body?.thinking;
    if (!thinking) return undefined;
    if (thinking.type === "disabled") return "low";
    if (thinking.type === "enabled") return levelFromThinkingBudget(thinking.budget_tokens);
    return undefined;
  }
  if (format === "openai-responses" || format === "responses") {
    return clientEffort(body?.reasoning?.effort);
  }
  if (format === "antigravity" || format === "gemini") {
    const config = body?.generationConfig?.thinkingConfig;
    if (!config) return undefined;
    if (config.thinkingLevel) return clientEffort(config.thinkingLevel);
    return levelFromThinkingBudget(config.thinkingBudget);
  }
  return clientEffort(body?.reasoning_effort);
}

/**
 * Resolve one family + effort to the runtime payload to send upstream.
 * A family with a single runtime ignores the level; a `-tiered` bucket takes the
 * level as thinkingLevel because that is how the tier travels on the wire.
 */
export function resolveFamilyRuntime(familyEntry, effort) {
  const variants = familyEntry?.variants || {};
  const wanted = normalizeEffort(effort);
  const chain = wanted && wanted !== "off" ? EFFORT_CHAIN[wanted] : undefined;

  let level = undefined;
  let runtimeId = undefined;
  for (const candidate of chain || [DEFAULT_EFFORT, "low", "minimal", "high"]) {
    if (variants[candidate]) {
      level = candidate;
      runtimeId = variants[candidate];
      break;
    }
  }

  if (!runtimeId) {
    runtimeId = familyEntry?.unsuffixed || familyEntry?.family;
    // A `-tiered` bucket IS the unsuffixed entry and carries the level itself,
    // so the level survives; a singleton (claude-sonnet-4-6) has none to carry.
    if (runtimeId !== familyEntry?.tiered) level = undefined;
    else level = wanted && wanted !== "off" ? wanted : DEFAULT_EFFORT;
  }
  if (!runtimeId) return undefined;

  const thinkingLevel = runtimeId === familyEntry?.tiered && level ? tierForThinkingLevel(level) : undefined;
  return { id: runtimeId, thinkingLevel };
}

/**
 * The tiered buckets accept the level as generationConfig.thinkingConfig.thinkingLevel.
 * `xhigh` has no bucket upstream and collapses onto `high`.
 */
function tierForThinkingLevel(level) {
  if (level === "xhigh") return "high";
  if (level === "minimal") return "low";
  return level;
}
