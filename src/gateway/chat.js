import { routeRequest } from "./route.js";
import { clientSessionKey } from "./session.js";
import { createTransformStream, FORMATS } from "../translator/index.js";
import { recordUsage, createUsageTapStream, estimateTokens } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";

const upstreamBaseUrl = (provider) =>
  provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";

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

  try {
    const routed = await routeRequest({
      model: body.model,
      body,
      signal: c.req.raw.signal,
      sourceFormat: FORMATS.OPENAI,
      defaultFormat: FORMATS.OPENAI,
      tokenSaverHeader: c.req.header("x-zenith-token-saver"),
      withUsageChunk: true,
      streamOptions: body.stream_options,
      baseUrlFor: upstreamBaseUrl,
      sessionKey: clientSessionKey({ header: (n) => c.req.header(n), body, apiKeyId: c.get("apiKeyId") }),
    });

    if (routed.notFound) {
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

    if (!routed.ok) {
      return routed.response;
    }

    const { provider, targetModel, targetFormat, upstreamRes, connection, startTime, comboName } = routed;
    const apiKeyId = c.get("apiKeyId") || null;

    if (body.stream) {
      let responseStream = upstreamRes.body;
      if (targetFormat !== FORMATS.OPENAI) {
        // Chat clients cannot declare Responses custom tools, so their set is
        // empty: upstream function_call items must never reach them as
        // custom_tool_call even when another client registered the same name.
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.OPENAI, targetModel, {
            customToolNames: new Set(),
            // OpenAI spec: the final usage chunk is sent only when requested.
            includeUsage: Boolean(body.stream_options?.include_usage),
          })
        );
      }

      responseStream = responseStream.pipeThrough(
        createUsageTapStream({
          connectionId: connection?.id,
          apiKeyId,
          provider: provider?.id,
          comboName,
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
        provider: provider?.id,
        comboName,
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
