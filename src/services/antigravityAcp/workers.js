import { lstat, stat, realpath, mkdir, chmod, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { getAccounts, isValidAccountId, workerIdForAccount, accountIdFromWorkerId } from "./accounts.js";
import path from "node:path";
import os from "node:os";

let loaderOverride = null;
// Accounts whose first login is still running. They have folders and a derived worker
// but are not in the account list yet; the list entry is written only after a verified login.
const pendingAccountIds = new Set();
let discoveryPathsOverride = null;
let provisionRootOverride = null;

/** Test hook; runtime callers must never derive worker launch data from requests. */
export function setAntigravityAcpWorkerLoaderForTests(loader) {
  loaderOverride = typeof loader === "function" ? loader : null;
}

/** Isolate auto-discovery from host-installed binaries in unit tests. */
export function setAntigravityAcpAutoDiscoveryForTests(paths) {
  discoveryPathsOverride = Array.isArray(paths) ? paths.filter((item) => typeof item === "string") : null;
}

export function setAntigravityAcpProvisionRootForTests(rootPath) {
  provisionRootOverride = typeof rootPath === "string" && path.isAbsolute(rootPath) ? rootPath : null;
}

// Troupe registry: Linux/macOS ship `agy_acp_server.par` (Linux with `--uid=`); a plain `agy_acp_server` is also accepted.
const SERVER_NAMES = process.platform === "win32" ? ["agy_acp_server.exe"] : ["agy_acp_server.par", "agy_acp_server"];

/** Fixed argv for a resolved binary; never derived from requests. */
export function serverArgsFor(binary) {
  return process.platform === "linux" && typeof binary === "string" && path.basename(binary).endsWith(".par") ? ["--uid="] : [];
}

/** Official ACP server only. The `agy` CLI is deliberately not a fallback: it is not isolated per account. */
function candidatePaths() {
  if (discoveryPathsOverride) return discoveryPathsOverride;
  const home = os.homedir();
  const candidates = [];
  if (process.env.ZENITH_AGY_ACP_SERVER && path.isAbsolute(process.env.ZENITH_AGY_ACP_SERVER)) candidates.push(process.env.ZENITH_AGY_ACP_SERVER);
  for (const name of SERVER_NAMES) candidates.push(path.join(home, ".local", "bin", name), `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  // Android Studio ships the official server here; each directory is still checked by findAgyBinary (owner/mode/parent).
  const studio = path.join(home, ".android", "studio", "agent", "binaries", "antigravity-acp");
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  for (const name of SERVER_NAMES) candidates.push(path.join(studio, `${plat}-${arch}`, name));
  const pathValue = process.env.PATH || "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    for (const name of SERVER_NAMES) candidates.push(path.join(entry, name));
  }
  return [...new Set(candidates)];
}

/**
 * Other-writable is never trusted. Group-writable is accepted only when the owner is this user and the
 * group is this user's own primary group, which is the default on Linux (umask 002, private user group).
 * Any other group could let someone else swap the binary.
 */
function isTrustedWriteMode(info) {
  if (info.mode & 0o002) return false;
  if (!(info.mode & 0o020)) return true;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && info.uid === uid && info.gid === gid;
}

async function findAgyBinary() {
  for (const candidate of candidatePaths()) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile() || (process.platform !== "win32" && (!(info.mode & 0o111) || !isTrustedWriteMode(info)))) continue;
      if (process.platform !== "win32") {
        const parent = await stat(path.dirname(resolved));
        if (!parent.isDirectory() || !isTrustedWriteMode(parent)) continue;
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
  return { root, home, run: path.join(home, "run"), appdata: path.join(root, "appdata"), workspace: path.join(root, "workspace"),
    tokenFile: path.join(home, ".gemini", "antigravity-acp", "acp_token.json"),
    businessTokenFile: path.join(home, ".gemini", "antigravity-acp", "acp_business_token.json") };
}

/** Workers are always derived from accounts; only a test loader replaces that. */
export function isDerivedWorkerMode() {
  return !loaderOverride;
}

/** Marks an account id as mid-login so its worker resolves before it is listed. */
export function registerPendingAntigravityAcpAccount(accountId) {
  if (!isValidAccountId(accountId)) return false;
  pendingAccountIds.add(accountId);
  return true;
}

export function unregisterPendingAntigravityAcpAccount(accountId) {
  pendingAccountIds.delete(accountId);
}

export function isPendingAntigravityAcpAccount(accountId) {
  return pendingAccountIds.has(accountId);
}

export function resetAntigravityAcpWorkerStateForTests() {
  pendingAccountIds.clear();
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
  if (process.platform === "linux") {
    env.DBUS_SESSION_BUS_ADDRESS = "disabled:";
    env.XDG_RUNTIME_DIR = path.join(worker.isolatedHome, "run");
  }
  return env;
}

async function ensureAccountDirs(accountId) {
  const paths = accountPaths(accountId);
  const base = accountsRoot();
  const home = os.homedir();
  const ancestors = provisionRootOverride ? [] : [path.join(home, ".config"), path.join(home, ".config", "zenith-router")];
  const directories = [...ancestors, base, paths.root, paths.home, paths.run, paths.appdata, paths.workspace];
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
    launcherArgs: Object.freeze(serverArgsFor(agy)),
    loginLauncher: agy,
    loginLauncherArgs: Object.freeze(serverArgsFor(agy)),
    loginMode: "acp-authenticate",
    authMethodId: "oauth-personal",
    workspace: paths.workspace, isolatedHome: paths.home, appData: paths.appdata,
  });
}

async function deriveAccountWorkers(onlyAccountId = null) {
  const agy = await findAgyBinary();
  if (!agy) return [];
  const ids = new Set(getAccounts().map((account) => account.id));
  for (const id of pendingAccountIds) ids.add(id);
  const workers = [];
  for (const id of ids) {
    if (onlyAccountId !== null && id !== onlyAccountId) continue;
    const worker = await deriveAccountWorker(id, agy);
    if (worker) workers.push(worker);
  }
  return workers;
}

async function loadWorkers(onlyAccountId = null) {
  if (loaderOverride) return loaderOverride();
  return deriveAccountWorkers(onlyAccountId);
}

export async function getAntigravityAcpWorkers() {
  const workers = await loadWorkers();
  return workers.map((worker) => ({ ...worker }));
}

export async function getAntigravityAcpWorker(workerId) {
  if (typeof workerId !== "string") return null;
  // Only workers derived from a listed or mid-login account are resolvable.
  const only = loaderOverride ? null : accountIdFromWorkerId(workerId);
  if (!loaderOverride && !only) return null;
  const workers = await loadWorkers(only);
  return workers.find((worker) => worker.workerId === workerId) || null;
}
