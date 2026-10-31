import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import extension, { buildStatus, probeGateway } from "../src/index.ts";
import { createModelRefresher } from "../src/refresh.ts";

interface Captured {
  providers: { id: string; config: Record<string, unknown> }[];
  commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  handlers: Record<string, () => Promise<void>>;
  emitted: { channel: string; data: { connections: unknown[] } }[];
}

function fakePi(): { pi: Record<string, unknown>; captured: Captured } {
  const captured: Captured = { providers: [], commands: {}, handlers: {}, emitted: [] };
  const pi = {
    registerProvider: (id: string, config: Record<string, unknown>) => captured.providers.push({ id, config }),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      captured.commands[name] = options;
    },
    on: (event: string, handler: () => Promise<void>) => {
      captured.handlers[event] = handler;
    },
    events: {
      emit: (channel: string, data: { connections: unknown[] }) => captured.emitted.push({ channel, data }),
      on: () => () => {},
    },
  };
  return { pi, captured };
}

async function withServer(handler: http.RequestListener, run: (origin: string) => Promise<void>): Promise<void> {
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

test("provider terdaftar dengan id zenith-router dan base URL dari ZENITH_URL", () => {
  const previous = process.env.ZENITH_URL;
  process.env.ZENITH_URL = "http://127.0.0.1:20999/";
  try {
    const { pi, captured } = fakePi();
    extension(pi as never);
    const [registered] = captured.providers;
    assert.equal(registered?.id, "zenith-router");
    assert.equal(registered?.config.baseUrl, "http://127.0.0.1:20999/v1", "garis miring tidak menjadi /v1/v1");
    assert.equal(registered?.config.api, "openai-completions");
    assert.equal(registered?.config.authHeader, true);
  } finally {
    if (previous === undefined) delete process.env.ZENITH_URL;
    else process.env.ZENITH_URL = previous;
  }
});

test("API key provider diisi placeholder env, bukan nilai literal dari kode", () => {
  const { pi, captured } = fakePi();
  extension(pi as never);
  const apiKey = captured.providers[0]?.config.apiKey;
  assert.equal(apiKey, "$ZENITH_ROUTER_API_KEY", "Pi yang me-resolve key, extension tidak membaca auth.json");
});

test("command /zenith-router terdaftar", () => {
  const { pi, captured } = fakePi();
  extension(pi as never);
  assert.ok(captured.commands["zenith-router"], "command harus terdaftar");
});

test("probeGateway mengembalikan false saat gateway tidak menjawab", async () => {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.equal(await probeGateway(`http://127.0.0.1:${port}`), false);
});

test("probeGateway mengembalikan true saat /health menjawab 200", async () => {
  await withServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "application/json" }).end("{\"status\":\"ok\"}");
  }, async (origin) => {
    assert.equal(await probeGateway(origin), true);
  });
});

test("status melaporkan gateway mati dan sumber model cache saat /health gagal", async () => {
  const refresher = createModelRefresher({
    fetchIds: async () => { throw new Error("tidak terhubung"); },
    readCache: () => ["cache-a", "cache-b"],
    writeCache: () => {},
    now: () => Date.now(),
  });
  const lines = await buildStatus("http://127.0.0.1:1", false, refresher, null);
  assert.equal(lines[0], "gateway http://127.0.0.1:1: mati");
  assert.equal(lines[1], "model: 2 (sumber: cache)");
  assert.equal(lines[2], "kuota: tidak tersedia");
});

test("status meringkas kuota dari payload /api/quota tanpa menampilkan field lain", async () => {
  const refresher = createModelRefresher({
    fetchIds: async () => ["live-a"],
    readCache: () => [],
    writeCache: () => {},
    now: () => Date.now(),
  });
  const quota = [
    { id: 1, provider: "codex", is_active: 1, is_exhausted: true, api_key: "rahasia-jangan-tampil" },
    { id: 2, provider: "kiro", is_active: 1, quota: { error: "gagal" } },
  ];
  const lines = await buildStatus("http://127.0.0.1:20120", true, refresher, quota as never);
  assert.equal(lines[2], "kuota: 2 koneksi, 2 aktif, 1 habis, 1 error");
  const secretInPayload = String((quota[0] as Record<string, unknown>).api_key);
  assert.ok(!lines.join("\n").includes(secretInPayload), "nilai api_key dari payload tidak boleh tampil di status");
});
