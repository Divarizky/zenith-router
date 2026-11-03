import test from "node:test";
import assert from "node:assert";
import { ZcodePlanExecutor, zcodeSessionId, withZcodeCacheBreakpoints } from "../src/executors/zcodePlan.js";
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

function planConnection() {
  return { id: "conn-1", provider: "glm", credentials: { access_token: "x", plan_token: PLAN_TOKEN } };
}

const body = {
  model: "glm-5.3",
  stream: false,
  messages: [
    { role: "system", content: "Ikuti instruksi klien." },
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai" },
    { role: "user", content: "lanjut" },
  ],
  tools: [
    { type: "function", function: { name: "a", parameters: { type: "object" } } },
    { type: "function", function: { name: "b", parameters: { type: "object" } } },
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

function countBreakpoints(p) {
  let n = 0;
  n += (p.system ?? []).filter((b) => b.cache_control).length;
  n += (p.tools ?? []).filter((t) => t.cache_control).length;
  for (const m of p.messages) if (Array.isArray(m.content)) n += m.content.filter((b) => b.cache_control).length;
  return n;
}

test("same sessionKey yields the same x-session-id, different key yields a different one", async () => {
  const sessionIdFor = async (sessionKey) => {
    const { fetchFn, calls } = recordingFetch(() => jsonRes(okMessage));
    await new ZcodePlanExecutor({ fetchFn }).execute({
      body: JSON.stringify(body), connection: planConnection(), targetModel: "glm-5.3", sessionKey,
    });
    return calls[0].init.headers.get("x-session-id");
  };
  const a1 = await sessionIdFor("conv-alpha");
  const a2 = await sessionIdFor("conv-alpha");
  const b = await sessionIdFor("conv-beta");
  assert.match(a1, /^session_[0-9a-f]{32}$/);
  assert.strictEqual(a1, a2);
  assert.notStrictEqual(a1, b);
  assert.ok(!a1.includes("conv-alpha"), "raw sessionKey is not forwarded");
});

test("null or apikey sessionKey falls back to a stable hash of the body, not random", () => {
  const first = zcodeSessionId(null, body);
  assert.strictEqual(zcodeSessionId(null, body), first);
  assert.strictEqual(zcodeSessionId("apikey:abc", body), first);
  const other = { ...body, messages: [{ role: "system", content: "Lain" }, { role: "user", content: "halo" }] };
  assert.notStrictEqual(zcodeSessionId(null, other), first);
});

test("client system, last tool, and last message text get breakpoints within the limit of 4", async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonRes(okMessage));
  await new ZcodePlanExecutor({ fetchFn }).execute({
    body: JSON.stringify(body), connection: planConnection(), targetModel: "glm-5.3",
  });
  const sent = calls[0].body;
  assert.deepStrictEqual(sent.system[1].cache_control, { type: "ephemeral" });
  assert.strictEqual(sent.system[1].text, ZCODE_IDENTITY.stablePrefix);
  assert.deepStrictEqual(sent.system[2].cache_control, { type: "ephemeral" }, "client system block is marked");
  assert.deepStrictEqual(sent.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.strictEqual(sent.tools[0].cache_control, undefined);
  const lastMsg = sent.messages.at(-1);
  const lastText = Array.isArray(lastMsg.content) ? lastMsg.content.at(-1) : lastMsg;
  assert.deepStrictEqual(lastText.cache_control, { type: "ephemeral" });
  assert.ok(countBreakpoints(sent) <= 4, `breakpoints=${countBreakpoints(sent)}`);
});

test("client cache_control is kept and not duplicated", () => {
  const payload = {
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "t", cache_control: { type: "ephemeral" } }, { name: "u" }],
    messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }],
  };
  const out = withZcodeCacheBreakpoints(payload);
  assert.strictEqual(out.system[0].cache_control.type, "ephemeral");
  assert.strictEqual(out.tools[0].cache_control.type, "ephemeral", "client marker on tool is kept");
  assert.strictEqual(out.messages[0].content.length, 1, "client-marked text block is not split or duplicated");
  assert.deepStrictEqual(out.tools[1].cache_control, { type: "ephemeral" }, "remaining budget goes to the last tool");
  assert.strictEqual(countBreakpoints(out), 4, "total stays at the limit of 4");
});

test("cache_read_input_tokens from message_start is reported as cached tokens in usage", async () => {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 40, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hai" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  const { fetchFn } = recordingFetch(() => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const res = await new ZcodePlanExecutor({ fetchFn }).execute({
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    connection: planConnection(),
    targetModel: "glm-5.3",
  });
  const text = await res.text();
  const usageLines = text.split("\n").filter((l) => l.startsWith("data: ") && l.includes("prompt_tokens"));
  const last = JSON.parse(usageLines.at(-1).slice(6));
  assert.strictEqual(last.usage.prompt_tokens_details.cached_tokens, 40);
  assert.strictEqual(last.usage.prompt_tokens, 45);
});
