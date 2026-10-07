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

function convertResponsesToChatBody(body) {
  const messages = [];

  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item) continue;
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (typeof item === "object") {
        const role = item.role || (item.type === "message" ? "user" : "user");
        let content = "";
        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content.map((c) => c.text || JSON.stringify(c)).join("\n");
        }
        messages.push({ role, content });
      }
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: " " });
  }

  return {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    tools: body.tools,
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
  };
}

export async function handleResponses(c) {
  let rawBody;
  try {
    rawBody = await c.req.json();
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

  if (!rawBody || !rawBody.model) {
    return c.json(
      {
        error: {
          message: "Missing required 'model' parameter",
          type: "invalid_request_error",
          code: "bad_request",
        },
      },
      400
    );
  }

  const chatBody = convertResponsesToChatBody(rawBody);

  const resolved = resolveModel(chatBody.model);
  if (!resolved || !resolved.provider) {
    return c.json(
      {
        error: {
          message: `Model '${chatBody.model}' not found in registry`,
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
  const translatedPayload = translateRequest(FORMATS.OPENAI, targetFormat, chatBody, targetModel);

  const upstreamPayload = applyTokenSaver(
    translatedPayload,
    targetFormat,
    tokenSaverOptions(getAllSettings(), c.req.header("x-zenroute-token-saver"))
  );

  if (chatBody.stream && targetFormat === FORMATS.OPENAI) {
    upstreamPayload.stream_options = { include_usage: true, ...(rawBody.stream_options || {}) };
  }

  const baseHeaders = {
    "Content-Type": "application/json",
    ...(provider.transport?.headers || {}),
  };

  if (targetFormat === FORMATS.CLAUDE && !baseHeaders["Anthropic-Version"]) {
    baseHeaders["Anthropic-Version"] = "2023-06-01";
  }

  const upstreamUrlBase = provider.transport?.responsesUrl || provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";

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
    const apiKeyId = c.get("apiKeyId") || null;

    if (chatBody.stream) {
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
          estimatedInputTokens: estimateTokens(chatBody.messages),
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
        apiKeyId,
        model: targetModel,
        inputTokens,
        outputTokens,
        durationMs,
      });
    });

    const responsesFormat = {
      id: finalData.id || `resp_${Date.now()}`,
      object: "response",
      status: "completed",
      model: targetModel,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: finalData.choices?.[0]?.message?.content || "",
            },
          ],
        },
      ],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };

    return c.json(responsesFormat, 200);
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
