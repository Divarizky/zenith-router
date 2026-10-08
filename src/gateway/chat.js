import { resolveModel } from "../providers/index.js";
import { getExecutor } from "../executors/base.js";
import { opencodePathForModel } from "../executors/opencode.js";
import {
  translateRequest,
  translateResponse,
  createTransformStream,
  FORMATS,
} from "../translator/index.js";
import { captureLine } from "../services/logger.js";
import { recordUsage, createUsageTapStream, estimateTokens } from "../services/usage.js";
import { applyTokenSaver, tokenSaverOptions } from "../services/tokenSaver.js";
import { getAllSettings } from "../services/settings.js";
import { executeWithFallback } from "../services/fallback.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";

export async function handleChat(c) {
  let body;
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json(
      {
        error: {
          message: "Invalid JSON in request body",
          type: "invalid_request_error",
          code: "bad_request",
        },
      },
      400
    );
  }

  if (!body || !body.model || !Array.isArray(body.messages)) {
    return c.json(
      {
        error: {
          message: "Missing or invalid 'model' or 'messages' parameter",
          type: "invalid_request_error",
          code: "bad_request",
        },
      },
      400
    );
  }

  const resolved = resolveModel(body.model);
  if (!resolved || !resolved.provider) {
    return c.json(
      {
        error: {
          message: `Model '${body.model}' not found in registry`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      404
    );
  }

  const { provider, targetModel } = resolved;
  captureLine(`[CHAT] model=${body.model} -> provider=${provider.id} (${targetModel}) stream=${Boolean(body.stream)}`);
  const startTime = Date.now();
  const executor = getExecutor(provider);

  let targetFormat = provider.format || provider.transport?.format || FORMATS.OPENAI;
  if (provider.id === "opencode") {
    const path = opencodePathForModel(targetModel);
    if (path.endsWith("/responses")) targetFormat = FORMATS.OPENAI_RESPONSES;
    else if (path.endsWith("/messages")) targetFormat = FORMATS.CLAUDE;
  }
  const clientStream = Boolean(body.stream);
  const upstreamStream = clientStream || Boolean(provider.transport?.forceStream);
  const translatedPayload = translateRequest(
    FORMATS.OPENAI,
    targetFormat,
    { ...body, stream: upstreamStream },
    targetModel
  );

  const upstreamPayload = applyTokenSaver(
    translatedPayload,
    targetFormat,
    tokenSaverOptions(getAllSettings(), c.req.header("x-zenroute-token-saver"))
  );

  if (upstreamStream && targetFormat === FORMATS.OPENAI) {
    upstreamPayload.stream_options = { include_usage: true, ...(body.stream_options || {}) };
  }

  const baseHeaders = {
    "Content-Type": "application/json",
    ...(provider.transport?.headers || {}),
  };

  if (targetFormat === FORMATS.CLAUDE && !baseHeaders["Anthropic-Version"]) {
    baseHeaders["Anthropic-Version"] = "2023-06-01";
  }

  const upstreamUrlBase = provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";

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
        let url = upstreamUrlBase;
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
      if (targetFormat !== FORMATS.OPENAI) {
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.OPENAI, targetModel)
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

    const finalData = await upstreamResponseToOpenAI(upstreamRes, targetFormat, targetModel);

    const durationMs = Date.now() - startTime;
    const inputTokens = finalData.usage?.prompt_tokens || finalData.usage?.input_tokens || 0;
    const outputTokens = finalData.usage?.completion_tokens || finalData.usage?.output_tokens || 0;
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
        error: {
          message: `Internal gateway error: ${err.message}`,
          type: "gateway_error",
          code: "internal_error",
        },
      },
      500
    );
  }
}
