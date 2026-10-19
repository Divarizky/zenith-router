import { routeRequest } from "./route.js";
import { clientSessionKey } from "./session.js";
import { translateResponse, createTransformStream, FORMATS } from "../translator/index.js";
import { recordUsage, createUsageTapStream, estimateTokens, normalizeUsage } from "../services/usage.js";
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
 * Handle POST /v1/messages (Anthropic Claude format)
 */
export async function handleMessages(c) {
  let body;
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON in request body",
        },
      },
      400
    );
  }

  if (!body || !body.model || !Array.isArray(body.messages)) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Missing required 'model' or 'messages' field",
        },
      },
      400
    );
  }

  body.messages = sanitizeClaudeMessages(body.messages);

  // Intercept explicit Claude Code warmup request ("Warmup")
  if (isWarmupRequest(body)) {
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

  try {
    const routed = await routeRequest({
      model: body.model,
      body,
      signal: c.req.raw.signal,
      sourceFormat: FORMATS.CLAUDE,
      defaultFormat: FORMATS.CLAUDE,
      tokenSaverHeader: c.req.header("x-zenith-token-saver"),
      extraHeaders: c.req.header("anthropic-beta") ? { "anthropic-beta": c.req.header("anthropic-beta") } : null,
      baseUrlFor: upstreamBaseUrl,
      sessionKey: clientSessionKey({ header: (n) => c.req.header(n), body, apiKeyId: c.get("apiKeyId") }),
    });

    if (routed.notFound) {
      return c.json(
        {
          type: "error",
          error: {
            type: "not_found_error",
            message: `Model '${body.model}' not found in registry`,
          },
        },
        404
      );
    }

    if (!routed.ok) {
      return routed.response;
    }

    const { provider, targetModel, targetFormat, upstreamRes, connection, startTime, comboName, fallbackFrom } = routed;
    const apiKeyId = c.get("apiKeyId") || null;

    if (body.stream) {
      let responseStream = upstreamRes.body;
      if (targetFormat !== FORMATS.CLAUDE) {
        // Claude clients cannot declare Responses custom tools either.
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.CLAUDE, targetModel, { customToolNames: new Set() })
        );
      }

      responseStream = responseStream.pipeThrough(
        createUsageTapStream({
          connectionId: connection?.id,
          apiKeyId,
          provider: provider?.id,
          comboName,
          fallbackFrom,
          model: targetModel,
          startTime,
          estimatedInputTokens: estimateTokens(body.messages),
        })
      );

      const streamHeaders = {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      };
      if (connection?.name) {
        streamHeaders["X-Zenith-Account"] = connection.name;
      }

      return new Response(responseStream, {
        status: 200,
        headers: streamHeaders,
      });
    }

    const finalData = await upstreamResponseToClaude(upstreamRes, targetFormat, targetModel);

    const durationMs = Date.now() - startTime;
    const usage = normalizeUsage(finalData.usage);
    queueMicrotask(() => {
      recordUsage({
        connectionId: connection?.id,
        apiKeyId,
        provider: provider?.id,
        comboName,
        fallbackFrom,
        model: targetModel,
        ...usage,
        durationMs,
      });
    });

    if (connection?.name) {
      c.header("X-Zenith-Account", connection.name);
    }
    return c.json(finalData, 200);
  } catch (err) {
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: `Internal gateway error: ${err.message}`,
        },
      },
      500
    );
  }
}
