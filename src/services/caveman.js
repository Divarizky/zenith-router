/**
 * Caveman System Prompt Compaction Injector.
 *
 * Exported surface here exists for the unit tests of this pure function. The
 * pipeline entry point is `applyTokenSaver` in tokenSaver.js: production opts
 * into Caveman through `tokenSaverOptions(settings).caveman`, never by calling
 * these functions directly.
 */

export const CAVEMAN_PROMPT =
  "Respond with high technical density and minimal filler. Omit conversational pleasantries, repetition, and preamble. State facts, solutions, code, and direct answers plainly.";

/** True when the Caveman instruction is already present, so it is not added twice. */
export function hasCaveman(text) {
  if (!text || typeof text !== "string") return false;
  return (
    text.includes("minimal filler") ||
    text.includes("high technical density") ||
    text.includes("caveman")
  );
}

/**
 * Inject Caveman prompt into request body (supporting both OpenAI and Claude formats)
 */
export function injectCaveman(body, format = "openai") {
  if (!body) return body;

  // Handle Anthropic Claude format
  if (format === "claude") {
    if (typeof body.system === "string") {
      if (hasCaveman(body.system)) return body;
      return {
        ...body,
        system: `${body.system}\n\n${CAVEMAN_PROMPT}`,
      };
    }

    if (Array.isArray(body.system)) {
      const alreadyHas = body.system.some((b) => b && hasCaveman(b.text));
      if (alreadyHas) return body;
      return {
        ...body,
        system: [...body.system, { type: "text", text: CAVEMAN_PROMPT }],
      };
    }

    return {
      ...body,
      system: CAVEMAN_PROMPT,
    };
  }

  // Handle OpenAI format
  if (!Array.isArray(body.messages)) return body;

  const messages = [...body.messages];
  const systemIdx = messages.findIndex((m) => m && m.role === "system");

  if (systemIdx !== -1) {
    const sysMsg = messages[systemIdx];
    if (typeof sysMsg.content === "string") {
      if (hasCaveman(sysMsg.content)) return body;
      messages[systemIdx] = {
        ...sysMsg,
        content: `${sysMsg.content}\n\n${CAVEMAN_PROMPT}`,
      };
    }
  } else {
    // Prepend new system message
    messages.unshift({
      role: "system",
      content: CAVEMAN_PROMPT,
    });
  }

  return {
    ...body,
    messages,
  };
}
