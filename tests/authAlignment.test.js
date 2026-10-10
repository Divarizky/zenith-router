import test from "node:test";
import assert from "node:assert";
import { applyConnectionAuth } from "../src/services/auth.js";
import { KiroExecutor, kiroBaseUrls, kiroHeadersForUrl } from "../src/executors/kiro.js";

test("glm auth uses Bearer token for OpenAI PaaS endpoint", () => {
  const oauth = applyConnectionAuth({}, {
    provider: "glm",
    auth_type: "oauth",
    credentials: { access_token: "glm-token" },
  });
  assert.strictEqual(oauth.Authorization, "Bearer glm-token");

  const apiKey = applyConnectionAuth({}, {
    provider: "glm",
    auth_type: "apikey",
    credentials: { api_key: "glm-key" },
  });
  assert.strictEqual(apiKey.Authorization, "Bearer glm-key");
});

test("kiro auth-aware routing puts Amazon Q first and regionalizes IDC", () => {
  assert.deepStrictEqual(kiroBaseUrls({ auth_method: "api_key" }), [
    "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
  ]);

  assert.deepStrictEqual(kiroBaseUrls({ auth_method: "idc", region: "eu-west-1" }), [
    "https://q.eu-west-1.amazonaws.com/generateAssistantResponse",
    "https://codewhisperer.eu-west-1.amazonaws.com/generateAssistantResponse",
    "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
  ]);
});

test("kiro builds endpoint-specific headers", () => {
  const q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
  const cw = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
  const runtime = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
  const credentials = { auth_method: "api_key" };

  const qHeaders = kiroHeadersForUrl({}, credentials, q);
  const cwHeaders = kiroHeadersForUrl({}, credentials, cw);
  const runtimeHeaders = kiroHeadersForUrl({}, credentials, runtime);

  assert.strictEqual(qHeaders.TokenType, "API_KEY");
  assert.strictEqual(qHeaders["X-Amz-Target"], undefined);
  assert.strictEqual(cwHeaders["X-Amz-Target"], "AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
  assert.strictEqual(runtimeHeaders["X-Amz-Target"], undefined);
});

test("kiro executor routes authenticated connections through Amazon Q first", async () => {
  let seenUrl;
  let seenHeaders;
  const executor = new KiroExecutor({
    fetchFn: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return new Response("{}", { status: 200 });
    },
  });

  await executor.execute({
    url: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    connection: { credentials: { auth_method: "api_key", region: "us-east-1" } },
  });

  assert.strictEqual(seenUrl, "https://q.us-east-1.amazonaws.com/generateAssistantResponse");
  assert.strictEqual(seenHeaders.get("TokenType"), "API_KEY");
  assert.strictEqual(seenHeaders.get("X-Amz-Target"), null);
});

test("cline auth adds 9router-style client identity headers plus workos token", () => {
  const h = applyConnectionAuth(
    { "Content-Type": "application/json" },
    { provider: "cline", auth_type: "oauth", credentials: { access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" } }
  );
  assert.strictEqual(h.Authorization, "Bearer workos:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig");
  assert.match(h["User-Agent"], /^zenith-router\//);
  assert.strictEqual(h["X-CLIENT-TYPE"], "zenith-router");
  assert.ok(h["X-CLIENT-VERSION"]);
  assert.ok(h["X-CORE-VERSION"]);
  assert.strictEqual(h["X-PLATFORM"], process.platform);
  assert.ok(h["X-PLATFORM-VERSION"]);
  assert.strictEqual(h["X-IS-MULTIROOT"], "false");
});
