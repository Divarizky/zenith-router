import { BaseExecutor, registerExecutor } from "./base.js";
import { randomBytes } from "node:crypto";
import { prepareResponsesBody, restoreResponsesToolNames } from "./opencodeResponses.js";

export const OPENCODE_UA = "opencode/1.19.0";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randBase62(n) {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += BASE62[bytes[i] % 62];
  return out;
}

let lastSessionTimestamp = 0;
let sessionCounter = 0;

export function opencodeSessionId(timestamp = Date.now()) {
  if (timestamp !== lastSessionTimestamp) {
    lastSessionTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${randBase62(14)}`;
}

export function opencodeRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${randBase62(14)}`;
}

const translatedSessions = new Map();
export const MAX_OPENCODE_SESSIONS = 1000;
export const OPENCODE_SESSION_TTL_MS = 1800000; // 30 menit

export function resetOpencodeSessionCache() {
  translatedSessions.clear();
}

export function getOpencodeSessionCacheSize() {
  return translatedSessions.size;
}

export function translateOpencodeSession(sessionId, clientTool = "", opts = {}) {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
  if (trimmed && OPENCODE_SESSION_RE.test(trimmed)) {
    return trimmed;
  }

  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? OPENCODE_SESSION_TTL_MS;
  const maxSessions = opts.maxSessions ?? MAX_OPENCODE_SESSIONS;

  const key = `opencode:ses:${clientTool || "generic"}:${trimmed || "default"}`;
  const existing = translatedSessions.get(key);

  if (existing) {
    if (now - existing.lastUsed <= ttlMs) {
      existing.lastUsed = now;
      translatedSessions.delete(key);
      translatedSessions.set(key, existing);
      return existing.sessionId;
    }
    translatedSessions.delete(key);
  }

  const newId = opencodeSessionId(now);
  if (translatedSessions.size >= maxSessions) {
    const oldestKey = translatedSessions.keys().next().value;
    if (oldestKey !== undefined) translatedSessions.delete(oldestKey);
  }

  translatedSessions.set(key, { sessionId: newId, lastUsed: now });
  return newId;
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

// Shape a fingerprint tool for the upstream path: Responses and Claude Messages
// both require a top-level `name`, unlike Chat Completions.
function shapeTool(tool, path) {
  const { name, description, parameters } = tool.function;
  if (path.endsWith("/responses")) return { type: "function", name, description, parameters };
  if (path.endsWith("/messages")) return { name, description, input_schema: parameters };
  return tool;
}

function ensureFingerprintTools(body, path = "/zen/v1/chat/completions") {
  if (!body || typeof body !== "object") return;
  if (!Array.isArray(body.tools)) body.tools = [];
  const have = new Set(body.tools.map((t) => t?.function?.name || t?.name).filter(Boolean));
  for (const tool of FINGERPRINT_TOOLS) {
    if (!have.has(tool.function.name)) body.tools.push(shapeTool(tool, path));
  }
}

export class OpencodeExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel, targetFormat, sessionKey = null }) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {}

    const model = targetModel || parsed?.model || "";
    let path = opencodePathForModel(model);
    if (String(targetFormat).includes("responses")) path = "/zen/v1/responses";
    else if (String(targetFormat) === "claude") path = "/zen/v1/messages";
    const finalUrl = `https://opencode.ai${path}`;

    let toolNameMap = null;
    if (parsed && typeof parsed === "object") {
      ensureFingerprintTools(parsed, path);
      parsed.stream = true;
      if (path.endsWith("/responses")) toolNameMap = prepareResponsesBody(parsed);
      body = JSON.stringify(parsed);
    }

    // Executor headers are built by the gateway and never carry client headers,
    // so the conversation identity arrives as sessionKey (src/gateway/session.js).
    const session = translateOpencodeSession(sessionKey || "default", "desktop");

    const opencodeHeaders = {
      ...headers,
      Authorization: "Bearer public",
      "User-Agent": OPENCODE_UA,
      "x-opencode-client": "desktop",
      "x-opencode-session": session,
      "x-opencode-request": opencodeRequestId(),
      "x-opencode-project": "global",
      Accept: "text/event-stream",
    };

    const res = await super.execute({
      url: finalUrl,
      method,
      headers: opencodeHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });
    return restoreResponsesToolNames(res, toolNameMap);
  }
}

export const opencodeExecutorInstance = new OpencodeExecutor();
registerExecutor("opencode", opencodeExecutorInstance);
