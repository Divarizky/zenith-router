import { routeRequest } from "./route.js";
import { clientSessionKey } from "./session.js";
import { createTransformStream, FORMATS } from "../translator/index.js";
import { recordUsage, createUsageTapStream, estimateResponsesInputTokens } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";
import { guardStream } from "../services/streamGuard.js";
import { openAIMessageToResponsesOutput, aggregateResponsesStream, customToolNamesFromBody } from "../translator/responses.js";

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

  // The raw Responses body is routed as-is: a Responses upstream receives it
  // verbatim, and a chat/Claude/Gemini/Kiro upstream gets the pivot
  // inside translateRequest per member — including after a combo failover.
  try {
    const routed = await routeRequest({
      model: rawBody.model,
      body: rawBody,
      signal: c.req.raw.signal,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
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
            message: `Model '${rawBody.model}' not found in registry`,
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

    const { provider, targetModel, targetFormat, upstreamRes, connection, startTime, comboName, fallbackFrom } = routed;
    const apiKeyId = c.get("apiKeyId") || null;

    if (rawBody.stream) {
      let responseStream = upstreamRes.body;
      if (targetFormat !== FORMATS.OPENAI_RESPONSES) {
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.OPENAI_RESPONSES, targetModel, {
            customToolNames: customToolNamesFromBody(rawBody),
          })
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
          estimatedInputTokens: estimateResponsesInputTokens(rawBody),
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

      return guardStream(
        new Response(responseStream, {
          status: 200,
          headers: streamHeaders,
        }),
        {
          signal: c.req.raw.signal,
          label: `${provider?.id || "upstream"} ${targetModel}`,
          format: "responses",
        }
      );
    }

    // Responses upstream answering a Responses client: the JSON body is the
    // client's own protocol, so it is returned untouched. Responses backends
    // always stream, so a non-streaming client gets the events aggregated.
    if (targetFormat === FORMATS.OPENAI_RESPONSES) {
      const contentType = upstreamRes.headers.get("content-type") || "";
      const rawText = await upstreamRes.text();
      const data = contentType.includes("event-stream") || /^\s*(data|event):/m.test(rawText)
        ? aggregateResponsesStream(rawText, targetModel)
        : JSON.parse(rawText);
      const inputTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;
      queueMicrotask(() => {
        recordUsage({
          connectionId: connection?.id,
          apiKeyId,
          provider: provider?.id,
          comboName,
          fallbackFrom,
          model: targetModel,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - startTime,
        });
      });
      if (connection?.name) {
        c.header("X-Zenith-Account", connection.name);
      }
      return c.json(data, 200);
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
        fallbackFrom,
        model: targetModel,
        inputTokens,
        outputTokens,
        durationMs,
      });
    });

    if (connection?.name) {
      c.header("X-Zenith-Account", connection.name);
    }
    const responsesFormat = {
      id: finalData.id || `resp_${Date.now()}`,
      object: "response",
      status: "completed",
      model: targetModel,
      output: openAIMessageToResponsesOutput(finalData.choices?.[0]?.message, {
        customToolNames: customToolNamesFromBody(rawBody),
      }),
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
