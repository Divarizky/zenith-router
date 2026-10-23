// Request cloaking for Claude OAuth connections. The upstream only accepts an
// sk-ant-oat token from a request that carries the billing header Claude Code
// puts in system[0]; without it the call is refused with a generic 429
// "rate_limit_error". Clients other than the official CLI do not send that
// header, so Zenith adds it for them.
import { createHash } from "node:crypto";
import { CLAUDE_CLI_VERSION } from "./claudeIdentity.js";

const BILLING_PREFIX = "x-anthropic-billing-header:";
// Salt and sample positions the CLI uses to derive the cc_version suffix from
// the first user message.
const VERSION_SALT = "59cf53e54c78";
const VERSION_POSITIONS = [4, 7, 20];

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isClaudeOAuthToken(token) {
  return typeof token === "string" && token.startsWith("sk-ant-oat");
}

// Text of the first user message that has any text block. Matches the
// selection the CLI makes, so the suffix stays aligned with what it would send.
function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const block = msg.content.find((b) => b?.type === "text" && typeof b.text === "string");
      if (block) return block.text;
    }
  }
  return "";
}

export function buildBillingHeader(messages) {
  const text = firstUserText(messages);
  const picks = VERSION_POSITIONS.map((p) => text[p] ?? "\0").join("");
  const suffix = sha256Hex(`${VERSION_SALT}${picks}${CLAUDE_CLI_VERSION}`).slice(0, 3);
  const cch = sha256Hex(text).slice(0, 5);
  return `${BILLING_PREFIX} cc_version=${CLAUDE_CLI_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

/**
 * Prepend the billing header as system[0]. Returns the same body object when
 * a billing header is already present, so a client that already cloaked its
 * request is passed through untouched.
 */
export function applyClaudeOAuthCloaking(body) {
  if (!body || typeof body !== "object") return body;
  const system = body.system;
  let blocks = [];
  if (Array.isArray(system)) blocks = system;
  else if (typeof system === "string" && system.trim()) blocks = [{ type: "text", text: system }];

  const alreadyCloaked = blocks.some(
    (b) => typeof b?.text === "string" && b.text.startsWith(BILLING_PREFIX)
  );
  if (alreadyCloaked) return body;

  const billing = { type: "text", text: buildBillingHeader(body.messages) };
  return { ...body, system: [billing, ...blocks] };
}
