/**
 * Some upstreams (Cline, OpenCode, and others that always stream) answer a rate
 * limit or quota error with HTTP 200 and put the error in the first SSE event.
 * Fallback and combo routing only judge the HTTP status, so such a response
 * would read as a success and the error would reach the client. The probe reads
 * up to the first data event: an error event becomes a real error status, any
 * other event is replayed untouched in front of the rest of the stream.
 */

import { parseSSEBlocks } from "../utils/sse.js";

// Enough for keep-alive comments and a large first chunk; past this the stream
// is passed through as is rather than held back any longer.
const MAX_PROBE_CHARS = 64 * 1024;

function httpStatusFrom(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : null;
}

function errorObject(event) {
  if (event?.error && typeof event.error === "object") return event.error;
  return {};
}

function errorMessage(event) {
  if (typeof event?.error === "string" && event.error) return event.error;
  return errorObject(event).message || event?.message || "Upstream stream returned an error";
}

function isChoiceMeaningful(choice) {
  if (!choice || typeof choice !== "object") return false;
  if (choice.finish_reason && choice.finish_reason !== "error") return true;
  const delta = choice.delta;
  if (!delta || typeof delta !== "object") return false;
  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  return false;
}

/** Is this SSE event an error rather than the start of an answer? */
export function isStreamErrorEvent(eventName, event) {
  if (eventName === "error") return true;
  if (!event || typeof event !== "object") return false;
  if (event.type === "error" || event.success === false) return true;
  if (event.error != null) {
    if (event.choices == null) return true;
    if (Array.isArray(event.choices)) {
      const anyMeaningful = event.choices.some(isChoiceMeaningful);
      if (!anyMeaningful) return true;
      const anyErrorFinish = event.choices.some((c) => c?.finish_reason === "error");
      if (anyErrorFinish) return true;
    }
  }
  return false;
}

/**
 * Does this event carry meaningful content or completion signal, meaning the stream
 * has definitely started answering successfully?
 */
function isMeaningfulEvent(eventName, event) {
  if (!event || typeof event !== "object") return true;
  if (Array.isArray(event.choices)) {
    return event.choices.some(isChoiceMeaningful);
  }
  return true;
}

/**
 * HTTP status for an error event. An explicit 4xx/5xx wins; otherwise a rate
 * limit or quota message maps to 429 so the account cools down, and anything
 * else to 502 so the next account or combo member is still tried.
 */
export function streamErrorStatus(event) {
  const err = errorObject(event);
  const explicit =
    httpStatusFrom(event?.status) ??
    httpStatusFrom(event?.statusCode) ??
    httpStatusFrom(err.status) ??
    httpStatusFrom(err.statusCode) ??
    httpStatusFrom(err.code) ??
    httpStatusFrom(event?.code);
  if (explicit) return explicit;

  const text = `${err.type || ""} ${err.code || ""} ${errorMessage(event)}`;
  if (/rate.?limit|quota|too many requests|exhausted|limit (reached|exceeded)|usage limit/i.test(text)) return 429;
  if (/authentication_error|unauthori[sz]ed|invalid.?api.?key/i.test(text)) return 401;
  return 502;
}

/**
 * Look at the complete events in `text`. Returns null while no data event has
 * arrived yet, otherwise `{ error: null }` or `{ error: { status, payload } }`.
 */
function inspectEvents(text) {
  for (const { event: eventName, data } of parseSSEBlocks(text, { dropIncompleteTail: true })) {
    if (!data || data === "[DONE]") return { error: null };
    let event = null;
    try {
      event = JSON.parse(data);
    } catch {
      return { error: null };
    }
    if (isStreamErrorEvent(eventName, event)) {
      const err = errorObject(event);
      return {
        error: {
          status: streamErrorStatus(event),
          payload: {
            error: {
              message: errorMessage(event),
              type: err.type || "upstream_error",
              code: typeof err.code === "string" ? err.code : "upstream_stream_error",
            },
          },
        },
      };
    }

    if (isMeaningfulEvent(eventName, event)) {
      return { error: null };
    }
    // Chunk seperti `choices:[{delta:{role:"assistant"}}]` tanpa konten/reasoning/finish
    // dilewati agar jika event persis setelahnya membawa pesan error, probe dapat menangkapnya.
  }
  return null;
}

function errorResponse(status, payload, retryAfter) {
  const headers = { "Content-Type": "application/json" };
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(JSON.stringify(payload), { status, headers });
}

/**
 * Return `res` unchanged unless it is a successful SSE response whose first
 * data event is an error, in which case an error Response is returned instead.
 * A client abort while probing is rethrown; any other read failure becomes a
 * 502 so the request moves on to the next account or member.
 */
export async function probeStreamError(res, signal) {
  const contentType = res?.headers?.get?.("content-type") || "";
  if (!res?.ok || !res.body || !contentType.includes("text/event-stream")) return res;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let outcome = null;

  try {
    while (!outcome && text.length <= MAX_PROBE_CHARS) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      text += decoder.decode(value, { stream: true });
      outcome = inspectEvents(text);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    return errorResponse(502, {
      error: {
        message: `Upstream stream failed before the first event: ${err.message}`,
        type: "upstream_error",
        code: "upstream_stream_error",
      },
    });
  }

  if (outcome?.error) {
    reader.cancel().catch(() => {});
    return errorResponse(outcome.error.status, outcome.error.payload, res.headers.get("retry-after"));
  }

  let replayIndex = 0;
  const replayed = new ReadableStream({
    async pull(controller) {
      if (replayIndex < chunks.length) {
        controller.enqueue(chunks[replayIndex++]);
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(replayed, { status: res.status, statusText: res.statusText, headers: res.headers });
}
