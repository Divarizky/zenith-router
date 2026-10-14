import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { BaseExecutor } from "../src/executors/base.js";
import { proxyFetch, connectSocks5, sanitizeError } from "../src/executors/proxy.js";

test("proxyFetch - routes HTTP request through proxy server", async () => {
  let proxyHit = false;

  // Mock forward HTTP proxy
  const proxyServer = http.createServer((req, res) => {
    proxyHit = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ proxied: true, url: req.url }));
  });

  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  try {
    const res = await proxyFetch(
      "http://api.example.com/v1/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello through proxy" }),
      },
      proxyUrl
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(proxyHit, true, "Request must hit proxy server");

    const json = await res.json();
    assert.strictEqual(json.proxied, true);
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
  }
});

test("BaseExecutor - uses proxyFetch when proxyUrl is supplied", async () => {
  let customFetchUsed = false;

  const mockFetch = async () => {
    customFetchUsed = true;
    return new Response(JSON.stringify({ direct: true }), { status: 200 });
  };

  const executor = new BaseExecutor({ fetchFn: mockFetch });

  // Call without proxyUrl should use fetchFn
  const directRes = await executor.execute({
    url: "http://example.com/direct",
  });
  assert.strictEqual(customFetchUsed, true);
  const directJson = await directRes.json();
  assert.strictEqual(directJson.direct, true);

  // Call with proxyUrl should route through proxy
  let proxyReceived = false;
  const proxyServer = http.createServer((req, res) => {
    proxyReceived = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ viaProxy: true }));
  });

  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  try {
    const proxiedRes = await executor.execute({
      url: "http://api.upstream.com/v1",
      proxyUrl,
    });
    assert.strictEqual(proxyReceived, true);
    const json = await proxiedRes.json();
    assert.strictEqual(json.viaProxy, true);
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
  }
});

test("oauthFetch - routes requests through proxyUrl when supplied", async () => {
  const { oauthFetch } = await import("../src/services/oauth/providers.js");
  let proxyCalled = false;

  const proxyServer = http.createServer((req, res) => {
    proxyCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ proxied_oauth: true }));
  });

  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  try {
    const res = await oauthFetch("http://oauth.example.com/token", { method: "POST" }, { proxyUrl });
    assert.strictEqual(proxyCalled, true, "OAuth request must be routed through proxy");
    const json = await res.json();
    assert.strictEqual(json.proxied_oauth, true);
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
  }
});

test("oauthFetch - throws error if proxyUrl fails and does not leak directly", async () => {
  const { oauthFetch } = await import("../src/services/oauth/providers.js");

  // Point to closed/dead port
  const deadProxy = "http://127.0.0.1:49999";

  await assert.rejects(
    async () => {
      await oauthFetch("http://oauth.example.com/token", { method: "POST" }, { proxyUrl: deadProxy });
    },
    /ECONNREFUSED/i,
    "Failing proxy must reject and not fall back to direct internet connection"
  );
});

// ---------------------------------------------------------------------------
// TASK-30: Proxy auth, abort during CONNECT, and password sanitization
// ---------------------------------------------------------------------------

function startTcpServer(onConnection) {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port })
    );
  });
}

test("proxyFetch - sends Proxy-Authorization on HTTP forward when proxy URL has credentials", async () => {
  let capturedAuth = null;
  const proxyServer = http.createServer((req, res) => {
    capturedAuth = req.headers["proxy-authorization"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const port = proxyServer.address().port;
  try {
    await proxyFetch(
      "http://api.example.com/v1",
      { method: "GET" },
      `http://alice:s3cret@127.0.0.1:${port}`
    );
    assert.strictEqual(
      capturedAuth,
      `Basic ${Buffer.from("alice:s3cret").toString("base64")}`
    );
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
  }
});

test("proxyFetch - sends Proxy-Authorization on CONNECT when proxy URL has credentials", async () => {
  let connectRequest = "";
  const { server, port } = await startTcpServer((socket) => {
    socket.on("data", (chunk) => {
      connectRequest += chunk.toString();
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      setTimeout(() => socket.destroy(), 50);
    });
  });
  try {
    // TLS handshake will fail behind this fake tunnel, which is fine — we only
    // need the CONNECT request bytes.
    await assert.rejects(
      proxyFetch("https://api.example.com/", {}, `http://alice:s3cret@127.0.0.1:${port}`)
    );
    assert.ok(
      connectRequest.startsWith("CONNECT api.example.com:443"),
      `unexpected CONNECT line: ${connectRequest.split("\r\n")[0]}`
    );
    const authLine = connectRequest
      .split("\r\n")
      .find((l) => l.toLowerCase().startsWith("proxy-authorization:"));
    assert.ok(authLine, "CONNECT request must carry Proxy-Authorization");
    assert.ok(
      authLine.includes(Buffer.from("alice:s3cret").toString("base64")),
      `auth header mismatch: ${authLine}`
    );
  } finally {
    server.close();
  }
});

test("proxyFetch - abort during CONNECT phase rejects instead of hanging", async () => {
  const sockets = [];
  const { server, port } = await startTcpServer((socket) => sockets.push(socket));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      proxyFetch(
        "https://api.example.com/",
        { signal: controller.signal },
        `http://127.0.0.1:${port}`
      ),
      /abort/i
    );
  } finally {
    sockets.forEach((s) => s.destroy());
    server.close();
  }
});

test("proxyFetch - rejects immediately when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    proxyFetch(
      "https://api.example.com/",
      { signal: controller.signal },
      "http://127.0.0.1:49999"
    ),
    /abort/i
  );
});

test("proxyFetch - rejects with status when proxy refuses CONNECT", async () => {
  const { server, port } = await startTcpServer((socket) => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    });
  });
  try {
    await assert.rejects(
      proxyFetch("https://api.example.com/", {}, `http://alice:s3cret@127.0.0.1:${port}`),
      /407/
    );
  } finally {
    server.close();
  }
});

test("proxyFetch - error messages never contain the proxy password", async () => {
  // CONNECT refused (407)
  const { server, port } = await startTcpServer((socket) => {
    socket.on("data", () => socket.write("HTTP/1.1 407\r\n\r\n"));
  });
  try {
    await assert.rejects(
      proxyFetch("https://api.example.com/", {}, `http://alice:S3cretP4ss@127.0.0.1:${port}`),
      (err) => {
        assert.ok(
          !err.message.includes("S3cretP4ss"),
          `CONNECT refusal must not leak password: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    server.close();
  }
  // Dead proxy, HTTP target
  await assert.rejects(
    proxyFetch("http://api.example.com/", {}, "http://alice:S3cretP4ss@127.0.0.1:49999"),
    (err) => {
      assert.ok(
        !err.message.includes("S3cretP4ss"),
        `dead proxy must not leak password: ${err.message}`
      );
      return true;
    }
  );
});

test("sanitizeError - masks password and full proxy URL in error messages", async () => {
  const proxy = new URL("http://alice:S3cretP4ss@127.0.0.1:9999");
  const masked = sanitizeError(
    new Error("upstream via http://alice:S3cretP4ss@127.0.0.1:9999/ failed"),
    proxy
  );
  assert.ok(!masked.message.includes("S3cretP4ss"), `password leaked: ${masked.message}`);
  assert.ok(
    !masked.message.includes("alice:S3cretP4ss"),
    `userinfo leaked: ${masked.message}`
  );
  assert.ok(masked.message.includes("http://127.0.0.1:9999"), "origin should remain");
  assert.strictEqual(masked.cause.message.includes("S3cretP4ss"), true, "cause preserves original");

  // SOCKS5 URLs (where origin is null in WHATWG URL) should also preserve scheme and host without leaking password
  const socksProxy = new URL("socks5://alice:S3cretP4ss@127.0.0.1:1080");
  const socksMasked = sanitizeError(
    new Error("connect via socks5://alice:S3cretP4ss@127.0.0.1:1080 failed"),
    socksProxy
  );
  assert.ok(!socksMasked.message.includes("S3cretP4ss"), `password leaked: ${socksMasked.message}`);
  assert.ok(socksMasked.message.includes("socks5://127.0.0.1:1080"), "origin should remain for socks5");

  // Without a password nothing is rewritten and the original error is returned.
  const plain = new Error("connect ECONNREFUSED 127.0.0.1:9999");
  assert.strictEqual(sanitizeError(plain, new URL("http://127.0.0.1:9999")), plain);
});

function createMockSocks5Server({ onConnect, expectedUser, expectedPass, rejectCode } = {}) {
  return net.createServer((socket) => {
    let stage = "greeting";
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const nMethods = buffer[1];
        if (buffer.length < 2 + nMethods) return;
        const methods = buffer.subarray(2, 2 + nMethods);
        buffer = buffer.subarray(2 + nMethods);

        if (expectedUser) {
          if (!methods.includes(0x02)) {
            socket.write(Buffer.from([0x05, 0xff]));
            return socket.destroy();
          }
          socket.write(Buffer.from([0x05, 0x02]));
          stage = "auth";
        } else {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = "connect";
        }
      }

      if (stage === "auth") {
        if (buffer.length < 2) return;
        const uLen = buffer[1];
        if (buffer.length < 2 + uLen + 1) return;
        const user = buffer.subarray(2, 2 + uLen).toString();
        const pLen = buffer[2 + uLen];
        if (buffer.length < 2 + uLen + 1 + pLen) return;
        const pass = buffer.subarray(2 + uLen + 1, 2 + uLen + 1 + pLen).toString();
        buffer = buffer.subarray(2 + uLen + 1 + pLen);

        if (user === expectedUser && pass === expectedPass) {
          socket.write(Buffer.from([0x01, 0x00]));
          stage = "connect";
        } else {
          socket.write(Buffer.from([0x01, 0x01]));
          return socket.destroy();
        }
      }

      if (stage === "connect") {
        if (buffer.length < 4) return;
        const atyp = buffer[3];
        let targetHost = "";
        let targetPort = 0;
        let headLen = 0;

        if (atyp === 0x03) {
          if (buffer.length < 5) return;
          const dLen = buffer[4];
          if (buffer.length < 5 + dLen + 2) return;
          targetHost = buffer.subarray(5, 5 + dLen).toString();
          targetPort = buffer.readUInt16BE(5 + dLen);
          headLen = 5 + dLen + 2;
        } else if (atyp === 0x01) {
          if (buffer.length < 10) return;
          targetHost = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
          targetPort = buffer.readUInt16BE(8);
          headLen = 10;
        }
        buffer = buffer.subarray(headLen);

        if (rejectCode) {
          socket.write(Buffer.from([0x05, rejectCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return socket.destroy();
        }

        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]));
        stage = "piped";
        if (onConnect) onConnect({ targetHost, targetPort, socket, remaining: buffer });
      }
    });
  });
}

test("connectSocks5 - connects anonymously and sends ATYP 0x03 domain name", async () => {
  let connectedTarget = null;
  const server = createMockSocks5Server({
    onConnect: ({ targetHost, targetPort, socket }) => {
      connectedTarget = { targetHost, targetPort };
      socket.write(Buffer.from("HELLO_FROM_SOCKS5"));
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const socket = await connectSocks5({
      proxy: `socks5://127.0.0.1:${port}`,
      targetHost: "opencode.ai",
      targetPort: 443,
    });

    assert.strictEqual(connectedTarget.targetHost, "opencode.ai");
    assert.strictEqual(connectedTarget.targetPort, 443);

    const received = await new Promise((resolve) => {
      socket.once("data", (chunk) => resolve(chunk.toString()));
    });
    assert.strictEqual(received, "HELLO_FROM_SOCKS5");
    socket.destroy();
  } finally {
    server.close();
  }
});

test("connectSocks5 - authenticates with username and password (RFC 1929)", async () => {
  let authSuccess = false;
  const server = createMockSocks5Server({
    expectedUser: "warpuser",
    expectedPass: "warppass",
    onConnect: ({ socket }) => {
      authSuccess = true;
      socket.write(Buffer.from("AUTH_OK"));
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const socket = await connectSocks5({
      proxy: `socks5://warpuser:warppass@127.0.0.1:${port}`,
      targetHost: "api.example.com",
      targetPort: 443,
    });

    assert.strictEqual(authSuccess, true);
    const data = await new Promise((resolve) => socket.once("data", (c) => resolve(c.toString())));
    assert.strictEqual(data, "AUTH_OK");
    socket.destroy();
  } finally {
    server.close();
  }
});

test("connectSocks5 - rejects on auth failure or server refusal", async () => {
  const server = createMockSocks5Server({
    expectedUser: "validuser",
    expectedPass: "validpass",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      connectSocks5({
        proxy: `socks5://wronguser:wrongpass@127.0.0.1:${port}`,
        targetHost: "api.example.com",
        targetPort: 443,
      }),
      /SOCKS5 authentication failed/
    );
  } finally {
    server.close();
  }

  const refuseServer = createMockSocks5Server({ rejectCode: 0x05 }); // connection refused
  await new Promise((resolve) => refuseServer.listen(0, "127.0.0.1", resolve));
  const refusePort = refuseServer.address().port;

  try {
    await assert.rejects(
      connectSocks5({
        proxy: `socks5://127.0.0.1:${refusePort}`,
        targetHost: "api.example.com",
        targetPort: 443,
      }),
      /connection refused/
    );
  } finally {
    refuseServer.close();
  }
});

test("connectSocks5 - abort signal cancels handshake promptly", async () => {
  const server = net.createServer(() => {
    // Deliberately hold connection without replying
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("Handshake timeout")), 50);

    await assert.rejects(
      connectSocks5({
        proxy: `socks5://127.0.0.1:${port}`,
        targetHost: "api.example.com",
        targetPort: 443,
        signal: ac.signal,
      }),
      /Handshake timeout/
    );
  } finally {
    server.close();
  }
});
