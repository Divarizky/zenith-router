function openaiToolToClaude(tool) {
  if (!tool || tool.type !== "function") return null;
  const fn = tool.function || {};
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters || { type: "object", properties: {} },
  };
}

function claudeContentToOpenAI(content) {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [{ role: "user", content: typeof content === "object" ? JSON.stringify(content) : String(content) }];

  const textParts = [];
  const toolResults = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && part.text) textParts.push(part.text);
    if (part.type === "tool_result") {
      toolResults.push({
        role: "tool",
        tool_call_id: part.tool_use_id,
        content: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
      });
    }
  }

  const messages = [];
  if (textParts.length > 0) messages.push({ role: "user", content: textParts.join("\n") });
  messages.push(...toolResults);
  return messages;
}

function openaiMessageToClaude(msg) {
  if (msg.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      }],
    };
  }

  if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
    const content = [];
    if (msg.content) {
      content.push(typeof msg.content === "string"
        ? { type: "text", text: msg.content }
        : { type: "text", text: JSON.stringify(msg.content) });
    }
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input: typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments || "{}")
          : (tc.function?.arguments || {}),
      });
    }
    return { role: "assistant", content };
  }

  return { role: msg.role === "assistant" ? "assistant" : "user", content: msg.content };
}

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
  if (body.tools && Array.isArray(body.tools)) {
    const tools = body.tools.map(openaiToolToClaude).filter(Boolean);
    if (tools.length > 0) result.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (tc === "auto" || tc === "any" || tc === "none") {
      result.tool_choice = { type: tc === "any" ? "any" : tc };
    } else if (tc && typeof tc === "object" && tc.type === "function") {
      result.tool_choice = { type: "tool", name: tc.function?.name };
    }
  }

  const systemParts = [];

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string"
          ? msg.content
          : (Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("\n") : "");
        if (text) systemParts.push(text);
      } else {
        const converted = openaiMessageToClaude(msg);
        result.messages.push(converted);
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
      if (msg.role === "user") {
        messages.push(...claudeContentToOpenAI(msg.content));
      } else {
        messages.push({ role: "assistant", content: msg.content });
      }
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
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (tc.type === "auto" || tc.type === "any" || tc.type === "none") {
      result.tool_choice = tc.type;
    } else if (tc.type === "tool") {
      result.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }

  return result;
}
