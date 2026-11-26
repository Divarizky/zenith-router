import { lstat, stat, realpath, readFile, mkdir, chmod, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { getAccounts, isValidAccountId, workerIdForAccount, accountIdFromWorkerId } from "./accounts.js";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONFIG = path.join(os.homedir(), ".config", "zenith-router", "antigravity-acp-workers.json");
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_CONFIG_BYTES = 32 * 1024;
let configPath = DEFAULT_CONFIG;
let loaderOverride = null;
let discoveryPathsOverride = null;
let provisionRootOverride = null;

/** Test hook; runtime callers must never derive worker launch data from requests. */
export function setAntigravityAcpWorkerLoaderForTests(loader) {
  loaderOverride = typeof loader === "function" ? loader : null;
}

export function setAntigravityAcpWorkerConfigPathForTests(filePath) {
  configPath = typeof filePath === "string" && path.isAbsolute(filePath) ? filePath : DEFAULT_CONFIG;
}

/** Isolate auto-discovery from host-installed binaries in unit tests. */
export function setAntigravityAcpAutoDiscoveryForTests(paths) {
  discoveryPathsOverride = Array.isArray(paths) ? paths.filter((item) => typeof item === "string") : null;
}

export function setAntigravityAcpProvisionRootForTests(rootPath) {
  provisionRootOverride = typeof rootPath === "string" && path.isAbsolute(rootPath) ? rootPath : null;
}

function candidatePaths() {
  if (discoveryPathsOverride) return discoveryPathsOverride;
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [
        process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)
          ? path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "bin", "agy.cmd") : null,
        process.env.USERPROFILE && path.isAbsolute(process.env.USERPROFILE)
          ? path.join(process.env.USERPROFILE, ".local", "bin", "agy.exe") : null,
      ].filter(Boolean)
    : [path.join(home, ".local", "bin", "agy"), "/usr/local/bin/agy", "/usr/bin/agy"];
  if (process.platform === "darwin") candidates.splice(2, 0, "/Applications/Antigravity.app/Contents/Resources/app/bin/agy", "/opt/homebrew/bin/agy");
  const pathValue = process.env.PATH || "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry) || entry === ".") continue;
    candidates.push(...(process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"]).map((name) => path.join(entry, name)));
  }
  return [...new Set(candidates)];
}

async function findAgyBinary() {
  for (const candidate of candidatePaths()) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile() || (process.platform !== "win32" && (!(info.mode & 0o111) || (info.mode & 0o022)))) continue;
      if (process.platform !== "win32") {
        const parent = await stat(path.dirname(resolved));
        if (!parent.isDirectory() || (parent.mode & 0o022)) continue;
      }
      return resolved;
    } catch {}
  }
  return null;
}

function accountsRoot() {
  return provisionRootOverride || path.join(os.homedir(), ".config", "zenith-router", "acp");
}

/** Per-account isolated folder layout. Only call with a validated hex account ID. */
export function accountPaths(accountId) {
  if (!isValidAccountId(accountId)) throw new Error("invalid account id");
  const root = path.join(accountsRoot(), accountId);
  const home = path.join(root, "home");
  return { root, home, appdata: path.join(root, "appdata"), workspace: path.join(root, "workspace"),
    tokenFile: path.join(home, ".gemini", "antigravity-acp", "acp_token.json"),
    businessTokenFile: path.join(home, ".gemini", "antigravity-acp", "acp_business_token.json") };
}

/** True when a deployment worker map file exists (it then overrides account-derived workers). */
export function isExplicitWorkerMapPresent() {
  try { lstatSync(configPath); return true; } catch (error) { return error?.code !== "ENOENT"; }
}

/** Account-derived workers are in effect only when neither a deployment map nor a test loader overrides them. */
export function isDerivedWorkerMode() {
  return !loaderOverride && !isExplicitWorkerMapPresent();
}

/** Login state from file presence/size only; the token contents are never read. */
export function accountHasLoginFile(accountId) {
  try {
    const info = lstatSync(accountPaths(accountId).tokenFile);
    return info.isFile() && info.size > 0;
  } catch { return false; }
}

/** Environment for an isolated worker; GEMINI_HOME and file storage keep Agy state inside the account folder. */
export function workerRuntimeEnv(worker) {
  if (!worker?.isolatedHome) return {};
  const env = {
    HOME: worker.isolatedHome,
    GEMINI_HOME: path.join(worker.isolatedHome, ".gemini"),
    AGY_ACP_FORCE_FILE_STORAGE: "1",
  };
  if (process.platform === "win32") {
    env.USERPROFILE = worker.isolatedHome;
    if (worker.appData) env.APPDATA = worker.appData;
  }
  return env;
}

async function ensureAccountDirs(accountId) {
  const paths = accountPaths(accountId);
  const base = accountsRoot();
  const home = os.homedir();
  const ancestors = provisionRootOverride ? [] : [path.join(home, ".config"), path.join(home, ".config", "zenith-router")];
  const directories = [...ancestors, base, paths.root, paths.home, paths.appdata, paths.workspace];
  try {
    // Reject pre-existing links and non-directories before mkdir/chmod can follow or modify them.
    for (const dir of directories) {
      try {
        const info = await lstat(dir);
        if (info.isSymbolicLink() || !info.isDirectory()) return null;
      } catch (error) {
        if (error?.code !== "ENOENT") return null;
      }
    }
    for (const dir of directories) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
      if (!ancestors.includes(dir) && process.platform !== "win32") await chmod(dir, 0o700);
    }
    const baseReal = await realpath(base);
    const prefix = baseReal.endsWith(path.sep) ? baseReal : `${baseReal}${path.sep}`;
    for (const dir of [paths.root, paths.home, paths.appdata, paths.workspace]) {
      if (!(await realpath(dir)).startsWith(prefix)) return null;
    }
  } catch { return null; }
  return paths;
}

/** Creates the isolated folders for a new account (no login happens here). */
export async function provisionAntigravityAcpAccountDirs(accountId) {
  return Boolean(await ensureAccountDirs(accountId));
}

/** Removes token files first, then the account folder. Refuses anything that is not a real directory below the accounts root. */
export async function removeAntigravityAcpAccountDirs(accountId) {
  const paths = accountPaths(accountId);
  try {
    const info = await lstat(paths.root);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    await rm(paths.tokenFile, { force: true });
    await rm(paths.businessTokenFile, { force: true });
    await rm(paths.root, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

async function deriveAccountWorker(accountId, agy) {
  const paths = await ensureAccountDirs(accountId);
  if (!paths) return null;
  return Object.freeze({
    workerId: workerIdForAccount(accountId), namespace: workerIdForAccount(accountId), launcher: agy,
    launcherArgs: Object.freeze(["acp", "--stdio"]),
    loginLauncher: agy,
    loginLauncherArgs: Object.freeze(["acp", "--login"]),
    workspace: paths.workspace, isolatedHome: paths.home, appData: paths.appdata,
  });
}

async function deriveAccountWorkers(onlyAccountId = null) {
  const agy = await findAgyBinary();
  if (!agy) return [];
  const accounts = getAccounts().filter((account) => onlyAccountId === null || account.id === onlyAccountId);
  const workers = [];
  for (const account of accounts) {
    const worker = await deriveAccountWorker(account.id, agy);
    if (worker) workers.push(worker);
  }
  return workers;
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

async function loadWorkers(onlyAccountId = null) {
  if (loaderOverride) return loaderOverride();
  let info;
  try {
    info = await lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return deriveAccountWorkers(onlyAccountId);
    return [];
  }
  try {
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) throw new Error("worker config invalid");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (!Array.isArray(parsed) || parsed.length > 256) throw new Error("worker config invalid");
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
  const explicit = isExplicitWorkerMapPresent();
  // Without a deployment map, only workers derived from an existing account are resolvable.
  const only = !explicit && !loaderOverride ? accountIdFromWorkerId(workerId) : null;
  if (!explicit && !loaderOverride && !only) return null;
  const workers = await loadWorkers(only);
  return workers.find((worker) => worker.workerId === workerId) || null;
}
