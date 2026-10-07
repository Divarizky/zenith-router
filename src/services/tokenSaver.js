import { condenseMessages } from "./rtk.js";
import { injectCaveman } from "./caveman.js";

/**
 * Apply token saver pipeline (RTK + Caveman) with fail-open guarantee
 */
export function applyTokenSaver(body, format = "openai", options = {}) {
  if (!body || typeof body !== "object") return body;

  // Bypass if explicitly disabled via option or header
  if (options.enabled === false || options.headerDisabled === true) {
    return body;
  }

  try {
    let optimized = { ...body };

    // 1. RTK: Condense repeating lines in messages
    if (Array.isArray(optimized.messages)) {
      const { messages } = condenseMessages(optimized.messages);
      optimized.messages = messages;
    }

    // 2. Caveman: Inject conciseness prompt
    if (options.caveman !== false) {
      optimized = injectCaveman(optimized, format);
    }

    return optimized;
  } catch (err) {
    console.error("[zenroute] Token saver pipeline failed, failing open:", err.message);
    return body;
  }
}
