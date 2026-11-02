import test from "node:test";
import assert from "node:assert/strict";
import { initDb, addConnection } from "../src/db/index.js";
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
