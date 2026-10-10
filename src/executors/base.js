import { proxyFetch } from "./proxy.js";

let customExecutor = null;
const EXECUTORS = new Map();

// Non-streaming LLM calls only return headers after the full generation, so the headers wait must be generous.
const DEFAULT_HEADERS_TIMEOUT_MS = Number(process.env.ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS) || 300000;
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.ZENITH_UPSTREAM_IDLE_TIMEOUT_MS) || 120000;

function timeoutError(message) {
  return new DOMException(message, "TimeoutError");
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

    let headersTimedOut = false;
    const headersTimer = setTimeout(() => {
      headersTimedOut = true;
      abort(timeoutError(`Upstream did not respond within ${headersTimeout}ms`));
    }, headersTimeout);

    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("Content-Type") && typeof body === "string") {
      requestHeaders.set("Content-Type", "application/json");
    }

    const init = { method, headers: requestHeaders, body, signal: controller.signal };

    let response;
    try {
      response = proxyUrl ? await proxyFetch(url, init, proxyUrl) : await this.fetchFn(url, init);
    } catch (err) {
      detachClientSignal();
      if (headersTimedOut || err.name === "TimeoutError") {
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

      return new Response(
        JSON.stringify({
          error: {
            message: `Upstream transport failed: ${err.message}`,
            type: "transport_error",
            code: "bad_gateway",
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    } finally {
      clearTimeout(headersTimer);
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
