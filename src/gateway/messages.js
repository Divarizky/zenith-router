import { resolveModel } from "../providers/index.js";
import { getExecutor } from "../executors/base.js";
import { opencodePathForModel } from "../executors/opencode.js";
import { captureLine } from "../services/logger.js";
import { recordUsage, createUsageTapStream, estimateTokens } from "../services/usage.js";
import { applyTokenSaver, tokenSaverOptions } from "../services/tokenSaver.js";
import { getAllSettings } from "../services/settings.js";
import { executeWithFallback } from "../services/fallback.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";
import {
  translateRequest,
  translateResponse,
  createTransformStream,
  FORMATS,
} from "../translator/index.js";

function isWarmupOrNamingRequest(body, userAgent = "") {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return false;

  const firstMsg = body.messages[0];
  const firstContent = typeof firstMsg.content === "string"
    ? firstMsg.content
    : (Array.isArray(firstMsg.content) ? firstMsg.content.map((c) => c.text || "").join(" ") : "");

  if (firstContent.trim() === "Warmup" || firstContent.trim().toLowerCase() === "warmup") {
    return true;
  }

  // Claude Code naming requests
  if (typeof body.system === "string" && body.system.includes("isNewTopic")) {
    return true;
  }
  if (Array.isArray(body.system)) {
    const sysText = body.system.map((s) => s.text || "").join(" ");
    if (sysText.includes("isNewTopic")) return true;
  }

  return false;
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

  const userAgent = c.req.header("user-agent") || "";

  // Intercept Claude Code warmup or naming request
  if (isWarmupOrNamingRequest(body, userAgent)) {
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

  // Resolve target provider and model
  const resolved = resolveModel(body.model);
  if (!resolved || !resolved.provider) {
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

  const { provider, targetModel } = resolved;
  captureLine(`[MESSAGES] model=${body.model} -> provider=${provider.id} (${targetModel}) stream=${Boolean(body.stream)}`);
  const startTime = Date.now();
  const executor = getExecutor(provider);

  let targetFormat = provider.format || provider.transport?.format || FORMATS.CLAUDE;
  if (provider.id === "opencode") {
    const path = opencodePathForModel(targetModel);
    if (path.endsWith("/responses")) targetFormat = FORMATS.OPENAI_RESPONSES;
    else if (path.endsWith("/messages")) targetFormat = FORMATS.CLAUDE;
  }
  const clientStream = Boolean(body.stream);
  const upstreamStream = clientStream || Boolean(provider.transport?.forceStream);
  const translatedPayload = translateRequest(
    FORMATS.CLAUDE,
    targetFormat,
    { ...body, stream: upstreamStream },
    targetModel
  );

  // Apply in-process Token Saver (RTK + Caveman) with fail-open, as configured in Settings
  const upstreamPayload = applyTokenSaver(
    translatedPayload,
    targetFormat,
    tokenSaverOptions(getAllSettings(), c.req.header("x-zenroute-token-saver"))
  );

  const upstreamUrl = targetFormat === FORMATS.OPENAI
    ? (provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions")
    : (provider.transport?.messagesUrl || provider.transport?.baseUrl || "https://api.anthropic.com/v1/messages");
  const baseHeaders = {
    "Content-Type": "application/json",
    ...(provider.transport?.headers || {}),
  };

  if (targetFormat === FORMATS.CLAUDE && !baseHeaders["Anthropic-Version"]) {
    baseHeaders["Anthropic-Version"] = "2023-06-01";
  }

  const anthropicBeta = c.req.header("anthropic-beta");
  if (anthropicBeta) {
    baseHeaders["anthropic-beta"] = anthropicBeta;
  }

  try {
    const result = await executeWithFallback({
      provider,
      targetFormat,
      upstreamPayload,
      baseHeaders,
      executor,
      signal: c.req.raw.signal,
      stream: upstreamStream,
      targetModel,
      resolveUrl: (conn) => {
        let url = upstreamUrl;
        if (url.includes("{accountId}") && conn?.credentials) {
          const acc =
            conn.credentials.account_id ||
            conn.credentials.accountId ||
            (typeof conn.credentials.api_key === "string" && conn.credentials.api_key.includes(":")
              ? conn.credentials.api_key.split(":")[0]
              : "");
          url = url.replace("{accountId}", acc);
        }
        return url;
      },
    });

    if (!result.ok) {
      return result.response;
    }

    const { upstreamRes, connection } = result;
    const apiKeyId = c.get("apiKeyId") || null;

    if (body.stream) {
      let responseStream = upstreamRes.body;
      if (targetFormat !== FORMATS.CLAUDE) {
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.CLAUDE, targetModel)
        );
      }

      responseStream = responseStream.pipeThrough(
        createUsageTapStream({
          connectionId: connection?.id,
          apiKeyId,
          model: targetModel,
          startTime,
          estimatedInputTokens: estimateTokens(body.messages),
        })
      );

      return new Response(responseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const openAIData = await upstreamResponseToOpenAI(upstreamRes, targetFormat, targetModel);
    const finalData = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openAIData, targetModel);

    const durationMs = Date.now() - startTime;
    const inputTokens = finalData.usage?.input_tokens || finalData.usage?.prompt_tokens || 0;
    const outputTokens = finalData.usage?.output_tokens || finalData.usage?.completion_tokens || 0;
    queueMicrotask(() => {
      recordUsage({
        connectionId: connection?.id,
        apiKeyId,
        model: targetModel,
        inputTokens,
        outputTokens,
        durationMs,
      });
    });

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
