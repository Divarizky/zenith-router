import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  createPowSolver,
  encodePowHeader,
  solvePowChallenge,
  POW_TARGET_PATH,
  PowError,
} from "../src/services/deepseekWeb/pow.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/deepseekWeb/pow-challenge.json", import.meta.url), "utf8")
);

const isIntegerLike = (value) => Math.abs(value - Math.round(value)) < 1e-9;

test("pow - the vendored WASM solves the cross-checked fixture deterministically", async () => {
  const first = await solvePowChallenge(fixture);
  const second = await solvePowChallenge(fixture);

  assert.strictEqual(first.answer, second.answer, "the same challenge yields the same answer");
  assert.ok(Number.isFinite(first.answer));
  assert.ok(isIntegerLike(first.answer), "the answer is an integer nonce, as the web client sends it");
  // Vektor ini menghasilkan answer yang sama di paket Python deepseek-pow.
  assert.strictEqual(first.answer, fixture.expected_answer);
  assert.strictEqual(first.algorithm, "DeepSeekHashV1");
  assert.strictEqual(first.challenge, fixture.challenge);
  assert.strictEqual(first.salt, fixture.salt);
  assert.strictEqual(first.signature, fixture.signature);
  assert.strictEqual(first.target_path, POW_TARGET_PATH);
});

test("pow - the header carries target_path, which the upstream requires", async () => {
  const payload = await solvePowChallenge(fixture);
  const decoded = JSON.parse(Buffer.from(encodePowHeader(payload), "base64").toString("utf8"));

  assert.deepStrictEqual(Object.keys(decoded).sort(), [
    "algorithm",
    "answer",
    "challenge",
    "salt",
    "signature",
    "target_path",
  ]);
  assert.strictEqual(decoded.target_path, "/api/v0/chat/completion");
  assert.strictEqual(decoded.algorithm, "DeepSeekHashV1");
  assert.strictEqual(decoded.answer, payload.answer);
});

test("pow - malformed challenges are rejected before any WASM work", async () => {
  const cases = [
    [null, /missing/],
    [{ ...fixture, algorithm: "SHA256V2" }, /Unsupported PoW algorithm/],
    [{ ...fixture, challenge: "" }, /challenge string/],
    [{ ...fixture, salt: "" }, /salt/],
    [{ ...fixture, difficulty: -1 }, /difficulty/],
    [{ ...fixture, difficulty: "difficult" }, /difficulty/],
    [{ ...fixture, expire_at: null }, /expiry/],
  ];

  for (const [challenge, pattern] of cases) {
    await assert.rejects(
      solvePowChallenge(challenge),
      (err) => err instanceof PowError && err.code === "pow_invalid" && pattern.test(err.message)
    );
  }
});

test("pow - a missing WASM file fails as pow_unavailable instead of crashing", async () => {
  const solver = createPowSolver({ wasmPath: "/no/such/deepseek-pow.wasm" });
  await assert.rejects(
    solver.solve(fixture),
    (err) => err instanceof PowError && err.code === "pow_unavailable" && /Failed to load PoW solver/.test(err.message)
  );
});

test("pow - solving the fixture stays well under one second", async () => {
  await solvePowChallenge(fixture);
  const started = process.hrtime.bigint();
  await solvePowChallenge(fixture);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // Difficulty 144000 measures ~20ms p50 on the dev machine (scripts/benchDeepSeekPow.js).
  assert.ok(ms < 1000, `difficulty ${fixture.difficulty} took ${Math.round(ms)}ms`);
});
