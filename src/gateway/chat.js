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
import {
  needsTokenRefresh,
  refreshOAuthToken,
} from "../services/tokenRefresh.js";
import {
  recordUsage,
  createUsageTapStream,
} from "../services/usage.js";
import { applyTokenSaver } from "../services/tokenSaver.js";

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
  const startTime = Date.now();
  const executor = getExecutor(provider);

  const targetFormat = provider.format || provider.transport?.format || FORMATS.OPENAI;
  const translatedPayload = translateRequest(FORMATS.OPENAI, targetFormat, body, targetModel);

  // Apply in-process Token Saver (RTK + Caveman) with fail-open
  const disableTokenSaver = c.req.header("x-zenroute-token-saver") === "false";
  const upstreamPayload = applyTokenSaver(translatedPayload, targetFormat, {
    headerDisabled: disableTokenSaver,
  });

  const upstreamUrl = provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";
  const upstreamHeaders = {
    "Content-Type": "application/json",
    ...(provider.transport?.headers || {}),
  };

  // If upstream is Claude, set Anthropic version header
  if (targetFormat === FORMATS.CLAUDE && !upstreamHeaders["Anthropic-Version"]) {
    upstreamHeaders["Anthropic-Version"] = "2023-06-01";
  }

  // Upstream credentials always come from a stored connection; client auth headers are never forwarded
  let connection = getActiveConnection(provider.id);
  if (!connection) {
    return c.json(
      {
        error: {
          message: `No available connection for provider '${provider.id}'. Add or re-enable one in the dashboard.`,
          type: "service_unavailable",
          code: "no_available_connection",
        },
      },
      503
    );
  }

  // Proactive token refresh if near expiry
  if (needsTokenRefresh(connection)) {
    try {
      const refreshed = await refreshOAuthToken(connection);
      if (refreshed) connection = refreshed;
    } catch (err) {
      console.error(`[zenroute] Proactive refresh error for ${connection.id}:`, err.message);
    }
  }
  applyConnectionAuth(upstreamHeaders, connection);

  try {
    let upstreamRes = await executor.execute({
      url: upstreamUrl,
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamPayload),
      signal: c.req.raw.signal,
      proxyUrl: connection?.proxy_url,
    });

    // Reactive 401/403 token refresh and retry once
    if (
      (upstreamRes.status === 401 || upstreamRes.status === 403) &&
      connection?.auth_type === "oauth" &&
      connection.credentials?.refresh_token
    ) {
      try {
        const refreshed = await refreshOAuthToken(connection);
        if (refreshed) {
          connection = refreshed;
          applyConnectionAuth(upstreamHeaders, connection);
          upstreamRes = await executor.execute({
            url: upstreamUrl,
            method: "POST",
            headers: upstreamHeaders,
            body: JSON.stringify(upstreamPayload),
            signal: c.req.raw.signal,
            proxyUrl: connection?.proxy_url,
          });
        }
      } catch (err) {
        console.error(`[zenroute] Reactive refresh error for ${connection.id}:`, err.message);
      }
    }

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

      responseStream = responseStream.pipeThrough(
        createUsageTapStream({
          connectionId: connection?.id,
          model: targetModel,
          startTime,
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

    // Handle non-streaming response
    const rawResData = await upstreamRes.json();
    const finalData = translateResponse(targetFormat, FORMATS.OPENAI, rawResData, targetModel);

    // Record non-streaming usage asynchronously
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
