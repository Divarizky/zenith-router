import { logQuiet } from "./logger.js";

const encoder = new TextEncoder();

/** Short reason for a body-stream failure, e.g. `terminated [ECONNRESET]`. */
export function describeStreamError(err) {
  if (typeof err === "string") return err;
  const cause = err?.cause && typeof err.cause === "object" ? err.cause : {};
  const code = cause.code || err?.code;
  const reason = err?.message || "unknown error";
  return code ? `${reason} [${code}]` : reason;
}

/**
 * SSE frame that reports a truncated stream in the client's own protocol, so
 * agents see a failure instead of a silently finished answer. `format` matches
 * the gateway handler: openai (chat), claude (messages), responses.
 */
export function streamErrorFrame(format, err) {
  const message = `Upstream stream interrupted: ${describeStreamError(err)}`;
  if (format === "claude") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
  }
  if (format === "responses") {
    return `event: error\ndata: ${JSON.stringify({
      type: "error",
      code: "upstream_stream_reset",
      message,
      param: null,
      sequence_number: 0,
    })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message, type: "upstream_error", code: "upstream_stream_reset" } })}\n\n`;
}

/**
 * Wrap an SSE response body so an upstream reset ends the stream instead of
 * throwing into the HTTP writer. @hono/node-server prints a raw stack whenever
 * a response body errors mid-write, which polluted the CLI on every dropped
 * provider connection. Here the failure goes to the dashboard console only, an
 * error frame in the client's protocol is appended, and the stream closes.
 */
export function guardStream(res, { signal, label = "upstream", format = "openai" } = {}) {
  if (!res?.body) return res;
  const reader = res.body.getReader();

  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // A client hang-up (or an already-cancelled stream) has nobody left to
        // report to; only a real upstream reset is worth logging.
        if (!signal?.aborted && controller.desiredSize !== null) {
          logQuiet(`[zenith] Stream reset from ${label}: ${describeStreamError(err)}`, "warn");
          try {
            controller.enqueue(encoder.encode(streamErrorFrame(format, err)));
          } catch {}
        }
        try {
          controller.close();
        } catch {}
        try {
          await reader.cancel(err);
        } catch {}
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
