import { resolveModel } from "../providers/index.js";
import { getExecutor } from "../executors/base.js";
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
  const startTime = Date.now();
  const executor = getExecutor(provider);

  const basePayload = {
    ...body,
    model: targetModel,
  };

  // Apply in-process Token Saver (RTK + Caveman) with fail-open
  const disableTokenSaver = c.req.header("x-zenroute-token-saver") === "false";
  const upstreamPayload = applyTokenSaver(basePayload, "claude", {
    headerDisabled: disableTokenSaver,
  });

  const upstreamUrl = provider.transport?.baseUrl || "https://api.anthropic.com/v1/messages";
  const upstreamHeaders = {
    "Content-Type": "application/json",
    "Anthropic-Version": "2023-06-01",
    ...(provider.transport?.headers || {}),
  };

  // Upstream credentials always come from a stored connection; client auth headers are never forwarded
  let connection = getActiveConnection(provider.id);
  if (!connection) {
    return c.json(
      {
        type: "error",
        error: {
          type: "overloaded_error",
          message: `No available connection for provider '${provider.id}'. Add or re-enable one in the dashboard.`,
        },
      },
      503
    );
  }

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

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      let errJson;
      try {
        errJson = JSON.parse(errText);
      } catch {
        errJson = {
          type: "error",
          error: {
            type: "upstream_error",
            message: errText || `Upstream returned HTTP ${upstreamRes.status}`,
          },
        };
      }
      return c.json(errJson, upstreamRes.status);
    }

    if (body.stream) {
      const responseStream = upstreamRes.body.pipeThrough(
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

    const resData = await upstreamRes.json();
    const durationMs = Date.now() - startTime;
    const inputTokens = resData.usage?.input_tokens || 0;
    const outputTokens = resData.usage?.output_tokens || 0;
    queueMicrotask(() => {
      recordUsage({
        connectionId: connection?.id,
        model: targetModel,
        inputTokens,
        outputTokens,
        durationMs,
      });
    });

    return c.json(resData, 200);
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
