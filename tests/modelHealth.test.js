import test from "node:test";
import assert from "node:assert/strict";
import {
  QUOTA_LATENCY_SENTINEL,
  isParkedLatency,
  classifyTestResult,
  testModelHealth,
} from "../src/services/modelHealth.js";

test("QUOTA_LATENCY_SENTINEL bernilai 999998", () => {
  assert.equal(QUOTA_LATENCY_SENTINEL, 999998);
});

test("isParkedLatency - mendeteksi latensi sentinel quota parkir", () => {
  assert.equal(isParkedLatency(999998), true);
  assert.equal(isParkedLatency(999999), true);
  assert.equal(isParkedLatency(1000000), true);
  assert.equal(isParkedLatency(500), false);
  assert.equal(isParkedLatency(0), false);
  assert.equal(isParkedLatency(-1), false);
  assert.equal(isParkedLatency(null), false);
  assert.equal(isParkedLatency(undefined), false);
  assert.equal(isParkedLatency("999998"), false);
});

test("classifyTestResult - sukses HTTP 200 menghasilkan status 'active'", () => {
  const result = classifyTestResult({
    status: 200,
    ok: true,
    latencyMs: 120,
  });
  assert.equal(result, "active");
});

test("classifyTestResult - latensi sentinel menghasilkan status 'quota'", () => {
  const result = classifyTestResult({
    status: 200,
    ok: true,
    latencyMs: QUOTA_LATENCY_SENTINEL,
  });
  assert.equal(result, "quota");
});

test("classifyTestResult - HTTP 429 menghasilkan status 'quota'", () => {
  const result = classifyTestResult({
    status: 429,
    ok: false,
    error: "Too Many Requests",
    latencyMs: 45,
  });
  assert.equal(result, "quota");
});

test("classifyTestResult - pesan error kuota/rate limit menghasilkan status 'quota'", () => {
  const cases = [
    "Rate limit exceeded. Please try again later.",
    "resource_exhausted: quota limit reached",
    "insufficient_quota: you exceeded your current quota",
    "credits exhausted for current billing cycle",
    "tokens limit reached",
    "model is overloaded",
  ];

  for (const errMsg of cases) {
    const result = classifyTestResult({
      status: 400,
      ok: false,
      error: errMsg,
      latencyMs: 80,
    });
    assert.equal(result, "quota", `Gagal pada pesan: ${errMsg}`);
  }
});

test("classifyTestResult - HTTP 404 menghasilkan status 'dead'", () => {
  const result = classifyTestResult({
    status: 404,
    ok: false,
    error: "Model not found",
    latencyMs: 50,
  });
  assert.equal(result, "dead");
});

test("classifyTestResult - HTTP 401 menghasilkan status 'dead'", () => {
  const result = classifyTestResult({
    status: 401,
    ok: false,
    error: "Unauthorized",
    latencyMs: 30,
  });
  assert.equal(result, "dead");
});

test("classifyTestResult - pesan error model deprecated atau invalid token menghasilkan status 'dead'", () => {
  const cases = [
    "Model 'gpt-3.5-turbo-0301' is deprecated and decommissioned",
    "model_not_found: The model does not exist",
    "invalid_api_key: Incorrect API key provided",
    "account suspended due to terms violation",
  ];

  for (const errMsg of cases) {
    const result = classifyTestResult({
      status: 400,
      ok: false,
      error: errMsg,
      latencyMs: 60,
    });
    assert.equal(result, "dead", `Gagal pada pesan: ${errMsg}`);
  }
});

test("classifyTestResult - error server umum dan jaringan menghasilkan status 'dead'", () => {
  const result = classifyTestResult({
    status: 500,
    ok: false,
    error: "Internal Server Error",
    latencyMs: 15,
  });
  assert.equal(result, "dead");
});

test("testModelHealth - memvalidasi argumen model ID", async () => {
  const res = await testModelHealth("");
  assert.equal(res.status, "dead");
  assert.equal(res.ok, false);
  assert.match(res.error, /wajib diisi/i);
});

test("testModelHealth - mengeksekusi micro-test sukses dan mencatat latensi asli", async () => {
  let capturedUrl = null;
  let capturedBody = null;
  let capturedHeaders = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    capturedHeaders = options.headers;

    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "pong" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const res = await testModelHealth("openai/gpt-4o", {
    fetch: mockFetch,
    baseUrl: "http://127.0.0.1:20120",
    apiKey: "test-sk-12345",
  });

  assert.equal(capturedUrl, "http://127.0.0.1:20120/v1/chat/completions");
  assert.equal(capturedBody.model, "openai/gpt-4o");
  assert.deepEqual(capturedBody.messages, [{ role: "user", content: "ping" }]);
  assert.equal(capturedBody.max_tokens, 1);
  assert.equal(capturedHeaders["Authorization"], "Bearer test-sk-12345");

  assert.equal(res.status, "active");
  assert.equal(res.ok, true);
  assert.equal(res.httpStatus, 200);
  assert.equal(typeof res.latencyMs, "number");
  assert.ok(res.latencyMs > 0 && res.latencyMs < QUOTA_LATENCY_SENTINEL);
});

test("testModelHealth - mendeteksi rate limit 429 dan memarkir dengan latensi sentinel", async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        error: { message: "Rate limit reached for gpt-4o" },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const res = await testModelHealth("openai/gpt-4o", {
    fetch: mockFetch,
  });

  assert.equal(res.status, "quota");
  assert.equal(res.ok, false);
  assert.equal(res.httpStatus, 429);
  assert.equal(res.latencyMs, QUOTA_LATENCY_SENTINEL);
  assert.match(res.error, /rate limit/i);
});

test("testModelHealth - mendeteksi 404 model dead/not found", async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        error: { message: "Model openai/gpt-legacy not found" },
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const res = await testModelHealth("openai/gpt-legacy", {
    fetch: mockFetch,
  });

  assert.equal(res.status, "dead");
  assert.equal(res.ok, false);
  assert.equal(res.httpStatus, 404);
  assert.match(res.error, /not found/i);
});

test("testModelHealth - mendeteksi 401 token invalid sebagai dead", async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        error: { message: "Invalid API key" },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const res = await testModelHealth("openai/gpt-4o", {
    fetch: mockFetch,
  });

  assert.equal(res.status, "dead");
  assert.equal(res.ok, false);
  assert.equal(res.httpStatus, 401);
});

test("testModelHealth - menangani network error dan timeout", async () => {
  const mockFetch = async () => {
    const err = new Error("Connection refused");
    err.code = "ECONNREFUSED";
    throw err;
  };

  const res = await testModelHealth("openai/gpt-4o", {
    fetch: mockFetch,
  });

  assert.equal(res.status, "dead");
  assert.equal(res.ok, false);
  assert.match(res.error, /connection refused/i);
});

test("testModelHealth - menyertakan API key aktif saat auth gateway aktif dan Authorization kosong", async () => {
  const { initDb } = await import("../src/db/index.js");
  const { setSetting } = await import("../src/services/settings.js");
  const { createApiKey } = await import("../src/services/apiKeys.js");
  initDb(":memory:");
  setSetting("require_api_key", "true");
  const created = createApiKey("probe-key");

  let capturedAuth = null;
  const mockFetch = async (_url, init) => {
    capturedAuth = init.headers?.["Authorization"] || init.headers?.["authorization"];
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };

  const res = await testModelHealth("openai/gpt-4o", {
    fetch: mockFetch,
  });

  assert.equal(res.ok, true);
  assert.ok(capturedAuth, "Header Authorization harus terpasang");
  assert.ok(capturedAuth.startsWith("Bearer "), "Harus berupa Bearer token");
  assert.ok(capturedAuth.includes(created.key_prefix), "Bearer token harus memuat prefix key");
});
