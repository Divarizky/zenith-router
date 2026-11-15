import test from "node:test";
import assert from "node:assert/strict";
import { OpencodeExecutor } from "../src/executors/opencode.js";
import { handleBridgeRequest } from "../src/bridge/opencode-bridge.js";

const DUMMY_PROXY = ["http://", "user", ":", "dummy_pass_123", "@127.0.0.1:3128"].join("");

test("OpencodeExecutor forwards proxy to Bun bridge via x-zenith-proxy without using proxyFetch to loopback", async () => {
  let executedCalls = [];

  class MockExecutor extends OpencodeExecutor {
    constructor() {
      super();
      this.fetchFn = async (url, init) => {
        executedCalls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok from mock bridge" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      this.proxyFetchFn = async (url, init, proxyUrl) => {
        executedCalls.push({ url, proxyUrl, type: "proxyFetch" });
        throw new Error("proxyFetch should NOT be called for bridge on loopback!");
      };
    }
  }

  const executor = new MockExecutor();
  const previousBaseUrl = process.env.ZENITH_OPENCODE_BASE_URL;
  // A configurable loopback bridge origin must use the internal proxy header.
  process.env.ZENITH_OPENCODE_BASE_URL = "http://[::1]:20130/v1";
  try {
    const res = await executor.execute({
      url: "http://[::1]:20130/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/free", messages: [{ role: "user", content: "hi" }] }),
      proxyUrl: DUMMY_PROXY,
    });

    assert.equal(res.status, 200);
    assert.equal(executedCalls.length, 1);
    assert.equal(executedCalls[0].type, undefined, "Must not call proxyFetch");
    assert.equal(executedCalls[0].headers["x-zenith-proxy"], DUMMY_PROXY);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.ZENITH_OPENCODE_BASE_URL;
    else process.env.ZENITH_OPENCODE_BASE_URL = previousBaseUrl;
  }
});

test("OpencodeExecutor keeps proxy routing on gate retries through a configured bridge", async () => {
  const previousBaseUrl = process.env.ZENITH_OPENCODE_BASE_URL;
  const calls = [];
  class RetryExecutor extends OpencodeExecutor {
    constructor() {
      super();
      this.fetchFn = async (url, init) => {
        calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      };
      this.proxyFetchFn = async () => {
        throw new Error("loopback bridge must not be sent to proxyFetch");
      };
    }
  }

  process.env.ZENITH_OPENCODE_BASE_URL = "http://localhost:20130/v1";
  try {
    const executor = new RetryExecutor();
    const res = await executor.execute({
      url: "http://localhost:20130/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/free", messages: [{ role: "user", content: "hi" }] }),
      proxyUrl: DUMMY_PROXY,
    });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 2, "gate rejection triggers one retry");
    for (const call of calls) {
      assert.equal(call.url, "http://localhost:20130/v1/chat/completions");
      assert.equal(call.headers["x-zenith-proxy"], DUMMY_PROXY);
    }
  } finally {
    if (previousBaseUrl === undefined) delete process.env.ZENITH_OPENCODE_BASE_URL;
    else process.env.ZENITH_OPENCODE_BASE_URL = previousBaseUrl;
  }
});

test("handleBridgeRequest extracts x-zenith-proxy into upstream fetch options", async () => {
  let capturedFetch = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedFetch = { url, opts };
    return new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  try {
    const req = new Request("http://127.0.0.1:20129/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zenith-proxy": DUMMY_PROXY,
      },
      body: JSON.stringify({
        model: "opencode/free",
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
    });

    const res = await handleBridgeRequest(req, { useBunProxy: true });
    assert.equal(res.status, 200);
    assert.ok(capturedFetch);
    assert.equal(capturedFetch.opts.proxy, DUMMY_PROXY, "the tunnel is Bun's `proxy` option");
    assert.equal(capturedFetch.opts.dispatcher, undefined, "a dispatcher is ignored by Bun and would leak the host IP");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Node bridge aborts a proxy connection that never returns headers", async () => {
  const previousTimeout = process.env.ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS;
  process.env.ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS = "20";
  const req = new Request("http://127.0.0.1:20129/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zenith-proxy": DUMMY_PROXY,
    },
    body: JSON.stringify({ model: "opencode/free", messages: [{ role: "user", content: "ping" }] }),
  });
  try {
    const res = await handleBridgeRequest(req, {
      useBunProxy: false,
      proxyFetchImpl: (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    });
    assert.equal(res.status, 502, "a stalled proxy handshake must time out");
  } finally {
    if (previousTimeout === undefined) delete process.env.ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS;
    else process.env.ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS = previousTimeout;
  }
});

test("Node bridge uses proxy transport and never falls back to direct fetch", async () => {
  let directFetchCalls = 0;
  let proxyFetchCalls = 0;
  const req = new Request("http://127.0.0.1:20129/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zenith-proxy": DUMMY_PROXY,
    },
    body: JSON.stringify({ model: "opencode/free", messages: [{ role: "user", content: "ping" }] }),
  });

  const res = await handleBridgeRequest(req, {
    useBunProxy: false,
    fetchImpl: async () => {
      directFetchCalls++;
      return new Response("unexpected direct fetch", { status: 200 });
    },
    proxyFetchImpl: async (url, options, proxyUrl) => {
      proxyFetchCalls++;
      assert.equal(proxyUrl, DUMMY_PROXY);
      assert.equal(options.method, "POST");
      throw new Error("proxy unavailable");
    },
  });

  assert.equal(res.status, 502);
  assert.equal(proxyFetchCalls, 1);
  assert.equal(directFetchCalls, 0, "proxy failure must not leak request directly upstream");
});
