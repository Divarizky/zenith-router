/**
 * End-to-end suite for the DeepSeek Web provider.
 *
 * Nothing is mocked except the upstream itself: a loopback HTTP server serves
 * the same endpoints as chat.deepseek.com, the real transport builds and signs
 * the PoW header, the real chain store tracks the conversation, and requests
 * enter through the Hono gateway exactly like a client. The PoW vector is the
 * vendored fixture with a refreshed `expire_at`, because the recorded vector
 * predates today and the transport is required to reject expired challenges.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { app } from "../src/index.js";
import { addConnection, getConnections, initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { resetTrafficGuardState } from "../src/services/trafficGuard.js";
import { chainStats, resetChainStore } from "../src/services/deepseekWeb/chains.js";
import {
  createDeepSeekWebTransport,
  deepseekBaseUrl,
  resetDeepSeekTransportFactory,
  setDeepSeekTransportFactory,
} from "../src/services/deepseekWeb/transport.js";
import { forgetSessionHealth } from "../src/services/deepseekWeb/health.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/deepseekWeb/pow-challenge.json", import.meta.url), "utf8")
);
// The recorded vector is only solvable with its own expire_at, and that moment
// has passed. The transport is otherwise real, so only its clock is pinned.
const FIXED_NOW = Number(FIXTURE.expire_at) - 60 * 1000;

const TOOL_REPLY = 'Aku jalankan.\n<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/** A minimal stand-in for chat.deepseek.com that behaves like the real one. */
async function startUpstream({ delayMs = 0 } = {}) {
  const state = {
    challengeAttempts: 0,
    challenges: 0,
    sessions: 0,
    completions: 0,
    histories: 0,
    active: 0,
    maxActive: 0,
    powPayloads: [],
    authorizations: [],
    prompts: [],
    replies: new Map(),
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://upstream");
    const authorization = String(req.headers.authorization || "");
    state.authorizations.push(authorization);
    if (url.pathname === "/api/v0/chat/create_pow_challenge") state.challengeAttempts += 1;

    if (authorization !== "Bearer good-token") {
      return sendJson(res, 401, { message: "Unauthorized" });
    }

    if (url.pathname === "/api/v0/chat/create_pow_challenge") {
      state.challenges += 1;
      await readBody(req);
      return sendJson(res, 200, { data: { biz_data: { challenge: FIXTURE } } });
    }

    if (url.pathname === "/api/v0/chat_session/create") {
      state.sessions += 1;
      await readBody(req);
      return sendJson(res, 200, { data: { biz_data: { chat_session: { id: `chat-${state.sessions}` } } } });
    }

    if (url.pathname === "/api/v0/chat/completion") {
      state.completions += 1;
      const body = JSON.parse(await readBody(req));
      const header = String(req.headers["x-ds-pow-response"] || "");
      try {
        state.powPayloads.push(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
      } catch {
        state.powPayloads.push(null);
      }
      state.prompts.push(body.prompt);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.active -= 1;

      const text = body.prompt.includes("PAKAI-TOOL") ? TOOL_REPLY : "Balasan web";
      state.replies.set(body.chat_session_id, { text, id: `msg-${state.completions}` });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ fragments: [{ type: "RESPONSE", content: text }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    if (url.pathname === "/api/v0/chat/history_messages") {
      state.histories += 1;
      const reply = state.replies.get(url.searchParams.get("chat_session_id"));
      return sendJson(res, 200, {
        data: {
          biz_data: {
            chat_messages: [
              { role: "USER", fragments: [{ type: "REQUEST", content: "halo" }] },
              ...(reply
                ? [{ role: "ASSISTANT", message_id: reply.id, fragments: [{ type: "RESPONSE", content: reply.text }] }]
                : []),
            ],
          },
        },
      });
    }

    return sendJson(res, 404, { message: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let upstream = null;

async function boot({ tokens = ["good-token"], connections = null, delayMs = 0 } = {}) {
  initDb(":memory:");
  resetTrafficGuardState();
  resetChainStore();
  forgetSessionHealth();
  resetDeepSeekTransportFactory();
  setSetting("traffic_guard_enabled", "true");
  setSetting("request_jitter_enabled", "false");

  upstream = await startUpstream({ delayMs });
  process.env.ZENITH_DEEPSEEK_BASE_URL = upstream.url;
  setDeepSeekTransportFactory((connection, options) =>
    createDeepSeekWebTransport(connection, { ...options, now: () => FIXED_NOW })
  );

  const entries = connections || tokens.map((token, index) => ({ token, name: `Web ${index + 1}` }));
  for (const entry of entries) {
    addConnection({
      provider: "deepseek-web",
      name: entry.name,
      auth_type: "session",
      credentials: { token: entry.token },
      ...(entry.proxy_url ? { proxy_url: entry.proxy_url } : {}),
    });
  }
  return getConnections("deepseek-web");
}

afterEach(async () => {
  if (upstream) {
    await upstream.close();
    upstream = null;
  }
  delete process.env.ZENITH_DEEPSEEK_BASE_URL;
  resetDeepSeekTransportFactory();
});

const chatBody = (extra = {}) => ({
  model: "dsw/deepseek-chat",
  messages: [{ role: "user", content: "Halo" }],
  ...extra,
});

test("e2e - the override points the transport at the loopback upstream", async () => {
  await boot();
  assert.strictEqual(deepseekBaseUrl(), upstream.url);
});

test("e2e - a whole chat turn runs over loopback HTTP with a signed PoW", async () => {
  await boot();

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": "e2e-chat", "x-api-key": "sk-client" },
    body: JSON.stringify(chatBody()),
  });

  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.choices[0].message.content, "Balasan web");
  assert.strictEqual(json.choices[0].finish_reason, "stop");

  assert.strictEqual(upstream.state.challengeAttempts, 1);
  assert.strictEqual(upstream.state.challenges, 1);
  assert.strictEqual(upstream.state.sessions, 1);
  assert.strictEqual(upstream.state.completions, 1);
  assert.strictEqual(upstream.state.histories, 1);

  const pow = upstream.state.powPayloads[0];
  assert.strictEqual(pow.algorithm, "DeepSeekHashV1");
  assert.strictEqual(pow.challenge, FIXTURE.challenge);
  assert.strictEqual(pow.salt, FIXTURE.salt);
  assert.strictEqual(pow.answer, FIXTURE.expected_answer);
  assert.strictEqual(pow.target_path, "/api/v0/chat/completion");

  assert.deepStrictEqual(
    [...new Set(upstream.state.authorizations)],
    ["Bearer good-token"],
    "only the stored session token reaches upstream"
  );
  assert.match(upstream.state.prompts[0], /Halo/);
  assert.doesNotMatch(upstream.state.prompts[0], /sk-client/);

  assert.deepStrictEqual(chainStats(), { main: 0, aux: 1, busy: 0, total: 1 });
});

test("e2e - a tool call reaches OpenAI, Claude, and Responses clients", async () => {
  await boot();
  const tools = {
    openai: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
  };

  const chat = await (
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "e2e-tools" },
      body: JSON.stringify(chatBody({ messages: [{ role: "user", content: "PAKAI-TOOL" }], tools: tools.openai })),
    })
  ).json();

  assert.strictEqual(chat.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(chat.choices[0].message.tool_calls[0].function.name, "bash");
  assert.deepStrictEqual(JSON.parse(chat.choices[0].message.tool_calls[0].function.arguments), { command: "ls -la" });
  assert.ok(!String(chat.choices[0].message.content).includes("<tool_call>"));

  const claude = await (
    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "e2e-tools-claude" },
      body: JSON.stringify({
        model: "dsw/deepseek-chat",
        max_tokens: 100,
        messages: [{ role: "user", content: "PAKAI-TOOL" }],
        tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
      }),
    })
  ).json();

  assert.strictEqual(claude.stop_reason, "tool_use");
  assert.strictEqual(claude.content.find((block) => block.type === "tool_use").name, "bash");

  const responses = await (
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "e2e-tools-responses" },
      body: JSON.stringify({
        model: "dsw/deepseek-chat",
        input: "PAKAI-TOOL",
        tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
      }),
    })
  ).json();

  assert.strictEqual(responses.output.find((item) => item.type === "function_call").name, "bash");
  assert.strictEqual(upstream.state.completions, 3, "one upstream turn per client request");
});

test("e2e - four parallel conversations never exceed three upstream completions", async () => {
  await boot({ delayMs: 150 });

  const responses = await Promise.all(
    ["a", "b", "c", "d"].map((session) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": `parallel-${session}` },
        body: JSON.stringify(chatBody()),
      })
    )
  );

  for (const res of responses) assert.strictEqual(res.status, 200);
  assert.strictEqual(upstream.state.completions, 4);
  assert.strictEqual(upstream.state.maxActive, 3, "the fourth turn waited for a free slot");
  assert.strictEqual(upstream.state.sessions, 4, "each conversation owns a chat session");
});

test("e2e - a dead token returns 401 with the expiry header and never completes", async () => {
  await boot({ tokens: ["bad-token"] });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatBody()),
  });

  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("x-zenith-auth-expired"), "1");
  const json = await res.json();
  assert.strictEqual(json.error.code, "invalid_token");

  assert.strictEqual(upstream.state.authorizations.length, 1, "the dead account is not retried");
  assert.strictEqual(upstream.state.sessions, 0);
  assert.strictEqual(upstream.state.completions, 0, "no turn is attempted with a rejected token");
});

test("e2e - a dead first account fails over to the second one", async () => {
  await boot({
    connections: [
      { token: "bad-token", name: "Web mati" },
      { token: "good-token", name: "Web hidup" },
    ],
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": "fallback-e2e" },
    body: JSON.stringify(chatBody()),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).choices[0].message.content, "Balasan web");
  assert.strictEqual(upstream.state.authorizations[0], "Bearer bad-token", "the first account is tried first");
  assert.strictEqual(
    upstream.state.authorizations.filter((value) => value === "Bearer bad-token").length,
    1,
    "the dead account is parked after its 401"
  );
  assert.ok(upstream.state.authorizations.includes("Bearer good-token"));
  assert.strictEqual(upstream.state.completions, 1);
});

test("e2e - the dashboard health badge uses the real transport", async () => {
  await boot({
    connections: [
      { token: "good-token", name: "Web hidup" },
      { token: "bad-token", name: "Web mati" },
    ],
  });

  const html = await (await app.request("/dashboard/providers/deepseek-web")).text();
  assert.ok(html.includes("Sesi OK"));
  assert.ok(html.includes("Sesi kedaluwarsa"));
  assert.strictEqual(upstream.state.challengeAttempts, 2, "one probe per account");
  assert.strictEqual(upstream.state.challenges, 1, "only the live token receives a challenge");
  assert.strictEqual(upstream.state.sessions, 0);
  assert.strictEqual(upstream.state.completions, 0);
});

test("e2e - streaming delivers the reply as OpenAI chunks", async () => {
  await boot();

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": "e2e-stream" },
    body: JSON.stringify(chatBody({ stream: true, stream_options: { include_usage: true } })),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /"object":"chat\.completion\.chunk"/);
  assert.match(text, /Balasan web/);
  assert.match(text, /data: \[DONE\]/);
});
