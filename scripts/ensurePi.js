#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Connects the bundled Pi extension (extensions/pi) to Pi when Pi is installed.
 * Never throws and never blocks npm install: without a TTY it only prints a hint.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PI_EXTENSION_DIR = path.join(ROOT, "extensions", "pi");
export const PI_INSTALL_CMD = "npm install -g --ignore-scripts @earendil-works/pi-coding-agent";

function run(cmd, args, timeout = 60000) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true, shell: process.platform === "win32" });
}

/** Pi is "installed" when its binary answers `--version`. */
export function detectPi({ runFn = run } = {}) {
  const res = runFn("pi", ["--version"], 15000);
  return res.status === 0;
}

/** True when `pi list` already mentions this extension directory. */
export function isExtensionRegistered({ runFn = run, extensionDir = PI_EXTENSION_DIR } = {}) {
  const res = runFn("pi", ["list"], 15000);
  if (res.status !== 0 || typeof res.stdout !== "string") return false;
  return res.stdout.includes(extensionDir);
}

export function installExtension({ runFn = run, extensionDir = PI_EXTENSION_DIR, logFn = console.log, warnFn = console.warn } = {}) {
  if (!existsSync(path.join(extensionDir, "index.ts"))) {
    warnFn(`[zenith] Extension Pi tidak ditemukan di ${extensionDir}; dilewati.`);
    return { ok: false, error: "extension_missing" };
  }
  const res = runFn("pi", ["install", extensionDir], 120000);
  if (res.status === 0) {
    logFn("[zenith] Extension Pi 'zenith-router' terpasang. Jalankan `pi` lalu pilih provider zenith-router.");
    return { ok: true, installed: true };
  }
  warnFn(`[zenith] Gagal memasang extension Pi: ${(res.stderr || res.error?.message || "").trim()}`);
  warnFn(`[zenith] Coba manual: pi install ${extensionDir}`);
  return { ok: false, error: "install_failed" };
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Entry point used by postinstall. Returns a status object for tests and logs.
 * `interactive` decides whether the user is asked; otherwise a hint is printed.
 */
export async function ensurePi({
  runFn = run,
  extensionDir = PI_EXTENSION_DIR,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  askFn = askYesNo,
  logFn = console.log,
  warnFn = console.warn,
} = {}) {
  if (!detectPi({ runFn })) {
    logFn("[zenith] Pi (coding agent) belum terpasang.");
    if (interactive && (await askFn("[zenith] Pasang Pi sekarang?"))) {
      const res = runFn("sh", ["-c", PI_INSTALL_CMD], 300000);
      if (res.status !== 0 || !detectPi({ runFn })) {
        warnFn("[zenith] Pemasangan Pi gagal. Lewati, atau pasang manual.");
        return { ok: false, error: "pi_install_failed" };
      }
      logFn("[zenith] Pi terpasang.");
    } else {
      logFn(`[zenith] Jika ingin memakai Zenith di Pi, pasang dengan: ${PI_INSTALL_CMD}`);
      logFn(`[zenith] Lalu jalankan: pi install ${extensionDir}`);
      return { ok: true, pi: false, extension: false };
    }
  }

  if (isExtensionRegistered({ runFn, extensionDir })) {
    logFn("[zenith] Extension Pi 'zenith-router' sudah terpasang.");
    return { ok: true, pi: true, extension: true, installed: false };
  }

  if (interactive && !(await askFn("[zenith] Pasang extension 'zenith-router' ke Pi sekarang?"))) {
    logFn(`[zenith] Dilewati. Pasang nanti dengan: pi install ${extensionDir}`);
    return { ok: true, pi: true, extension: false };
  }
  const result = installExtension({ runFn, extensionDir, logFn, warnFn });
  return { ok: result.ok, pi: true, extension: result.ok, installed: result.installed === true };
}

const isDirectEntry = typeof process !== "undefined" && process.argv?.[1] && process.argv[1].endsWith("ensurePi.js");
if (isDirectEntry) {
  ensurePi().catch(() => {
    // Never fail npm install
  });
}
