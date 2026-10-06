let customExecutor = null;

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
    this.timeoutMs = options.timeoutMs || 60000;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  /**
   * Execute an HTTP request
   */
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs }) {
    const effectiveTimeout = timeoutMs || this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("Content-Type") && typeof body === "string") {
      requestHeaders.set("Content-Type", "application/json");
    }

    try {
      const response = await this.fetchFn(url, {
        method,
        headers: requestHeaders,
        body,
        signal: combinedSignal,
      });

      return response;
    } catch (err) {
      if (err.name === "TimeoutError") {
        return new Response(
          JSON.stringify({
            error: {
              message: `Upstream request timed out after ${effectiveTimeout}ms`,
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
    }
  }
}

const defaultExecutorInstance = new BaseExecutor();

/**
 * Get active executor for a provider
 */
export function getExecutor(provider) {
  if (customExecutor) return customExecutor;
  return defaultExecutorInstance;
}
