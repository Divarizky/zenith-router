import test from "node:test";
import assert from "node:assert/strict";
import { initDb, getDb, addConnection } from "../src/db/index.js";
import { testConnection } from "../src/services/testConnection.js";
import { handleTestConnection } from "../src/ui/pages/providers.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("testConnection - returns error for unknown provider", async () => {
  const res = await testConnection("non-existent-provider");
  assert.equal(res.ok, false);
  assert.match(res.error, /tidak ditemukan/i);
});

test("testConnection - returns error if provider requires auth but has no connection", async () => {
  initDb(":memory:");
  const res = await testConnection("together");
  assert.equal(res.ok, false);
  assert.match(res.error, /belum ada akun aktif/i);
});

test("testConnection - succeeds for provider with quota fetcher using mock", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "glm",
    name: "GLM Key",
    credentials: { api_key: "[REDACTED:credential_assignment]" },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/user/quota")) {
      return new Response(JSON.stringify({ data: { limits: [{ percentage: 10, unit: 3 }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(url);
  };

  try {
    const res = await testConnection("glm", { connection: conn });
    assert.equal(res.ok, true);
    assert.match(res.details, /berhasil/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("testConnection - tests specific connection with importer endpoint", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "together",
    name: "Together Key",
    credentials: { api_key: "[REDACTED:credential_assignment]" },
  });

  setCustomExecutor({
    async execute() {
      return new Response(JSON.stringify([{ id: "meta-llama/Llama-3-70b" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const res = await testConnection("together", { connection: conn });
    assert.equal(res.ok, true);
  } finally {
    setCustomExecutor(null);
  }
});

test("handleTestConnection - redirects to dashboard with test_ok notice", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "together",
    name: "Together Key",
    credentials: { api_key: "[REDACTED:credential_assignment]" },
  });

  setCustomExecutor({
    async execute() {
      return new Response(JSON.stringify([{ id: "meta-llama/Llama-3-70b" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    let redirectedTo = "";
    const mockContext = {
      req: {
        parseBody: async () => ({ provider: "together", id: String(conn.id) }),
      },
      redirect: (url) => {
        redirectedTo = url;
        return new Response(null, { status: 302, headers: { Location: url } });
      },
    };

    const res = await handleTestConnection(mockContext);
    assert.equal(res.status, 302);
    assert.match(redirectedTo, /notice=test_ok/);
  } finally {
    setCustomExecutor(null);
  }
});

test("handleTestConnection - redirects with test_fail when upstream fails", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "together",
    name: "Together Key",
    credentials: { api_key: "[REDACTED:credential_assignment]" },
  });

  setCustomExecutor({
    async execute() {
      return new Response(JSON.stringify({ error: "Invalid API Key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    let redirectedTo = "";
    const mockContext = {
      req: {
        parseBody: async () => ({ provider: "together", id: String(conn.id) }),
      },
      redirect: (url) => {
        redirectedTo = url;
        return new Response(null, { status: 302, headers: { Location: url } });
      },
    };

    const res = await handleTestConnection(mockContext);
    assert.equal(res.status, 302);
    assert.match(redirectedTo, /notice=test_fail/);
    assert.match(redirectedTo, /HTTP%20401/);
  } finally {
    setCustomExecutor(null);
  }
});

/** Nous probe: the public model list always answers; only the chat status decides. */
async function nousProbe(chatStatus) {
  initDb(":memory:");
  getDb()
    .prepare("INSERT INTO synced_models (provider, model_id, name, synced_at) VALUES (?, ?, ?, ?)")
    .run("nous", "x/free:free", "Free", Date.now());
  const conn = addConnection({ provider: "nous", name: "Nous Key", credentials: { api_key: "test-key-1" } });
  const calls = [];
  setCustomExecutor({
    async execute(req) {
      calls.push(req);
      if (req.method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response("{}", { status: chatStatus });
    },
  });
  try {
    return { res: await testConnection("nous", { connection: conn }), calls };
  } finally {
    setCustomExecutor(null);
  }
}

test("testConnection nous - does not treat the public model list as proof of access", async () => {
  const { res, calls } = await nousProbe(401);
  assert.equal(res.ok, false);
  assert.match(res.error, /401/);
  assert.ok(calls.every((c) => c.method === "POST"), "no GET /v1/models used as the check");
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, "x/free:free");
  assert.equal(body.max_tokens, 1);
});

test("testConnection nous - maps 403, 402, 404, 429 and 2xx to distinct outcomes", async () => {
  const outcomes = {};
  for (const status of [200, 403, 402, 404, 429]) outcomes[status] = (await nousProbe(status)).res;
  assert.equal(outcomes[200].ok, true);
  assert.match(outcomes[200].details, /berhasil/);
  assert.match(outcomes[403].error, /403.*(ditolak|akses)/);
  assert.match(outcomes[402].error, /402.*(kredit|pembayaran)/);
  assert.match(outcomes[404].error, /404.*tidak ditemukan/);
  assert.equal(outcomes[429].ok, true);
  assert.match(outcomes[429].details, /rate limit/);
  assert.equal(new Set(Object.values(outcomes).map((o) => o.error || o.details)).size, 5);
});
