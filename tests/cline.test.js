import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { setCustomExecutor, BaseExecutor } from "../src/executors/base.js";
import { clineEnvelopeStatus } from "../src/executors/cline.js";
import { initDb, addConnection } from "../src/db/index.js";

test("cline non-stream forces upstream stream and unwraps success envelope", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "Cline test", credentials: { access_token: "token" } });

  let seenBody;
  setCustomExecutor({
    async execute({ body }) {
      seenBody = JSON.parse(body);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "chatcmpl-cline",
            object: "chat.completion",
            created: 1,
            model: "z-ai/glm-5.2",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cline/z-ai/glm-5.2",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seenBody.stream, true);
    const json = await res.json();
    assert.strictEqual(json.choices[0].message.content, "ok");
  } finally {
    setCustomExecutor(null);
  }
});

// ClineExecutor dijalankan sungguhan; hanya transport HTTP di bawahnya yang ditiru.
async function withUpstream(responder, fn) {
  const original = BaseExecutor.prototype.execute;
  const calls = [];
  BaseExecutor.prototype.execute = async function (args) {
    calls.push(args.headers?.Authorization || args.headers?.authorization);
    return responder(calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    BaseExecutor.prototype.execute = original;
  }
}

const envelopeError = (error, extra = {}) =>
  new Response(JSON.stringify({ success: false, error, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sseOk = () =>
  new Response(
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

test("clineEnvelopeStatus - takes an HTTP status from the envelope, else 502", () => {
  assert.strictEqual(clineEnvelopeStatus({ success: false, error: { code: 402 } }), 402);
  assert.strictEqual(clineEnvelopeStatus({ success: false, status: 429 }), 429);
  assert.strictEqual(clineEnvelopeStatus({ success: false, error: { status: "401" } }), 401);
  assert.strictEqual(clineEnvelopeStatus({ success: false, error: { code: "bad_request" } }), 502, "kode teks bukan status HTTP");
  assert.strictEqual(clineEnvelopeStatus({ success: false, error: { code: 200 } }), 502, "status sukses tidak dipakai");
  assert.strictEqual(clineEnvelopeStatus({ success: false }), 502);
});

test("cline success:false becomes a real HTTP error, not a 200", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "Cline test", credentials: { access_token: "token" } });

  await withUpstream(
    () => envelopeError({ message: "cline rejected", type: "invalid_request_error", code: 400 }),
    async () => {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cline/z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.match(json.error.message, /cline rejected/);
    }
  );
});

test("cline success:false without a status fails over to the next account", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "a", credentials: { access_token: "token-a" } });
  addConnection({ provider: "cline", name: "b", credentials: { access_token: "token-b" } });

  await withUpstream(
    (n) => (n === 1 ? envelopeError({ message: "Insufficient credits" }) : sseOk()),
    async (calls) => {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cline/z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.json()).choices[0].message.content, "ok");
      assert.strictEqual(calls.length, 2, "akun kedua dicoba setelah envelope gagal");
      assert.notStrictEqual(calls[0], calls[1], "dua akun berbeda");
    }
  );
});

test("cline success:false reaches a Claude client as an error, not an empty message", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "a", credentials: { access_token: "token" } });

  await withUpstream(
    () => envelopeError({ message: "Insufficient credits", code: 402 }),
    async () => {
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "cline/z-ai/glm-5.2",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.strictEqual(res.status, 402, "klien Claude melihat status error, bukan pesan kosong 200");
      const json = await res.json();
      assert.match(JSON.stringify(json), /Insufficient credits/);
    }
  );
});

test("cline success:true JSON still passes through the executor intact", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "a", credentials: { access_token: "token" } });

  await withUpstream(
    () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { choices: [{ index: 0, message: { role: "assistant", content: "utuh" }, finish_reason: "stop" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    async () => {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cline/z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.json()).choices[0].message.content, "utuh");
    }
  );
});

test("cline registry alone registers ClineExecutor (no test-side import)", async () => {
  const { execFileSync } = await import("node:child_process");
  // Proses terpisah hanya memuat registry provider, seperti server produksi.
  const script = `
    const { getProvider } = await import("./src/providers/index.js");
    const { getExecutor } = await import("./src/executors/base.js");
    process.stdout.write(getExecutor(getProvider("cline")).constructor.name);
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.strictEqual(out.trim(), "ClineExecutor");
});
