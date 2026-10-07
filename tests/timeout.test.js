import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { BaseExecutor } from "../src/executors/base.js";

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

function streamEvery(intervalMs, count, gapAfter = null) {
  return (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let sent = 0;
    const tick = () => {
      if (res.destroyed) return;
      res.write(`data: ${sent}\n\n`);
      sent++;
      if (sent >= count) return res.end();
      const wait = gapAfter !== null && sent === gapAfter ? intervalMs * 20 : intervalMs;
      setTimeout(tick, wait);
    };
    tick();
  };
}

test("timeout - a steady stream longer than the idle timeout is not cut", async () => {
  const { server, url } = await startServer(streamEvery(50, 16));
  try {
    const executor = new BaseExecutor({ headersTimeoutMs: 1000, idleTimeoutMs: 300 });
    const res = await executor.execute({ url, method: "GET" });
    const text = await readAll(res.body);
    assert.strictEqual((text.match(/data:/g) || []).length, 16, "All chunks must arrive (~800ms total)");
  } finally {
    server.close();
  }
});

test("timeout - a stream that stalls longer than the idle timeout is aborted", async () => {
  const { server, url } = await startServer(streamEvery(50, 10, 3));
  try {
    const executor = new BaseExecutor({ headersTimeoutMs: 1000, idleTimeoutMs: 300 });
    const res = await executor.execute({ url, method: "GET" });
    await assert.rejects(readAll(res.body));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("timeout - missing response headers return 504", async () => {
  const { server, url } = await startServer(() => {});
  try {
    const executor = new BaseExecutor({ headersTimeoutMs: 200, idleTimeoutMs: 1000 });
    const res = await executor.execute({ url, method: "GET" });
    assert.strictEqual(res.status, 504);
    assert.strictEqual((await res.json()).error.code, "gateway_timeout");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("timeout - client abort cancels the upstream request", async () => {
  let upstreamClosed = false;
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    res.on("close", () => {
      upstreamClosed = true;
    });
  });
  try {
    const client = new AbortController();
    const executor = new BaseExecutor({ headersTimeoutMs: 1000, idleTimeoutMs: 5000 });
    const res = await executor.execute({ url, method: "GET", signal: client.signal });
    const reader = res.body.getReader();
    await reader.read();
    client.abort();
    await assert.rejects(reader.read());
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(upstreamClosed, true);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
