import { EventEmitter } from "node:events";

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"];
const MAX_LOG_LINES = 250;
const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

if (!global._zenithLogBufferState) {
  global._zenithLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
    pendingLines: [],
    flushTimer: null,
  };
  global._zenithLogBufferState.emitter.setMaxListeners(100);
}

const state = global._zenithLogBufferState;

function stripAnsi(str) {
  return typeof str === "string" ? str.replace(ANSI_RE, "") : String(str);
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function flushPendingLines() {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;
  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit("lines", lines);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  state.flushTimer?.unref?.();
}

// Device-local wall clock (toISOString is UTC, which shows the wrong hour on the dashboard).
function localTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function appendLine(level, args) {
  const timestamp = localTimestamp();
  const tag = level.toUpperCase();
  const text = args.map(formatArg).join(" ");
  const line = `[${timestamp}] [${tag}] ${text}`;

  state.logs.push(line);
  if (state.logs.length > MAX_LOG_LINES) {
    state.logs = state.logs.slice(-MAX_LOG_LINES);
  }

  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

let capturing = false;

export function initConsoleLogCapture() {
  if (state.patched) return;

  for (const level of CONSOLE_LEVELS) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      if (!capturing) {
        capturing = true;
        try {
          appendLine(level, args);
        } catch {} finally {
          capturing = false;
        }
      }
      state.originals[level]?.apply(console, args);
    };
  }

  state.patched = true;
}

/**
 * Log only to the dashboard console Logs panel. Keeps the terminal clean for
 * background work the user did not run by hand (quota sync, scheduler ticks).
 */
export function logQuiet(text, level = "log") {
  captureLine(text, level);
}

export function captureLine(text, level = "log") {
  try {
    appendLine(level, [String(text)]);
  } catch {}
}

export function getConsoleLogs() {
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.pendingLines = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}

/**
 * Parse raw console log string or structured object into a normalized log entry.
 * Accurately parses timestamp [HH:MM:SS], level/tag ([LOG], [INFO], [ROUTE], [USAGE], [ERROR], etc.),
 * and message text. Promotes gateway activity sub-tags ([ROUTE], [USAGE], [COMBO], [FALLBACK], etc.)
 * from generic [LOG]/[INFO] lines into distinct log levels.
 */
export function parseConsoleLogLine(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") {
    let tsObj = raw.timestamp || "";
    if (typeof tsObj === "string" && tsObj.includes("T")) {
      tsObj = tsObj.split("T")[1]?.replace("Z", "") || tsObj;
    }
    return {
      timestamp: tsObj || localTimestamp(),
      level: String(raw.level || "LOG").toUpperCase(),
      message: String(raw.message || ""),
      requestId: raw.requestId ? String(raw.requestId) : "",
      model: raw.model ? String(raw.model) : "",
    };
  }

  const str = String(raw).trim();
  if (!str) return null;

  let ts = "";
  let level = "LOG";
  let msg = str;

  // 1. Ekstrak timestamp [HH:MM:SS] atau [HH:MM]
  const tsMatch = msg.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/);
  if (tsMatch) {
    ts = tsMatch[1];
    msg = msg.slice(tsMatch[0].length);
  } else {
    ts = localTimestamp();
  }

  // 2. Ekstrak tag utama [TAG]
  const tagMatch = msg.match(/^\[([A-Za-z0-9_-]+)\]\s*/);
  if (tagMatch) {
    level = tagMatch[1].toUpperCase();
    msg = msg.slice(tagMatch[0].length);

    // 3. Jika tag utama adalah generic (LOG atau INFO), periksa apakah ada sub-tag aktivitas gateway
    // huruf kapital seperti [ROUTE], [USAGE], [COMBO], [FALLBACK], [ERROR], [WARN], [TRAFFIC], dll.
    if (level === "LOG" || level === "INFO") {
      const subTagMatch = msg.match(/^\[([A-Z0-9_-]+)\]\s*/);
      if (subTagMatch) {
        level = subTagMatch[1].toUpperCase();
        msg = msg.slice(subTagMatch[0].length);
      }
    }
  }

  return {
    timestamp: ts,
    level,
    message: msg,
    requestId: "",
    model: "",
  };
}

