import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_CLOSE_GRACE_MS = 250;
const DEFAULT_KILL_GRACE_MS = 750;

function transportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Isolated stdio JSON-RPC transport for a caller-selected ACP executable. */
export class AntigravityAcpTransport extends EventEmitter {
  constructor({ command, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, closeGraceMs = DEFAULT_CLOSE_GRACE_MS, killGraceMs = DEFAULT_KILL_GRACE_MS, spawnFn = nodeSpawn } = {}) {
    super();
    if (typeof command !== "string" || command.length === 0 || !Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
      throw new TypeError("ACP command and argv must be explicit strings");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || !Number.isFinite(closeGraceMs) || closeGraceMs < 0 || !Number.isFinite(killGraceMs) || killGraceMs <= 0) {
      throw new TypeError("ACP timeout, output limit, and shutdown bounds must be positive");
    }
    this.pending = new Map();
    this.nextId = 1;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.closeGraceMs = closeGraceMs;
    this.killGraceMs = killGraceMs;
    this.childExited = false;
    this.childClosed = false;
    this.closePromise = null;
    this.outputBytes = 0;
    this.buffer = "";
    this.closed = false;
    this.child = spawnFn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.#consume(chunk));
    // Drain but never expose subprocess stderr; an undrained pipe can stall the child.
    this.child.stderr.resume();
    // Writable stream errors such as EPIPE are asynchronous; consume them and
    // reject pending work with a safe transport error instead of crashing host.
    this.child.stdin.on("error", () => this.#finish(transportError("ACP_WRITE_ERROR", "Could not write to ACP subprocess")));
    this.child.on("error", () => this.#finish(transportError("ACP_SPAWN_ERROR", "ACP subprocess failed to start")));
    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      this.#finish(transportError("ACP_EXIT", `ACP subprocess exited (${signal || code})`));
    });
    this.child.on("close", () => { this.childClosed = true; });
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(transportError("ACP_CLOSED", "ACP transport is closed"));
    if (typeof method !== "string" || !method) return Promise.reject(new TypeError("JSON-RPC method is required"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        reject(transportError("ACP_TIMEOUT", `ACP request timed out: ${method}`));
        if (pending?.method === "session/prompt" && typeof pending.params?.sessionId === "string") {
          this.cancel(pending.params.sessionId);
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method, params });
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(transportError("ACP_WRITE_ERROR", "Could not write ACP request"));
      }
    });
  }

  async initialize(params = {}) {
    return this.request("initialize", params);
  }

  async prompt(params = {}) {
    return this.request("session/prompt", params);
  }

  cancel(sessionId) {
    if (this.closed || typeof sessionId !== "string" || !sessionId) return false;
    return this.#write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (!this.closed) this.#finish(transportError("ACP_CLOSED", "ACP transport closed"));
    this.closePromise = (async () => {
      if (this.childExited || this.childClosed) return true;
      this.#killChild("SIGTERM");
      if (await this.#waitForExit(this.closeGraceMs)) return true;
      this.#killChild("SIGKILL");
      const exited = await this.#waitForExit(this.killGraceMs);
      if (!exited) this.emit("cleanupError", transportError("ACP_CLEANUP_ERROR", "ACP subprocess did not exit after termination"));
      return exited;
    })();
    return this.closePromise;
  }

  #killChild(signal) {
    try { this.child.kill(signal); } catch {}
  }

  #waitForExit(timeoutMs) {
    if (this.childExited || this.childClosed) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.off("exit", onExit);
        this.child.off("close", onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(this.childExited || this.childClosed), timeoutMs);
      this.child.once("exit", onExit);
      this.child.once("close", onExit);
    });
  }

  #write(message) {
    if (this.closed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      // Writable.write() returning false signals backpressure, not failure: the
      // message was accepted into the stream buffer and must not be retried.
      return true;
    } catch { return false; }
  }

  #consume(chunk) {
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > this.maxOutputBytes) {
      this.#finish(transportError("ACP_OUTPUT_LIMIT", "ACP subprocess output limit exceeded"));
      this.child.kill();
      return;
    }
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.#finish(transportError("ACP_PROTOCOL_ERROR", "ACP subprocess emitted invalid JSON-RPC"));
        this.child.kill();
        return;
      }
      if (!message || message.jsonrpc !== "2.0") {
        this.#finish(transportError("ACP_PROTOCOL_ERROR", "ACP subprocess emitted invalid JSON-RPC"));
        this.child.kill();
        return;
      }
      if (message.method === "session/request_permission" && Object.hasOwn(message, "id")) {
        this.#write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      } else if (Object.hasOwn(message, "method")) {
        if (Object.hasOwn(message, "id")) {
          this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        } else {
          this.emit("notification", message);
        }
      } else if (Object.hasOwn(message, "id")) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const authRequired = message.error.code === -32000 && ["initialize", "session/new"].includes(pending.method);
          pending.reject(transportError(authRequired ? -32000 : "ACP_REMOTE_ERROR", authRequired ? "ACP authentication is required" : "ACP subprocess returned an error"));
        }
        else if (!Object.hasOwn(message, "result")) pending.reject(transportError("ACP_PROTOCOL_ERROR", "ACP response missing result"));
        else pending.resolve(message.result);
      }
    }
  }

  #finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("close", error);
  }
}

export function createAntigravityAcpTransport(options) {
  return new AntigravityAcpTransport(options);
}
