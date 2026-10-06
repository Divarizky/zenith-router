import { resolveModel } from "../providers/index.js";
import { getExecutor } from "../executors/base.js";
import {
  translateRequest,
  translateResponse,
  createTransformStream,
  FORMATS,
} from "../translator/index.js";
import {
  getActiveConnection,
  applyConnectionAuth,
  markConnectionCooldown,
} from "../services/auth.js";

/**
 * Handle POST /v1/chat/completions (OpenAI client format)
 */
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

  // Resolve target provider and model
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
  const executor = getExecutor(provider);

  const targetFormat = provider.format || provider.transport?.format || FORMATS.OPENAI;
  const upstreamPayload = translateRequest(FORMATS.OPENAI, targetFormat, body, targetModel);

  const upstreamUrl = provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";
  const upstreamHeaders = {
    "Content-Type": "application/json",
    ...(provider.transport?.headers || {}),
  };

  // If upstream is Claude, set Anthropic version header
  if (targetFormat === FORMATS.CLAUDE && !upstreamHeaders["Anthropic-Version"]) {
    upstreamHeaders["Anthropic-Version"] = "2023-06-01";
  }

  // Pick connection from local DB if available
  const connection = getActiveConnection(provider.id);
  if (connection) {
    applyConnectionAuth(upstreamHeaders, connection);
  }

  // Pass incoming authorization or api-key as override if client supplied one
  const authHeader = c.req.header("authorization");
  const xApiKey = c.req.header("x-api-key");
  if (authHeader) upstreamHeaders["Authorization"] = authHeader;
  if (xApiKey) upstreamHeaders["x-api-key"] = xApiKey;

  try {
    const upstreamRes = await executor.execute({
      url: upstreamUrl,
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamPayload),
      signal: c.req.raw.signal,
    });

    // Handle rate-limit cooldown
    if (upstreamRes.status === 429 && connection?.id) {
      markConnectionCooldown(connection.id, 60000);
    }

    // Handle upstream error response
    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      let errJson;
      try {
        errJson = JSON.parse(errText);
      } catch {
        errJson = {
          error: {
            message: errText || `Upstream returned HTTP ${upstreamRes.status}`,
            type: "upstream_error",
            code: `http_${upstreamRes.status}`,
          },
        };
      }
      return c.json(errJson, upstreamRes.status);
    }

    // Handle streaming response
    if (body.stream) {
      let responseStream = upstreamRes.body;
      if (targetFormat !== FORMATS.OPENAI) {
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, FORMATS.OPENAI, targetModel)
        );
      }

      return new Response(responseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Handle non-streaming response
    const rawResData = await upstreamRes.json();
    const finalData = translateResponse(targetFormat, FORMATS.OPENAI, rawResData, targetModel);
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
