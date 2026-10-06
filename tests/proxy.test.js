import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { BaseExecutor } from "../src/executors/base.js";
import { proxyFetch } from "../src/executors/proxy.js";

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
