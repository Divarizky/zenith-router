#!/usr/bin/env node
import { execSync } from "node:child_process";
import { findBunBinary } from "../src/services/opencodeBridge.js";

/**
 * Installs Bun cross-platform (Linux, macOS, Windows) softly.
 * Does not throw and does not block if network is offline or installation fails.
 */
export function installBunSoft({
  platform = process.platform,
  execFn = execSync,
  logFn = console.log,
  warnFn = console.warn,
  findFn = findBunBinary,
} = {}) {
  const existing = findFn({ platform });
  if (existing) {
    logFn(`[zenith] Bun runtime is ready at: ${existing}`);
    return { ok: true, path: existing, installed: false };
  }

  logFn("[zenith] Bun runtime not found. Attempting non-blocking installation for OpenCode free-tier bridge...");

  try {
    if (platform === "win32") {
      logFn("[zenith] Running Windows PowerShell Bun installer...");
      execFn('powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"', {
        stdio: "inherit",
        timeout: 60000,
        windowsHide: true,
      });
    } else {
      logFn("[zenith] Running Linux/macOS Bun installer script...");
      execFn("curl -fsSL https://bun.sh/install | bash", {
        stdio: "inherit",
        timeout: 60000,
      });
    }

    const newlyInstalled = findFn({ platform });
    if (newlyInstalled) {
      logFn(`[zenith] Bun successfully installed at: ${newlyInstalled}`);
      return { ok: true, path: newlyInstalled, installed: true };
    }
  } catch (err) {
    warnFn(`[zenith] Bun installation was skipped or encountered an issue: ${err?.message || err}`);
  }

  warnFn(
    "[zenith] Notice: Bun was not installed. All other Zenith providers continue to work normally.\n" +
    "         To enable OpenCode free-tier without TLS rate-limits, you can install Bun manually from https://bun.sh"
  );
  return { ok: false, error: "install_skipped_or_failed" };
}

const isDirectEntry =
  (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].endsWith("ensureBun.js")) ||
  (typeof import.meta !== "undefined" && import.meta.main);

if (isDirectEntry) {
  try {
    installBunSoft();
  } catch {
    // Never fail npm install or process
  }
}
