import { logQuiet } from "./logger.js";
import { isStreamErrorEvent } from "./streamProbe.js";

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

function midstreamErrorFrame(format, event, label) {
  const source = event?.error && typeof event.error === "object" ? event.error : event || {};
  const retryAfter = Number(source.retry_after ?? event?.retry_after);
  const message = source.message || event?.message || "Upstream stream returned an error";
  const rateLimited =
    source.reason === "rate_limited" ||
    event?.reason === "rate_limited" ||
    source.status === 429 ||
    event?.status === 429 ||
    /rate.?limit|fair.?share|quota/i.test(message);
  const fairShare = rateLimited && /^nous(?:\s|$)/i.test(String(label || ""));
  const error = {
    message,
    type: rateLimited ? "rate_limit_error" : source.type || "upstream_error",
    code: fairShare ? "fair_share_rate_limited" : rateLimited ? "rate_limited" : source.code || "upstream_stream_error",
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retry_after: Math.ceil(retryAfter) } : {}),
  };
  if (format === "claude") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: error.type, message: error.message, ...(error.retry_after ? { retry_after: error.retry_after } : {}) } })}\n\n`;
  }
  if (format === "responses") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", code: error.code, message: error.message, ...(error.retry_after ? { retry_after: error.retry_after } : {}) })}\n\n`;
  }
  return `data: ${JSON.stringify({ error })}\n\n`;
}

function parseCompleteSseBlock(block) {
  const eventName = block.match(/(?:^|\r?\n)event:\s*([^\r\n]*)/)?.[1]?.trim() || "";
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return { eventName, event: null };
  try {
    return { eventName, event: JSON.parse(data) };
  } catch {
    return eventName === "error"
      ? { eventName, event: { type: "error", message: data, raw: true } }
      : { eventName, event: null };
  }
}

/**
 * Convert an upstream error event that arrives after answer bytes have already
 * been sent into the client's protocol, then close the stream. Fallback is not
 * safe after the first token, so the same response must terminate explicitly.
 */
function normalizeMidstreamErrors(res, format, label, onError) {
  const contentType = res?.headers?.get?.("content-type") || "";
  if (!res?.body || !contentType.includes("text/event-stream")) return res;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let pending = "";
  let stopped = false;

  const body = new ReadableStream({
    async pull(controller) {
      if (stopped) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          pending += decoder.decode();
          if (pending) controller.enqueue(textEncoder.encode(pending));
          stopped = true;
          controller.close();
          return;
        }
        pending += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = pending.match(/\r?\n\r?\n/);
          if (!boundary) break;
          const end = boundary.index + boundary[0].length;
          const block = pending.slice(0, end);
          pending = pending.slice(end);
          const parsed = parseCompleteSseBlock(block);
          if (parsed.event && isStreamErrorEvent(parsed.eventName, parsed.event)) {
            logQuiet(`[zenith] Stream error from ${label}: phase=midstream code=${parsed.event?.error?.code || parsed.event?.reason || "upstream_error"}`, "warn");
            try {
              onError?.({ event: parsed.event, phase: "midstream" });
            } catch {}
            controller.enqueue(textEncoder.encode(midstreamErrorFrame(format, parsed.event, label)));
            stopped = true;
            await reader.cancel();
            controller.close();
            return;
          }
          controller.enqueue(textEncoder.encode(block));
        }
      } catch (err) {
        stopped = true;
        try {
          controller.error(err);
        } catch {}
      }
    },
    cancel(reason) {
      stopped = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Wrap an SSE response body so an upstream reset ends the stream instead of
 * throwing into the HTTP writer. @hono/node-server prints a raw stack whenever
 * a response body errors mid-write, which polluted the CLI on every dropped
 * provider connection. Here the failure goes to the dashboard console only, an
 * error frame in the client's protocol is appended, and the stream closes.
 */
export function guardStream(res, { signal, label = "upstream", format = "openai", onError } = {}) {
  if (!res?.body) return res;
  const normalized = normalizeMidstreamErrors(res, format, label, onError);
  const reader = normalized.body.getReader();

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

  return new Response(body, { status: normalized.status, statusText: normalized.statusText, headers: normalized.headers });
}
