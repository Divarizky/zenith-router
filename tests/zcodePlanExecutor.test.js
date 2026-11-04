import test from "node:test";
import assert from "node:assert";
import { ZcodePlanExecutor, ZCODE_PLAN_URL } from "../src/executors/zcodePlan.js";
import { ZCODE_IDENTITY } from "../src/services/zcodeIdentity.js";

const PLAN_TOKEN = "plan-test-token-value";

function recordingFetch(responder) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, init);
  };
  return { fetchFn, calls };
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function planConnection(extra = {}) {
  return { id: "conn-1", provider: "glm", credentials: { access_token: "paas-key", plan_token: PLAN_TOKEN, ...extra } };
}

const openAIBody = {
  model: "glm-5.3",
  stream: false,
  messages: [
    { role: "system", content: "Ikuti instruksi klien." },
    { role: "user", content: "halo" },
  ],
};

const okMessage = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "glm-5.3",
  content: [{ type: "text", text: "hai" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
};

test("plan lane posts to the Start-Plan endpoint with the plan token and ZCode identity", async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonRes(okMessage));
  const executor = new ZcodePlanExecutor({ fetchFn });

  await executor.execute({
    url: "https://api.z.ai/unused",
    headers: { Authorization: "Bearer paas-key" },
    body: JSON.stringify(openAIBody),
    connection: planConnection(),
    targetModel: "glm-5.3",
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, ZCODE_PLAN_URL);
  assert.strictEqual(calls[0].init.method, "POST");
  const headers = calls[0].init.headers;
  assert.strictEqual(headers.get("authorization"), `Bearer ${PLAN_TOKEN}`, "plan_token replaces the PaaS key");
  assert.strictEqual(headers.get("x-zcode-app-version"), "3.16.3");
  assert.strictEqual(headers.get("anthropic-version"), ZCODE_IDENTITY.anthropicVersion);
  assert.strictEqual(headers.get("anthropic-beta"), ZCODE_IDENTITY.anthropicBeta);
});

test("plan lane translates the OpenAI body to Anthropic Messages with the ZCode system blocks", async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonRes(okMessage));
  const executor = new ZcodePlanExecutor({ fetchFn });

  await executor.execute({
    body: JSON.stringify(openAIBody),
    connection: planConnection(),
    targetModel: "glm-5.3",
  });

  const sent = calls[0].body;
  assert.strictEqual(sent.model, "glm-5.3");
  assert.deepStrictEqual(
    sent.messages.map((m) => m.role),
    ["user"],
    "system role moves out of messages into the system array"
  );
  assert.strictEqual(sent.system[0].text, ZCODE_IDENTITY.cliPrefix);
  assert.strictEqual(sent.system[1].text, ZCODE_IDENTITY.stablePrefix);
  assert.deepStrictEqual(sent.system[1].cache_control, { type: "ephemeral" });
  assert.ok(sent.system[2].text.includes("Ikuti instruksi klien."), "client system prompt is kept as block 3");
});

test("plan lane converts a non-streaming Anthropic reply back to OpenAI chat shape", async () => {
  const { fetchFn } = recordingFetch(() => jsonRes(okMessage));
  const executor = new ZcodePlanExecutor({ fetchFn });

  const res = await executor.execute({
    body: JSON.stringify(openAIBody),
    connection: planConnection(),
    targetModel: "glm-5.3",
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "hai");
  assert.strictEqual(data.choices[0].finish_reason, "stop");
});

test("error 3012 (expired identity) maps to HTTP 401 so fallback can refresh", async () => {
  const { fetchFn } = recordingFetch(() => jsonRes({ code: 3012, msg: "identity expired" }, 400));
  const executor = new ZcodePlanExecutor({ fetchFn });

  const res = await executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3" });

  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.error.code, 3012);
  assert.strictEqual(data.error.type, "authentication_error");
});

test("error 1113 (insufficient balance) maps to HTTP 402", async () => {
  const { fetchFn } = recordingFetch(() => jsonRes({ error: { code: "1113", message: "balance" } }, 400));
  const executor = new ZcodePlanExecutor({ fetchFn });

  const res = await executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3" });

  assert.strictEqual(res.status, 402);
  const data = await res.json();
  assert.strictEqual(data.error.code, 1113);
  assert.strictEqual(data.error.type, "insufficient_balance");
});

test("concurrency errors 3008 and 3009 map to HTTP 429 for account failover", async () => {
  for (const code of [3008, 3009]) {
    const { fetchFn } = recordingFetch(() => jsonRes({ code }, 400));
    const executor = new ZcodePlanExecutor({ fetchFn });
    const res = await executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3" });
    assert.strictEqual(res.status, 429, `code ${code}`);
  }
});

test("unknown upstream error keeps its HTTP status and message", async () => {
  const { fetchFn } = recordingFetch(() => jsonRes({ error: { message: "bad model" } }, 400));
  const executor = new ZcodePlanExecutor({ fetchFn });

  const res = await executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3" });

  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error.message, "bad model");
});

test("without plan_token the request goes to the given PaaS url with the original body", async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonRes({ ok: true }));
  const executor = new ZcodePlanExecutor({ fetchFn });
  const paasUrl = "https://api.z.ai/api/coding/paas/v4/chat/completions";

  await executor.execute({
    url: paasUrl,
    headers: { Authorization: "Bearer paas-key", "Content-Type": "application/json" },
    body: JSON.stringify(openAIBody),
    connection: { id: "conn-2", provider: "glm", credentials: { access_token: "paas-key" } },
    targetModel: "glm-5.3",
  });

  assert.strictEqual(calls[0].url, paasUrl);
  assert.strictEqual(calls[0].init.headers.get("authorization"), "Bearer paas-key");
  assert.deepStrictEqual(calls[0].body, openAIBody, "body is forwarded without Anthropic translation");
});

test("model concurrency 3009 is retried in place and a later success is returned", async () => {
  let n = 0;
  const { fetchFn, calls } = recordingFetch(() => {
    n++;
    return n < 3 ? jsonRes({ code: 3009 }, 400) : jsonRes(okMessage);
  });
  const executor = new ZcodePlanExecutor({ fetchFn });
  const res = await executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3" });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(res.status, 200);
});

test("model concurrency 3009 that persists is reported as 429 after the retry budget", async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonRes({ code: 3009 }, 400));
  const executor = new ZcodePlanExecutor({ fetchFn });
  const res = await executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3" });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(res.status, 429);
  const data = await res.json();
  assert.strictEqual(data.error.code, 3009);
});

test("client abort during 3009 backoff stops retrying and rejects with the abort reason", async () => {
  const controller = new AbortController();
  const { fetchFn, calls } = recordingFetch(() => {
    setTimeout(() => controller.abort(new Error("client gone")), 50);
    return jsonRes({ code: 3009 }, 400);
  });
  const executor = new ZcodePlanExecutor({ fetchFn });
  await assert.rejects(
    executor.execute({ body: JSON.stringify(openAIBody), connection: planConnection(), targetModel: "glm-5.3", signal: controller.signal }),
    { message: "client gone" }
  );
  assert.strictEqual(calls.length, 1);
});
