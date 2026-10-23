/**
 * Model catalog for the DeepSeek web chat.
 *
 * The web endpoint takes no `model` field: the mode is chosen by
 * `thinking_enabled` (and `search_enabled`), so these ids are gateway labels that
 * map onto a flag. `deepseek-chat` stays the default because a tool-calling agent
 * pays the reasoning latency on every turn, while `deepseek-reasoner` opts into
 * thinking and surfaces it as `reasoning_content`.
 */
export const DEEPSEEK_WEB_MODELS = [
  { id: "deepseek-chat", name: "DeepSeek Chat (web)", thinking: false },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner (web)", thinking: true },
];

const THINKING_HINTS = /reason|think|\br1\b|deepseek-r/;

/**
 * Map a requested id onto a catalog entry. Unknown ids fall back to the chat
 * mode unless their name clearly asks for reasoning, so older clients that
 * spell the reasoner differently still get thinking.
 */
export function resolveDeepSeekModel(id) {
  const name = String(id || "").trim().toLowerCase();
  const exact = DEEPSEEK_WEB_MODELS.find((model) => model.id === name);
  if (exact) return exact;
  if (THINKING_HINTS.test(name)) return DEEPSEEK_WEB_MODELS[1];
  return DEEPSEEK_WEB_MODELS[0];
}
