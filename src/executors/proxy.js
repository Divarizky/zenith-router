import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";

/**
 * Execute HTTP/HTTPS fetch through an HTTP proxy without third-party dependencies
 */
export async function proxyFetch(targetUrl, options = {}, proxyUrl) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);

  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : { ...(options.headers || {}) };

  const isHttps = target.protocol === "https:";
  const targetPort = target.port || (isHttps ? 443 : 80);
  const proxyPort = Number(proxy.port || 80);

  return new Promise((resolve, reject) => {
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

      req.on("error", reject);
      if (options.signal) {
        options.signal.addEventListener("abort", () => req.destroy(new Error("Request aborted")));
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
      },
    });

    connectReq.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
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

      req.on("error", reject);
      if (options.signal) {
        options.signal.addEventListener("abort", () => req.destroy(new Error("Request aborted")));
      }
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });

    connectReq.on("error", reject);
    connectReq.end();
  });
}
