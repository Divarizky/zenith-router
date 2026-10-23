import test from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import {
  applyClaudeOAuthCloaking,
  buildBillingHeader,
  isClaudeOAuthToken,
} from "../src/services/claudeCloaking.js";

const BILLING_RE = /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/;

test("isClaudeOAuthToken hanya mengenali token sk-ant-oat", () => {
  assert.strictEqual(isClaudeOAuthToken("sk-ant-oat01-abc"), true);
  assert.strictEqual(isClaudeOAuthToken("sk-ant-api03-abc"), false);
  assert.strictEqual(isClaudeOAuthToken(""), false);
  assert.strictEqual(isClaudeOAuthToken(undefined), false);
});

test("billing header memakai format CLI dan cch dari pesan user pertama", () => {
  const header = buildBillingHeader([{ role: "user", content: "hello world" }]);
  assert.match(header, BILLING_RE);
  const expectedCch = createHash("sha256").update("hello world", "utf8").digest("hex").slice(0, 5);
  assert.ok(header.endsWith(`cch=${expectedCch};`));
});

test("billing header mengambil teks dari blok user array dan melewati user tanpa teks", () => {
  const fromArray = buildBillingHeader([
    { role: "user", content: [{ type: "image", source: {} }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: "halo dunia" }] },
  ]);
  const direct = buildBillingHeader([{ role: "user", content: "halo dunia" }]);
  assert.strictEqual(fromArray, direct);
});

test("applyClaudeOAuthCloaking menambahkan billing sebagai system[0] pada system string", () => {
  const body = { model: "claude-opus-5", system: "Kamu asisten.", messages: [{ role: "user", content: "hi" }] };
  const out = applyClaudeOAuthCloaking(body);
  assert.match(out.system[0].text, BILLING_RE);
  assert.deepStrictEqual(out.system[1], { type: "text", text: "Kamu asisten." });
  assert.strictEqual(body.system, "Kamu asisten.", "body asli tidak boleh diubah");
});

test("applyClaudeOAuthCloaking mempertahankan system array dan tanpa system", () => {
  const withArray = applyClaudeOAuthCloaking({
    system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.strictEqual(withArray.system.length, 3);
  assert.match(withArray.system[0].text, BILLING_RE);
  assert.deepStrictEqual(withArray.system.slice(1).map((b) => b.text), ["A", "B"]);

  const noSystem = applyClaudeOAuthCloaking({ messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(noSystem.system.length, 1);
  assert.match(noSystem.system[0].text, BILLING_RE);
});

test("applyClaudeOAuthCloaking tidak menduplikasi billing header yang sudah ada", () => {
  const once = applyClaudeOAuthCloaking({ system: "X", messages: [{ role: "user", content: "hi" }] });
  const twice = applyClaudeOAuthCloaking(once);
  assert.strictEqual(twice, once);
  assert.strictEqual(twice.system.length, 2);
});

test("gateway menambahkan billing header hanya untuk koneksi Claude OAuth", async () => {
  const captured = [];
  initDb(":memory:");
  addConnection({
    provider: "claude",
    name: "Claude OAuth",
    auth_type: "oauth",
    credentials: { access_token: "sk-ant-oat01-test", refresh_token: "rt" },
  });
  setCustomExecutor({
    async execute({ body: sentBody }) {
      captured.push(typeof sentBody === "string" ? JSON.parse(sentBody) : sentBody);
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude/claude-opus-5",
        max_tokens: 64,
        stream: false,
        system: "Kamu asisten.",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.strictEqual(res.status, 200);
    assert.match(captured[0].system[0].text, BILLING_RE);
    assert.strictEqual(captured[0].system[1].text, "Kamu asisten.");
  } finally {
    setCustomExecutor(null);
  }
});

test("gateway tidak mengubah body untuk koneksi Claude API key", async () => {
  const captured = [];
  initDb(":memory:");
  addConnection({
    provider: "claude",
    name: "Claude API key",
    auth_type: "apikey",
    credentials: { api_key: "sk-ant-api03-test" },
  });
  setCustomExecutor({
    async execute({ body: sentBody }) {
      captured.push(typeof sentBody === "string" ? JSON.parse(sentBody) : sentBody);
      return new Response(
        JSON.stringify({
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude/claude-opus-5",
        max_tokens: 64,
        stream: false,
        system: "Kamu asisten.",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.strictEqual(captured[0].system, "Kamu asisten.");
  } finally {
    setCustomExecutor(null);
  }
});
