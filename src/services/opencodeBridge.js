import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { captureLine } from "./logger.js";
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_URL,
} from "../bridge/opencode-bridge.js";

let managedProcess = null;
let bridgeActive = false;

function checkAccessible(filePath, isWindows, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(filePath)) return false;
    const stat = fsImpl.statSync(filePath);
    if (stat.isDirectory()) return false;
    if (isWindows) {
      fsImpl.accessSync(filePath, fsImpl.constants?.F_OK ?? 0);
    } else {
      fsImpl.accessSync(filePath, fsImpl.constants?.X_OK ?? 1);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate bun binary on system cross-platform (Linux, macOS, Windows):
 * 1. process.env.BUN_BIN
 * 2. Platform-specific known candidate paths (.bun/bin, AppData, /usr/local/bin, /opt/homebrew)
 * 3. PATH lookup via `where.exe bun` (Windows) or `which bun` (Linux/macOS)
 */
export function findBunBinary({
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  execFn = execSync,
} = {}) {
  const isWindows = platform === "win32";
  const pathImpl = isWindows ? path.win32 : path.posix;

  if (env.BUN_BIN && checkAccessible(env.BUN_BIN, isWindows, fsImpl)) {
    return env.BUN_BIN;
  }

  const home = env.USERPROFILE || env.HOME || (typeof os?.homedir === "function" ? os.homedir() : "");
  const candidates = [];

  if (isWindows) {
    if (home) {
      candidates.push(pathImpl.join(home, ".bun", "bin", "bun.exe"));
      candidates.push(pathImpl.join(home, ".bun", "bin", "bun"));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(pathImpl.join(env.LOCALAPPDATA, "bun", "bun.exe"));
      candidates.push(pathImpl.join(env.LOCALAPPDATA, "Programs", "bun", "bun.exe"));
    }
    if (env.ProgramFiles) {
      candidates.push(pathImpl.join(env.ProgramFiles, "bun", "bun.exe"));
    }
  } else {
    if (home) {
      candidates.push(pathImpl.join(home, ".bun", "bin", "bun"));
      candidates.push(pathImpl.join(home, ".local", "bin", "bun"));
    }
    candidates.push("/usr/local/bin/bun");
    candidates.push("/usr/bin/bun");
    candidates.push("/opt/homebrew/bin/bun");
  }

  for (const c of candidates) {
    if (checkAccessible(c, isWindows, fsImpl)) {
      return c;
    }
  }

  // Fallback to system PATH lookup
  try {
    const cmd = isWindows ? "where.exe bun" : "which bun";
    const stdout = execFn(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 1000,
    });
    if (typeof stdout === "string") {
      const firstLine = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      if (firstLine && checkAccessible(firstLine, isWindows, fsImpl)) {
        return firstLine;
      }
    }
  } catch {}

  return null;
}

/**
 * Check if the bridge HTTP endpoint is alive and responsive.
 */
export async function isOpencodeBridgeRunning(baseUrl = DEFAULT_BRIDGE_URL) {
  try {
    const healthUrl = `${String(baseUrl).replace(/\/+$/, "")}/health`;
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(600),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return data?.bridge === "opencode-bun" || res.status === 200;
    }
  } catch {}
  return false;
}

export function isOpencodeBridgeActive() {
  return bridgeActive;
}

export function setOpencodeBridgeActive(active) {
  bridgeActive = Boolean(active);
}

/**
 * Starts the Bun bridge worker in the background if bun is available.
 */
export async function startOpencodeBridgeService({
  port = DEFAULT_BRIDGE_PORT,
  host = DEFAULT_BRIDGE_HOST,
  silent = false,
} = {}) {
  const url = `http://${host}:${port}`;

  if (await isOpencodeBridgeRunning(url)) {
    bridgeActive = true;
    if (!silent) captureLine(`[opencode-bridge] External bridge detected and active on ${url}`);
    return { ok: true, url, external: true };
  }

  const bunBin = findBunBinary();
  if (!bunBin) {
    if (!silent) captureLine("[opencode-bridge] Bun binary not found on system; bridge skipped");
    return { ok: false, error: "bun_not_found" };
  }

  const bridgeScript = fileURLToPath(
    new URL("../bridge/opencode-bridge.js", import.meta.url)
  );

  if (!fs.existsSync(bridgeScript)) {
    if (!silent) captureLine(`[opencode-bridge] Bridge script not found at ${bridgeScript}`);
    return { ok: false, error: "bridge_script_not_found" };
  }

  try {
    const child = spawn(bunBin, ["run", bridgeScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ZENITH_OPENCODE_BRIDGE_PORT: String(port),
        ZENITH_OPENCODE_BRIDGE_HOST: host,
      },
    });

    child.unref();
    managedProcess = child;
    // A worker that dies must not leave `bridgeActive` behind: the flag would
    // keep sending OpenCode requests to a closed port (ECONNREFUSED → 502).
    child.once("exit", () => {
      if (managedProcess === child) managedProcess = null;
      bridgeActive = false;
    });

    // Poll until ready (up to 3.5s)
    const startTime = Date.now();
    while (Date.now() - startTime < 3500) {
      if (await isOpencodeBridgeRunning(url)) {
        bridgeActive = true;
        if (!silent) {
          captureLine(`[opencode-bridge] Started Bun bridge worker (PID ${child.pid}) on ${url}`);
        }
        return { ok: true, url, pid: child.pid };
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    return { ok: false, error: "bridge_startup_timeout" };
  } catch (err) {
    if (!silent) captureLine(`[opencode-bridge] Failed to start bridge: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Ensures the bridge is active before dispatching an OpenCode request.
 *
 * A recorded `bridgeActive` is not proof of life. A worker started outside this
 * process has no exit handler here, so it can disappear while the flag stays
 * set and every OpenCode call then fails with ECONNREFUSED on the bridge port.
 * When no managed child is held, verify with a health ping and respawn.
 */
export async function ensureOpencodeBridge({
  isRunning = isOpencodeBridgeRunning,
  start = startOpencodeBridgeService,
} = {}) {
  if (bridgeActive) {
    if (managedProcess) return true;
    if (await isRunning()) return true;
    bridgeActive = false;
  }
  const result = await start({ silent: false });
  return result.ok;
}

/**
 * Stops any managed bridge child process.
 */
export function stopOpencodeBridgeService() {
  if (managedProcess && managedProcess.pid) {
    try {
      managedProcess.kill("SIGTERM");
    } catch {}
    managedProcess = null;
  }
  bridgeActive = false;
}
