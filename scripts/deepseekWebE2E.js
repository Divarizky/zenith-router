#!/usr/bin/env node
/**
 * Manual end-to-end check against a real DeepSeek Web account.
 *
 * The automated suite (tests/deepseekWebE2E.test.js) runs the same paths against
 * a loopback stand-in for chat.deepseek.com. This script is for the step that
 * cannot be faked: a token that only the user has.
 *
 *   1. Add the account in the dashboard (Providers -> Session Providers).
 *   2. Start the gateway: npm start
 *   3. ZR_KEY=zr_... node scripts/deepseekWebE2E.js
 *
 * Optional: ZR_BASE_URL (default http://127.0.0.1:20120), ZR_MODEL
 * (default dsw/deepseek-chat), ZR_TIMEOUT_MS (default 180000).
 */

const BASE = (process.env.ZR_BASE_URL || "http://127.0.0.1:20120").replace(/\/+$/, "");
const KEY = process.env.ZR_KEY || "";
const MODEL = process.env.ZR_MODEL || "dsw/deepseek-chat";
const TIMEOUT_MS = Number(process.env.ZR_TIMEOUT_MS || 180000);

if (!KEY) {
  console.error("ZR_KEY belum diisi. Buat key di dashboard API Keys (format zr_...).");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function post(path, body, extraHeaders = {}, signal = AbortSignal.timeout(TIMEOUT_MS)) {
  return fetch(`${BASE}${path}`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body), signal });
}

async function run() {
  const models = await fetch(`${BASE}/v1/models`, { headers, signal: AbortSignal.timeout(30000) });
  const catalog = models.ok ? (await models.json()).data || [] : [];
  const listed = catalog.some((model) => model.id === MODEL);
  record("model terdaftar", listed, listed ? MODEL : `belum ada; tambahkan akun dulu. Katalog: ${catalog.length} model`);

  const chat = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Balas satu kalimat: halo." }] });
  const chatJson = await chat.json().catch(() => ({}));
  const content = chatJson?.choices?.[0]?.message?.content || "";
  record("chat non-stream", chat.ok && content.length > 0, `HTTP ${chat.status}, ${content.length} karakter`);
  if (!chat.ok) return;

  const stream = await post(
    "/v1/chat/completions",
    { model: MODEL, stream: true, messages: [{ role: "user", content: "Hitung 1 sampai 3." }] },
    { "x-session-id": `e2e-stream-${Date.now()}` }
  );
  const streamText = stream.ok ? await stream.text() : "";
  record("streaming", stream.ok && streamText.includes("data:") && streamText.includes("[DONE]"), `HTTP ${stream.status}, ${streamText.length} byte`);

  const tool = await post(
    "/v1/chat/completions",
    {
      model: MODEL,
      messages: [{ role: "user", content: "Jalankan tool bash untuk melihat isi folder kerja." }],
      tools: [
        {
          type: "function",
          function: { name: "bash", description: "jalankan perintah shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
    },
    { "x-session-id": `e2e-tool-${Date.now()}` }
  );
  const toolJson = await tool.json().catch(() => ({}));
  const toolCalls = toolJson?.choices?.[0]?.message?.tool_calls || [];
  record("tool call", tool.ok && toolCalls.length > 0, `HTTP ${tool.status}, ${toolCalls.length} call, finish=${toolJson?.choices?.[0]?.finish_reason}`);

  const started = Date.now();
  const parallel = await Promise.all(
    ["a", "b", "c", "d"].map((session) =>
      post(
        "/v1/chat/completions",
        { model: MODEL, messages: [{ role: "user", content: `Balas satu kata: ${session}` }] },
        { "x-session-id": `e2e-parallel-${session}-${Date.now()}` }
      ).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
    )
  );
  const elapsed = Date.now() - started;
  const okCount = parallel.filter((item) => item.status === 200).length;
  const busy = parallel.filter((item) => item.status === 429).length;
  record(
    "4 percakapan paralel",
    okCount === 4,
    `${okCount}/4 sukses, ${busy} antre/timeout, total ${elapsed} ms (cap default 3 per akun, jadi satu memang menunggu)`
  );
}

run()
  .catch((err) => record("eksekusi", false, err?.name === "TimeoutError" ? "timeout" : err.message))
  .finally(() => {
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} skenario lulus.`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
