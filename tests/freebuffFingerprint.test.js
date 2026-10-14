import test from "node:test";
import assert from "node:assert";
import { FreebuffExecutor } from "../src/executors/freebuff.js";

test("Freebuff UA rotation - every upstream call carries a UA from the official CLI list", async () => {
  const { FREEBUFF_USER_AGENTS } = await import("../src/executors/freebuff.js");
  // Literal independen dari proxy referensi dinarw88/freebuff-proxy, bukan dari kode.
  const expected = [
    "codebuff-cli/1.0.0 (Windows; Node.js v22.3.0)",
    "codebuff-cli/1.1.2 (darwin; Node.js v22.5.1)",
    "freebuff/0.2.4 (linux; Node.js v20.11.1)",
    "ai-sdk/openai-compatible/1.0.25/codebuff",
  ];
  for (const ua of expected) {
    assert.ok(FREEBUFF_USER_AGENTS.includes(ua), `daftar UA harus memuat ${ua}`);
  }

  const getUA = (headers) =>
    headers instanceof Headers ? headers.get("User-Agent") : headers?.["User-Agent"];
  const seen = [];
  const mockFetch = async (url, init = {}) => {
    seen.push(getUA(init.headers));
    if (url.endsWith("/freebuff/session")) {
      return new Response(JSON.stringify({ instanceId: "i1" }), { status: 200 });
    }
    if (url.endsWith("/agent-runs")) {
      return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new FreebuffExecutor({ fetchFn: mockFetch });
  await executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [] }),
  });
  assert.strictEqual(seen.length, 4, "session + START + chat + FINISH memakai UA");
  for (const ua of seen) {
    assert.ok(FREEBUFF_USER_AGENTS.includes(ua), `UA ${ua} harus dari daftar resmi`);
  }
});

test("Freebuff envelope - chat body carries data_collection deny and cb_easp stop", async () => {
  const bodies = [];
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith("/chat/completions")) {
      try { bodies.push(JSON.parse(init.body)); } catch {}
    }
    if (url.endsWith("/freebuff/session")) {
      return new Response(JSON.stringify({ instanceId: "i1" }), { status: 200 });
    }
    if (url.endsWith("/agent-runs")) {
      return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new FreebuffExecutor({ fetchFn: mockFetch });

  await executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hai" }] }),
  });
  await executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [], stop: ["DONE"] }),
  });

  assert.deepStrictEqual(
    bodies[0].provider,
    { data_collection: "deny" },
    "tanpa provider dari klien, envelope menyuntik data_collection deny"
  );
  assert.deepStrictEqual(bodies[0].stop, ["cb_easp"], "tanpa stop dari klien, sentinel cb_easp ditambahkan");
  assert.deepStrictEqual(bodies[1].stop, ["DONE"], "stop klien tidak diubah");
});

test("Freebuff force stream - upstream body always streams even for non-stream clients", async () => {
  const { default: freebuffProvider } = await import("../src/providers/registry/freebuff.js");
  assert.strictEqual(
    freebuffProvider.transport?.forceStream,
    true,
    "transport freebuff harus memaksa streaming upstream seperti opencode"
  );

  const bodies = [];
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith("/chat/completions")) {
      try { bodies.push(JSON.parse(init.body)); } catch {}
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.endsWith("/freebuff/session")) {
      return new Response(JSON.stringify({ instanceId: "i1" }), { status: 200 });
    }
    if (url.endsWith("/agent-runs")) {
      return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };
  const executor = new FreebuffExecutor({ fetchFn: mockFetch });
  await executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [], stream: false }),
  });
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(bodies[0].stream, true, "executor memaksa stream true lapis kedua");
});

test("Gateway integration - non-streaming client request to freebuff receives aggregated JSON", async () => {
  const { initDb, addConnection } = await import("../src/db/index.js");
  const { app } = await import("../src/index.js");
  const { setCustomExecutor } = await import("../src/executors/base.js");
  initDb(":memory:");
  addConnection({ provider: "freebuff", name: "fb", credentials: { auth_token: "tok" } });

  let upstreamReceivedStream = null;
  setCustomExecutor({
    async execute({ body }) {
      const parsed = typeof body === "string" ? JSON.parse(body) : body;
      upstreamReceivedStream = parsed?.stream;
      const sseBody =
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Jawaban"}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{"content":" lengkap"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";
      return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "freebuff/deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "halo" }],
        stream: false,
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(upstreamReceivedStream, true, "upstream harus menerima stream: true");
    const json = await res.json();
    assert.strictEqual(json.choices[0].message.content, "Jawaban lengkap");
  } finally {
    setCustomExecutor(null);
  }
});

test("Freebuff session cache - sequential requests reuse the same session and run", async () => {
  const { resetFreebuffSessionCache } = await import("../src/executors/freebuff.js");
  resetFreebuffSessionCache();

  const counts = { session: 0, start: 0, finish: 0 };
  const mockFetch = async (url, init = {}) => {
    let req = {};
    try { req = JSON.parse(init.body || "{}"); } catch {}
    if (url.endsWith("/freebuff/session")) {
      counts.session++;
      return new Response(JSON.stringify({ instanceId: `inst_${counts.session}` }), { status: 200 });
    }
    if (url.endsWith("/agent-runs")) {
      if (req.action === "START") {
        counts.start++;
        return new Response(JSON.stringify({ runId: `run_${counts.start}` }), { status: 200 });
      }
      counts.finish++;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new FreebuffExecutor({ fetchFn: mockFetch });
  const req = (sessionKey) => executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [] }),
    sessionKey,
  });

  await req("percakapan-a");
  await req("percakapan-a");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(counts, { session: 1, start: 1, finish: 1 },
    "request kedua identitas sama memakai ulang session+run tanpa lifecycle baru");

  await req("percakapan-b");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(counts, { session: 2, start: 2, finish: 2 },
    "identitas berbeda mendapat session+run sendiri");
});

test("Freebuff session cache - TTL expiry, LRU eviction, and drop on auth failure", async () => {
  const {
    resetFreebuffSessionCache,
    lookupFreebuffSession,
    storeFreebuffSession,
    dropFreebuffSession,
    getFreebuffSessionCacheSize,
  } = await import("../src/executors/freebuff.js");
  resetFreebuffSessionCache();

  storeFreebuffSession("a", { instanceId: "i", runId: "r" }, { now: 1000 });
  assert.deepStrictEqual(
    lookupFreebuffSession("a", { now: 1000 + 1800000 }),
    { instanceId: "i", runId: "r", lastUsed: 1000 + 1800000 },
    "tepat di batas TTL masih dipakai ulang"
  );
  // Sliding TTL: lookup di atas menggeser lastUsed ke 1000+1800000, jadi
  // batas baru adalah 1000+2*1800000.
  assert.strictEqual(lookupFreebuffSession("a", { now: 1000 + 2 * 1800001 }), null, "lewat TTL dibuang");
  assert.strictEqual(getFreebuffSessionCacheSize(), 0);

  storeFreebuffSession("x", { instanceId: "i", runId: "r" }, { now: 0, maxSessions: 2 });
  storeFreebuffSession("y", { instanceId: "i", runId: "r" }, { now: 0, maxSessions: 2 });
  lookupFreebuffSession("x", { now: 1 });
  storeFreebuffSession("z", { instanceId: "i", runId: "r" }, { now: 2, maxSessions: 2 });
  assert.ok(lookupFreebuffSession("x", { now: 3 }), "yang baru dipakai selamat dari eviction");
  assert.strictEqual(lookupFreebuffSession("y", { now: 3 }), null, "yang paling lama tak dipakai ter-evict");

  dropFreebuffSession("x");
  assert.strictEqual(lookupFreebuffSession("x", { now: 4 }), null, "drop membuang entri");
});

test("Freebuff session cache - auth failure drops the entry so the next request starts fresh", async () => {
  const { resetFreebuffSessionCache } = await import("../src/executors/freebuff.js");
  resetFreebuffSessionCache();

  let chatCalls = 0;
  let sessions = 0;
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith("/freebuff/session")) {
      sessions++;
      return new Response(JSON.stringify({ instanceId: "i1" }), { status: 200 });
    }
    if (url.endsWith("/agent-runs")) {
      try {
        if (JSON.parse(init.body || "{}").action === "START") {
          return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
        }
      } catch {}
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    chatCalls++;
    // Panggilan pertama ditolak seolah session mati; berikutnya sukses.
    if (chatCalls === 1) return new Response("unauthorized", { status: 401 });
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new FreebuffExecutor({ fetchFn: mockFetch });
  const req = () => executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [] }),
    sessionKey: "sesi-rusak",
  });

  const first = await req();
  assert.strictEqual(first.status, 401);
  const second = await req();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(second.status, 200);
  assert.strictEqual(sessions, 2, "cache dibuang saat 401, request berikutnya membuat session baru");
});

test("Freebuff session cache - same identity with a different model gets its own session", async () => {
  const { resetFreebuffSessionCache } = await import("../src/executors/freebuff.js");
  resetFreebuffSessionCache();

  const sessionModels = [];
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith("/freebuff/session")) {
      sessionModels.push(init.headers?.["x-freebuff-model"]);
      return new Response(JSON.stringify({ instanceId: `i${sessionModels.length}` }), { status: 200 });
    }
    if (url.endsWith("/agent-runs")) {
      return new Response(JSON.stringify({ runId: "r" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "x" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const executor = new FreebuffExecutor({ fetchFn: mockFetch });
  const req = (model) => executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ model, messages: [] }),
    sessionKey: "sesi-sama",
  });

  await req("deepseek/deepseek-v4-flash");
  await req("z-ai/glm-5.3-flash");
  await req("deepseek/deepseek-v4-flash");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(
    sessionModels,
    ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
    "model berbeda tidak memakai session model lain; kembali ke model lama memakai cache"
  );
});

