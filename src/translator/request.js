/**
 * Convert OpenAI request body to Anthropic Claude format
 */
export function openaiToClaude(body, targetModel) {
  const result = {
    model: targetModel || body.model,
    messages: [],
    max_tokens: body.max_tokens || 4096,
  };

  if (body.stream !== undefined) result.stream = body.stream;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  const systemParts = [];

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string"
          ? msg.content
          : (Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("\n") : "");
        if (text) systemParts.push(text);
      } else {
        result.messages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }
  }

  if (systemParts.length > 0) {
    result.system = systemParts.join("\n\n");
  }

  // Ensure at least one message exists for Claude
  if (result.messages.length === 0) {
    result.messages.push({ role: "user", content: " " });
  }

  return result;
}

/**
 * Convert Anthropic Claude request body to OpenAI format
 */
export function claudeToOpenAI(body, targetModel) {
  const messages = [];

  // Extract top-level system field into OpenAI system message
  if (body.system) {
    const sysText = typeof body.system === "string"
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((s) => s.text || "").join("\n\n") : "");
    if (sysText) {
      messages.push({ role: "system", content: sysText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  const result = {
    model: targetModel || body.model,
    messages,
  };

  if (body.max_tokens) result.max_tokens = body.max_tokens;
  if (body.stream !== undefined) result.stream = body.stream;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  return result;
}
