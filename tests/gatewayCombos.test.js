// Smoke test end-to-end lewat HTTP nyata: router dijalankan di port sungguhan dan
// upstream dis.stub di server lokal. app.request() melewati TCP, proxy, dan parsing
// header sehingga tidak bisa membuktikan alur ini benar-benar jalan.
import test from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { serve } from "@hono/node-server";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { getProvider } from "../src/providers/index.js";
import { createSessionToken } from "../src/services/dashboardAuth.js";

const STUB_MODEL_OK = "gpt-oss:20b";
const STUB_MODEL_FAIL = "gpt-oss:120b";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Upstream palsu: satu model kena 429, model lain menjawab normal. */
function startStubUpstream(hits) {
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    hits.push(body.model);
    res.setHeader("Content-Type", "application/json");
    if (body.model === STUB_MODEL_FAIL) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: "rate limit reached", type: "rate_limit_error" } }));
      return;
    }
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "dilayani anggota kedua" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function waitUntilReady(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("zenith tidak siap");
}

test("Smoke - combo dari dashboard dilayani anggota kedua lewat HTTP nyata", async (t) => {
  const dbPath = join(tmpdir(), `zenith-smoke-${process.pid}-${Math.floor(process.uptime() * 1000)}.db`);
  const hits = [];
  const { server: stub, port: stubPort } = await startStubUpstream(hits);
  const ollama = getProvider("ollama");
  const originalBaseUrl = ollama.transport.baseUrl;
  ollama.transport.baseUrl = `http://127.0.0.1:${stubPort}/v1/chat/completions`;

  const port = 20186 + Math.floor(process.uptime() * 97) % 10;
  const router = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

  t.after(async () => {
    await new Promise((r) => router.close(r));
    await new Promise((r) => stub.close(r));
    ollama.transport.baseUrl = originalBaseUrl;
    try { rmSync(dbPath, { force: true }); } catch {}
  });

  initDb(dbPath);
  addConnection({ provider: "ollama", name: "Ollama Lokal", credentials: { api_key: "ollama-test-key" } });
  await waitUntilReady(port);

  // Combo dibuat lewat form dashboard, bukan lewat service.
  const created = await fetch(`http://127.0.0.1:${port}/dashboard/combos/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `zenith_session=${createSessionToken()}`,
    },
    body: new URLSearchParams({
      name: "smoke-antai",
      models: `ollama/${STUB_MODEL_FAIL}\nollama/${STUB_MODEL_OK}`,
    }),
    redirect: "manual",
  });
  assert.ok(
    created.status === 302 || created.status === 200,
    `form combo harus diterima, dapat ${created.status}`
  );

  const sessionCookie = `zenith_session=${createSessionToken()}`;
  const listed = await (
    await fetch(`http://127.0.0.1:${port}/dashboard/combos`, {
      headers: { Cookie: sessionCookie },
    })
  ).text();
  assert.ok(listed.includes("smoke-antai"), "combo tampil di halaman dashboard");

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "smoke-antai",
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const payload = await res.json();
  assert.strictEqual(payload.choices[0].message.content, "dilayani anggota kedua");
  assert.deepStrictEqual(
    hits,
    [STUB_MODEL_FAIL, STUB_MODEL_OK],
    "upstream harus menerima anggota pertama lalu anggota kedua"
  );
});