import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { getAvailableModels, getProvider, resolveModel } from "../src/providers/index.js";
import { listAvailableConnections } from "../src/services/fallback.js";
import { computeFreeTierTotals } from "../src/config/freeTierCatalog.js";
import { makeDuckDuckGoFeSignals, solveDuckDuckGoChallenge } from "../src/services/duckduckgoWeb/challenge.js";
import { pickLiveModel } from "../src/services/duckduckgoWeb/models.js";

test("registry - duckduckgo-web is keyless with a virtual connection", () => {
  initDb(":memory:");
  const provider = getProvider("duckduckgo-web");
  assert.strictEqual(getProvider("ddgw").id, "duckduckgo-web");
  assert.strictEqual(provider.category, "free");
  assert.strictEqual(provider.noAuth, true);
  assert.strictEqual(provider.executor, "duckduckgo-web");
  // Parallel turns on one anonymous IP trip the rate limit.
  assert.strictEqual(provider.concurrency, 1);
  const available = listAvailableConnections("duckduckgo-web", { model: "gpt-5.4-mini" });
  assert.strictEqual(available.length, 1);
  assert.strictEqual(available[0].id, null, "no account row is stored for a keyless provider");
});

test("catalog - a keyless provider publishes models and resolves by prefix", () => {
  initDb(":memory:");
  // A keyless provider is always visible, even with no account row.
  const ids = getAvailableModels().map((model) => model.id);
  assert.ok(ids.includes("ddgw/gpt-5.4-mini"));
  assert.strictEqual(resolveModel("ddgw/claude-haiku-4-5").targetModel, "claude-haiku-4-5");
});

test("free tier - duckduckgo-web is flagged avoid", () => {
  const totals = computeFreeTierTotals();
  assert.ok(totals.providers > 0);
  assert.ok(totals.tosAvoid >= 1, "duck.ai is flagged avoid");
});

test("challenge - fe signals decode to a plausible event timeline", () => {
  const decoded = JSON.parse(Buffer.from(makeDuckDuckGoFeSignals(), "base64").toString("utf8"));
  assert.ok(Array.isArray(decoded.events) && decoded.events.length > 0);
  assert.strictEqual(decoded.events.at(-1).name, "user_submit");
  assert.ok(decoded.end >= 3000);
});

test("challenge - a solved vector carries origin, stack and duration", async () => {
  // Minimal script the stub environment can run: report one hash and no meta.
  const script = "(() => { return { client_hashes: ['a'], meta: {} }; })()";
  const challenge = Buffer.from(script, "utf8").toString("base64");
  const solved = JSON.parse(Buffer.from(await solveDuckDuckGoChallenge(challenge, "UA/1"), "base64").toString("utf8"));
  assert.strictEqual(solved.meta.origin, "https://duck.ai");
  assert.match(solved.meta.stack, /entry\.duckai\.js/);
  assert.ok(Number(solved.meta.duration) >= 0);
  assert.strictEqual(solved.client_hashes.length, 1);
});

test("models - a retired id reroutes to the same family, then to the default", () => {
  const live = new Set(["gpt-5.4-mini", "claude-haiku-4-5"]);
  assert.strictEqual(pickLiveModel("claude-haiku-4-5", live), "claude-haiku-4-5");
  assert.strictEqual(pickLiveModel("claude-opus-4-8", live), "claude-haiku-4-5", "same family wins");
  assert.strictEqual(pickLiveModel("tinfoil/gemma4-31b", live), "gpt-5.4-mini", "unknown family falls back");
  assert.strictEqual(pickLiveModel("anything", null), "anything", "no live list keeps the request");
});
