import test from "node:test";
import assert from "node:assert/strict";
import {
  AntigravityExecutor,
  isAntigravityPromptRejection,
  moveSystemInstructionToContents,
} from "../src/executors/antigravity.js";
import { app } from "../src/index.js";
import { initDb, addConnection, getDb } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

const PLAIN = { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } };
const FLAT = { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" };
const WITH_DETAILS = {
  error: { ...PLAIN.error, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }] },
};

const json429 = (body) => new Response(JSON.stringify(body), { status: 429, headers: { "Content-Type": "application/json" } });

function makeExecutor(responses) {
  const bodies = [];
  const executor = new AntigravityExecutor({
    fetchFn: async (_url, init = {}) => {
      bodies.push(JSON.parse(init.body));
      const next = responses[Math.min(bodies.length - 1, responses.length - 1)];
      return typeof next === "function" ? next() : next;
    },
  });
  return { executor, bodies };
}

const baseArgs = () => ({
  url: "x",
  body: JSON.stringify({
    model: "gemini-3.8-flash",
    contents: [{ role: "user", parts: [{ text: "halo" }] }],
    systemInstruction: { parts: [{ text: "SYSTEM-TEXT" }] },
  }),
  connection: { credentials: { project_id: "proj-1" } },
  targetModel: "gemini-3.8-flash",
});

test("isAntigravityPromptRejection classifies plain 429 only", () => {
  assert.equal(isAntigravityPromptRejection(429, JSON.stringify(PLAIN)), true);
  assert.equal(isAntigravityPromptRejection(429, JSON.stringify(FLAT)), true);
  assert.equal(isAntigravityPromptRejection(429, JSON.stringify({ error: { ...PLAIN.error, details: [] } })), true);
  assert.equal(isAntigravityPromptRejection(429, JSON.stringify(WITH_DETAILS)), false);
  assert.equal(isAntigravityPromptRejection(429, "Resource has been exhausted"), false);
  assert.equal(isAntigravityPromptRejection(400, JSON.stringify(PLAIN)), false);
  assert.equal(isAntigravityPromptRejection(500, JSON.stringify(PLAIN)), false);
});

test("moveSystemInstructionToContents puts system text before the first user turn", () => {
  const inline = { inlineData: { mimeType: "image/png", data: "x" } };
  const request = {
    contents: [{ role: "model", parts: [{ text: "m" }] }, { role: "user", parts: [inline] }],
    systemInstruction: { parts: [{ text: "S1" }, { text: "S2" }] },
    generationConfig: { temperature: 1 },
  };
  const snapshot = structuredClone(request);
  const out = moveSystemInstructionToContents(request);
  assert.deepEqual(request, snapshot);
  assert.equal("systemInstruction" in out, false);
  assert.deepEqual(out.contents[0], request.contents[0]);
  assert.deepEqual(out.contents[1].parts, [{ text: "S1" }, { text: "S2" }, inline]);
  assert.deepEqual(out.generationConfig, { temperature: 1 });
});

test("moveSystemInstructionToContents creates a user turn when none exists", () => {
  const request = { contents: [], systemInstruction: { parts: [{ text: "S" }] } };
  const out = moveSystemInstructionToContents(request);
  assert.deepEqual(out.contents, [{ role: "user", parts: [{ text: "S" }] }]);
  assert.deepEqual(request.contents, []);
  assert.ok(request.systemInstruction);
});

test("moveSystemInstructionToContents returns same reference without systemInstruction", () => {
  const request = { contents: [] };
  assert.strictEqual(moveSystemInstructionToContents(request), request);
});

test("execute retries once with system text in the user turn and succeeds", async () => {
  const { executor, bodies } = makeExecutor([json429(PLAIN), new Response("{}", { status: 200 })]);
  const res = await executor.execute(baseArgs());
  assert.equal(res.status, 200);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].request.systemInstruction);
  assert.equal("systemInstruction" in bodies[1].request, false);
  assert.deepEqual(bodies[1].request.contents[0].parts[0], { text: "SYSTEM-TEXT" });
  assert.notEqual(bodies[0].requestId, bodies[1].requestId);
});

test("execute returns 400 prompt_rejected when both calls are rejected", async () => {
  const { executor, bodies } = makeExecutor([() => json429(PLAIN)]);
  const res = await executor.execute(baseArgs());
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assert.equal(body.error.reason, "antigravity_prompt_rejected");
  assert.equal(bodies.length, 2);
});

test("execute returns 400 without retry when there is no systemInstruction to move", async () => {
  const { executor, bodies } = makeExecutor([() => json429(PLAIN)]);
  const args = baseArgs();
  args.body = JSON.stringify({ model: "gemini-3.8-flash", contents: [{ role: "user", parts: [{ text: "hi" }] }] });
  const res = await executor.execute(args);
  assert.equal(res.status, 400);
  assert.equal(bodies.length, 1);
});

test("execute passes a genuine quota 429 through untouched", async () => {
  const { executor, bodies } = makeExecutor([() => json429(WITH_DETAILS)]);
  const res = await executor.execute(baseArgs());
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), WITH_DETAILS);
  assert.equal(bodies.length, 1);
});

test("execute handles response objects without clone() and single-read bodies", async () => {
  const mk = (payload) => {
    let used = false;
    return {
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "Content-Type": "application/json" }),
      async text() {
        assert.equal(used, false, "body dibaca dua kali");
        used = true;
        return JSON.stringify(payload);
      },
    };
  };
  const quota = makeExecutor([() => mk(WITH_DETAILS)]);
  const q = await quota.executor.execute(baseArgs());
  assert.equal(q.status, 429);
  assert.deepEqual(await q.json(), WITH_DETAILS);

  const rej = makeExecutor([() => mk(PLAIN)]);
  const r = await rej.executor.execute(baseArgs());
  assert.equal(r.status, 400);
  assert.equal(rej.bodies.length, 2);
});

test("fallback: a prompt rejection (400) does not lock the account or model", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "AG", credentials: { project_id: "p", access_token: "t" } });
  let calls = 0;
  setCustomExecutor({
    async execute() {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "rejected", reason: "antigravity_prompt_rejected" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "antigravity/gemini-3.8-flash", messages: [{ role: "user", content: "halo" }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls, 1);
    const db = getDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection_model_locks WHERE locked_until > ?").get(Date.now()).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connections WHERE cooldown_until > ?").get(Date.now()).n, 0);
  } finally {
    setCustomExecutor(null);
  }
});
