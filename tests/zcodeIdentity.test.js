import test from "node:test";
import assert from "node:assert";
import identity from "../src/providers/assets/zcodeIdentity.json" with { type: "json" };
import { buildZcodeLLMHeaders, buildZcodeSystemBlocks } from "../src/services/zcodeIdentity.js";
import { OAUTH_FLOWS, setOAuthFetch } from "../src/services/oauth/providers.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("identity asset keeps the captured prompt prefix and version fields", () => {
  assert.strictEqual(identity.stablePrefix.length, 3014, "stablePrefix must match the ZCode 3.16.3 capture length");
  assert.ok(identity.cliPrefix.length > 0, "cliPrefix must be present");
  assert.strictEqual(identity.anthropicVersion, "2023-06-01");
  assert.strictEqual(identity.anthropicBeta, "mid-conversation-system-2026-04-07");
  assert.ok(identity.sdkUserAgent.length > 0, "sdkUserAgent must be present");
});

test("LLM headers carry the ZCode referer, title and app version", () => {
  const h = buildZcodeLLMHeaders();
  assert.strictEqual(h["http-referer"], "https://zcode.z.ai");
  assert.strictEqual(h["x-title"], "Z Code@electron");
  assert.strictEqual(h["x-zcode-app-version"], "3.16.3");
  assert.strictEqual(h["x-zcode-agent"], "glm");
  assert.strictEqual(h["anthropic-version"], identity.anthropicVersion);
  assert.strictEqual(h["anthropic-beta"], identity.anthropicBeta);
});

test("LLM headers generate session, request and trace ids in ZCode formats", () => {
  const h = buildZcodeLLMHeaders();
  assert.match(h["x-session-id"], /^session_[0-9a-f]{32}$/);
  assert.match(h["x-request-id"], /^req_[0-9a-f]{32}$/);
  assert.match(h["x-zcode-trace-id"], /^tr_[0-9a-f]{32}$/);
  assert.strictEqual(h["x-zcode-query-source"], "main_turn");
  assert.strictEqual(h["x-zcode-session-type"], "main");
  assert.notStrictEqual(buildZcodeLLMHeaders()["x-request-id"], h["x-request-id"], "each call gets a fresh request id");
});

test("system blocks build three ordered blocks with ephemeral cache on block two", () => {
  const blocks = buildZcodeSystemBlocks("Be concise.");
  assert.strictEqual(blocks.length, 3);
  assert.deepStrictEqual(blocks[0], { type: "text", text: identity.cliPrefix });
  assert.deepStrictEqual(blocks[1], {
    type: "text",
    text: identity.stablePrefix,
    cache_control: { type: "ephemeral" },
  });
  assert.deepStrictEqual(blocks[2], { type: "text", text: "\n\nBe concise." });
});

test("system blocks omit the third block when the client sends no system prompt", () => {
  const blocks = buildZcodeSystemBlocks(undefined);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[1].cache_control?.type, "ephemeral");
});

function mockGlmPoll(payload) {
  setOAuthFetch(async (url, init = {}) => {
    const u = String(url);
    if (u.includes("oauth/cli/poll")) return json(payload);
    if (u.includes("auth/z/login")) return json({ code: 0, data: { access_token: "biz" } });
    if (u.includes("getCustomerInfo")) {
      return json({
        code: 0,
        data: { organizations: [{ organizationId: "o1", projects: [{ projectId: "p1", projectName: "default" }] }] },
      });
    }
    if (u.includes("/copy/")) return json({ code: 0, data: { secretKey: "SECRET" } });
    if (u.includes("api_keys")) {
      return init.method === "POST" ? json({ code: 0, data: { apiKey: "KEYID" } }) : json({ code: 0, data: [] });
    }
    return json({ error: "unmocked" }, 404);
  });
}

test("glm poll stores plan_token and refresh_token alongside the PaaS key", async (t) => {
  t.after(() => setOAuthFetch(null));
  mockGlmPoll({
    code: 0,
    data: {
      status: "ready",
      token: "plan.jwt.value",
      user: { email: "z@x.io" },
      zai: { access_token: "zai-access", refresh_token: "zai-refresh" },
    },
  });
  const tokens = await OAUTH_FLOWS.glm.poll({ deviceCode: "f1", state: { pollToken: "p" } });
  assert.strictEqual(tokens.tokens.plan_token, "plan.jwt.value");
  assert.strictEqual(tokens.tokens.refresh_token, "zai-refresh");
  assert.match(tokens.tokens.access_token, /^KEYID\.SECRET$/, "PaaS API key is still returned");
});

test("glm poll returns the PaaS key with null plan_token when ZCode omits data.token", async (t) => {
  t.after(() => setOAuthFetch(null));
  mockGlmPoll({
    code: 0,
    data: { status: "ready", user: { email: "z@x.io" }, zai: { access_token: "zai-access" } },
  });
  const result = await OAUTH_FLOWS.glm.poll({ deviceCode: "f1", state: { pollToken: "p" } });
  assert.ifError(result.error);
  assert.strictEqual(result.tokens.plan_token, null);
  assert.strictEqual(result.tokens.refresh_token, null);
  assert.match(result.tokens.access_token, /^KEYID\.SECRET$/);
});
