import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchModelIds, getJson, GatewayError } from "../src/gateway.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: Handler, run: (origin: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function capture(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  assert.fail("permintaan seharusnya gagal");
}

test("timeout gateway dilaporkan sebagai timeout, bukan menunggu selamanya", async () => {
  await withServer(() => { /* tidak pernah merespons */ }, async (origin) => {
    const error = await capture(getJson(`${origin}/v1/models`, { timeoutMs: 100 }));
    assert.equal(error.kind, "timeout");
  });
});

test("401 dan redirect ke login sama-sama dianggap auth, supaya key salah tidak dianggap gateway mati", async () => {
  await withServer((_req, res) => { res.writeHead(401).end("Unauthorized"); }, async (origin) => {
    const error = await capture(getJson(`${origin}/api/quota`, { timeoutMs: 1000 }));
    assert.equal(error.kind, "auth");
    assert.equal(error.status, 401);
  });
  await withServer((_req, res) => { res.writeHead(302, { Location: "/dashboard/login" }).end(); }, async (origin) => {
    const error = await capture(getJson(`${origin}/api/quota`, { timeoutMs: 1000 }));
    assert.equal(error.kind, "auth", "redirect tidak boleh diikuti ke halaman login");
  });
});

test("JSON rusak menghasilkan kind payload, tidak melempar SyntaxError mentah", async () => {
  await withServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }).end("{\"data\": ["); }, async (origin) => {
    const error = await capture(getJson(`${origin}/v1/models`, { timeoutMs: 1000 }));
    assert.equal(error.kind, "payload");
  });
});

test("HTTP 500 dilaporkan sebagai http dengan status yang benar", async () => {
  await withServer((_req, res) => { res.writeHead(500).end("boom"); }, async (origin) => {
    const error = await capture(getJson(`${origin}/v1/models`, { timeoutMs: 1000 }));
    assert.equal(error.kind, "http");
    assert.equal(error.status, 500);
  });
});

test("gateway yang tidak berjalan dilaporkan sebagai network", async () => {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const error = await capture(getJson(`http://127.0.0.1:${port}/health`, { timeoutMs: 1000 }));
  assert.equal(error.kind, "network");
});

test("API key dikirim sebagai Bearer hanya saat diberikan", async () => {
  const seen: (string | undefined)[] = [];
  await withServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  }, async (origin) => {
    await getJson(`${origin}/health`, { timeoutMs: 1000 });
    await getJson(`${origin}/v1/models`, { timeoutMs: 1000, apiKey: "zr_contoh" });
  });
  assert.deepEqual(seen, [undefined, "Bearer zr_contoh"]);
});

test("fetchModelIds mengembalikan id dari /v1/models, dan bentuk salah menjadi payload error", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "dsw/deepseek-chat" }] }));
  }, async (origin) => {
    assert.deepEqual(await fetchModelIds(origin, { timeoutMs: 1000 }), ["dsw/deepseek-chat"]);
  });
  await withServer((_req, res) => { res.writeHead(200).end("{\"hasil\":1}"); }, async (origin) => {
    const error = await capture(fetchModelIds(origin, { timeoutMs: 1000 }));
    assert.equal(error.kind, "payload");
  });
});
