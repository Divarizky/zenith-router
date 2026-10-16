import test from "node:test";
import assert from "node:assert";
import { isFreeOpencodeModel } from "../src/services/opencodeDiscovery.js";

test("isFreeOpencodeModel - identifies free models and excludes jev evaluation models", () => {
  assert.strictEqual(isFreeOpencodeModel("muse-spark-1.3-contributor-free"), true);
  assert.strictEqual(isFreeOpencodeModel("muse-spark-1.2-contributor"), true);
  assert.strictEqual(isFreeOpencodeModel("big-pickle"), true);
  assert.strictEqual(isFreeOpencodeModel("mimo-v2.6-flash-free"), true);

  assert.strictEqual(isFreeOpencodeModel("jev-1.13-free"), false);
  assert.strictEqual(isFreeOpencodeModel("gpt-4o"), false);
  assert.strictEqual(isFreeOpencodeModel("claude-3-5-sonnet"), false);
});
