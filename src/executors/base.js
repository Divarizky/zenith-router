import { proxyFetch } from "./proxy.js";

let customExecutor = null;
const EXECUTORS = new Map();

// Non-streaming LLM calls only return headers after the full generation, so the headers wait must be generous.
const DEFAULT_HEADERS_TIMEOUT_MS = Number(process.env.ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS) || 300000;
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.ZENITH_UPSTREAM_IDLE_TIMEOUT_MS) || 120000;

// Resets on a socket the upstream closed while it sat idle. Nothing reached the
// upstream application, so one retry on a fresh connection is safe. DNS and
// connect failures are not retried: a second attempt there only adds latency.
const TRANSPORT_RETRY_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
const TRANSPORT_ATTEMPTS = 2;

function timeoutError(message) {
  return new DOMException(message, "TimeoutError");
}

function transportErrorCode(err) {
  if (!err || typeof err !== "object") return null;
  return err.cause?.code || err.code || null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-host";
  }
}

/**
 * Names the failing step (DNS, TCP, TLS, socket) instead of the bare "fetch failed".
 * Undici throws a plain string when the caller aborts with a string reason.
 */
function transportFailureMessage(err, url) {
  const reason = typeof err === "string" ? err : err?.message || "unknown error";
  const cause = err?.cause && typeof err.cause === "object" ? err.cause : {};
  const detail = [cause.code || err?.code, cause.syscall].filter(Boolean).join(" ");
  return `Upstream transport failed: ${reason}${detail ? ` [${detail}]` : ""} host=${hostOf(url)}`;
}

/**
 * Wrap an upstream body so the idle timer only runs while waiting for the next upstream chunk.
 * A long but steady stream is never cut; a stalled one is aborted.
 */
function watchBodyIdle(body, idleMs, abort, onDone) {
  const reader = body.getReader();
  let timer = null;

  const stop = () => {
    clearTimeout(timer);
    onDone();
  };

  return new ReadableStream({
    async pull(controller) {
      timer = setTimeout(() => abort(timeoutError(`Upstream stream idle for ${idleMs}ms`)), idleMs);
      timer.unref?.();
      try {
        const { done, value } = await reader.read();
        clearTimeout(timer);
        if (done) {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        stop();
        controller.error(err);
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
}

/**
 * Set custom executor (useful for testing and mocks)
 */
export function setCustomExecutor(executor) {
  customExecutor = executor;
}

/**
 * Base Executor for HTTP requests to upstream providers
 */
export class BaseExecutor {
  constructor(options = {}) {
    this.headersTimeoutMs = options.headersTimeoutMs || options.timeoutMs || DEFAULT_HEADERS_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Execute an HTTP request. `timeoutMs` bounds the wait for response headers;
   * after that, only upstream silence longer than the idle timeout aborts the body.
   */
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl }) {
    const headersTimeout = timeoutMs || this.headersTimeoutMs;
    const controller = new AbortController();
    const abort = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };

    const onClientAbort = () => abort(signal.reason);
    if (signal) {
      if (signal.aborted) abort(signal.reason);
      else signal.addEventListener("abort", onClientAbort, { once: true });
    }
    const detachClientSignal = () => signal?.removeEventListener("abort", onClientAbort);

    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("Content-Type") && typeof body === "string") {
      requestHeaders.set("Content-Type", "application/json");
    }

    const init = { method, headers: requestHeaders, body, signal: controller.signal };
    // A stream body is consumed by the first attempt, so only buffered bodies can be sent twice.
    const isReplayable = body === undefined || body === null || typeof body === "string";

    let response;
    for (let attempt = 1; ; attempt++) {
      let headersTimedOut = false;
      const headersTimer = setTimeout(() => {
        headersTimedOut = true;
        abort(timeoutError(`Upstream did not respond within ${headersTimeout}ms`));
      }, headersTimeout);

      try {
        response = proxyUrl ? await proxyFetch(url, init, proxyUrl) : await this.fetchFn(url, init);
        break;
      } catch (err) {
        // The client hung up, so no account should be penalised for a request nobody awaits.
        if (signal?.aborted) {
          detachClientSignal();
          return new Response(
            JSON.stringify({
              error: {
                message: "Client closed the request before upstream responded",
                type: "client_closed",
                code: "client_closed_request",
              },
            }),
            { status: 499, headers: { "Content-Type": "application/json" } }
          );
        }

        if (headersTimedOut || err?.name === "TimeoutError") {
          detachClientSignal();
          return new Response(
            JSON.stringify({
              error: {
                message: `Upstream request timed out after ${headersTimeout}ms`,
                type: "timeout_error",
                code: "gateway_timeout",
              },
            }),
            { status: 504, headers: { "Content-Type": "application/json" } }
          );
        }

        const code = transportErrorCode(err);
        if (attempt < TRANSPORT_ATTEMPTS && isReplayable && TRANSPORT_RETRY_CODES.has(code)) {
          console.warn(`[UPSTREAM] ${code} on ${hostOf(url)}, retrying once on a new connection`);
          continue;
        }

        detachClientSignal();
        return new Response(
          JSON.stringify({
            error: {
              message: transportFailureMessage(err, url),
              type: "transport_error",
              code: "bad_gateway",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      } finally {
        clearTimeout(headersTimer);
      }
    }

    if (!response.body) {
      detachClientSignal();
      return response;
    }

    return new Response(watchBodyIdle(response.body, this.idleTimeoutMs, abort, detachClientSignal), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

const defaultExecutorInstance = new BaseExecutor();

/**
 * Register a custom provider executor
 */
export function registerExecutor(id, executor) {
  EXECUTORS.set(id, executor);
}

/**
 * Get active executor for a provider
 */
export function getExecutor(provider) {
  if (customExecutor) return customExecutor;
  if (provider?.executor && EXECUTORS.has(provider.executor)) {
    return EXECUTORS.get(provider.executor);
  }
  if (provider?.id && EXECUTORS.has(provider.id)) {
    return EXECUTORS.get(provider.id);
  }
  return defaultExecutorInstance;
}
