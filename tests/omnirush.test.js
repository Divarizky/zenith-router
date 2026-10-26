import test from "node:test";
import assert from "node:assert";
import { getProvider } from "../src/providers/index.js";
import {
  OmnirushExecutor,
  DEFAULT_OMNIRUSH_CLIENT_VERSION,
  getOmnirushClientVersion,
  getOmnirushDeviceUserAgent,
  OMNIRUSH_MODEL_USER_AGENT,
  getOmnirushClientHeader,
  buildUpdateRequiredMessage,
} from "../src/executors/omnirush.js";
import { getOAuthFlow, setOAuthFetch } from "../src/services/oauth/providers.js";
import { saveOAuthConnection, startOAuthFlow } from "../src/services/oauth/flows.js";
import {
  refreshOAuthToken,
  needsTokenRefresh,
  canRefresh,
} from "../src/services/tokenRefresh.js";
import { initDb, addConnection, getConnectionById, getConnections } from "../src/db/index.js";
import { BaseExecutor } from "../src/executors/base.js";

// ============================================================================
// 1. REGISTRY & METADATA
// ============================================================================

test("Omnirush provider registry - valid definition and aliases", () => {
  const byId = getProvider("omnirush");
  const byAlias = getProvider("or-rush");

  assert.ok(byId, "Provider omnirush harus terdaftar");
  assert.strictEqual(byId, byAlias, "Alias or-rush harus menunjuk ke provider yang sama");
  assert.strictEqual(byId.id, "omnirush");
  assert.strictEqual(byId.category, "oauth");
  assert.strictEqual(byId.format, "openai-responses");
  assert.strictEqual(byId.executor, "omnirush");
  assert.strictEqual(byId.singleAccount, true, "Wajib singleAccount untuk mematuhi fair use");
  assert.strictEqual(byId.noBackgroundSync, true, "Wajib noBackgroundSync untuk menghindari proactive sweep");
  assert.ok(typeof byId.warning === "string" && byId.warning.length > 20, "Harus memuat peringatan risiko");

  // Model checks
  const modelIds = byId.models.map((m) => m.id);
  assert.ok(modelIds.includes("gpt-6-astra"), "Harus memuat gpt-6-astra (terverifikasi)");
  assert.ok(modelIds.includes("gpt-6.1-sol"), "Harus memuat gpt-6.1-sol");
  assert.ok(modelIds.includes("gpt-6-sol"), "Harus memuat gpt-6-sol");

  const astra = byId.models.find((m) => m.id === "gpt-6-astra");
  assert.strictEqual(astra.reasoning, true);
  assert.deepStrictEqual(astra.input, ["text", "image"]);
  assert.strictEqual(astra.contextWindow, 400000);
});

// ============================================================================
// 2. EXECUTOR HEADERS & 426 HANDLING
// ============================================================================

test("OmnirushExecutor - injects official CLI headers for model requests", async () => {
  let capturedArgs = null;
  const original = BaseExecutor.prototype.execute;
  BaseExecutor.prototype.execute = async function (args) {
    capturedArgs = args;
    return new Response(JSON.stringify({ id: "resp_123", output: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const executor = new OmnirushExecutor();
    const res = await executor.execute({
      url: "https://omnirush.ai/omnirush/v1/responses",
      method: "POST",
      headers: { Authorization: "Bearer test_token" },
      body: JSON.stringify({ model: "gpt-6-astra" }),
    });

    assert.strictEqual(res.status, 200);
    assert.ok(capturedArgs, "Super.execute harus dipanggil");
    assert.strictEqual(
      capturedArgs.headers["User-Agent"],
      OMNIRUSH_MODEL_USER_AGENT,
      "User-Agent model call harus 'omnirush' polos"
    );
    assert.strictEqual(
      capturedArgs.headers["X-OmniRush-Client"],
      `cli/${DEFAULT_OMNIRUSH_CLIENT_VERSION}`
    );
    assert.strictEqual(capturedArgs.headers["Authorization"], "Bearer test_token");
  } finally {
    BaseExecutor.prototype.execute = original;
  }
});

test("OmnirushExecutor - handles 426 update_required with actionable guidance", async () => {
  const original = BaseExecutor.prototype.execute;
  BaseExecutor.prototype.execute = async function () {
    return new Response(JSON.stringify({ detail: "client_outdated: minimum version is 3.0.0" }), {
      status: 426,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const executor = new OmnirushExecutor();
    const res = await executor.execute({
      url: "https://omnirush.ai/omnirush/v1/responses",
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-astra" }),
    });

    assert.strictEqual(res.status, 426);
    const body = await res.json();
    assert.strictEqual(body.error.code, "update_required");
    assert.ok(
      body.error.message.includes("OMNIRUSH_CLIENT_VERSION"),
      "Pesan error 426 harus menginstruksikan update OMNIRUSH_CLIENT_VERSION"
    );
  } finally {
    BaseExecutor.prototype.execute = original;
  }
});

test("Omnirush device headers - respect environment override", () => {
  const defaultVersion = getOmnirushClientVersion();
  assert.strictEqual(defaultVersion, DEFAULT_OMNIRUSH_CLIENT_VERSION);

  const prevEnv = process.env.OMNIRUSH_CLIENT_VERSION;
  try {
    process.env.OMNIRUSH_CLIENT_VERSION = "2.9.9";
    assert.strictEqual(getOmnirushClientVersion(), "2.9.9");
    assert.strictEqual(getOmnirushClientHeader(), "cli/2.9.9");
    assert.ok(getOmnirushDeviceUserAgent().startsWith("omnirush/2.9.9 ("));
  } finally {
    if (prevEnv !== undefined) {
      process.env.OMNIRUSH_CLIENT_VERSION = prevEnv;
    } else {
      delete process.env.OMNIRUSH_CLIENT_VERSION;
    }
  }
});

// ============================================================================
// 3. OAUTH DEVICE FLOW (start & poll)
// ============================================================================

test("Omnirush OAuth flow - start initiates device authorization and validates hostname", async () => {
  initDb(":memory:");
  const flow = getOAuthFlow("omnirush");
  assert.ok(flow, "Flow omnirush harus terdaftar");
  assert.strictEqual(flow.flowType, "device_code");

  let calledUrl = null;
  let calledHeaders = null;
  let calledBody = null;

  setOAuthFetch(async (url, init = {}) => {
    calledUrl = url;
    calledHeaders = init.headers;
    calledBody = JSON.parse(init.body || "{}");
    return new Response(
      JSON.stringify({
        device_code: "dev_code_123",
        user_code: "ABCD-1234",
        verification_uri: "https://omnirush.ai/console",
        verification_uri_complete: "https://omnirush.ai/console?code=ABCD-1234",
        expires_in: 600,
        interval: 5,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await flow.start();
    assert.strictEqual(calledUrl, "https://omnirush.ai/omnirush/device/authorize");
    assert.ok(calledHeaders["User-Agent"].startsWith("omnirush/"));
    assert.ok(calledHeaders["X-OmniRush-Client"].startsWith("cli/"));
    assert.ok(calledBody.device_name.startsWith("zenith-router di "));
    assert.ok(calledBody.platform);

    assert.strictEqual(result.deviceCode, "dev_code_123");
    assert.strictEqual(result.userCode, "ABCD-1234");
    assert.strictEqual(result.verificationUri, "https://omnirush.ai/console?code=ABCD-1234");
    assert.strictEqual(result.expiresIn, 600);
    assert.strictEqual(result.interval, 5);
  } finally {
    setOAuthFetch(null);
  }
});

test("Omnirush OAuth flow - start rejects untrusted verification hostname", async () => {
  initDb(":memory:");
  const flow = getOAuthFlow("omnirush");

  setOAuthFetch(async () => {
    return new Response(
      JSON.stringify({
        device_code: "dev_code_evil",
        user_code: "EVIL-1234",
        verification_uri_complete: "https://phishing-site.com/console?code=EVIL",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    await assert.rejects(
      async () => {
        await flow.start();
      },
      /mencurigakan/i
    );
  } finally {
    setOAuthFetch(null);
  }
});

test("Omnirush OAuth flow - poll handles pending (428), slow_down (429), expired (400), and success (200)", async () => {
  const flow = getOAuthFlow("omnirush");

  // Case 1: 428 Precondition Required -> { pending: true }
  setOAuthFetch(async () => {
    return new Response(JSON.stringify({ detail: "authorization_pending" }), {
      status: 428,
      headers: { "Content-Type": "application/json" },
    });
  });
  let pollRes = await flow.poll({ deviceCode: "dev_123", interval: 5 });
  assert.strictEqual(pollRes.pending, true);

  // Case 2: 429 Too Many Requests -> { pending: true, interval: 10 }
  setOAuthFetch(async () => {
    return new Response(JSON.stringify({ detail: "slow_down" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  });
  pollRes = await flow.poll({ deviceCode: "dev_123", interval: 5 });
  assert.strictEqual(pollRes.pending, true);
  assert.strictEqual(pollRes.interval, 10);

  // Case 3: 400 expired_token -> error kedaluwarsa
  setOAuthFetch(async () => {
    return new Response(JSON.stringify({ detail: "expired_token" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  });
  pollRes = await flow.poll({ deviceCode: "dev_123", interval: 5 });
  assert.ok(pollRes.error);
  assert.ok(pollRes.error.includes("kedaluwarsa"));

  // Case 4: 200 Success -> returns token pair
  setOAuthFetch(async () => {
    return new Response(
      JSON.stringify({
        access_token: "omni_acc_token_xyz",
        refresh_token: "omni_ref_token_abc",
        gateway_url: "https://omnirush.ai/omnirush/v1",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  pollRes = await flow.poll({ deviceCode: "dev_123", interval: 5 });
  assert.ok(pollRes.tokens);
  assert.strictEqual(pollRes.tokens.access_token, "omni_acc_token_xyz");
  assert.strictEqual(pollRes.tokens.refresh_token, "omni_ref_token_abc");
  assert.strictEqual(pollRes.tokens.extra.gateway_url, "https://omnirush.ai/omnirush/v1");
  assert.strictEqual(pollRes.tokens.extra.device_code, "dev_123");

  setOAuthFetch(null);
});

// ============================================================================
// 4. SINGLE ACCOUNT CONSTRAINT
// ============================================================================

test("Omnirush single-account constraint - prevents adding second account", async () => {
  initDb(":memory:");

  // Akun pertama ditambahkan
  addConnection({
    provider: "omnirush",
    name: "Akun Omnirush Utama",
    auth_type: "oauth",
    credentials: { access_token: "token_1", refresh_token: "refresh_1" },
  });

  const existing = getConnections("omnirush");
  assert.strictEqual(existing.length, 1);

  // Coba startOAuthFlow untuk akun kedua -> harus gagal
  const flow = getOAuthFlow("omnirush");
  await assert.rejects(
    async () => {
      await flow.start();
    },
    /Hanya satu akun Omnirush yang diperbolehkan/i
  );

  await assert.rejects(
    async () => {
      await startOAuthFlow({ providerId: "omnirush", origin: "http://localhost:20120" });
    },
    /Hanya satu akun Omnirush yang diperbolehkan/i
  );

  // Coba saveOAuthConnection langsung untuk akun kedua -> harus ditolak
  assert.throws(
    () => {
      saveOAuthConnection("omnirush", { access_token: "token_2", refresh_token: "refresh_2" });
    },
    /Hanya satu akun Omnirush yang diperbolehkan/i
  );

  assert.strictEqual(getConnections("omnirush").length, 1, "Tetap hanya ada 1 akun di DB");
});

// ============================================================================
// 5. TOKEN REFRESH & MUTEX
// ============================================================================

test("needsTokenRefresh - always returns false for omnirush to avoid background sweeps", () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "omnirush",
    name: "Omnirush Test",
    auth_type: "oauth",
    credentials: {
      access_token: "acc_token",
      refresh_token: "ref_token",
      expires_at: Date.now() - 1000, // Walaupun secara timestamp sudah lewat
    },
  });

  assert.strictEqual(canRefresh(conn), true, "Dapat di-refresh secara reaktif");
  assert.strictEqual(
    needsTokenRefresh(conn),
    false,
    "needsTokenRefresh harus false agar tidak di-sweep scheduler"
  );
});

test("refreshOAuthToken - rotates both tokens and persists immediately before use", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "omnirush",
    name: "Omnirush Test",
    auth_type: "oauth",
    credentials: {
      access_token: "old_access",
      refresh_token: "old_refresh",
    },
  });

  let refreshCallCount = 0;
  let receivedBody = null;

  setOAuthFetch(async (url, init = {}) => {
    if (url.includes("/device/refresh")) {
      refreshCallCount++;
      receivedBody = JSON.parse(init.body || "{}");
      return new Response(
        JSON.stringify({
          access_token: "new_rotated_access",
          refresh_token: "new_rotated_refresh",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const refreshed = await refreshOAuthToken(conn, { force: true });
    assert.strictEqual(refreshCallCount, 1);
    assert.strictEqual(receivedBody.refresh_token, "old_refresh");
    assert.strictEqual(refreshed.credentials.access_token, "new_rotated_access");
    assert.strictEqual(refreshed.credentials.refresh_token, "new_rotated_refresh");

    // Pastikan database terupdate seketika
    const fromDb = getConnectionById(conn.id);
    assert.strictEqual(fromDb.credentials.access_token, "new_rotated_access");
    assert.strictEqual(fromDb.credentials.refresh_token, "new_rotated_refresh");
  } finally {
    setOAuthFetch(null);
  }
});

test("refreshOAuthToken - single-flight mutex ensures only 1 refresh is in-flight", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "omnirush",
    name: "Omnirush Mutex Test",
    auth_type: "oauth",
    credentials: {
      access_token: "acc_1",
      refresh_token: "ref_1",
    },
  });

  let refreshCalls = 0;
  setOAuthFetch(async (url) => {
    if (url.includes("/device/refresh")) {
      refreshCalls++;
      // Simulasi delay jaringan
      await new Promise((r) => setTimeout(r, 50));
      return new Response(
        JSON.stringify({
          access_token: "acc_mutex_done",
          refresh_token: "ref_mutex_done",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    // Dua pemanggil bersamaan dengan force: true
    const [p1, p2] = await Promise.all([
      refreshOAuthToken(conn, { force: true }),
      refreshOAuthToken(conn, { force: true }),
    ]);

    assert.strictEqual(refreshCalls, 1, "Hanya 1 permintaan HTTP refresh yang dikirim");
    assert.strictEqual(p1.credentials.access_token, "acc_mutex_done");
    assert.strictEqual(p2.credentials.access_token, "acc_mutex_done");
  } finally {
    setOAuthFetch(null);
  }
});

test("refreshOAuthToken - deactivates connection on 401 and 409 without retrying", async () => {
  initDb(":memory:");

  // Uji respons 409 (refresh_token_already_used)
  const conn409 = addConnection({
    provider: "omnirush",
    name: "Omnirush 409 Test",
    auth_type: "oauth",
    credentials: { access_token: "acc", refresh_token: "already_used_refresh" },
  });

  setOAuthFetch(async (url) => {
    if (url.includes("/device/refresh")) {
      return new Response(JSON.stringify({ detail: "refresh_token_already_used" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    await assert.rejects(
      async () => {
        await refreshOAuthToken(conn409, { force: true });
      },
      /sudah pernah digunakan/i
    );

    const fromDb = getConnectionById(conn409.id);
    assert.strictEqual(fromDb.is_active, 0, "Akun harus ditandai nonaktif pada 409");
  } finally {
    setOAuthFetch(null);
  }

  // Uji respons 401 (refresh_token_invalid_or_expired)
  const conn401 = addConnection({
    provider: "omnirush",
    name: "Omnirush 401 Test",
    auth_type: "oauth",
    credentials: { access_token: "acc", refresh_token: "dead_refresh" },
  });

  setOAuthFetch(async (url) => {
    if (url.includes("/device/refresh")) {
      return new Response(JSON.stringify({ detail: "refresh_token_invalid_or_expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    await assert.rejects(
      async () => {
        await refreshOAuthToken(conn401, { force: true });
      },
      /tidak lagi valid/i
    );

    const fromDb401 = getConnectionById(conn401.id);
    assert.strictEqual(fromDb401.is_active, 0, "Akun harus ditandai nonaktif pada 401");
  } finally {
    setOAuthFetch(null);
  }
});
