/**
 * DuckDuckGo VQD challenge solver.
 *
 * duck.ai refuses every chat POST until the caller answers a challenge: the
 * status endpoint returns base64 JavaScript that fingerprints the runtime, and
 * the reply must look like it came from the real frontend or the endpoint
 * answers 418 ERR_CHALLENGE. This module runs that script and shapes the answer.
 *
 * SECURITY: the decoded challenge is upstream-supplied code. It runs in an empty
 * vm context capped at 5s, which bounds the damage but is still a supply-chain
 * surface. Only this provider uses it.
 */
import { createHash } from "node:crypto";
import vm from "node:vm";
import { parseFragment, serialize } from "parse5";
import { CHALLENGE_STUBS } from "./challengeStub.js";

export const DUCKDUCKGO_CHALLENGE_ORIGIN = "https://duck.ai";

const CHALLENGE_TIMEOUT_MS = 5000;
const DEFAULT_BUNDLE_PATH = "/dist/duckai-dist/entry.duckai.js";
const HTML_LITERAL = /(['"])(<[^'"]{1,400}?)\1/g;

/** Element count of a parsed fragment; backs querySelectorAll('*').length. */
export function countHtmlElements(node) {
  if (!node || typeof node !== "object") return 0;
  const own = node.nodeName && node.nodeName !== "#document-fragment" ? 1 : 0;
  let childCount = 0;
  for (const child of node.childNodes ?? []) childCount += countHtmlElements(child);
  return own + childCount;
}

/**
 * The challenge probes innerHTML round-trips: it assigns a literal, then reads
 * back a descendant count. Map every literal the script mentions to the fragment
 * parse5 would build, so those probes agree with a real browser.
 */
export function buildHtmlLookup(js) {
  const lookup = {};
  const seen = new Set();
  for (const match of js.matchAll(HTML_LITERAL)) {
    const html = match[2];
    if (seen.has(html)) continue;
    seen.add(html);
    const fragment = parseFragment(html);
    lookup[html] = { html: serialize(fragment), count: countHtmlElements(fragment) };
  }
  return lookup;
}

export function sha256Base64(value) {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

/**
 * The upstream only accepts a plausible frontend stack. Ablation shows a
 * generic bundle path passes and omitting the field does not.
 */
function buildChallengeStack(origin, bundlePath) {
  const url = `${origin}${bundlePath}`;
  return `Error\nat l (${url}:2:1695625)\nat async ${url}:2:1519117`;
}

/**
 * Run the upstream challenge and return the value for the x-vqd-hash-1 header.
 * The frontend augments the challenge's own meta with origin, stack and duration
 * before sending it back; leaving them out yields 418 even with correct hashes.
 */
export async function solveDuckDuckGoChallenge(challenge, userAgent, options = {}) {
  const js = Buffer.from(challenge, "base64").toString("utf8");
  const stubs = CHALLENGE_STUBS.replace("__DDG_REAL_UA__", JSON.stringify(userAgent)).replace(
    "__DDG_HTML_LOOKUP__",
    JSON.stringify(buildHtmlLookup(js))
  );

  const context = vm.createContext({});
  vm.runInContext(stubs, context, { timeout: CHALLENGE_TIMEOUT_MS });
  const startedAt = Date.now();
  const result = await vm.runInContext(js, context, { timeout: CHALLENGE_TIMEOUT_MS });
  const elapsedMs = Date.now() - startedAt;

  const clientHashes = Array.isArray(result?.client_hashes) ? result.client_hashes : [];
  if (clientHashes.length === 0) throw new Error("DuckDuckGo challenge returned empty client_hashes");
  clientHashes[0] = userAgent;
  result.client_hashes = clientHashes.map((hash) => sha256Base64(String(hash)));

  const origin = options.origin ?? DUCKDUCKGO_CHALLENGE_ORIGIN;
  const bundlePath = options.bundlePath ?? DEFAULT_BUNDLE_PATH;
  result.meta = {
    ...(result.meta ?? {}),
    origin,
    stack: buildChallengeStack(origin, bundlePath),
    duration: String(elapsedMs),
  };

  return Buffer.from(JSON.stringify(result), "utf8").toString("base64");
}

/**
 * Synthetic interaction trace for the x-fe-signals header. The endpoint expects
 * a plausible event timeline; a missing header is treated as a non-browser.
 */
export function makeDuckDuckGoFeSignals(random = Math.random) {
  const start = Date.now() - 3000;
  let delta = 80 + Math.floor(random() * 101);
  const events = [{ name: "onboarding_impression_1", delta }];
  delta += 120 + Math.floor(random() * 141);
  events.push({ name: "onboarding_impression_2", delta });
  delta += 200 + Math.floor(random() * 301);
  events.push({ name: "startNewChat", delta });
  const keyEvents = 6 + Math.floor(random() * 13);
  for (let i = 0; i < keyEvents; i++) {
    delta += 40 + Math.floor(random() * 141);
    events.push({ name: "user_input", delta });
  }
  delta += 120 + Math.floor(random() * 231);
  events.push({ name: "user_submit", delta });
  const payload = { start, events, end: Math.max(delta + 20 + Math.floor(random() * 71), 3000) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
