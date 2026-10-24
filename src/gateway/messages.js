import { claudeEnvelope, relayClientRequest } from "./relay.js";
import { FORMATS, translateResponse } from "../translator/index.js";
import { estimateTokens, normalizeUsage } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";

/**
 * Non-streaming body for an Anthropic client. A native Anthropic message from a
 * Claude-format upstream is returned untouched: the round trip through the
 * OpenAI pivot format drops thinking blocks and their signatures (which the
 * next tool-use turn must send back), cache usage, and stop_sequence.
 */
async function upstreamResponseToClaude(upstreamRes, targetFormat, targetModel) {
  const contentType = upstreamRes.headers.get("content-type") || "";
  if (targetFormat === FORMATS.CLAUDE && contentType.includes("application/json")) {
    const text = await upstreamRes.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (data?.type === "message" && Array.isArray(data.content)) return data;
    upstreamRes = new Response(text, { status: upstreamRes.status, headers: upstreamRes.headers });
  }
  const openAIData = await upstreamResponseToOpenAI(upstreamRes, targetFormat, targetModel);
  return translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openAIData, targetModel);
}

const upstreamBaseUrl = (provider, targetFormat) =>
  targetFormat === FORMATS.OPENAI
    ? provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions"
    : provider.transport?.messagesUrl ||
      provider.transport?.baseUrl ||
      "https://api.anthropic.com/v1/messages";

function isWarmupRequest(body) {
  // Only intercept explicit warmup probes ("Warmup"). A longer conversation
  // is real work. Topic-naming requests (isNewTopic) are deliberately NOT
  // intercepted so the client receives a real generated topic from upstream.
  if (!body || !Array.isArray(body.messages) || body.messages.length !== 1) return false;

  const firstMsg = body.messages[0];
  const firstContent = typeof firstMsg.content === "string"
    ? firstMsg.content
    : (Array.isArray(firstMsg.content) ? firstMsg.content.map((c) => c.text || "").join(" ") : "");

  return firstContent.trim().toLowerCase() === "warmup";
}

function createSyntheticWarmupStream(model) {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_warmup",
        type: "message",
        role: "assistant",
        content: [],
        model: model || "claude-3-5-sonnet",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Warmup OK" },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({
      type: "message_stop",
    })}\n\n`,
  ];

  return new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(new TextEncoder().encode(ev));
      }
      controller.close();
    },
  });
}

function sanitizeClaudeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const sanitizedContent = msg.content.map((part) => {
      if (part && typeof part === "object" && part.type === "tool_use") {
        if (!part.name || typeof part.name !== "string" || part.name.trim() === "") {
          return { ...part, name: "tool_call" };
        }
      }
      return part;
    });
    return { ...msg, content: sanitizedContent };
  });
}

/**
 * Intercept explicit Claude Code warmup request ("Warmup") and repair tool names
 * before the body is routed. Runs before routing, so it may rewrite the body.
 */
function beforeRoute(body, c) {
  body.messages = sanitizeClaudeMessages(body.messages);

  if (!isWarmupRequest(body)) return null;

  if (body.stream) {
    return new Response(createSyntheticWarmupStream(body.model), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  return c.json(
    {
      id: "msg_synthetic_warmup",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "Warmup OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    200
  );
}

/**
 * Handle POST /v1/messages (Anthropic Claude format)
 */
export async function handleMessages(c) {
  return relayClientRequest(c, {
    sourceFormat: FORMATS.CLAUDE,
    defaultFormat: FORMATS.CLAUDE,
    baseUrlFor: upstreamBaseUrl,
    extraHeaders: (ctx) => {
      const beta = ctx.req.header("anthropic-beta");
      return beta ? { "anthropic-beta": beta } : null;
    },
    validate: (body) => Boolean(body && body.model && Array.isArray(body.messages)),
    missingFieldMessage: "Missing required 'model' or 'messages' field",
    envelope: claudeEnvelope,
    beforeRoute,
    streamFormat: "claude",
    // Claude clients cannot declare Responses custom tools either.
    transformOptions: () => ({ customToolNames: new Set() }),
    estimateInputTokens: (body) => estimateTokens(body.messages),
    finalize: async ({ upstreamRes, targetFormat, targetModel }) => {
      const data = await upstreamResponseToClaude(upstreamRes, targetFormat, targetModel);
      return { data, usage: normalizeUsage(data.usage) };
    },
  });
}
