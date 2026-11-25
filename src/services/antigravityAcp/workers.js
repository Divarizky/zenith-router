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
  if (Object.keys(entry).some((key) => !["workerId", "namespace", "launcher", "workspace"].includes(key))) throw new Error("unsupported worker config field");
  if (typeof entry.workerId !== "string" || !ID_PATTERN.test(entry.workerId)) throw new Error("invalid worker id");
  if (typeof entry.namespace !== "string" || !ID_PATTERN.test(entry.namespace)) throw new Error("invalid worker namespace");
  for (const key of ["launcher", "workspace"]) {
    if (typeof entry[key] !== "string" || !path.isAbsolute(entry[key]) || entry[key].includes("\0")) throw new Error("worker paths must be absolute");
  }
  const [launcherReal, workspaceReal] = await Promise.all([realpath(entry.launcher), realpath(entry.workspace)]);
  // Stat the resolved paths: a symlink's own mode says nothing about the file Zenith will execute.
  const [launcherStat, workspaceStat] = await Promise.all([stat(launcherReal), stat(workspaceReal)]);
  if (process.platform !== "win32" && ((launcherStat.mode & 0o022) !== 0 || (workspaceStat.mode & 0o022) !== 0)) throw new Error("worker launcher/workspace must not be group/other writable");
  if (!launcherStat.isFile() || (process.platform !== "win32" && !(launcherStat.mode & 0o111)) || !workspaceStat.isDirectory()) throw new Error("worker launcher/workspace type invalid");
  return Object.freeze({
    workerId: entry.workerId,
    namespace: entry.namespace,
    launcher: launcherReal,
    workspace: workspaceReal,
  });
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
    const workspaces = new Set();
    for (const worker of workers) {
      const workerKey = worker.workerId.toLocaleLowerCase("en-US");
      const namespaceKey = worker.namespace.toLocaleLowerCase("en-US");
      if (workerIds.has(workerKey) || namespaces.has(namespaceKey) || launchers.has(worker.launcher) || workspaces.has(worker.workspace)) throw new Error("duplicate worker mapping");
      workerIds.add(workerKey);
      namespaces.add(namespaceKey);
      launchers.add(worker.launcher);
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
