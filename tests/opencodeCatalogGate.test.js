import test from "node:test";
import assert from "node:assert";
import {
  OpencodeExecutor,
  opencodeLaneForModel,
  resetOpencodeProtocolLanes,
  resetOpencodeSessionCache,
} from "../src/executors/opencode.js";
import { buildErrorResponse } from "../src/services/fallback.js";
import {
  OPENCODE_DEFAULT_BASE_URL,
  OPENCODE_LEGACY_BASE_URL,
  getOpencodeCatalog,
  getOpencodeModelInfo,
  isOpencodeCatalogStale,
  isOpencodeModelDeprecated,
  listOpencodeCatalogFreeModels,
  parseOpencodeCatalog,
  refreshOpencodeCatalog,
  resetOpencodeCatalog,
  resolveOpencodeUrl,
  setOpencodeCatalog,
  startOpencodeCatalogRefresh,
} from "../src/services/opencodeCatalog.js";
import {
  auditOpencodeGateShape,
  buildOpencodeGateResponse,
  escalateOpencodeCooldown,
  opencodeGateStatus,
  getOpencodeGateState,
  isOpencodeGateRejection,
  isOpencodeGateShapeOk,
  listMissingOpencodeGateAnchors,
  noteOpencodeGateRejection,
  opencodeGateKey,
  resetOpencodeGate,
} from "../src/services/opencodeGate.js";

function stubFetch(responses) {
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, headers: new Headers(init.headers), body: init.body });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return typeof next === "function" ? next() : next;
    },
  });
  return { executor, calls };
}

const gate403 = (message = "OpenCode's free tier can only be used from within OpenCode.") =>
  new Response(JSON.stringify({ type: "FreeTierError", message }), {
    status: 403,
    headers: { "Content-Type": "application/json", "x-opencode-log-id": "log-1" },
  });

const okJson = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

const chatRequest = (model, sessionKey) => ({
  url: "https://opencode.ai/v1/chat/completions",
  method: "POST",
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  targetModel: model,
  sessionKey,
});

test("catalog - parses base URL, price and retirement from models.opencode.ai", () => {
  const parsed = parseOpencodeCatalog({
    opencode: {
      api: "https://opencode.ai/inference/openai/v1",
      models: {
        "free-one": { name: "Free One", cost: { input: 0, output: 0 } },
        "paid-one": { cost: { input: 3, output: 15 } },
        "retired-one": { status: "deprecated", cost: { input: 0, output: 0 } },
        "anthropic-one": {
          provider: { api: "https://opencode.ai/inference/anthropic/v1" },
          cost: { input: 0, output: 0 },
        },
      },
    },
  });

  assert.strictEqual(parsed.baseUrl, OPENCODE_DEFAULT_BASE_URL);
  assert.strictEqual(parsed.models.get("free-one").isFree, true);
  assert.strictEqual(parsed.models.get("paid-one").isFree, false);
  assert.strictEqual(parsed.models.get("retired-one").deprecated, true);
  assert.strictEqual(parsed.models.get("anthropic-one").api, "https://opencode.ai/inference/anthropic/v1");

  // Not an OpenCode catalog at all.
  assert.strictEqual(parseOpencodeCatalog({ data: [] }), null);
  // A base outside opencode.ai is ignored rather than trusted blindly.
  const hostile = parseOpencodeCatalog({
    opencode: { api: "https://evil.example/v1", models: { a: {} } },
  });
  assert.strictEqual(hostile.baseUrl, OPENCODE_DEFAULT_BASE_URL);
  assert.strictEqual(hostile.models.get("a").api, null);
});

test("catalog - the snapshot drives the resolved URL per lane", () => {
  resetOpencodeCatalog();
  assert.strictEqual(resolveOpencodeUrl("unknown", "chat"), `${OPENCODE_DEFAULT_BASE_URL}/chat/completions`);
  assert.strictEqual(resolveOpencodeUrl("unknown", "responses"), `${OPENCODE_DEFAULT_BASE_URL}/responses`);
  assert.strictEqual(resolveOpencodeUrl("unknown", "messages"), `${OPENCODE_LEGACY_BASE_URL}/messages`);

  setOpencodeCatalog({
    opencode: {
      api: "https://opencode.ai/inference/custom/v1",
      models: { "anthropic-one": { provider: { api: "https://opencode.ai/inference/anthropic/v1" } } },
    },
  });
  assert.strictEqual(resolveOpencodeUrl("other", "chat"), "https://opencode.ai/inference/custom/v1/chat/completions");
  assert.strictEqual(resolveOpencodeUrl("other", "responses"), "https://opencode.ai/inference/custom/v1/responses");
  assert.strictEqual(resolveOpencodeUrl("anthropic-one", "messages"), "https://opencode.ai/inference/anthropic/v1/messages");
  assert.strictEqual(getOpencodeModelInfo("never-seen"), null);
  assert.strictEqual(isOpencodeModelDeprecated("anthropic-one"), false);

  // The bridge override wins over the catalog, trailing slash included.
  process.env.ZENITH_OPENCODE_BASE_URL = "http://127.0.0.1:20129/v1/";
  assert.strictEqual(resolveOpencodeUrl("other", "responses"), "http://127.0.0.1:20129/v1/responses");
  assert.strictEqual(resolveOpencodeUrl("anthropic-one", "messages"), "http://127.0.0.1:20129/v1/messages");
  delete process.env.ZENITH_OPENCODE_BASE_URL;

  resetOpencodeCatalog();
  assert.strictEqual(resolveOpencodeUrl("other", "chat"), `${OPENCODE_DEFAULT_BASE_URL}/chat/completions`);
});

test("catalog - the free list drops retired and evaluation models", () => {
  resetOpencodeCatalog();
  setOpencodeCatalog({
    opencode: {
      api: OPENCODE_DEFAULT_BASE_URL,
      models: {
        "live-free": { name: "Live Free", cost: { input: 0 } },
        "paid-model": { cost: { input: 1 } },
        "retired-free": { status: "deprecated", cost: { input: 0 } },
        "jev-1.13-free": { cost: { input: 0 } },
      },
    },
  });
  assert.deepStrictEqual(listOpencodeCatalogFreeModels(), [{ id: "live-free", name: "Live Free" }]);
  resetOpencodeCatalog();
  assert.deepStrictEqual(listOpencodeCatalogFreeModels(), []);
});

test("catalog - refresh installs the snapshot, a failed fetch keeps the previous one", async () => {
  resetOpencodeCatalog();
  const payload = { opencode: { api: OPENCODE_DEFAULT_BASE_URL, models: { "a-free": { cost: { input: 0 } } } } };

  const refreshed = await refreshOpencodeCatalog({
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
    force: true,
  });
  assert.deepStrictEqual(refreshed, { ok: true, count: 1 });
  assert.strictEqual(getOpencodeCatalog().models.size, 1);
  assert.strictEqual(isOpencodeCatalogStale(), false);

  const failed = await refreshOpencodeCatalog({
    fetchImpl: async () => {
      throw new Error("network down");
    },
    force: true,
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(getOpencodeCatalog().models.size, 1, "snapshot lama tetap dipakai");

  const cached = await refreshOpencodeCatalog({
    fetchImpl: async () => {
      throw new Error("tidak boleh dipanggil");
    },
  });
  assert.deepStrictEqual(cached, { ok: true, cached: true });
  resetOpencodeCatalog();
});

test("gate - only gate statuses and payloads count as rejections", () => {
  assert.ok(isOpencodeGateRejection(403, JSON.stringify({ type: "FreeTierError" })));
  assert.ok(isOpencodeGateRejection(403, JSON.stringify({ error: { type: "UpgradeRequired" } })));
  assert.ok(
    isOpencodeGateRejection(403, JSON.stringify({ error: { message: "OpenCode Free Model Gateway Detect Abuse Traffic" } }))
  );
  assert.ok(isOpencodeGateRejection(426, ""));
  assert.ok(!isOpencodeGateRejection(429, "slow down"), "429 adalah kapasitas, bukan gate");
  assert.ok(!isOpencodeGateRejection(403, JSON.stringify({ error: { type: "invalid_request_error" } })));
  assert.ok(!isOpencodeGateRejection(400, JSON.stringify({ type: "FreeTierError" })));
});

test("gate - the shape audit reports the anchors upstream checks", () => {
  const full = auditOpencodeGateShape({
    body: JSON.stringify({ stream: true, tools: [{ type: "function", function: { name: "read" } }] }),
    headers: { "User-Agent": "opencode/latest/2.1.2/cli", "x-opencode-session": "ses_x" },
  });
  assert.strictEqual(isOpencodeGateShapeOk(full), true);
  assert.strictEqual(full.hasShellTool, false);

  const thin = auditOpencodeGateShape({ body: JSON.stringify({ tools: [] }), headers: {} });
  assert.strictEqual(isOpencodeGateShapeOk(thin), false);
  assert.deepStrictEqual(listMissingOpencodeGateAnchors(thin), [
    "tool `read`",
    "an `opencode/*` User-Agent",
    "a session header",
    "a streamed body",
  ]);

  const state = noteOpencodeGateRejection(opencodeGateKey(null), {
    status: 403,
    shape: thin,
    shapeOk: false,
    missing: listMissingOpencodeGateAnchors(thin),
  });
  assert.strictEqual(state.gate, "shape-rejected");
  assert.strictEqual(buildOpencodeGateResponse(state).headers.get("X-OpenCode-Gate"), "shape-rejected");
  resetOpencodeGate();
});

test("OpencodeExecutor - a model the catalog retired is refused locally", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();
  setOpencodeCatalog({
    opencode: {
      api: OPENCODE_DEFAULT_BASE_URL,
      models: { "retired-free": { status: "deprecated" }, "live-free": { cost: { input: 0 } } },
    },
  });

  const { executor, calls } = stubFetch([okJson()]);
  const refused = await executor.execute(chatRequest("retired-free"));
  assert.strictEqual(refused.status, 410);
  assert.strictEqual(calls.length, 0, "model pensiun tidak dikirim ke upstream");
  assert.strictEqual((await refused.json()).error.code, "model_deprecated");

  resetOpencodeCatalog();
  const allowed = await executor.execute(chatRequest("live-free"));
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(calls.length, 1);
});

test("OpencodeExecutor - gate rejection retries once with a fresh session, then holds locally", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();

  const { executor, calls } = stubFetch([gate403(), gate403()]);
  const first = await executor.execute(chatRequest("big-pickle", "conversation-1"));

  assert.strictEqual(calls.length, 2, "satu retry identitas, tidak lebih");
  assert.strictEqual(first.status, 403, "status upstream dipakai apa adanya");
  assert.strictEqual(first.headers.get("X-OpenCode-Gate"), "ip-throttled");
  assert.strictEqual(first.headers.get("X-OpenCode-Log-Id"), "log-1");
  assert.ok(Number(first.headers.get("Retry-After")) > 0);

  const firstSession = calls[0].headers.get("x-opencode-session");
  const retrySession = calls[1].headers.get("x-opencode-session");
  assert.match(firstSession, /^ses_/);
  assert.notStrictEqual(retrySession, firstSession, "session id baru untuk retry");
  assert.strictEqual(calls[1].headers.get("x-session-affinity"), retrySession);
  assert.strictEqual(calls[1].headers.get("User-Agent"), calls[0].headers.get("User-Agent"));

  const retryBody = JSON.parse(calls[1].body);
  assert.strictEqual(retryBody.stream, true);
  assert.deepStrictEqual(retryBody.tools.map((t) => t.function.name).sort(), ["read", "shell"]);

  // While cooling down the request is answered locally: forwarding it would only
  // extend the block on this egress.
  const held = await executor.execute(chatRequest("big-pickle"));
  assert.strictEqual(calls.length, 2, "tidak ada request tambahan ke upstream");
  assert.strictEqual(held.status, 429);
  assert.strictEqual((await held.json()).error.code, "opencode_gate_throttled");
  assert.strictEqual(held.headers.get("X-OpenCode-Gate"), "ip-throttled");
  assert.ok(Number(held.headers.get("Retry-After")) > 0);

  resetOpencodeGate();
});

test("OpencodeExecutor - cooldown 0 disables holding, a success clears the state", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  process.env.ZENITH_OPENCODE_GATE_COOLDOWN_MS = "0";

  const { executor, calls } = stubFetch([gate403(), gate403(), okJson()]);
  await executor.execute(chatRequest("big-pickle", "conversation-2"));
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(await getOpencodeGateState(opencodeGateKey(null)), null, "cooldown 0 tidak menahan apa pun");

  const recovered = await executor.execute(chatRequest("big-pickle", "conversation-3"));
  assert.strictEqual(recovered.status, 200);
  assert.strictEqual(calls.length, 3);

  delete process.env.ZENITH_OPENCODE_GATE_COOLDOWN_MS;
  resetOpencodeGate();
});

test("OpencodeExecutor - capacity and plain errors are not gate rejections", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();

  const busy = stubFetch([new Response("slow down", { status: 429 })]);
  const busyRes = await busy.executor.execute(chatRequest("big-pickle"));
  assert.strictEqual(busy.calls.length, 1, "429 tidak di-retry sebagai gate");
  assert.strictEqual(busyRes.status, 429);
  assert.strictEqual(busyRes.headers.get("X-OpenCode-Gate"), null);

  const broken = stubFetch([new Response("boom", { status: 503 })]);
  const brokenRes = await broken.executor.execute(chatRequest("big-pickle"));
  assert.strictEqual(broken.calls.length, 1);
  assert.strictEqual(brokenRes.status, 503);

  resetOpencodeGate();
});

test("OpencodeExecutor - a request that already changed lane is not retried again", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();

  const protocol400 = () =>
    new Response(
      JSON.stringify({ error: { type: "ModelProtocolUnsupported", message: "model does not support this protocol" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  const { executor, calls } = stubFetch([protocol400(), gate403()]);

  const res = await executor.execute(chatRequest("flipping-model", "conversation-4"));
  assert.strictEqual(calls.length, 2, "satu client request maksimal dua panggilan upstream");
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.headers.get("X-OpenCode-Gate"), null, "tidak ada cooldown tanpa audit retry");

  resetOpencodeGate();
  resetOpencodeProtocolLanes();
});

test("OpencodeExecutor - the session minted by the retry is kept for the next request", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();
  resetOpencodeSessionCache();

  // Rejected twice, then accepted on the following request.
  const { executor, calls } = stubFetch([gate403(), gate403(), okJson()]);
  await executor.execute(chatRequest("big-pickle", "conversation-2"));
  const retrySession = calls[1].headers.get("x-opencode-session");

  resetOpencodeGate();
  await executor.execute(chatRequest("big-pickle", "conversation-2"));
  assert.strictEqual(calls.length, 3, "request berikutnya langsung berhasil, tanpa retry");
  assert.strictEqual(calls[2].headers.get("x-opencode-session"), retrySession, "memakai id hasil retry, bukan yang ditolak");

  resetOpencodeGate();
});

test("fallback error response keeps Retry-After and the gate labels", () => {
  const upstream = new Response("{}", {
    status: 429,
    headers: { "Retry-After": "30", "X-OpenCode-Gate": "ip-throttled", "X-OpenCode-Log-Id": "log-9", "Set-Cookie": "a=b" },
  });
  const out = buildErrorResponse(upstream, "{}", "openai");
  assert.strictEqual(out.headers.get("Retry-After"), "30");
  assert.strictEqual(out.headers.get("X-OpenCode-Gate"), "ip-throttled");
  assert.strictEqual(out.headers.get("X-OpenCode-Log-Id"), "log-9");
  assert.strictEqual(out.headers.get("Set-Cookie"), null, "header lain tidak ikut diteruskan");
});

test("OpencodeExecutor - a bridge override pins every model to the chat lane", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  const previous = process.env.ZENITH_OPENCODE_BASE_URL;
  process.env.ZENITH_OPENCODE_BASE_URL = "http://127.0.0.1:20129/v1";
  try {
    assert.strictEqual(opencodeLaneForModel("muse-spark-1.3-contributor-free"), "chat");
    assert.strictEqual(opencodeLaneForModel("union-alpha"), "chat");

    // A 400 protocol error must not trigger a lane switch the bridge cannot serve.
    const protocol400 = () =>
      new Response(JSON.stringify({ error: { type: "ModelProtocolUnsupported", message: "does not support this protocol" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    const { executor, calls } = stubFetch([protocol400]);
    const res = await executor.execute(chatRequest("big-pickle", "conversation-3"));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "http://127.0.0.1:20129/v1/chat/completions");
  } finally {
    if (previous === undefined) delete process.env.ZENITH_OPENCODE_BASE_URL;
    else process.env.ZENITH_OPENCODE_BASE_URL = previous;
    resetOpencodeGate();
  }
});

const networkBlock403 = () =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address." } }),
    { status: 403, headers: { "Content-Type": "application/json", "x-opencode-log-id": "log-net" } }
  );

test("gate - cooldown doubles per consecutive refusal and caps at ten minutes", () => {
  resetOpencodeGate();
  assert.strictEqual(escalateOpencodeCooldown(30000, 1), 30000);
  assert.strictEqual(escalateOpencodeCooldown(30000, 2), 60000);
  assert.strictEqual(escalateOpencodeCooldown(30000, 3), 120000);
  assert.strictEqual(escalateOpencodeCooldown(30000, 20), 600000);
  assert.strictEqual(escalateOpencodeCooldown(0, 5), 0, "cooldown 0 tetap mematikan penahanan");

  const t0 = 1_000_000;
  const first = noteOpencodeGateRejection("direct", { status: 403, shapeOk: true }, t0);
  assert.strictEqual(first.retryAfterMs, 30000);
  const second = noteOpencodeGateRejection("direct", { status: 403, shapeOk: true }, t0 + 31000);
  assert.strictEqual(second.retryAfterMs, 60000);
  assert.strictEqual(second.strikes, 2);
  // Long quiet period: the block had lifted, so the count starts over.
  const later = noteOpencodeGateRejection("direct", { status: 403, shapeOk: true }, t0 + 31000 + 3_600_000);
  assert.strictEqual(later.retryAfterMs, 30000);
  resetOpencodeGate();
});

test("gate - cooldown is tracked per egress", () => {
  resetOpencodeGate();
  noteOpencodeGateRejection(opencodeGateKey("http://proxy-a:8080"), { status: 403, shapeOk: true });
  assert.ok(getOpencodeGateState(opencodeGateKey("http://proxy-a:8080")));
  assert.strictEqual(getOpencodeGateState(opencodeGateKey("http://proxy-b:8080")), null);
  assert.strictEqual(getOpencodeGateState(opencodeGateKey(null)), null);
  resetOpencodeGate();
});

test("gate - a status outside 400-599 falls back to 429 instead of crashing", () => {
  const previous = process.env.ZENITH_OPENCODE_GATE_STATUS;
  try {
    for (const bad of ["700", "200", "abc", "429.5"]) {
      process.env.ZENITH_OPENCODE_GATE_STATUS = bad;
      assert.strictEqual(opencodeGateStatus(), 429, bad);
      assert.doesNotThrow(() => buildOpencodeGateResponse(null));
    }
    process.env.ZENITH_OPENCODE_GATE_STATUS = "503";
    assert.strictEqual(opencodeGateStatus(), 503);
  } finally {
    if (previous === undefined) delete process.env.ZENITH_OPENCODE_GATE_STATUS;
    else process.env.ZENITH_OPENCODE_GATE_STATUS = previous;
  }
});

test("OpencodeExecutor - an explicit network block starts the cooldown without a retry", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();
  const { executor, calls } = stubFetch([networkBlock403]);
  const res = await executor.execute(chatRequest("big-pickle", "conversation-4"));
  assert.strictEqual(calls.length, 1, "tidak ada request kedua ke IP yang diblokir");
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.headers.get("X-OpenCode-Gate"), "ip-throttled");
  assert.ok(getOpencodeGateState(opencodeGateKey(null)));
  resetOpencodeGate();
});

test("OpencodeExecutor - the cooldown quotes the log id of the retry that triggered it", async () => {
  resetOpencodeGate();
  resetOpencodeProtocolLanes();
  resetOpencodeCatalog();
  const retry403 = () =>
    new Response(JSON.stringify({ type: "FreeTierError", message: "free tier" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "x-opencode-log-id": "log-retry" },
    });
  const { executor } = stubFetch([gate403, retry403]);
  const res = await executor.execute(chatRequest("big-pickle", "conversation-5"));
  assert.strictEqual(res.headers.get("X-OpenCode-Log-Id"), "log-retry");
  resetOpencodeGate();
});

test("gate - a 426 is labelled as a version floor, not an IP throttle", () => {
  resetOpencodeGate();
  const state = noteOpencodeGateRejection("direct", { status: 426, shapeOk: true });
  assert.strictEqual(state.gate, "version-rejected");
  assert.match(state.reason, /newer OpenCode client version/);
  resetOpencodeGate();
});

test("catalog - the standalone refresher fetches once, survives failures and does not hold the process", async () => {
  resetOpencodeCatalog();
  let fetches = 0;
  const failing = async () => {
    fetches++;
    throw new Error("offline");
  };
  const timer = startOpencodeCatalogRefresh({ fetchImpl: failing, intervalMs: 3_600_000 });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(fetches, 1, "satu fetch saat dipanggil");
    assert.strictEqual(timer.hasRef(), false, "timer di-unref");
    assert.strictEqual(getOpencodeCatalog(), null, "fetch gagal tidak memasang snapshot");
  } finally {
    clearInterval(timer);
    resetOpencodeCatalog();
  }
});
