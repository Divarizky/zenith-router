import test from "node:test";
import assert from "node:assert/strict";
import { getProvider, getAllProviders, resolveModel } from "../src/providers/index.js";
import { getProviderIconPath } from "../src/ui/assets.js";

test("pollinations - terdaftar sebagai provider keyless gratis", () => {
  const p = getProvider("pollinations");
  assert.ok(p, "pollinations harus ada di registry");
  assert.equal(p.category, "free");
  assert.equal(p.noAuth, true);
  assert.equal(p.format, "openai");
});

test("pollinations - prefix alias poll dan pollinations mengarah ke provider yang sama", () => {
  assert.equal(getProvider("poll"), getProvider("pollinations"));
});

test("pollinations - prefix poll tidak bertabrakan dengan provider lain", () => {
  const owners = getAllProviders().filter((p) => (Array.isArray(p.alias) ? p.alias : [p.alias]).includes("poll"));
  assert.equal(owners.length, 1);
});

test("pollinations - resolveModel memetakan poll/<model> ke endpoint OpenAI-compatible", () => {
  const resolved = resolveModel("poll/openai-fast");
  assert.equal(resolved.provider.id, "pollinations");
  assert.equal(resolved.targetModel, "openai-fast");
  assert.equal(resolved.provider.transport.baseUrl, "https://text.pollinations.ai/openai/chat/completions");
});

test("pollinations - tidak punya ikon PNG sehingga fallback badge dipakai", () => {
  assert.equal(getProviderIconPath("pollinations"), null);
});
