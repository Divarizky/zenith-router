import test from "node:test";
import assert from "node:assert/strict";
import { openaiToClaude } from "../src/translator/request.js";
import { translateRequest, FORMATS } from "../src/translator/index.js";
import { applyConnectionAuth } from "../src/services/auth.js";
import { getAvailableModels } from "../src/providers/index.js";

const baseBody = {
  model: "x",
  messages: [{ role: "user", content: "halo" }],
  max_tokens: 8000,
};

const BETA_REDACT = "redact-thinking-2026-02-12";

test("reasoning_effort ke cc/ menjadi adaptive+summarized dengan output_config.effort sesuai pemetaan", () => {
  const expected = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  for (const [effort, mapped] of Object.entries(expected)) {
    const out = openaiToClaude({ ...baseBody, reasoning_effort: effort }, "claude-opus-5-5", { adaptiveThinking: true });
    assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" }, `effort ${effort}`);
    assert.deepEqual(out.output_config, { effort: mapped }, `effort ${effort}`);
    assert.equal(out.temperature, 1, "sampling tetap dikunci saat thinking aktif");
    assert.equal(out.top_p, undefined);
  }
});

test("nilai reasoning_effort yang tidak dikenal tidak mengirim thinking", () => {
  const out = openaiToClaude({ ...baseBody, reasoning_effort: "turbo" }, "claude-opus-5-5", { adaptiveThinking: true });
  assert.equal(out.thinking, undefined);
  assert.equal(out.output_config, undefined);
});

test("tanpa reasoning_effort tidak ada field thinking maupun output_config", () => {
  const out = openaiToClaude({ ...baseBody, temperature: 0.4 }, "claude-opus-5-5", { adaptiveThinking: true });
  assert.equal(out.thinking, undefined);
  assert.equal(out.output_config, undefined);
  assert.equal(out.temperature, 0.4, "sampling dari klien tetap dipakai tanpa thinking");
});

test("jalur cc/ tanpa opsi adaptif tetap memakai enabled+budget_tokens", () => {
  const out = openaiToClaude({ ...baseBody, reasoning_effort: "high" }, "claude-opus-5-5");
  assert.deepEqual(out.thinking, { type: "enabled", budget_tokens: 7999 });
  assert.equal(out.output_config, undefined);
});

test("header beta kehilangan redact-thinking hanya pada request adaptive", () => {
  const connection = { provider: "claude", auth_type: "oauth", credentials: { access_token: "sk-ant-oat01-test" } };
  const adaptive = applyConnectionAuth({ "anthropic-beta": "a-beta" }, connection, { adaptiveThinking: true });
  const adaptiveFlags = adaptive["anthropic-beta"].split(",");
  assert.ok(!adaptiveFlags.includes(BETA_REDACT), "adaptive harus membuang redact-thinking");
  assert.ok(adaptiveFlags.includes("a-beta"), "beta dari klien tetap ada");

  const plain = applyConnectionAuth({}, connection);
  assert.ok(plain["anthropic-beta"].split(",").includes(BETA_REDACT), "request lain tetap membawa redact-thinking");
  const plainFlags = plain["anthropic-beta"].split(",");
  assert.equal(new Set(plainFlags).size, plainFlags.length);
});

test("jalur non-Claude tidak berubah walaupun opsi adaptif dikirim", () => {
  const body = { ...baseBody, reasoning_effort: "high" };
  const off = translateRequest("openai", "openai-responses", body, "gpt-5", { adaptiveThinking: false });
  const on = translateRequest("openai", "openai-responses", body, "gpt-5", { adaptiveThinking: true });
  assert.deepEqual(on, off);

  const gemini = translateRequest("openai", "gemini", body, "gemini-2.5-pro", { adaptiveThinking: true });
  assert.equal(gemini.thinking, undefined);
  assert.equal(gemini.output_config, undefined);
  assert.equal(translateRequest("openai", FORMATS.CLAUDE, body, "claude-x").thinking.type, "enabled");
});

test("/v1/models mengumumkan thinking_levels untuk cc/ dan tidak untuk model lain", () => {
  const models = getAvailableModels({ all: true });
  const cc = models.filter((m) => m.id.startsWith("cc/"));
  assert.ok(cc.length > 0, "ada model cc/");
  for (const m of cc) {
    assert.deepEqual(m.thinking_levels, ["low", "medium", "high", "xhigh", "max"], m.id);
  }
  // Antigravity announces its own per-family levels; every other non-cc/ provider stays unannounced.
  const others = models.filter((m) => !m.id.startsWith("cc/") && !m.id.startsWith("ag/"));
  assert.ok(others.length > 0);
  assert.ok(others.every((m) => m.thinking_levels === undefined), "model non-cc/ dan non-ag/ tidak berubah");
});

test("passthrough Claude native tidak memakai jalur adaptif dan header-nya tetap", async () => {
  const { getProvider } = await import("../src/providers/index.js");
  const { prepareUpstreamRequest } = await import("../src/gateway/prepare.js");
  const provider = getProvider("claude");
  const body = { ...baseBody, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } };
  const passthrough = prepareUpstreamRequest({
    provider, targetModel: "claude-opus-5-5", body, sourceFormat: "claude", baseUrlFor: () => "http://x",
  });
  assert.equal(passthrough.adaptiveThinking, false, "klien Claude native memegang header-nya sendiri");

  const fromOpenAI = prepareUpstreamRequest({
    provider, targetModel: "claude-opus-5-5", body: { ...baseBody, reasoning_effort: "max" }, sourceFormat: "openai", baseUrlFor: () => "http://x",
  });
  assert.equal(fromOpenAI.adaptiveThinking, true);
  assert.equal(fromOpenAI.upstreamPayload.thinking.type, "adaptive");
});
