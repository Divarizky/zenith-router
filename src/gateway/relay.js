/**
 * One client request relayed to an upstream in the client's own format.
 *
 * The three client endpoints (/v1/chat/completions, /v1/messages,
 * /v1/responses) share one skeleton: read the body, validate it, route it,
 * stream it back through the transform + usage tap + guard, or record usage for
 * a non-streaming answer. Only the wire shapes differ. That skeleton lives
 * here so the endpoints declare their format instead of repeating it.
 *
 * What an endpoint supplies:
 * - sourceFormat / defaultFormat / baseUrlFor, and whether it needs the OpenAI
 *   usage chunk in the upstream stream.
 * - envelope: the client's own error shape (OpenAI or Claude).
 * - validate + missingFieldMessage: the endpoint's required fields.
 * - transformOptions + estimateInputTokens: how the pivot and the usage tap see
 *   this request.
 * - finalize: turn a non-streaming upstream response into the client payload
 *   plus the usage to record.
 * - beforeRoute (optional): intercept the request before routing, e.g. the
 *   Claude Code warmup probe.
 */

import { routeRequest } from "./route.js";
import { clientSessionKey } from "./session.js";
import { createTransformStream } from "../translator/index.js";
import { recordUsage, createUsageTapStream } from "../services/usage.js";
import { guardStream } from "../services/streamGuard.js";

/** Error envelope for the OpenAI-shaped clients. */
export const openAIEnvelope = {
  invalidJson: () => ({
    error: {
      message: "Invalid JSON in request body",
      type: "invalid_request_error",
      code: "bad_request",
    },
  }),
  missingField: (message) => ({
    error: { message, type: "invalid_request_error", code: "bad_request" },
  }),
  notFound: (model) => ({
    error: {
      message: `Model '${model}' not found in registry`,
      type: "invalid_request_error",
      code: "model_not_found",
    },
  }),
  internal: (err) => ({
    error: {
      message: `Internal gateway error: ${err.message}`,
      type: "gateway_error",
      code: "internal_error",
    },
  }),
};

/** Error envelope for the Anthropic-shaped client. */
export const claudeEnvelope = {
  invalidJson: () => ({
    type: "error",
    error: { type: "invalid_request_error", message: "Invalid JSON in request body" },
  }),
  missingField: (message) => ({
    type: "error",
    error: { type: "invalid_request_error", message },
  }),
  notFound: (model) => ({
    type: "error",
    error: { type: "not_found_error", message: `Model '${model}' not found in registry` },
  }),
  internal: (err) => ({
    type: "error",
    error: { type: "api_error", message: `Internal gateway error: ${err.message}` },
  }),
};

export async function relayClientRequest(c, spec) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json(spec.envelope.invalidJson(), 400);
  }

  if (!spec.validate(body)) {
    return c.json(spec.envelope.missingField(spec.missingFieldMessage), 400);
  }

  try {
    const intercepted = spec.beforeRoute ? await spec.beforeRoute(body, c) : null;
    if (intercepted) return intercepted;

    const routed = await routeRequest({
      model: body.model,
      body,
      signal: c.req.raw.signal,
      sourceFormat: spec.sourceFormat,
      defaultFormat: spec.defaultFormat,
      tokenSaverHeader: c.req.header("x-zenith-token-saver"),
      extraHeaders: spec.extraHeaders ? spec.extraHeaders(c) : null,
      withUsageChunk: Boolean(spec.withUsageChunk),
      streamOptions: spec.withUsageChunk ? body.stream_options : undefined,
      baseUrlFor: spec.baseUrlFor,
      sessionKey: clientSessionKey({ header: (n) => c.req.header(n), body, apiKeyId: c.get("apiKeyId") }),
    });

    if (routed.notFound) {
      return c.json(spec.envelope.notFound(body.model), 404);
    }

    if (!routed.ok) {
      return routed.response;
    }

    const { provider, targetModel, targetFormat, upstreamRes, connection, startTime, comboName, fallbackFrom } = routed;
    const apiKeyId = c.get("apiKeyId") || null;

    if (body.stream) {
      let responseStream = upstreamRes.body;
      // Same format means the body passed through untouched, so the stream is
      // already the client's protocol and only needs the usage tap.
      if (targetFormat !== spec.sourceFormat) {
        responseStream = responseStream.pipeThrough(
          createTransformStream(targetFormat, spec.sourceFormat, targetModel, spec.transformOptions(body))
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
          estimatedInputTokens: spec.estimateInputTokens(body),
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
        new Response(responseStream, { status: 200, headers: streamHeaders }),
        {
          signal: c.req.raw.signal,
          label: `${provider?.id || "upstream"} ${targetModel}`,
          format: spec.streamFormat,
        }
      );
    }

    const { data, usage } = await spec.finalize({ upstreamRes, targetFormat, targetModel, body });

    const durationMs = Date.now() - startTime;
    queueMicrotask(() => {
      recordUsage({
        connectionId: connection?.id,
        apiKeyId,
        provider: provider?.id,
        comboName,
        fallbackFrom,
        model: targetModel,
        ...usage,
        durationMs,
      });
    });

    if (connection?.name) {
      c.header("X-Zenith-Account", connection.name);
    }
    return c.json(data, 200);
  } catch (err) {
    return c.json(spec.envelope.internal(err), 500);
  }
}
