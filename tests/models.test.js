import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { getAvailableModels, getProvider } from "../src/providers/index.js";

test("Provider Registry - contains 17 core providers", () => {
  const providers = [
    "claude",
    "codex",
    "github",
    "kiro",
    "antigravity",
    "glm",
    "opencode",
    "kilocode",
    "nvidia",
    "cline",
    "pollinations",
    "cloudflare-ai",
    "openrouter",
    "llm7",
    "bazaarlink",
    "together",
    "freebuff",
  ];
  for (const id of providers) {
    const p = getProvider(id);
    assert.ok(p, `Provider ${id} must exist in registry`);
    assert.strictEqual(p.id, id);
    assert.ok(Array.isArray(p.models), `Provider ${id} must have models array`);
    assert.ok(p.models.length > 0, `Provider ${id} must provide at least one model`);
  }
});

test("Provider Registry - nvidia and cline use standard OpenAI transport", () => {
  const nvidia = getProvider("nvidia");
  assert.strictEqual(nvidia.transport.baseUrl, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.strictEqual(nvidia.category, "apikey");
  assert.ok(nvidia.models.some((m) => m.id === "moonshotai/kimi-k3"));

  const cline = getProvider("cline");
  assert.strictEqual(cline.transport.baseUrl, "https://api.cline.bot/api/v1/chat/completions");
  assert.strictEqual(cline.category, "oauth");
  assert.strictEqual(cline.transport.headers["HTTP-Referer"], "https://cline.bot");
  assert.ok(cline.models.some((m) => m.id === "moonshotai/kimi-k3"));
});

test("Provider Registry - new providers use expected configs", () => {
  const pol = getProvider("pollinations");
  assert.strictEqual(pol.category, "free");
  assert.strictEqual(pol.noAuth, true);
  assert.strictEqual(pol.transport.baseUrl, "https://gen.pollinations.ai/v1/chat/completions");

  const cf = getProvider("cloudflare-ai");
  assert.strictEqual(cf.category, "apikey");
  assert.ok(cf.transport.baseUrl.includes("{accountId}"));

  const or = getProvider("openrouter");
  assert.strictEqual(or.category, "apikey");
  assert.strictEqual(or.transport.baseUrl, "https://openrouter.ai/api/v1/chat/completions");

  const l7 = getProvider("llm7");
  assert.strictEqual(l7.category, "apikey");
  assert.strictEqual(l7.transport.baseUrl, "https://api.llm7.io/v1/chat/completions");

  const bzl = getProvider("bazaarlink");
  assert.strictEqual(bzl.category, "apikey");
  assert.strictEqual(bzl.transport.baseUrl, "https://bazaarlink.ai/api/v1/chat/completions");

  const fb = getProvider("freebuff");
  assert.strictEqual(fb.category, "oauth");
  assert.strictEqual(fb.executor, "freebuff");
  assert.strictEqual(fb.transport.baseUrl, "https://www.codebuff.com/api/v1/chat/completions");
});

test("Provider Registry - aligned configs for codex, github, kiro, and antigravity", () => {
  const codex = getProvider("codex");
  assert.strictEqual(codex.transport.baseUrl, "https://chatgpt.com/backend-api/codex/responses");
  assert.strictEqual(codex.transport.headers.originator, "codex_cli_rs");
  assert.ok(codex.models.some((m) => m.id === "gpt-6.1-sol"));

  const github = getProvider("github");
  assert.strictEqual(github.transport.baseUrl, "https://api.githubcopilot.com/chat/completions");
  assert.strictEqual(github.transport.responsesUrl, "https://api.githubcopilot.com/responses");
  assert.strictEqual(github.transport.messagesUrl, "https://api.githubcopilot.com/v1/messages");
  assert.ok(github.transport.headers["copilot-integration-id"], "vscode-chat");

  const kiro = getProvider("kiro");
  assert.ok(Array.isArray(kiro.transport.baseUrls));
  assert.strictEqual(kiro.transport.headers["Accept"], "application/vnd.amazon.eventstream");

  const ag = getProvider("antigravity");
  assert.strictEqual(ag.transport.baseUrls[0], "https://daily-cloudcode-pa.googleapis.com");
  assert.ok(ag.transport.headers["User-Agent"].includes("antigravity/ide"));
});

test("Provider Registry - getAvailableModels aggregates model list with provider prefixes", () => {
  const models = getAvailableModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);

  // Checks structure of each model item
  const first = models[0];
  assert.ok(first.id, "Model must have id");
  assert.strictEqual(first.object, "model");
  assert.ok(first.owned_by, "Model must have owned_by");

  // Check some expected models exist with alias or prefix
  const modelIds = models.map((m) => m.id);
  assert.ok(modelIds.some((id) => id.startsWith("glm/") || id.startsWith("glm:")), "Must contain GLM model");
  assert.ok(modelIds.some((id) => id.startsWith("claude/") || id.startsWith("cc/")), "Must contain Claude model");
  assert.ok(modelIds.some((id) => id.startsWith("nv/")), "Must contain NVIDIA model");
  assert.ok(modelIds.some((id) => id.startsWith("cl/")), "Must contain Cline model");
  assert.ok(modelIds.some((id) => id.startsWith("pol/")), "Must contain Pollinations model");
  assert.ok(modelIds.some((id) => id.startsWith("cf/")), "Must contain Cloudflare model");
  assert.ok(modelIds.some((id) => id.startsWith("or/")), "Must contain OpenRouter model");
  assert.ok(modelIds.some((id) => id.startsWith("llm7/")), "Must contain LLM7 model");
  assert.ok(modelIds.some((id) => id.startsWith("bzl/")), "Must contain Bazaarlink model");
  assert.ok(modelIds.some((id) => id.startsWith("together/")), "Must contain Together model");
  assert.ok(modelIds.some((id) => id.startsWith("fb/")), "Must contain Freebuff model");
});

test("GET /v1/models - returns OpenAI compatible model list", async () => {
  const res = await app.request("/v1/models");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.strictEqual(json.object, "list");
  assert.ok(Array.isArray(json.data));
  assert.ok(json.data.length > 0);

  const first = json.data[0];
  assert.ok(first.id);
  assert.strictEqual(first.object, "model");
  assert.ok(first.owned_by);
});
