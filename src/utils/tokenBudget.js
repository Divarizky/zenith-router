export const MIN_ANSWER_TOKENS = 1024;
export const THINKING_BUDGET = 4096;
export const MAX_OUTPUT_TOKENS = 131072;
export const MIN_PLAIN_TOKENS = 512;

export const REASONING_MODEL_HINTS = [
  "muse",
  "mimo",
  "nemotron",
  "longcat",
  "cat-jam",
  "pickle",
  "step-",
  "deepseek",
];

export function isReasoningModel(modelId) {
  const id = String(modelId || "").toLowerCase();
  return REASONING_MODEL_HINTS.some((hint) => id.includes(hint));
}

export function isReasoningRequest(body, modelId) {
  if (isReasoningModel(modelId)) return true;
  const effort = body && body.reasoning_effort;
  return Boolean(effort) && effort !== "none";
}

export function parseRequestedTokens(requested) {
  if (requested === undefined || requested === null || typeof requested === "boolean") {
    return MAX_OUTPUT_TOKENS;
  }
  if (typeof requested === "string" && requested.trim() === "") {
    return MAX_OUTPUT_TOKENS;
  }
  const raw = Number(requested);
  if (!Number.isFinite(raw) || raw < 0) {
    return MAX_OUTPUT_TOKENS;
  }
  return Math.floor(raw);
}

/**
 * Effective output budget. `maxOutput` lets the caller pick the lane clamp:
 * the chat lane accepts 131072, while the /responses lane rejects anything
 * above 65536 (enforced by prepareResponsesBody). The client's value is raised
 * to the floor/thinking headroom, but capped at the lane's ceiling.
 */
export function effectiveMaxTokens(requested, modelId, body, maxOutput = MAX_OUTPUT_TOKENS) {
  const wanted = parseRequestedTokens(requested);
  const ceiling = Math.min(maxOutput, MAX_OUTPUT_TOKENS);

  const effective = isReasoningRequest(body, modelId)
    ? Math.max(wanted, MIN_ANSWER_TOKENS) + THINKING_BUDGET
    : Math.max(wanted, MIN_PLAIN_TOKENS);

  return Math.min(effective, ceiling);
}
