import { resolveModel } from "../providers/index.js";
import { getExecutor } from "../executors/base.js";
import {
  translateRequest,
  translateResponse,
  createTransformStream,
  FORMATS,
} from "../translator/index.js";
import { recordUsage, createUsageTapStream, estimateTokens } from "../services/usage.js";
import { applyTokenSaver, tokenSaverOptions } from "../services/tokenSaver.js";
import { getAllSettings } from "../services/settings.js";
import { executeWithFallback } from "../services/fallback.js";

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
  const startTime = Date.now();
  const executor = getExecutor(provider);

  const targetFormat = provider.format || provider.transport?.format || FORMATS.OPENAI;
  const translatedPayload = translateRequest(FORMATS.OPENAI, targetFormat, body, targetModel);

  const upstreamPayload = applyTokenSaver(
    translatedPayload,
    targetFormat,
    tokenSaverOptions(getAllSettings(), c.req.header("x-zenroute-token-saver"))
  );

  if (body.stream && targetFormat === FORMATS.OPENAI) {
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

    const rawResData = await upstreamRes.json();
    const finalData = translateResponse(targetFormat, FORMATS.OPENAI, rawResData, targetModel);

    const durationMs = Date.now() - startTime;
    const inputTokens = finalData.usage?.prompt_tokens || finalData.usage?.input_tokens || 0;
    const outputTokens = finalData.usage?.completion_tokens || finalData.usage?.output_tokens || 0;
    queueMicrotask(() => {
      recordUsage({
        connectionId: connection?.id,
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
