import test from "node:test";
import assert from "node:assert";
import {
  generateOpencodeSessionId,
  prepareOpenCodePayload,
  buildOpenCodeHeaders,
  handleBridgeRequest,
  parseSseStreamToChatCompletion,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_BRIDGE_URL,
  OPENCODE_USER_AGENT,
} from "../src/bridge/opencode-bridge.js";
import {
  findBunBinary,
  isOpencodeBridgeActive,
  setOpencodeBridgeActive,
  isOpencodeBridgeRunning,
} from "../src/services/opencodeBridge.js";
import {
  getOpencodeBaseUrlOverride,
  resolveOpencodeUrl,
  resetOpencodeCatalog,
} from "../src/services/opencodeCatalog.js";
import {
  isOpencodeGateStatus,
  isOpencodeFreeUsageLimit,
  isOpencodeGateRejection,
  noteOpencodeGateRejection,
  resetOpencodeGate,
  getOpencodeGateState,
} from "../src/services/opencodeGate.js";
import { OpencodeExecutor } from "../src/executors/opencode.js";
import { initDb } from "../src/db/index.js";
import { recordUsage, getUsageStats } from "../src/services/usage.js";
import { installBunSoft } from "../scripts/ensureBun.js";

test("opencode bridge - session ID matches official upstream shape", () => {
  const sid = generateOpencodeSessionId();
  assert.strictEqual(sid.length, 30);
  assert.match(sid, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

  // Deterministic timestamp produces consistent hex prefix
  const fixedTime = 1793700000000;
  const sid1 = generateOpencodeSessionId(fixedTime);
  const sid2 = generateOpencodeSessionId(fixedTime);
  assert.strictEqual(sid1.slice(0, 16), sid2.slice(0, 16));
  assert.strictEqual(sid1.startsWith("ses_"), true);
});

test("opencode bridge - payload preparation injects baseline template and tools", () => {
  // Case 1: no system prompt and no tools
  const raw1 = {
    model: "glm-5.3-flash-free",
    messages: [{ role: "user", content: "halo" }],
  };
  const prepared1 = prepareOpenCodePayload(raw1);
  assert.strictEqual(prepared1.messages.length, 2);
  assert.strictEqual(prepared1.messages[0].role, "system");
  assert.ok(prepared1.messages[0].content.length > 8000, "baseline prompt must be ~10KB");
  assert.ok(prepared1.tools.length >= 1, "at least 1 tool definition must be present");
  assert.strictEqual(prepared1.tools.some((t) => (t.function?.name || t.name) === "read"), true);
  assert.strictEqual(prepared1.stream, true);

  // Case 2: client sends custom system prompt and custom tool
  const raw2 = {
    model: "glm-5.3-flash-free",
    messages: [
      { role: "system", content: "You are an expert in JavaScript." },
      { role: "user", content: "halo" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "custom_eval", description: "Evaluate code" },
      },
    ],
  };
  const prepared2 = prepareOpenCodePayload(raw2);
  assert.strictEqual(prepared2.messages.length, 2);
  assert.strictEqual(prepared2.messages[0].role, "system");
  assert.ok(prepared2.messages[0].content.includes("You are an expert in JavaScript."));
  assert.ok(prepared2.messages[0].content.includes("You are an AI agent running in OpenCode"));
  // Both read tool and custom_eval must be in tools array
  const toolNames = prepared2.tools.map((t) => t.function?.name || t.name);
  assert.ok(toolNames.includes("read"), "read tool must be included");
  assert.ok(toolNames.includes("custom_eval"), "custom_eval must be preserved");
});

test("opencode bridge - buildOpenCodeHeaders sets standard UA, auth, and 4 session headers", () => {
  const sid = "ses_e5eff29e6ffevDXKDkWzWYz6FQ";
  const headers = buildOpenCodeHeaders({}, sid);

  assert.strictEqual(headers["User-Agent"], OPENCODE_USER_AGENT);
  assert.strictEqual(headers["Authorization"], "Bearer public");
  assert.strictEqual(headers["x-opencode-client"], "cli");
  assert.strictEqual(headers["x-opencode-session-id"], sid);
  assert.strictEqual(headers["x-opencode-session"], sid);
  assert.strictEqual(headers["x-session-affinity"], sid);
  assert.strictEqual(headers["x-session-id"], sid);

  // Custom authorization is passed through
  const authHeaders = buildOpenCodeHeaders({ authorization: "CustomAuthHeader123" }, sid);
  assert.strictEqual(authHeaders["Authorization"], "CustomAuthHeader123");
});

test("opencode bridge - handleBridgeRequest responds to health check and validates routes", async () => {
  const healthReq = new Request("http://127.0.0.1:20129/health", { method: "GET" });
  const healthRes = await handleBridgeRequest(healthReq);
  assert.strictEqual(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.status, "ok");
  assert.strictEqual(healthData.bridge, "opencode-bun");

  const notFoundReq = new Request("http://127.0.0.1:20129/unknown", { method: "GET" });
  const notFoundRes = await handleBridgeRequest(notFoundReq);
  assert.strictEqual(notFoundRes.status, 404);

  const invalidJsonReq = new Request("http://127.0.0.1:20129/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid-json",
  });
  const invalidJsonRes = await handleBridgeRequest(invalidJsonReq);
  assert.strictEqual(invalidJsonRes.status, 400);
});

test("opencode bridge - lifecycle detection and URL routing override", () => {
  const previousOverride = process.env.ZENITH_OPENCODE_BASE_URL;
  delete process.env.ZENITH_OPENCODE_BASE_URL;
  setOpencodeBridgeActive(false);

  // Default when bridge is inactive: catalog resolves to real upstream
  assert.strictEqual(getOpencodeBaseUrlOverride(), null);
  assert.strictEqual(resolveOpencodeUrl("glm-5.3-flash-free", "chat"), "https://opencode.ai/inference/openai/v1/chat/completions");

  // When bridge is active: resolves to loopback bridge URL
  setOpencodeBridgeActive(true);
  assert.strictEqual(getOpencodeBaseUrlOverride(), DEFAULT_BRIDGE_URL);
  assert.strictEqual(resolveOpencodeUrl("glm-5.3-flash-free", "chat"), `${DEFAULT_BRIDGE_URL}/chat/completions`);

  // Explicit env var takes precedence
  process.env.ZENITH_OPENCODE_BASE_URL = "http://127.0.0.1:9999/v1";
  assert.strictEqual(getOpencodeBaseUrlOverride(), "http://127.0.0.1:9999/v1");
  assert.strictEqual(resolveOpencodeUrl("glm-5.3-flash-free", "chat"), "http://127.0.0.1:9999/v1/chat/completions");

  // Cleanup
  if (previousOverride !== undefined) process.env.ZENITH_OPENCODE_BASE_URL = previousOverride;
  else delete process.env.ZENITH_OPENCODE_BASE_URL;
  setOpencodeBridgeActive(false);
});

test("opencode bridge - bun binary detection finds local bun", () => {
  const bun = findBunBinary();
  assert.ok(bun, "bun binary should be found in system or ~/.bun/bin/bun");
});

test("opencode bridge - FreeUsageLimitError detection and cooldown handling", async () => {
  resetOpencodeGate();

  const errBody = JSON.stringify({
    type: "error",
    error: {
      type: "FreeUsageLimitError",
      message: "Free usage limit reached. Free models work in OpenCode: subscribe to OpenCode Go.",
    },
  });

  assert.strictEqual(isOpencodeGateStatus(429), true);
  assert.strictEqual(isOpencodeFreeUsageLimit(errBody), true);
  assert.strictEqual(isOpencodeGateRejection(429, errBody), true);

  // Plain 429 without FreeUsageLimitError is capacity, not gate rejection
  assert.strictEqual(isOpencodeGateRejection(429, "Too Many Requests"), false);

  // noteOpencodeGateRejection records quota-exhausted gate with Retry-After
  const now = 1000000;
  const state = noteOpencodeGateRejection(
    "direct",
    {
      status: 429,
      shapeOk: true,
      retryAfterMs: 45000,
    },
    now
  );

  assert.strictEqual(state.gate, "quota-exhausted");
  assert.strictEqual(state.retryAfterMs, 45000);
  assert.strictEqual(state.until, now + 45000);

  // OpencodeExecutor with 429 FreeUsageLimitError starts cooldown directly without useless retry
  let fetchCount = 0;
  const executor = new OpencodeExecutor({
    fetchFn: async () => {
      fetchCount++;
      return new Response(errBody, {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      });
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/inference/openai/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.3-flash-free",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.strictEqual(fetchCount, 1, "FreeUsageLimitError quota limit must not do a redundant identity retry");
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get("X-OpenCode-Gate"), "quota-exhausted");
  assert.strictEqual(res.headers.get("Retry-After"), "60");

  resetOpencodeGate();
});

test("opencode bridge - usage history records provider stats for keyless opencode", () => {
  initDb(":memory:");

  // Record 1 successful request and 1 failed request for provider opencode
  recordUsage({
    provider: "opencode",
    model: "glm-5.3-flash-free",
    inputTokens: 120,
    outputTokens: 30,
    durationMs: 850,
  });

  recordUsage({
    provider: "opencode",
    model: "glm-5.3-flash-free",
    inputTokens: 50,
    outputTokens: 0,
    durationMs: 200,
  });

  const stats = getUsageStats();
  assert.strictEqual(stats.summary.total_requests, 2);
  assert.strictEqual(stats.summary.total_tokens, 200);

  const opencodeStat = stats.by_provider.find((p) => p.provider === "opencode");
  assert.ok(opencodeStat, "provider 'opencode' must appear in by_provider stats even without connection");
  assert.strictEqual(opencodeStat.count, 2);
  assert.strictEqual(opencodeStat.total_tokens, 200);
});

test("opencode bridge - upstream body always has stream: true even when client sends stream: false", () => {
  const payloadFalse = prepareOpenCodePayload({
    model: "glm-5.3-flash-free",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });
  assert.strictEqual(payloadFalse.stream, true, "upstream payload must always force stream: true");

  const payloadOmitted = prepareOpenCodePayload({
    model: "glm-5.3-flash-free",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.strictEqual(payloadOmitted.stream, true, "omitted stream must default to stream: true");
});

test("opencode bridge - parseSseStreamToChatCompletion correctly aggregates SSE to non-stream JSON including tool_calls and reasoning", async () => {
  const sseLines = [
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[{"index":0,"delta":{"reasoning_content":"Let me check."}}]}',
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[{"index":0,"delta":{"content":"Halo!"}}]}',
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read","arguments":"{\\"path\\": "}}]}}]}',
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.txt\\"}"}}]}}]}',
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[{"index":0,"finish_reason":"tool_calls"}]}',
    'data: {"id":"chatcmpl-123","model":"glm-5.3-flash-free","created":1793700000,"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20,"total_tokens":70}}',
    'data: [DONE]',
  ].join("\n\n");

  const completion = await parseSseStreamToChatCompletion(sseLines, "glm-5.3-flash-free");

  assert.strictEqual(completion.id, "chatcmpl-123");
  assert.strictEqual(completion.object, "chat.completion");
  assert.strictEqual(completion.model, "glm-5.3-flash-free");
  assert.strictEqual(completion.created, 1793700000);
  assert.strictEqual(completion.choices.length, 1);
  assert.strictEqual(completion.choices[0].finish_reason, "tool_calls");

  const msg = completion.choices[0].message;
  assert.strictEqual(msg.role, "assistant");
  assert.strictEqual(msg.content, "Halo!");
  assert.strictEqual(msg.reasoning_content, "Let me check.");
  assert.strictEqual(Array.isArray(msg.tool_calls), true);
  assert.strictEqual(msg.tool_calls.length, 1);
  assert.strictEqual(msg.tool_calls[0].id, "call_abc");
  assert.strictEqual(msg.tool_calls[0].type, "function");
  assert.strictEqual(msg.tool_calls[0].function.name, "read");
  assert.strictEqual(msg.tool_calls[0].function.arguments, '{"path": "test.txt"}');

  assert.deepStrictEqual(completion.usage, {
    prompt_tokens: 50,
    completion_tokens: 20,
    total_tokens: 70,
  });
});

test("opencode bridge - handleBridgeRequest forwards upstream error status (429) without wrapping", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Quota reached" },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "120",
          },
        }
      );
    };

    const req = new Request("http://127.0.0.1:20129/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3-flash-free",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });

    const res = await handleBridgeRequest(req);
    assert.strictEqual(res.status, 429, "upstream 429 status must be forwarded as-is");
    assert.strictEqual(res.headers.get("retry-after"), "120");
    const body = await res.json();
    assert.strictEqual(body.error.type, "FreeUsageLimitError");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("opencode bridge - handleBridgeRequest handles client stream: false by aggregating SSE", async () => {
  const origFetch = globalThis.fetch;
  try {
    let capturedBody = null;
    globalThis.fetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      const sseStream = [
        'data: {"id":"chatcmpl-mock","model":"glm-5.3-flash-free","choices":[{"index":0,"delta":{"content":"Non-stream answer"}}]}',
        'data: {"id":"chatcmpl-mock","model":"glm-5.3-flash-free","choices":[{"index":0,"finish_reason":"stop"}]}',
        'data: [DONE]',
      ].join("\n\n");
      return new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const req = new Request("http://127.0.0.1:20129/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3-flash-free",
        messages: [{ role: "user", content: "halo" }],
        stream: false,
      }),
    });

    const res = await handleBridgeRequest(req);
    assert.strictEqual(capturedBody.stream, true, "body sent to upstream must be stream: true");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/json");

    const json = await res.json();
    assert.strictEqual(json.object, "chat.completion");
    assert.strictEqual(json.choices[0].message.content, "Non-stream answer");
    assert.strictEqual(json.choices[0].finish_reason, "stop");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("opencode bridge - findBunBinary detects Windows bun.exe in AppData or .bun", () => {
  const mockFs = {
    existsSync(p) {
      return p === "C:\\Users\\tester\\.bun\\bin\\bun.exe";
    },
    statSync() {
      return { isDirectory: () => false };
    },
    accessSync() {
      return true;
    },
    constants: { F_OK: 0, X_OK: 1 },
  };

  const found = findBunBinary({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\tester" },
    fsImpl: mockFs,
  });

  assert.strictEqual(found, "C:\\Users\\tester\\.bun\\bin\\bun.exe");

  // PATH fallback via where.exe
  const mockFs2 = {
    existsSync(p) {
      return p === "C:\\Program Files\\bun\\bun.exe";
    },
    statSync() {
      return { isDirectory: () => false };
    },
    accessSync() {
      return true;
    },
    constants: { F_OK: 0, X_OK: 1 },
  };
  const foundPath = findBunBinary({
    platform: "win32",
    env: {},
    fsImpl: mockFs2,
    execFn: () => "C:\\Program Files\\bun\\bun.exe\r\n",
  });
  assert.strictEqual(foundPath, "C:\\Program Files\\bun\\bun.exe");
});

test("opencode bridge - installBunSoft handles offline/failed installer softly without throwing", () => {
  let warned = false;
  const result = installBunSoft({
    platform: "linux",
    findFn: () => null,
    execFn: () => {
      throw new Error("Could not resolve host: bun.sh");
    },
    logFn: () => {},
    warnFn: () => {
      warned = true;
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, "install_skipped_or_failed");
  assert.strictEqual(warned, true);
});


