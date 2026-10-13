import { routeRequest } from "./route.js";
import { clientSessionKey } from "./session.js";
import { createTransformStream, FORMATS } from "../translator/index.js";
import { recordUsage, createUsageTapStream, estimateTokens } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";

const upstreamBaseUrl = (provider) =>
  provider.transport?.responsesUrl ||
  provider.transport?.baseUrl ||
  "https://api.openai.com/v1/chat/completions";

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
    max_tokens: body.max_tokens ?? body.max_output_tokens,
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
