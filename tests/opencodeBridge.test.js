import test from "node:test";
import assert from "node:assert";
import {
  generateOpencodeSessionId,
  prepareOpenCodePayload,
  buildOpenCodeHeaders,
  handleBridgeRequest,
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
