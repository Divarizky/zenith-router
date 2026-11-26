import { lstat, stat, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONFIG = path.join(os.homedir(), ".config", "zenith-router", "antigravity-acp-workers.json");
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_CONFIG_BYTES = 32 * 1024;
let configPath = DEFAULT_CONFIG;
let loaderOverride = null;

/** Test hook; runtime callers must never derive worker launch data from requests. */
export function setAntigravityAcpWorkerLoaderForTests(loader) {
  loaderOverride = typeof loader === "function" ? loader : null;
}

export function setAntigravityAcpWorkerConfigPathForTests(filePath) {
  configPath = typeof filePath === "string" && path.isAbsolute(filePath) ? filePath : DEFAULT_CONFIG;
}

async function canonicalWorker(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid worker entry");
  if (Object.keys(entry).some((key) => !["workerId", "namespace", "launcher", "loginLauncher", "workspace"].includes(key))) throw new Error("unsupported worker config field");
  if (typeof entry.workerId !== "string" || !ID_PATTERN.test(entry.workerId)) throw new Error("invalid worker id");
  if (typeof entry.namespace !== "string" || !ID_PATTERN.test(entry.namespace)) throw new Error("invalid worker namespace");
  for (const key of ["launcher", "workspace"]) {
    if (typeof entry[key] !== "string" || !path.isAbsolute(entry[key]) || entry[key].includes("\0")) throw new Error("worker paths must be absolute");
  }
  if (entry.loginLauncher !== undefined && (typeof entry.loginLauncher !== "string" || !path.isAbsolute(entry.loginLauncher) || entry.loginLauncher.includes("\0"))) {
    throw new Error("login launcher path must be absolute");
  }
  const [launcherReal, loginLauncherReal, workspaceReal] = await Promise.all([
    realpath(entry.launcher),
    entry.loginLauncher === undefined ? null : realpath(entry.loginLauncher),
    realpath(entry.workspace),
  ]);
  // Stat the resolved paths: a symlink's own mode says nothing about the file Zenith will execute.
  const [launcherStat, loginLauncherStat, workspaceStat] = await Promise.all([
    stat(launcherReal),
    loginLauncherReal ? stat(loginLauncherReal) : null,
    stat(workspaceReal),
  ]);
  const launchers = [launcherStat, loginLauncherStat].filter(Boolean);
  if (process.platform !== "win32" && (launchers.some((entryStat) => (entryStat.mode & 0o022) !== 0) || (workspaceStat.mode & 0o022) !== 0)) {
    throw new Error("worker launcher/workspace must not be group/other writable");
  }
  if (launchers.some((entryStat) => !entryStat.isFile() || (process.platform !== "win32" && !(entryStat.mode & 0o111))) || !workspaceStat.isDirectory()) {
    throw new Error("worker launcher/workspace type invalid");
  }
  const worker = {
    workerId: entry.workerId,
    namespace: entry.namespace,
    launcher: launcherReal,
    workspace: workspaceReal,
  };
  // Keep the field absent for legacy worker maps so existing callers and configs remain stable.
  if (loginLauncherReal) worker.loginLauncher = loginLauncherReal;
  return Object.freeze(worker);
}

async function loadWorkers() {
  if (loaderOverride) return loaderOverride();
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) throw new Error("worker config invalid");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (!Array.isArray(parsed) || parsed.length > 2) throw new Error("worker config invalid");
    const workers = await Promise.all(parsed.map(canonicalWorker));
    const workerIds = new Set();
    const namespaces = new Set();
    const launchers = new Set();
    const loginLaunchers = new Set();
    const workspaces = new Set();
    for (const worker of workers) {
      const workerKey = worker.workerId.toLocaleLowerCase("en-US");
      const namespaceKey = worker.namespace.toLocaleLowerCase("en-US");
      if (workerIds.has(workerKey) || namespaces.has(namespaceKey) || workspaces.has(worker.workspace) || launchers.has(worker.launcher) || (worker.loginLauncher && (launchers.has(worker.loginLauncher) || loginLaunchers.has(worker.loginLauncher)))) throw new Error("duplicate worker mapping");
      workerIds.add(workerKey);
      namespaces.add(namespaceKey);
      launchers.add(worker.launcher);
      if (worker.loginLauncher) {
        launchers.add(worker.loginLauncher);
        loginLaunchers.add(worker.loginLauncher);
      }
      workspaces.add(worker.workspace);
    }
    return workers;
  } catch {
    return [];
  }
}

export async function getAntigravityAcpWorkers() {
  const workers = await loadWorkers();
  return workers.map((worker) => ({ ...worker }));
}

export async function getAntigravityAcpWorker(workerId) {
  if (typeof workerId !== "string") return null;
  const workers = await loadWorkers();
  return workers.find((worker) => worker.workerId === workerId) || null;
}
