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
  // Ensure bridge active flag is set so resolveOpencodeUrl points to the Bun bridge URL
  process.env.ZENITH_OPENCODE_BASE_URL = "http://127.0.0.1:20129/v1";
  try {
    const res = await executor.execute({
      url: "http://127.0.0.1:20129/v1/chat/completions",
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
    delete process.env.ZENITH_OPENCODE_BASE_URL;
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

    const res = await handleBridgeRequest(req);
    assert.equal(res.status, 200);
    assert.ok(capturedFetch);
    assert.equal(capturedFetch.opts.proxy, DUMMY_PROXY, "the tunnel is Bun's `proxy` option");
    assert.equal(capturedFetch.opts.dispatcher, undefined, "a dispatcher is ignored by Bun and would leak the host IP");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
