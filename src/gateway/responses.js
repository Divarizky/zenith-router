import { routeRequest } from "./route.js";
import { clientSessionKey } from "./session.js";
import { createTransformStream, FORMATS } from "../translator/index.js";
import { recordUsage, createUsageTapStream, estimateTokens } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";
import { responsesToOpenAIRequest, openAIMessageToResponsesOutput } from "../translator/responses.js";

const upstreamBaseUrl = (provider) =>
  provider.transport?.responsesUrl ||
  provider.transport?.baseUrl ||
  "https://api.openai.com/v1/chat/completions";

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

  const chatBody = responsesToOpenAIRequest(rawBody);

  try {
    const routed = await routeRequest({
      model: chatBody.model,
      body: chatBody,
      signal: c.req.raw.signal,
      sourceFormat: FORMATS.OPENAI,
      defaultFormat: FORMATS.OPENAI,
      tokenSaverHeader: c.req.header("x-zenith-token-saver"),
      withUsageChunk: true,
      streamOptions: rawBody.stream_options,
      baseUrlFor: upstreamBaseUrl,
      sessionKey: clientSessionKey({ header: (n) => c.req.header(n), body: rawBody, apiKeyId: c.get("apiKeyId") }),
    });

    if (routed.notFound) {
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

    if (!routed.ok) {
      return routed.response;
    }

    const { provider, targetModel, targetFormat, upstreamRes, connection, startTime, comboName } = routed;
    const apiKeyId = c.get("apiKeyId") || null;

    if (chatBody.stream) {
      let responseStream = upstreamRes.body;
      if (targetFormat !== FORMATS.OPENAI_RESPONSES) {
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.OPENAI_RESPONSES, targetModel)
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

    const responsesFormat = {
      id: finalData.id || `resp_${Date.now()}`,
      object: "response",
      status: "completed",
      model: targetModel,
      output: openAIMessageToResponsesOutput(finalData.choices?.[0]?.message),
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
