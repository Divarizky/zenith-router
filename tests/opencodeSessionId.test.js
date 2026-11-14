import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpencodeId,
  opencodeSessionId,
  opencodeRequestId,
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
} from "../src/executors/opencode.js";

test("opencodeSessionId satisfies OpenCode gate 2 structure and reverse-timestamp math", () => {
  const fixedNow = 1794640000000;
  const id = opencodeSessionId(fixedNow);

  assert.equal(id.length, 30, "ID length must be exactly 30 characters");
  assert.ok(OPENCODE_SESSION_RE.test(id), "must match /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/");

  const hexPrefix = id.slice(4, 16);
  assert.equal(hexPrefix.length, 12, "time payload must be 12 hex characters");

  // Counter=1 -> (current & 0xfff) = 1.
  // Inverted: ~1 & 0xfff = 0xffe. So the low 3 hex characters must always end in "ffe".
  assert.equal(hexPrefix.slice(-3), "ffe", "counter 1 inverted must end in 'ffe'");

  // Reverse decode 48-bit timestamp
  const value = BigInt(`0x${hexPrefix}`);
  const inverted = (~value) & ((1n << 48n) - 1n);
  const decodedMs36 = Number(inverted >> 12n);
  const expectedMs36 = Number(BigInt(fixedNow) & ((1n << 36n) - 1n));

  assert.equal(
    decodedMs36,
    expectedMs36,
    "decoded 36-bit timestamp must exactly match timestamp mod 2^36"
  );
});

test("opencodeSessionId generates unique IDs and increments counter within same millisecond", () => {
  const fixedNow = 1794641234567;
  const ids = Array.from({ length: 50 }, () => opencodeSessionId(fixedNow));
  const uniqueSet = new Set(ids);

  assert.equal(uniqueSet.size, 50, "all 50 generated IDs must be unique");

  for (const id of ids) {
    assert.ok(OPENCODE_SESSION_RE.test(id), `id ${id} must match canonical regex`);
  }

  // The 12-hex descending timestamps within the same ms must be distinct
  const hexes = ids.map((id) => id.slice(4, 16));
  const uniqueHexes = new Set(hexes);
  assert.equal(uniqueHexes.size, 50, "timestamps with monotonic counter must be distinct");
});

test("opencodeRequestId satisfies msg_ prefix and canonical request regex", () => {
  const reqId = opencodeRequestId();
  assert.equal(reqId.length, 30);
  assert.ok(OPENCODE_REQUEST_RE.test(reqId));
  assert.ok(reqId.startsWith("msg_"));
});
