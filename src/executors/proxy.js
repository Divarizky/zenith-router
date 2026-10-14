import http from "node:http";
import https from "node:https";
import net from "node:net";
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
  const origin = proxy.origin && proxy.origin !== "null"
    ? proxy.origin
    : `${proxy.protocol}//${proxy.host}`;
  // Full URL first (it contains the password), then any bare password that
  // remains outside the URL.
  if (proxy.href !== origin) safe = safe.replaceAll(proxy.href, origin);
  if (pass) safe = safe.replaceAll(pass, "***");
  if (safe === msg) return err;
  const e = new Error(safe);
  e.cause = err;
  return e;
}

export const SOCKS5_REPLY_ERRORS = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

/**
 * Read exactly `length` bytes from a readable socket using Node.js paused-mode stream.
 */
function readExactBytes(socket, length) {
  return new Promise((resolve, reject) => {
    const chunk = socket.read(length);
    if (chunk) return resolve(chunk);

    const onReadable = () => {
      const chunk = socket.read(length);
      if (chunk) {
        cleanup();
        resolve(chunk);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SOCKS5 connection closed unexpectedly"));
    };

    function cleanup() {
      socket.removeListener("readable", onReadable);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("end", onClose);
    }

    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("end", onClose);
  });
}

/**
 * Establish a TCP tunnel through a SOCKS5 proxy server (RFC 1928, RFC 1929)
 * using Node.js built-in `node:net` without external dependencies.
 *
 * - Always resolves destination hostname on the proxy (ATYP 0x03 DOMAINNAME)
 *   to prevent local DNS leaks.
 * - Supports anonymous (0x00) and username/password (0x02) authentication.
 * - Honors AbortSignal during connection, greeting, auth, and connect command.
 */
export async function connectSocks5({ proxy, targetHost, targetPort, signal }) {
  const proxyUrl = typeof proxy === "string" ? new URL(proxy) : proxy;
  if (signal?.aborted) {
    throw signal.reason || new Error("Request aborted");
  }

  const proxyPort = Number(proxyUrl.port || 1080);
  const proxyHost = proxyUrl.hostname;

  const socket = new net.Socket();

  let onAbort = null;
  if (signal) {
    onAbort = () => socket.destroy(signal.reason || new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("SOCKS5 connection closed during connect"));
      };
      function cleanup() {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      }
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.connect(proxyPort, proxyHost);
    });

    // 1. Send greeting
    const hasAuth = Boolean(proxyUrl.username || proxyUrl.password);
    const greeting = hasAuth
      ? Buffer.from([0x05, 0x02, 0x00, 0x02])
      : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(greeting);

    const greetingRes = await readExactBytes(socket, 2);
    if (greetingRes[0] !== 0x05) {
      throw new Error(`Invalid SOCKS5 greeting version: 0x${greetingRes[0].toString(16)}`);
    }
    const chosenMethod = greetingRes[1];
    if (chosenMethod === 0xff) {
      throw new Error("SOCKS5 authentication method negotiation failed (no acceptable methods)");
    }

    // 2. Authenticate if required
    if (chosenMethod === 0x02) {
      const username = decodeURIComponent(proxyUrl.username || "");
      const password = decodeURIComponent(proxyUrl.password || "");
      const uBuf = Buffer.from(username);
      const pBuf = Buffer.from(password);
      if (uBuf.length > 255 || pBuf.length > 255) {
        throw new Error("SOCKS5 username and password must be <= 255 bytes");
      }
      const authReq = Buffer.concat([
        Buffer.from([0x01, uBuf.length]),
        uBuf,
        Buffer.from([pBuf.length]),
        pBuf,
      ]);
      socket.write(authReq);

      const authRes = await readExactBytes(socket, 2);
      if (authRes[1] !== 0x00) {
        throw new Error(`SOCKS5 authentication failed with status ${authRes[1]}`);
      }
    } else if (chosenMethod !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method selected by server: 0x${chosenMethod.toString(16)}`);
    }

    // 3. Send CONNECT request with domain name (ATYP 0x03)
    const domainBuf = Buffer.from(targetHost);
    if (domainBuf.length > 255) {
      throw new Error("Target host length must be <= 255 bytes for SOCKS5 domain name");
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(Number(targetPort), 0);
    const connectReq = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
      domainBuf,
      portBuf,
    ]);
    socket.write(connectReq);

    // 4. Read CONNECT response
    const head = await readExactBytes(socket, 4);
    if (head[0] !== 0x05) {
      throw new Error(`Invalid SOCKS5 connect response version: 0x${head[0].toString(16)}`);
    }
    const rep = head[1];
    if (rep !== 0x00) {
      const errMsg = SOCKS5_REPLY_ERRORS[rep] || `error code 0x${rep.toString(16)}`;
      throw new Error(`SOCKS5 connect failed: ${errMsg}`);
    }

    const atyp = head[3];
    let remaining = 0;
    if (atyp === 0x01) {
      remaining = 6; // 4 bytes IPv4 + 2 bytes port
    } else if (atyp === 0x04) {
      remaining = 18; // 16 bytes IPv6 + 2 bytes port
    } else if (atyp === 0x03) {
      const lenBuf = await readExactBytes(socket, 1);
      remaining = lenBuf[0] + 2;
    } else {
      throw new Error(`Unsupported SOCKS5 address type: 0x${atyp.toString(16)}`);
    }

    if (remaining > 0) {
      await readExactBytes(socket, remaining);
    }

    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort);
    }
    return socket;
  } catch (err) {
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort);
    }
    socket.destroy();
    throw err;
  }
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
