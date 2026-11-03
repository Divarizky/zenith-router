import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { captureLine } from "./logger.js";
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_URL,
} from "../bridge/opencode-bridge.js";

let managedProcess = null;
let bridgeActive = false;

/**
 * Locate bun binary on system:
 * 1. process.env.BUN_BIN
 * 2. ~/.bun/bin/bun
 * 3. /usr/local/bin/bun, /usr/bin/bun
 */
export function findBunBinary() {
  if (process.env.BUN_BIN && fs.existsSync(process.env.BUN_BIN)) {
    return process.env.BUN_BIN;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      } catch {}
    }
  }
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

  const bridgeScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../bridge/opencode-bridge.js"
  );

  if (!fs.existsSync(bridgeScript)) {
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
    captureLine(`[opencode-bridge] Failed to start bridge: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Ensures the bridge is active before dispatching an OpenCode request.
 */
export async function ensureOpencodeBridge() {
  if (bridgeActive) return true;
  const result = await startOpencodeBridgeService({ silent: false });
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
