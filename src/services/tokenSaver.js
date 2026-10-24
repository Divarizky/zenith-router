import { condenseMessages } from "./rtk.js";
import { injectCaveman } from "./caveman.js";

/**
 * Token saver: the one place that shapes the text of a request.
 *
 * This module is the only production entry point. `rtk.js` and `caveman.js`
 * are pure translation steps reached from here; their exports exist so their
 * own unit tests can exercise them directly, and must not be called by
 * anything else in src/.
 *
 * The order is fixed and the guarantee is fail-open: a step that throws leaves
 * the request untouched rather than failing it.
 */

/**
 * Apply the token saver pipeline (RTK, then Caveman).
 *
 * RTK runs unless disabled; Caveman changes the agent's own system prompt and
 * therefore only runs when explicitly opted in.
 */
export function applyTokenSaver(body, format = "openai", options = {}) {
  if (!body || typeof body !== "object") return body;

  // Bypass if explicitly disabled via option or header
  if (options.enabled === false || options.headerDisabled === true) {
    return body;
  }

  try {
    let optimized = { ...body };

    // 1. RTK: Condense repeating lines in user-typed messages
    if (options.rtk !== false && Array.isArray(optimized.messages)) {
      const { messages } = condenseMessages(optimized.messages);
      optimized.messages = messages;
    }

    // 2. Caveman: Inject conciseness prompt (opt-in)
    if (options.caveman === true) {
      optimized = injectCaveman(optimized, format);
    }

    return optimized;
  } catch (err) {
    console.error("[zenith] Token saver pipeline failed, failing open:", err.message);
    return body;
  }
}

/**
 * Token saver options for one request, from global settings and the per-request bypass header
 */
export function tokenSaverOptions(settings, headerValue) {
  return {
    headerDisabled: headerValue === "false",
    rtk: settings.token_saver_rtk !== "false",
    caveman: settings.token_saver_caveman === "true",
  };
}
