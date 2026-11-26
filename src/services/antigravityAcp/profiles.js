import { randomUUID } from "node:crypto";
import { getSetting, setSetting } from "../settings.js";
import {
  ACCOUNTS_SETTING, accountNameKey, getAccounts, normalizeAccountName, validateAccounts, workerIdForAccount, isValidAccountId,
} from "./accounts.js";
import {
  accountHasLoginFile, getAntigravityAcpWorker, isDerivedWorkerMode, provisionAntigravityAcpAccountDirs, removeAntigravityAcpAccountDirs,
} from "./workers.js";
import { DEFAULT_LIMIT_MS } from "./quota.js";

const ENABLED_SETTING = "antigravity_acp_enabled";
const VALID_STATUSES = new Set(["ready", "needs_login", "unavailable"]);
const profileStatuses = new Map();
const limitedUntil = new Map();
const activeUse = new Map();
let configGeneration = 0;
let clock = () => Date.now();

/** Test hook for the limit clock only. */
export function setAntigravityAcpClockForTests(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

export function resetAntigravityAcpRuntimeStateForTests() {
  profileStatuses.clear();
  limitedUntil.clear();
  activeUse.clear();
}

export function getAntigravityAcpProfiles() {
  return getAccounts();
}

export function getAntigravityAcpConfigGeneration() {
  return configGeneration;
}

function isLimited(id) {
  const until = limitedUntil.get(id);
  if (until === undefined) return false;
  if (until > clock()) return true;
  limitedUntil.delete(id);
  return false;
}

function needsLogin(id) {
  return isDerivedWorkerMode() && !accountHasLoginFile(id);
}

/** Marks an account limited until the reported reset, or five hours when none was reported. */
export function markAntigravityAcpAccountLimited(accountId, resetAt = null) {
  if (!getAccounts().some(({ id }) => id === accountId)) return false;
  const now = clock();
  const until = Number.isFinite(resetAt) && resetAt > now ? resetAt : now + DEFAULT_LIMIT_MS;
  limitedUntil.set(accountId, until);
  return true;
}

export function getAntigravityAcpAccountLimitedUntil(accountId) {
  return isLimited(accountId) ? limitedUntil.get(accountId) : null;
}

/** Counts an in-flight request/login against an account so it cannot be deleted underneath it. Returns a release function. */
export function acquireAntigravityAcpAccountUse(accountId) {
  activeUse.set(accountId, (activeUse.get(accountId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (activeUse.get(accountId) || 1) - 1;
    if (left <= 0) activeUse.delete(accountId); else activeUse.set(accountId, left);
  };
}

/** Synchronously snapshots routable accounts in list order; limited and needs_login accounts are skipped. */
export function snapshotAntigravityAcpCandidates() {
  const generation = configGeneration;
  return getAccounts().filter((a) => a.enabled && !isLimited(a.id) && !needsLogin(a.id) && !(isDerivedWorkerMode() && profileStatuses.get(a.id) === "needs_login"))
    .map((profile) => ({ profile: { ...profile, workerId: workerIdForAccount(profile.id) }, binding: { profileId: profile.id, workerId: workerIdForAccount(profile.id), generation } }));
}

/** True only while the binding still matches the live account configuration. */
export function isAntigravityAcpBindingCurrent(binding) {
  if (!binding || binding.generation !== configGeneration) return false;
  const account = getAccounts().find(({ id }) => id === binding.profileId);
  return account?.enabled === true && workerIdForAccount(account.id) === binding.workerId;
}

/** ACP stays opt-in even when accounts have been provisioned. */
export function isAntigravityAcpEnabled() {
  return getSetting(ENABLED_SETTING, "false") === "true";
}

export function setAntigravityAcpEnabled(enabled) {
  if (typeof enabled !== "boolean") return false;
  if (enabled && !getAccounts().some((account) => account.enabled)) return false;
  return setSetting(ENABLED_SETTING, enabled ? "true" : "false") !== null;
}

function writeAccounts(next, { bump }) {
  if (!validateAccounts(next)) return false;
  if (setSetting(ACCOUNTS_SETTING, JSON.stringify(next)) === null) return false;
  // Pure appends must not invalidate bindings of in-flight requests to other accounts.
  if (bump) configGeneration += 1;
  profileStatuses.clear();
  return true;
}

/** Creates the account entry and its isolated folders only; the account starts as needs_login. */
export async function addAntigravityAcpAccount(name) {
  const clean = normalizeAccountName(name);
  if (clean === null) return { ok: false, reason: "invalid_name" };
  const accounts = getAccounts();
  if (accounts.some((a) => accountNameKey(a.name) === accountNameKey(clean))) return { ok: false, reason: "duplicate_name" };
  const id = randomUUID().replaceAll("-", "");
  if (!await provisionAntigravityAcpAccountDirs(id)) return { ok: false, reason: "provision_failed" };
  // Re-read: another add may have committed while folders were being created.
  const current = getAccounts();
  if (current.some((a) => accountNameKey(a.name) === accountNameKey(clean))) {
    await removeAntigravityAcpAccountDirs(id);
    return { ok: false, reason: "duplicate_name" };
  }
  const account = { id, name: clean, enabled: true };
  if (!writeAccounts([...current, account], { bump: false })) {
    await removeAntigravityAcpAccountDirs(id);
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, account: { ...account } };
}

/** Deletes token files, the account folder, then the list entry. Refuses while a request or login uses the account. */
export async function removeAntigravityAcpAccount(accountId) {
  if (!isValidAccountId(accountId)) return { ok: false, reason: "invalid_id" };
  const accounts = getAccounts();
  if (!accounts.some((a) => a.id === accountId)) return { ok: false, reason: "not_found" };
  if (activeUse.has(accountId)) return { ok: false, reason: "account_busy" };
  const release = acquireAntigravityAcpAccountUse(accountId);
  try {
    if (!await removeAntigravityAcpAccountDirs(accountId)) return { ok: false, reason: "cleanup_failed" };
    if (!writeAccounts(getAccounts().filter((a) => a.id !== accountId), { bump: true })) return { ok: false, reason: "invalid" };
    limitedUntil.delete(accountId);
    return { ok: true };
  } finally {
    release();
  }
}

export function setAntigravityAcpAccountEnabled(accountId, enabled) {
  if (typeof enabled !== "boolean") return false;
  const accounts = getAccounts();
  if (!accounts.some((a) => a.id === accountId)) return false;
  return writeAccounts(accounts.map((a) => (a.id === accountId ? { ...a, enabled } : a)), { bump: true });
}

/** Replaces the whole ordered list (order = routing order). Strict allowlist validation applies. */
export async function setAntigravityAcpProfiles(profiles, { expectedGeneration = null } = {}) {
  if (!validateAccounts(profiles)) return false;
  if (expectedGeneration !== null && expectedGeneration !== configGeneration) return false;
  const prev = getAccounts();
  const appendOnly = profiles.length >= prev.length && prev.every((a, i) => JSON.stringify(a) === JSON.stringify(profiles[i]));
  return writeAccounts(profiles, { bump: !appendOnly });
}

/**
 * Called after a verified login. Fails closed when the account vanished or the worker mapping
 * changed while the attempt ran. Clears stale runtime state so the account becomes routable.
 */
export async function completeAntigravityAcpLogin(accountId, { expectedWorker = null, shouldCommit = null } = {}) {
  if (!getAccounts().some((a) => a.id === accountId)) return { ok: false, reason: "stale" };
  const worker = await getAntigravityAcpWorker(workerIdForAccount(accountId));
  if (!worker || !getAccounts().some((a) => a.id === accountId)) return { ok: false, reason: "stale" };
  if (expectedWorker && (worker.launcher !== expectedWorker.launcher || worker.workspace !== expectedWorker.workspace || worker.loginLauncher !== expectedWorker.loginLauncher || worker.isolatedHome !== expectedWorker.isolatedHome || JSON.stringify(worker.launcherArgs || []) !== JSON.stringify(expectedWorker.launcherArgs || []) || JSON.stringify(worker.loginLauncherArgs || []) !== JSON.stringify(expectedWorker.loginLauncherArgs || []))) {
    return { ok: false, reason: "stale" };
  }
  if (typeof shouldCommit === "function" && !shouldCommit()) return { ok: false, reason: "cancelled" };
  profileStatuses.delete(accountId);
  limitedUntil.delete(accountId);
  return { ok: true };
}

/** Status is runtime-only and contains no process output or secret-bearing details. */
export function setAntigravityAcpProfileStatus(profileId, status, binding = undefined) {
  if (!VALID_STATUSES.has(status)) return false;
  if (!getAccounts().some(({ id }) => id === profileId)) return false;
  if (binding !== undefined && (!binding || binding.profileId !== profileId || !isAntigravityAcpBindingCurrent(binding))) return false;
  profileStatuses.set(profileId, status);
  return true;
}

export function getAntigravityAcpProfileStatus(profileId) {
  const account = getAccounts().find(({ id }) => id === profileId);
  if (!account || !account.enabled) return "unavailable";
  if (isLimited(profileId)) return "limited";
  if (needsLogin(profileId)) return "needs_login";
  return profileStatuses.get(profileId) || (isDerivedWorkerMode() ? "ready" : "unavailable");
}

export function listAntigravityAcpProfiles() {
  return getAccounts().map((account, index) => ({
    id: account.id,
    name: account.name,
    workerId: workerIdForAccount(account.id),
    priority: index,
    enabled: account.enabled,
    status: getAntigravityAcpProfileStatus(account.id),
    limitedUntil: getAntigravityAcpAccountLimitedUntil(account.id),
  }));
}
