import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Readable } from "node:stream";

/**
 * Build a Proxy-Authorization header value from proxy URL userinfo, or null.
 */
function proxyAuthValue(proxy) {
  if (!proxy.username || !proxy.password) return null;
  const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

/**
 * Strip the proxy password and full proxy URL from an error message before it
 * reaches the client. Returns the original error when nothing needs masking.
 * Exported for direct unit testing.
 */
export function sanitizeError(err, proxy) {
  const msg = err?.message || String(err);
  const pass = proxy.password ? decodeURIComponent(proxy.password) : "";
  let safe = msg;
  // Full URL first (it contains the password), then any bare password that
  // remains outside the URL.
  if (proxy.href !== proxy.origin) safe = safe.replaceAll(proxy.href, proxy.origin);
  if (pass) safe = safe.replaceAll(pass, "***");
  if (safe === msg) return err;
  const e = new Error(safe);
  e.cause = err;
  return e;
}

/**
 * Execute HTTP/HTTPS fetch through an HTTP proxy without third-party dependencies.
 *
 * - Sends Proxy-Authorization when the proxy URL carries user:pass credentials.
 * - Honors AbortSignal in every phase, including the CONNECT negotiation, so a
 *   proxy that accepts TCP but never answers the tunnel request ends with a
 *   timeout (via the caller's headers timeout) instead of hanging forever.
 * - Error messages are sanitized so the proxy password never leaks to the client.
 */
export async function proxyFetch(targetUrl, options = {}, proxyUrl) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);

  if (options.signal?.aborted) {
    throw options.signal.reason || new Error("Request aborted");
  }

  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : { ...(options.headers || {}) };
  const auth = proxyAuthValue(proxy);

  const isHttps = target.protocol === "https:";
  const targetPort = target.port || (isHttps ? 443 : 80);
  const proxyPort = Number(proxy.port || 80);

  return new Promise((resolve, reject) => {
    const fail = (err) => reject(sanitizeError(err, proxy));

    // If target is HTTP, send standard proxy request
    if (!isHttps) {
      const reqOptions = {
        host: proxy.hostname,
        port: proxyPort,
        method,
        path: target.href, // full URL for HTTP forward proxy
        headers: {
          ...headers,
          Host: target.host,
          ...(auth ? { "Proxy-Authorization": auth } : {}),
        },
      };

      const req = http.request(reqOptions, (res) => {
        const webStream = Readable.toWeb(res);
        resolve(
          new Response(webStream, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "",
            headers: new Headers(res.headers),
          })
        );
      });

      req.on("error", fail);
      if (options.signal) {
        options.signal.addEventListener("abort", () => req.destroy(new Error("Request aborted")), { once: true });
      }
      if (options.body) {
        req.write(options.body);
      }
      req.end();
      return;
    }

    // If target is HTTPS, create CONNECT tunnel through the proxy
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...(auth ? { "Proxy-Authorization": auth } : {}),
      },
    });

    // Abort must reach the CONNECT phase too: a proxy that accepts TCP but
    // never answers the tunnel request would otherwise hang forever.
    const onAbort = () => connectReq.destroy(new Error("Request aborted"));
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    connectReq.on("connect", (res, socket, head) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
      }

      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
      });

      const reqOptions = {
        method,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          Host: target.host,
        },
        createConnection: () => tlsSocket,
      };

      const req = https.request(reqOptions, (upstreamRes) => {
        const webStream = Readable.toWeb(upstreamRes);
        resolve(
          new Response(webStream, {
            status: upstreamRes.statusCode || 200,
            statusText: upstreamRes.statusMessage || "",
            headers: new Headers(upstreamRes.headers),
          })
        );
      });

      req.on("error", fail);
      if (options.signal) {
        options.signal.addEventListener("abort", () => req.destroy(new Error("Request aborted")), { once: true });
      }
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });

    connectReq.on("error", fail);
    connectReq.end();
  });
}
