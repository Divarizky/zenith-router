import { condenseMessages } from "./rtk.js";
import { injectCaveman } from "./caveman.js";

/**
 * Apply token saver pipeline (RTK + Caveman) with fail-open guarantee.
 * RTK runs unless `rtk: false`; Caveman changes the agent's system prompt, so it only runs with `caveman: true`.
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
