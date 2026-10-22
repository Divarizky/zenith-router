import { resolveCapabilities } from "../providers/capabilities.js";

// Claude reads sampling params on a 0..1 scale; OpenAI-style clients may send
// up to 2. Values out of range are a hard 400 upstream, so they are clamped.
function clampUnitInterval(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

// reasoning_effort -> extended thinking budget (nearest documented tier).
const REASONING_EFFORT_BUDGET = { minimal: 1024, low: 4096, medium: 8192, high: 16384 };
const REASONING_MIN_BUDGET = 1024;

// Last-resort max_tokens when neither the client nor the model table says.
const CLAUDE_MAX_TOKENS_FALLBACK = 4096;

function claudeMaxTokensFor(body, targetModel) {
  const requested = body.max_completion_tokens ?? body.max_tokens;
  const { maxOutput } = resolveCapabilities(targetModel) || {};
  const requestedNum = typeof requested === "number" && !Number.isNaN(requested) ? requested : undefined;
  if (requestedNum === undefined) return maxOutput || CLAUDE_MAX_TOKENS_FALLBACK;
  // A value above the model's published output cap is a hard 400 upstream.
  return maxOutput ? Math.min(requestedNum, maxOutput) : requestedNum;
}

// Parse tool-call arguments without throwing on malformed JSON.
function safeToolArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// OpenAI image_url part -> Claude image/url source block.
function openaiImagePartToClaude(part) {
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  if (typeof url !== "string" || !url) return null;
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return null;
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

function openaiToolResultContentToClaude(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "object" ? JSON.stringify(content) : String(content ?? "");
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
    else if (part.type === "image_url") {
      const img = openaiImagePartToClaude(part);
      if (img) blocks.push(img);
    }
  }
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
  return blocks;
}

function openaiToolToClaude(tool) {
  if (!tool || tool.type !== "function") return null;
  const fn = tool.function || {};
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters || { type: "object", properties: {} },
  };
}

function claudeImageToOpenAI(part) {
  const src = part?.source;
  if (!src || typeof src !== "object") return null;
  if (src.type === "base64" && src.data) {
    const media = src.media_type || "image/png";
    return { type: "image_url", image_url: { url: `data:${media};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

// tool_result content may be a string, an array of text/image blocks, or an
// object. Text is joined into one string. Images are deliberately dropped:
// OpenAI tool messages accept text-only content and reject image parts with a
// 400.
function claudeToolResultToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "object" ? JSON.stringify(content) : String(content);

  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      if (typeof block === "string") texts.push(block);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    // image blocks have no legal place in a tool message; dropped
  }
  return texts.join("\n");
}

// A Claude assistant content array: thinking blocks are dropped, text becomes
// the message content, and each tool_use becomes an OpenAI tool_call. Returns
// null for a thinking-only turn (nothing representable in chat).
function claudeAssistantToOpenAI(content) {
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content)) {
    return { role: "assistant", content: typeof content === "object" ? JSON.stringify(content) : String(content) };
  }

  const textParts = [];
  const toolCalls = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function",
        function: {
          name: block.name || "tool_call",
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking / redacted_thinking / server_tool_use have no chat analogue
  }

  if (textParts.length === 0 && toolCalls.length === 0) return null;

  const message = { role: "assistant", content: textParts.length > 0 ? textParts.join("\n") : null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

// A Claude user/assistant content array becomes OpenAI messages. Tool results
// are emitted as `tool` messages that must sit right after the assistant that
// declared the calls, so they always precede the trailing user text.
function claudeContentToOpenAI(content) {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) {
    return [{ role: "user", content: typeof content === "object" ? JSON.stringify(content) : String(content) }];
  }

  const userParts = [];
  const toolMessages = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      userParts.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const img = claudeImageToOpenAI(part);
      if (img) userParts.push(img);
    } else if (part.type === "tool_result") {
      toolMessages.push({
        role: "tool",
        tool_call_id: part.tool_use_id,
        content: claudeToolResultToOpenAI(part.content),
      });
    }
    // thinking / redacted_thinking / server_tool_use have no chat analogue
  }

  const messages = [];
  messages.push(...toolMessages);
  if (userParts.length > 0) {
    // Keep plain text as a string (max upstream compatibility); only use
    // parts when an image (or other non-text part) is present.
    if (userParts.every((p) => p.type === "text")) {
      messages.push({ role: "user", content: userParts.map((p) => p.text).join("\n") });
    } else {
      messages.push({ role: "user", content: userParts });
    }
  }
  return messages;
}

function openaiMessageToClaude(msg) {
  if (msg.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: openaiToolResultContentToClaude(msg.content),
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
        id: tc.id || `call_${Date.now()}`,
        name: tc.function?.name || "tool_call",
        input: safeToolArguments(tc.function?.arguments),
      });
    }
    return { role: "assistant", content };
  }

  // Array content (OpenAI parts) is normalized for both roles: text parts
  // keep their Claude-compatible shape, image parts only make sense for user
  // messages (Claude assistant turns cannot carry user-image blocks).
  if (Array.isArray(msg.content)) {
    const blocks = [];
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
      else if (part.type === "image_url" && msg.role !== "assistant") {
        const img = openaiImagePartToClaude(part);
        if (img) blocks.push(img);
      }
    }
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (blocks.length === 1 && blocks[0].type === "text") return { role, content: blocks[0].text };
    if (blocks.length > 0) return { role, content: blocks };
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
    max_tokens: claudeMaxTokensFor(body, targetModel),
  };

  // Extended thinking has hard upstream constraints: the budget must fit
  // inside max_tokens, and sampling is locked (temperature 1, no top_p).
  // Reasoning is only requested when the client explicitly asks for it.
  const wantsThinking = typeof body.reasoning_effort === "string" && REASONING_EFFORT_BUDGET[body.reasoning_effort];
  // The budget must fit strictly inside max_tokens with at least one token left
  // for output, so a tiny max_tokens disables thinking rather than violating
  // the constraint upstream.
  const thinkingBudget = wantsThinking && result.max_tokens > REASONING_MIN_BUDGET
    ? Math.min(REASONING_EFFORT_BUDGET[body.reasoning_effort], result.max_tokens - 1)
    : 0;
  if (thinkingBudget) {
    result.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  }

  if (body.stream !== undefined) result.stream = body.stream;
  if (thinkingBudget) {
    result.temperature = 1;
  } else {
    const temperature = clampUnitInterval(body.temperature);
    if (temperature !== undefined) result.temperature = temperature;
    const topP = clampUnitInterval(body.top_p);
    if (topP !== undefined) result.top_p = topP;
  }
  if (Array.isArray(body.stop) && body.stop.length > 0) result.stop_sequences = body.stop;
  if (typeof body.stop === "string" && body.stop) result.stop_sequences = [body.stop];
  if (body.tools && Array.isArray(body.tools)) {
    const tools = body.tools.map(openaiToolToClaude).filter(Boolean);
    if (tools.length > 0) result.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (tc === "auto" || tc === "any" || tc === "none" || tc === "required") {
      result.tool_choice = { type: tc === "any" || tc === "required" ? "any" : tc };
    } else if (tc && typeof tc === "object" && tc.type === "function") {
      result.tool_choice = { type: "tool", name: tc.function?.name };
    }
  } else if (result.tools && body.parallel_tool_calls === false) {
    // OpenAI exposes parallel control as a boolean; Claude folds it into the
    // forced tool_choice object.
    result.tool_choice = { type: "auto", disable_parallel_tool_use: true };
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

  // Claude Code sends metadata.user_id as the account/session identity. The
  // upstream checks it against x-claude-code-session-id, so it has to travel
  // with the request; other providers never see it.
  if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) {
    result.metadata = { user_id: body.metadata.user_id };
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
      } else if (msg.role === "assistant") {
        const converted = claudeAssistantToOpenAI(msg.content);
        if (converted) messages.push(converted);
      } else {
        // developer/system-ish roles keep their role and text
        const text = typeof msg.content === "string" ? msg.content : (Array.isArray(msg.content) ? msg.content.map((c) => c?.text || "").join("\n") : "");
        messages.push({ role: msg.role, content: text });
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
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences;
  }
  // metadata.user_id (contains the local account/session identifier) is
  // deliberately not forwarded as `user`: it would leak identifiers to
  // third-party providers.
  // body.thinking and body.top_k have no Chat Completions analogue and are
  // deliberately dropped rather than forwarded as-is. translateRequest reads
  // body.thinking itself for the Gemini target (thinkingConfig).
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
