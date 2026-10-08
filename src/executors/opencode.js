import { BaseExecutor, registerExecutor } from "./base.js";
import { randomBytes } from "node:crypto";

const OPENCODE_UA = "opencode/1.18.31";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randBase62(n) {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += BASE62[bytes[i] % 62];
  return out;
}

function randHex(n) {
  return randomBytes(n).toString("hex").slice(0, n);
}

export function opencodeSessionId() {
  return `ses_${randHex(12)}${randBase62(14)}`;
}

export function opencodeRequestId() {
  return `msg_${randHex(12)}${randBase62(14)}`;
}

const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

export function opencodePathForModel(model) {
  if (RESPONSES_MODELS.has(model)) return "/zen/v1/responses";
  if (MESSAGES_MODELS.has(model)) return "/zen/v1/messages";
  return "/zen/v1/chat/completions";
}

const FINGERPRINT_TOOLS = [
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } } },
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "grep", description: "Search file contents", parameters: { type: "object", properties: { pattern: { type: "string" } } } } },
  { type: "function", function: { name: "glob", description: "Find files by pattern", parameters: { type: "object", properties: { pattern: { type: "string" } } } } },
];

function ensureFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  if (!Array.isArray(body.tools)) body.tools = [];
  const have = new Set(body.tools.map((t) => t?.function?.name || t?.name).filter(Boolean));
  for (const tool of FINGERPRINT_TOOLS) {
    if (!have.has(tool.function.name)) body.tools.push(tool);
  }
}

export class OpencodeExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel, targetFormat }) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {}

    const model = targetModel || parsed?.model || "";
    let path = opencodePathForModel(model);
    if (String(targetFormat).includes("responses")) path = "/zen/v1/responses";
    else if (String(targetFormat) === "claude") path = "/zen/v1/messages";
    const finalUrl = `https://opencode.ai${path}`;

    if (parsed && typeof parsed === "object") {
      ensureFingerprintTools(parsed);
      body = JSON.stringify(parsed);
    }

    const opencodeHeaders = {
      ...headers,
      Authorization: "Bearer public",
      "User-Agent": OPENCODE_UA,
      "x-opencode-client": "desktop",
      "x-opencode-session": headers["x-opencode-session"] || opencodeSessionId(),
      "x-opencode-request": headers["x-opencode-request"] || opencodeRequestId(),
      "x-opencode-project": headers["x-opencode-project"] || "global",
      Accept: "text/event-stream",
    };

    return super.execute({
      url: finalUrl,
      method,
      headers: opencodeHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });
  }
}

export const opencodeExecutorInstance = new OpencodeExecutor();
registerExecutor("opencode", opencodeExecutorInstance);
