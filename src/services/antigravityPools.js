/**
 * Routing gate for the 5h and weekly pool limits of Antigravity.
 *
 * Pool group names are the displayName values that retrieveUserQuotaSummary returns. That
 * response lists groups but not their models, so a model is mapped to its group by id.
 * A model with no mapped group has no pool and is never blocked here.
 */

const ARGON_GROUP = "Gemini 4 Argon";
const GEMINI_GROUP = "Gemini Models";
const CLAUDE_GPT_GROUP = "Claude and GPT models";

/** Argon is checked first because its ids also start with `gemini-`, and Argon quota is separate. */
export function poolGroupForModel(modelId) {
  if (typeof modelId !== "string") return null;
  if (/argon/i.test(modelId)) return ARGON_GROUP;
  if (/^gemini-/.test(modelId)) return GEMINI_GROUP;
  if (/^(claude-|gpt-oss-)/.test(modelId)) return CLAUDE_GPT_GROUP;
  return null;
}

/**
 * True while one pool window of the model's group is at 0% and its reset is still ahead.
 * A pool without a reset time, or whose reset has passed, does not block: the stored value is
 * stale until the next sync, and the reset time is the only signal that it has refilled.
 */
export function isAntigravityPoolExhausted(quota, modelId, now = Date.now()) {
  const group = poolGroupForModel(modelId);
  const pools = quota?.pools;
  if (!group || !Array.isArray(pools)) return false;
  return pools.some((pool) => pool.group === group && pool.remainingPercentage <= 0 && Date.parse(pool.resetAt) > now);
}
