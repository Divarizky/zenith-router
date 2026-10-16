import { createTransformStream, translateResponse, FORMATS, normalizeFormat } from "../translator/index.js";

function decodeSSE(text) {
  const events = [];
  for (const part of text.split(/\r?\n\r?\n/)) {
    let data = "";
    for (const line of part.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("data:")) data += t.slice(5).trim();
    }
    if (data && data !== "[DONE]") {
      try {
        events.push(JSON.parse(data));
      } catch {}
    }
  }
  return events;
}

function aggregateOpenAISSE(text, model) {
  const events = decodeSSE(text);
  let id = null;
  let created = Math.floor(Date.now() / 1000);
  let role = "assistant";
  let content = "";
  let reasoning = "";
  const toolMap = new Map();
  let finishReason = null;
  let usage = null;

  for (const ev of events) {
    id = id || ev.id;
    created = ev.created || created;
    const choice = ev.choices?.[0] || {};
    const delta = choice.delta || {};
    const message = choice.message || {};
    if (delta.role) role = delta.role;
    if (typeof delta.content === "string") content += delta.content;
    // Thinking models stream their chain-of-thought as reasoning_content (the
    // executor normalizes delta.reasoning into it); keep it for non-streaming
    // clients instead of dropping it during aggregation.
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    else if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
    if (typeof message.content === "string" && !content) content = message.content;
    if (!reasoning && typeof message.reasoning_content === "string") reasoning = message.reasoning_content;
    if (message.role) role = message.role;
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) toolMap.set(tc.id || tc.index || toolMap.size, tc);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = tc.index ?? (tc.id || toolMap.size);
        const prev = toolMap.get(key) || { id: tc.id, type: tc.type || "function", function: { name: "", arguments: "" } };
        if (tc.id) prev.id = tc.id;
        if (tc.type) prev.type = tc.type;
        if (tc.function?.name) prev.function.name += tc.function.name;
        if (tc.function?.arguments) prev.function.arguments += tc.function.arguments;
        toolMap.set(key, prev);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (ev.usage) usage = ev.usage;
  }

  const tool_calls = Array.from(toolMap.values()).map((tc) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
    type: tc.type || "function",
    function: {
      name: tc.function?.name || "",
      arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
    },
  }));

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model: model || "unknown",
    choices: [
      {
        index: 0,
        message: {
          role,
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        },
        finish_reason: finishReason || (tool_calls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function unwrapClineEnvelope(data, targetModel) {
  if (!data || typeof data !== "object" || !("success" in data)) return null;
  const payload = data.data ?? data.result;

  if (data.success === false) {
    return {
      error: {
        message: data.error?.message || data.message || "Upstream request failed",
        type: data.error?.type || "upstream_error",
        code: data.error?.code || data.code || "upstream_error",
      },
    };
  }

  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return aggregateOpenAISSE(payload, targetModel);
    }
  }

  return payload || data;
}

export async function upstreamResponseToOpenAI(upstreamRes, targetFormat, targetModel) {
  const src = normalizeFormat(targetFormat);
  const contentType = upstreamRes.headers.get("content-type") || "";

  if (contentType.includes("application/json") && src !== FORMATS.KIRO) {
    const data = await upstreamRes.json();
    const unwrapped = unwrapClineEnvelope(data, targetModel);
    const normalized = unwrapped || data;
    return src === FORMATS.OPENAI ? normalized : translateResponse(src, FORMATS.OPENAI, normalized, targetModel);
  }

  const translated = upstreamRes.body.pipeThrough(createTransformStream(src, FORMATS.OPENAI, targetModel));
  const text = await new Response(translated).text();
  try {
    return JSON.parse(text);
  } catch {
    return aggregateOpenAISSE(text, targetModel);
  }
}
