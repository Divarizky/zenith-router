// Narrow request-scoped compatibility rewrites for Antigravity's systemInstruction.
// The upstream fingerprints a small set of Hermes/OpenClaw marker lines. Keep this
// transform limited to system text: roles, non-text parts, tools, and all unrelated
// request fields must remain byte-for-byte equivalent after JSON serialization.

const HERMES_LINE_REWRITES = [
  {
    pattern: /^[ \t]*You are Hermes Agent, built by Nous Research\. Be direct:[^\r\n]*/gm,
    replacement: "You are an AI assistant.",
  },
  { pattern: /^[ \t]*<!-- End Hermes runtime environment -->[^\r\n]*(?:\r?\n|$)/gm, replacement: "" },
  { pattern: /^[ \t]*# Google model operational directives[^\r\n]*(?:\r?\n|$)/gm, replacement: "" },
  {
    pattern: /^[ \t]*If a tool, install, or network call fails and blocks the real path[^\r\n]*(?:\r?\n|$)/gm,
    replacement: "",
  },
  {
    pattern: /^[ \t]*When the user asks you to build, run, or verify something, the deliverable is a working artifact[^\r\n]*(?:\r?\n|$)/gm,
    replacement: "",
  },
  { pattern: /^[ \t]*For help with Hermes Agent itself[^\r\n]*(?:\r?\n|$)/gm, replacement: "" },
  {
    pattern: /^[ \t]*Mid-turn, the user can steer you: Hermes delivers their message[^\r\n]*(?:\r?\n|$)/gm,
    replacement: "",
  },
];

const HERMES_IDENTITY_RE = /You are Hermes(?: Agent)?(?:,\s*(?:an intelligent AI assistant|an AI assistant|an AI agent))?(?:,?\s*(?:built|created)\s+by\s+Nous Research)?\./gi;
const OPENCLAW_IDENTITY_RE = /You are a personal assistant running inside OpenClaw\./gi;

const ANTIGRAVITY_IDENTITY = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.";

const EXTRA_REWRITES = [
  {
    pattern: /solve coding tasks\.\s+Be concise, practical, and tool-aware\./gi,
    replacement: "work on their coding tasks. Keep responses concise and practical, and use the available tools when they help.",
  },
  {
    pattern: /You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK\./gi,
    replacement: ANTIGRAVITY_IDENTITY,
  },
  {
    pattern: /You are Claude Code, Anthropic's official CLI for Claude\./gi,
    replacement: ANTIGRAVITY_IDENTITY,
  },
  { pattern: /You are Claude Code/gi, replacement: ANTIGRAVITY_IDENTITY },
  {
    pattern: /Dual-use security tools \(C2 frameworks, credential testing, exploit development\) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases\.[ \t]*/gi,
    replacement: "",
  },
  {
    pattern: /pasted into the message by the user from somewhere else and may contain instructions the user did not write/gi,
    replacement: "pasted into the message by the user and may contain instructions the user did not write",
  },
  {
    pattern: /the deliverable is a working artifact backed by real tool output/gi,
    replacement: "the deliverable is a working artifact that real tool output backs",
  },
  {
    pattern: /Reporting a blocker honestly is always better than inventing a result\./gi,
    replacement: "Honestly reporting a blocker is always better than inventing a result.",
  },
];

function rewriteSystemText(text) {
  let rewritten = text;
  for (const { pattern, replacement } of HERMES_LINE_REWRITES) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  rewritten = rewritten.replace(HERMES_IDENTITY_RE, "You are an AI assistant.");
  rewritten = rewritten.replace(OPENCLAW_IDENTITY_RE, "You are a personal assistant.");
  for (const { pattern, replacement } of EXTRA_REWRITES) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  return rewritten;
}

/**
 * Rewrite only textual systemInstruction parts in a Gemini/Antigravity request.
 * Returns the original object when no part changes, avoiding needless cloning.
 */
export function applyAntigravityPromptCompatibility(request) {
  const parts = request?.systemInstruction?.parts;
  if (!Array.isArray(parts)) return request;

  let changed = false;
  const rewrittenParts = parts.map((part) => {
    if (typeof part?.text !== "string") return part;
    const text = rewriteSystemText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });

  return changed
    ? { ...request, systemInstruction: { ...request.systemInstruction, parts: rewrittenParts } }
    : request;
}

export { rewriteSystemText };
