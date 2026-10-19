/**
 * Upstream answers the same `403 FreeTierError` whether it refused the shape of
 * the request or blocked this egress, and retrying into a block extends it.
 * Measured anchors the gate checks: a tool named `read`, an `opencode/*`
 * User-Agent, and a session header — plus a streamed body.
 *
 * This module reproduces what a router needs from the bridge's handling: audit
 * what was actually sent, hold local traffic back for a cooldown once the gate
 * refuses twice, and label the rejection so a blocked egress can be told apart
 * from a shape this router got wrong.
 */
import { captureLine } from "./logger.js";

export const OPENCODE_GATE_DEFAULT_COOLDOWN_MS = 30000;
export const OPENCODE_GATE_DEFAULT_STATUS = 429;
export const OPENCODE_GATE_MAX_COOLDOWN_MS = 600000;

const GATE_ERROR_TYPES = new Set(["FreeTierError", "UpgradeRequired"]);
const GATE_MESSAGE_RE = /freetiererror|free tier|detect abuse traffic|upgrade required/i;
const SESSION_HEADERS = ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"];

const gateState = new Map();
// Consecutive refusals per egress. Outlives the cooldown itself so a block that
// returns right after it expires is met with a longer wait, not the same one.
const strikeState = new Map();

// Wording of the egress-level block. A request refused like this was not
// misshaped, so a second identical request can only extend the block.
const NETWORK_BLOCK_RE = /abusive traffic|ip address|current network|detect abuse/i;

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorTypeOf(text) {
  const json = safeJson(text);
  if (!json || typeof json !== "object") return "";
  const type = json.type ?? json.error?.type;
  return typeof type === "string" ? type : "";
}

/** 401/403 are the gate's statuses; 426 is its version-floor handshake. */
export function isOpencodeGateStatus(status) {
  return status === 401 || status === 403 || status === 426;
}

export function isOpencodeGateRejection(status, text = "") {
  if (status === 426) return true;
  if (!isOpencodeGateStatus(status)) return false;
  if (GATE_ERROR_TYPES.has(errorTypeOf(text))) return true;
  return GATE_MESSAGE_RE.test(String(text || ""));
}

/**
 * What the request that was actually sent carried. The gate returns the same
 * error for both causes, so this is the only way to tell a blocked egress from
 * a request this router shaped wrongly.
 */
export function auditOpencodeGateShape({ body, headers } = {}) {
  const parsed = typeof body === "string" ? safeJson(body) : body;
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  const names = new Set(tools.map((t) => t?.function?.name || t?.name || "").filter(Boolean));
  const ua = String(headers?.["User-Agent"] || headers?.["user-agent"] || "");
  return {
    hasReadTool: names.has("read"),
    hasShellTool: names.has("shell"),
    userAgentOk: /^opencode\//i.test(ua),
    sessionHeaders: SESSION_HEADERS.filter((h) => Boolean(headers?.[h])),
    streaming: parsed?.stream === true,
  };
}

export function isOpencodeGateShapeOk(shape) {
  return Boolean(shape?.hasReadTool && shape?.userAgentOk && shape?.sessionHeaders?.length && shape?.streaming);
}

export function listMissingOpencodeGateAnchors(shape) {
  const missing = [];
  if (!shape?.hasReadTool) missing.push("tool `read`");
  if (!shape?.userAgentOk) missing.push("an `opencode/*` User-Agent");
  if (!shape?.sessionHeaders?.length) missing.push("a session header");
  if (!shape?.streaming) missing.push("a streamed body");
  return missing;
}

export function opencodeGateCooldownMs() {
  const raw = process.env.ZENITH_OPENCODE_GATE_COOLDOWN_MS;
  const ms = raw === undefined || raw === "" ? OPENCODE_GATE_DEFAULT_COOLDOWN_MS : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : OPENCODE_GATE_DEFAULT_COOLDOWN_MS;
}

/** Status returned while cooling down; 429 keeps clients and fallback sane. */
export function opencodeGateStatus() {
  const raw = process.env.ZENITH_OPENCODE_GATE_STATUS;
  const status = raw === undefined || raw === "" ? OPENCODE_GATE_DEFAULT_STATUS : Number(raw);
  // `new Response` throws outside 200-599, which would crash the request.
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : OPENCODE_GATE_DEFAULT_STATUS;
}

/** The cooldown is per egress: every proxy is its own route to upstream. */
export function opencodeGateKey(proxyUrl) {
  return proxyUrl ? String(proxyUrl) : "direct";
}

/** The refusal says the network, not the request, is the problem. */
export function isOpencodeNetworkBlock(text = "") {
  return NETWORK_BLOCK_RE.test(String(text || ""));
}

/** Base cooldown doubled per consecutive refusal, capped at ten minutes. */
export function escalateOpencodeCooldown(baseMs, strikes) {
  if (baseMs <= 0) return 0;
  return Math.min(baseMs * 2 ** Math.max(0, strikes - 1), Math.max(baseMs, OPENCODE_GATE_MAX_COOLDOWN_MS));
}

export function getOpencodeGateState(key, now = Date.now()) {
  const state = gateState.get(key);
  if (!state) return null;
  if (state.until <= now) {
    gateState.delete(key);
    return null;
  }
  return { ...state, retryAfterMs: state.until - now };
}

export function getOpencodeGateDiagnostic(key) {
  const state = gateState.get(key);
  return state ? { ...state } : null;
}

/**
 * Record a rejection that survived the identity retry: requests to this egress
 * are held back until the cooldown expires instead of being forwarded.
 */
export function noteOpencodeGateRejection(key, { status, shape, shapeOk, logId = null, missing = [] } = {}, now = Date.now()) {
  const baseMs = opencodeGateCooldownMs();
  const previous = strikeState.get(key);
  // A strike older than two max cooldowns means the block had lifted.
  const strikes = previous && now - previous.at <= OPENCODE_GATE_MAX_COOLDOWN_MS * 2 ? previous.count + 1 : 1;
  strikeState.set(key, { count: strikes, at: now });
  const cooldownMs = escalateOpencodeCooldown(baseMs, strikes);
  const isVersionFloor = status === 426;
  const state = {
    until: now + cooldownMs,
    at: now,
    status,
    strikes,
    shapeOk: Boolean(shapeOk),
    gate: isVersionFloor ? "version-rejected" : shapeOk ? "ip-throttled" : "shape-rejected",
    reason: isVersionFloor
      ? "upstream demands a newer OpenCode client version (HTTP 426); the emulated User-Agent is below its floor"
      : shapeOk
        ? "upstream refused this egress; the free-tier allowance for this route is spent or the network is blocked"
        : `the request this router sent was refused — missing ${missing.join(", ")}`,
    missing,
    shape: shape || null,
    logId,
  };
  gateState.set(key, state);
  captureLine(
    `[OPENCODE] Gate cooldown ${Math.round(cooldownMs / 1000)}s on ${key} (${state.gate}, strike ${strikes}, HTTP ${status}): ${state.reason}` +
      (logId ? ` [x-opencode-log-id: ${logId}]` : "")
  );
  return { ...state, retryAfterMs: cooldownMs };
}

/** A request that got through clears the cooldown early. */
export function noteOpencodeGateSuccess(key) {
  strikeState.delete(key);
  if (gateState.delete(key)) captureLine(`[OPENCODE] Gate cooldown cleared on ${key}`);
}

export function resetOpencodeGate() {
  gateState.clear();
  strikeState.clear();
}

/**
 * Local answer while cooling down. Keeping the upstream status would look like
 * a fresh refusal and invite the same retry, so the status defaults to 429 with
 * `Retry-After` and the same `X-OpenCode-Gate` label the bridge publishes.
 */
export function buildOpencodeGateResponse(state) {
  const retryAfterSec = Math.max(1, Math.ceil((state?.retryAfterMs ?? opencodeGateCooldownMs()) / 1000));
  const headers = {
    "Content-Type": "application/json",
    "Retry-After": String(retryAfterSec),
    "X-OpenCode-Gate": state?.gate || "ip-throttled",
  };
  if (state?.logId) headers["X-OpenCode-Log-Id"] = state.logId;

  const body = {
    error: {
      message:
        `OpenCode free tier is refusing this route: ${state?.reason || "previous request was refused"}. ` +
        `Retry in ${retryAfterSec}s or route this model to another provider.`,
      type: "rate_limit_error",
      code: "opencode_gate_throttled",
    },
  };
  return new Response(JSON.stringify(body), { status: opencodeGateStatus(), headers });
}

/** Attach the gate labels to an upstream refusal without changing its status. */
export function withOpencodeGateHeaders(res, state) {
  const retryAfterSec = Math.max(1, Math.ceil((state?.retryAfterMs ?? opencodeGateCooldownMs()) / 1000));
  const headers = new Headers(res.headers);
  headers.set("Retry-After", String(retryAfterSec));
  headers.set("X-OpenCode-Gate", state?.gate || "ip-throttled");
  if (state?.logId) headers.set("X-OpenCode-Log-Id", state.logId);
  return headers;
}
