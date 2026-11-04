import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdvanceableErrorText } from "../src/gateway/route.js";

test("isAdvanceableErrorText - HTTP 400 mismatch parameter/kapabilitas memicu failover", () => {
  // Mencegah regresi: upstream 400 karena kapabilitas tidak cocok harus pindah ke model berikutnya.
  assert.equal(isAdvanceableErrorText("this model does not support tools"), true);
  assert.equal(isAdvanceableErrorText("invalid temperature for reasoning model"), true);
  assert.equal(isAdvanceableErrorText("unsupported parameter: top_k"), true);
});

test("isAdvanceableErrorText - 400 generik tanpa sinyal kapabilitas tidak memicu failover", () => {
  // Mencegah failover membabi buta pada request yang memang invalid untuk semua model.
  assert.equal(isAdvanceableErrorText("random 400 bad request"), false);
});
