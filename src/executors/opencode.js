import { BaseExecutor, registerExecutor } from "./base.js";
import { randomBytes } from "node:crypto";
import { prepareResponsesBody, restoreResponsesToolNames, MAX_OUTPUT_TOKENS as MAX_RESPONSES_OUTPUT_TOKENS } from "./opencodeResponses.js";
import { effectiveMaxTokens, MAX_OUTPUT_TOKENS } from "../utils/tokenBudget.js";
import { openaiToResponsesRequest, responsesToOpenAIRequest } from "../translator/responses.js";

export const OPENCODE_UA = "opencode/latest/2.1.2/cli";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const MAX_COUNTER_PER_MS = 16;

function randBase62(n) {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += BASE62[bytes[i] % 62];
  return out;
}

let lastSessionTimestamp = 0;
let sessionCounter = 0;

export function createOpencodeId(type = "ses", timestamp = Date.now()) {
  const descending = type === "ses";
  if (timestamp !== lastSessionTimestamp) {
    lastSessionTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;

  const counter = sessionCounter;
  const extraMs = Math.floor((counter - 1) / MAX_COUNTER_PER_MS);
  const effectiveCounter = ((counter - 1) % MAX_COUNTER_PER_MS) + 1;
  const current = BigInt(timestamp + extraMs) * 0x1000n + BigInt(effectiveCounter);
  const value = (descending ? ~current : current) & SESSION_PREFIX_MASK;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `${type}_${time}${randBase62(14)}`;
}

export function opencodeSessionId(timestamp = Date.now()) {
  return createOpencodeId("ses", timestamp);
}

export function opencodeRequestId(timestamp = Date.now()) {
  return createOpencodeId("msg", timestamp);
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

const dynamicProtocolLanes = new Map();
export const PROTOCOL_LANE_TTL_MS = 3600000; // 1 jam — lane upstream bisa dikembalikan, jangan dikunci selamanya

export function setOpencodeProtocolLane(model, lane) {
  if (model) dynamicProtocolLanes.set(model, { lane, at: Date.now() });
}

export function getOpencodeProtocolLane(model, opts = {}) {
  if (!model) return null;
  const entry = dynamicProtocolLanes.get(model);
  if (!entry) return null;
  const now = opts?.now ?? Date.now();
  const ttl = opts?.ttlMs ?? PROTOCOL_LANE_TTL_MS;
  if (now - entry.at >= ttl) {
    dynamicProtocolLanes.delete(model);
    return null;
  }
  return entry.lane;
}

export function resetOpencodeProtocolLanes() {
  dynamicProtocolLanes.clear();
}

export function opencodePathForModel(model) {
  const dynamic = getOpencodeProtocolLane(model);
  if (dynamic === "responses") return "/inference/v1/responses";
  if (dynamic === "chat") return "/inference/v1/chat/completions";
  if (RESPONSES_MODELS.has(model)) return "/inference/v1/responses";
  if (MESSAGES_MODELS.has(model)) return "/inference/v1/messages";
  return "/inference/v1/chat/completions";
}

export const FINGERPRINT_TOOL_NAMES = ["read", "shell"];

export const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

function stableStringify(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

const FINGERPRINT_PARAM_STRINGS = {
  read: stableStringify(FINGERPRINT_TOOL_DEFINITIONS.read.parameters),
  shell: stableStringify(FINGERPRINT_TOOL_DEFINITIONS.shell.parameters),
};

function getToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name.trim();
  if (tool.function && typeof tool.function.name === "string") return tool.function.name.trim();
  return "";
}

function isExactFingerprintDef(tool, key) {
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  if (!want || !tool || typeof tool !== "object") return false;
  const def = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return (
    def.description === want.description &&
    stableStringify(def.parameters || def.input_schema) === FINGERPRINT_PARAM_STRINGS[key]
  );
}

function shapeFingerprintTool(name, path) {
  const def = FINGERPRINT_TOOL_DEFINITIONS[name];
  if (path.endsWith("/responses")) {
    return { type: "function", name, description: def.description, parameters: def.parameters, strict: false };
  }
  if (path.endsWith("/messages")) {
    return { name, description: def.description, input_schema: def.parameters };
  }
  return { type: "function", function: { name, description: def.description, parameters: def.parameters } };
}

function buildPlaceholderNote(appendedNames) {
  if (!Array.isArray(appendedNames) || appendedNames.length === 0) return "";
  const list = appendedNames.map((n) => `\`${n}\``).join(" or ");
  return appendedNames.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

export function prepareToolsWithFingerprint(body, path = "/inference/v1/chat/completions") {
  if (!body || typeof body !== "object") return null;

  // Upstream v2 rejects tool_choice: "none" with 403 FreeTierError
  if (body.tool_choice === "none") {
    delete body.tool_choice;
  }

  const clientTools = Array.isArray(body.tools) ? body.tools : [];
  const aliasToOriginal = new Map();
  const originalToAlias = new Map();
  const normalized = [];
  const takenNames = new Set(clientTools.map(getToolName).filter(Boolean));
  const presentExactFingerprints = new Set();

  for (const t of clientTools) {
    const name = getToolName(t);
    if (!name) continue;
    const def = t.function && typeof t.function === "object" ? t.function : t;
    const description = def.description || "";
    const parameters = def.parameters || def.input_schema || { type: "object", properties: {} };

    if (FINGERPRINT_TOOL_NAMES.includes(name)) {
      if (presentExactFingerprints.has(name)) continue;
      if (isExactFingerprintDef(t, name)) {
        presentExactFingerprints.add(name);
        normalized.push(shapeFingerprintTool(name, path));
        continue;
      }
      // Custom client tool collides with canonical name: alias it
      if (originalToAlias.has(name)) continue;
      let alias = `${name}_client`;
      for (let i = 2; takenNames.has(alias); i++) alias = `${name}_client${i}`;
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);

      if (path.endsWith("/responses")) {
        normalized.push({ type: "function", name: alias, description, parameters, strict: false });
      } else if (path.endsWith("/messages")) {
        normalized.push({ name: alias, description, input_schema: parameters });
      } else {
        normalized.push({ type: "function", function: { name: alias, description, parameters } });
      }
      continue;
    }

    // Client tool is not a fingerprint collision
    if (path.endsWith("/responses")) {
      normalized.push({ type: "function", name, description, parameters, strict: false });
    } else if (path.endsWith("/messages")) {
      normalized.push({ name, description, input_schema: parameters });
    } else {
      normalized.push({ type: "function", function: { name, description, parameters } });
    }
  }

  const appended = [];
  for (const name of FINGERPRINT_TOOL_NAMES) {
    if (!presentExactFingerprints.has(name)) {
      normalized.push(shapeFingerprintTool(name, path));
      appended.push(name);
    }
  }

  body.tools = normalized;

  // If fingerprint tools were injected, add a placeholder note
  if (appended.length > 0) {
    const note = buildPlaceholderNote(appended);
    if (path.endsWith("/responses")) {
      if (body.instructions) body.instructions += `\n\n${note}`;
      else body.instructions = note;
    } else if (path.endsWith("/messages")) {
      // Claude-style bodies carry the system prompt in a top-level field; a
      // system role inside `messages` is rejected by Anthropic-shaped APIs.
      if (typeof body.system === "string" && body.system.trim()) {
        body.system += `\n\n[System Note: ${note}]`;
      } else if (Array.isArray(body.system)) {
        body.system.push({ type: "text", text: `[System Note: ${note}]` });
      } else {
        const sysMsg = Array.isArray(body.messages)
          ? [...body.messages].reverse().find((m) => (m.role === "system" || m.role === "developer") && typeof m.content === "string")
          : null;
        if (sysMsg) sysMsg.content += `\n\n[System Note: ${note}]`;
        else body.system = `[System Note: ${note}]`;
      }
    } else if (Array.isArray(body.messages)) {
      let injected = false;
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i];
        if (msg.role === "system" || msg.role === "developer") {
          if (typeof msg.content === "string") {
            msg.content += `\n\n[System Note: ${note}]`;
            injected = true;
            break;
          }
        }
      }
      if (!injected) {
        body.messages.unshift({ role: "system", content: `[System Note: ${note}]` });
      }
    }
  }

  // Rewrite any references in messages / input / tool_choice to aliased names
  if (originalToAlias.size > 0) {
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc.function && originalToAlias.has(tc.function.name)) {
              tc.function.name = originalToAlias.get(tc.function.name);
            }
          }
        }
        if (msg.role === "tool" && originalToAlias.has(msg.name)) {
          msg.name = originalToAlias.get(msg.name);
        }
      }
    }
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (item?.type === "function_call" && originalToAlias.has(item.name)) {
          item.name = originalToAlias.get(item.name);
        }
      }
    }
    if (body.tool_choice && typeof body.tool_choice === "object") {
      if (typeof body.tool_choice.name === "string" && originalToAlias.has(body.tool_choice.name)) {
        body.tool_choice.name = originalToAlias.get(body.tool_choice.name);
      }
      if (body.tool_choice.function && typeof body.tool_choice.function.name === "string" && originalToAlias.has(body.tool_choice.function.name)) {
        body.tool_choice.function.name = originalToAlias.get(body.tool_choice.function.name);
      }
    }
  }

  return aliasToOriginal;
}

export class OpencodeExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel, targetFormat, sessionKey = null }) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {}

    const model = targetModel || parsed?.model || "";
    let path = opencodePathForModel(model);
    if (String(targetFormat).includes("responses")) path = "/inference/v1/responses";
    else if (String(targetFormat) === "claude") path = "/inference/v1/messages";
    const finalUrl = `https://opencode.ai${path}`;

    let toolNameMap = null;
    let budgetValue = null; // budget final — dihitung SEKALI, dibawa lintas lane saat retry
    if (parsed && typeof parsed === "object") {
      const aliasMap = prepareToolsWithFingerprint(parsed, path);
      parsed.stream = true;

      const clientTokens = parsed.max_tokens ?? parsed.max_completion_tokens ?? parsed.max_output_tokens;
      // Default injection only for the chat/responses lanes; /messages keeps the
      // client's own value (Claude clients always send one) and is never invented.
      if (clientTokens !== undefined || !path.endsWith("/messages")) {
        const laneMax = path.endsWith("/responses") ? MAX_RESPONSES_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;
        budgetValue = effectiveMaxTokens(clientTokens, model, parsed, laneMax);
        applyBudget(parsed, budgetValue, path);
      }

      if (path.endsWith("/responses")) {
        const respMap = prepareResponsesBody(parsed);
        toolNameMap = new Map();
        if (aliasMap) for (const [k, v] of aliasMap) toolNameMap.set(k, v);
        if (respMap) for (const [k, v] of respMap) toolNameMap.set(k, v);
      } else {
        toolNameMap = aliasMap;
      }
      body = JSON.stringify(parsed);
    }

    // Executor headers are built by the gateway and never carry client headers,
    // so the conversation identity arrives as sessionKey (src/gateway/session.js).
    const session = translateOpencodeSession(sessionKey || "default", "desktop");

    const opencodeHeaders = {
      ...headers,
      Authorization: "Bearer public",
      "User-Agent": OPENCODE_UA,
      "x-opencode-client": "cli",
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": "global",
      Accept: "text/event-stream",
    };

    let res = await super.execute({
      url: finalUrl,
      method,
      headers: opencodeHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });

    if (res.status === 400 && model) {
      try {
        const cloned = res.clone();
        const errText = await cloned.text();
        let errJson;
        try {
          errJson = JSON.parse(errText);
        } catch {
          errJson = { message: errText };
        }
        const errType = errJson?.error?.type || "";
        const errMsg = errJson?.error?.message || errJson?.message || "";
        const isUnsupported =
          errType === "ModelProtocolUnsupported" ||
          errMsg.includes("ModelProtocolUnsupported") ||
          errMsg.includes("does not support this protocol");

        if (isUnsupported) {
          // Self-healing only covers the chat <-> responses lanes. A /messages
          // body is Claude-shaped and has no lane twin here.
          if (path.endsWith("/messages")) {
            return restoreResponsesToolNames(res, toolNameMap);
          }

          const wasResponses = path.endsWith("/responses");
          const alternateLane = wasResponses ? "chat" : "responses";
          path = alternateLane === "responses" ? "/inference/v1/responses" : "/inference/v1/chat/completions";
          const retryUrl = `https://opencode.ai${path}`;

          let retryParsed = null;
          try {
            retryParsed = JSON.parse(body);
          } catch {}

          if (retryParsed && typeof retryParsed === "object") {
            // Rebuild the payload in the target lane's shape; flipping the URL
            // alone would send `input` to /chat/completions or `messages` to
            // /responses and fail with an unrelated 400.
            retryParsed = wasResponses
              ? responsesToOpenAIRequest(retryParsed)
              : openaiToResponsesRequest(retryParsed, model);

            const aliasMap = prepareToolsWithFingerprint(retryParsed, path);
            retryParsed.stream = true;

            // Carry the final budget across lanes WITHOUT recomputation —
            // re-running effectiveMaxTokens would add THINKING_BUDGET again.
            if (budgetValue !== null) {
              const retryBudget = path.endsWith("/responses")
                ? Math.min(budgetValue, MAX_RESPONSES_OUTPUT_TOKENS)
                : Math.min(budgetValue, MAX_OUTPUT_TOKENS);
              if (path.endsWith("/responses")) {
                delete retryParsed.max_tokens;
                delete retryParsed.max_completion_tokens;
                retryParsed.max_output_tokens = retryBudget;
              } else {
                delete retryParsed.max_output_tokens;
                retryParsed.max_tokens = retryBudget;
              }
            }

            if (path.endsWith("/responses")) {
              const respMap = prepareResponsesBody(retryParsed);
              // Merge with the pass-1 map instead of replacing it: the second
              // pass finds no collisions (tools are already aliased), so a
              // replacement would drop the alias restorations.
              if (!toolNameMap) toolNameMap = new Map();
              if (aliasMap) for (const [k, v] of aliasMap) toolNameMap.set(k, v);
              if (respMap) for (const [k, v] of respMap) toolNameMap.set(k, v);
            } else if (aliasMap && toolNameMap) {
              for (const [k, v] of aliasMap) toolNameMap.set(k, v);
            } else if (aliasMap) {
              toolNameMap = aliasMap;
            }
            body = JSON.stringify(retryParsed);
          }

          try {
            const retryRes = await super.execute({
              url: retryUrl,
              method,
              headers: opencodeHeaders,
              body,
              signal,
              timeoutMs,
              proxyUrl,
            });
            if (retryRes && retryRes.ok) {
              setOpencodeProtocolLane(model, alternateLane);
            }
            res = retryRes;
          } catch (retryErr) {
            console.warn(`[opencode] protocol retry to ${path} failed:`, retryErr?.message || retryErr);
          }
        }
      } catch (err) {
        console.warn(`[opencode] protocol retry error for ${model}:`, err?.message || err);
      }
    }

    return restoreResponsesToolNames(res, toolNameMap);
  }
}

export const opencodeExecutorInstance = new OpencodeExecutor();
registerExecutor("opencode", opencodeExecutorInstance);

function applyBudget(body, budget, path = "") {
  let applied = false;
  if (body.max_tokens !== undefined) {
    body.max_tokens = budget;
    applied = true;
  }
  if (body.max_completion_tokens !== undefined) {
    body.max_completion_tokens = budget;
    applied = true;
  }
  if (body.max_output_tokens !== undefined) {
    body.max_output_tokens = budget;
    applied = true;
  }
  if (!applied) {
    if (path.endsWith("/responses")) {
      body.max_output_tokens = budget;
    } else {
      body.max_tokens = budget;
    }
  }
}
