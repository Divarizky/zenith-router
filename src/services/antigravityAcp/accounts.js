import { getSetting } from "../settings.js";

export const ACCOUNTS_SETTING = "antigravity_acp_profiles";
export const MAX_ACCOUNT_NAME_LENGTH = 40;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const WORKER_PREFIX = "agy-worker-";
const ALLOWED_FIELDS = ["id", "name", "enabled"];

export function isValidAccountId(id) {
  return typeof id === "string" && ACCOUNT_ID_PATTERN.test(id);
}

export function normalizeAccountName(name) {
  if (typeof name !== "string") return null;
  if (name.length === 0 || name.length > MAX_ACCOUNT_NAME_LENGTH || name !== name.trim() || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function accountNameKey(name) {
  return name.toLocaleLowerCase("en-US");
}

/** Worker IDs are derived from the validated hex account ID; never from user input. */
export function workerIdForAccount(accountId) {
  return `${WORKER_PREFIX}${accountId}`;
}

export function accountIdFromWorkerId(workerId) {
  if (typeof workerId !== "string" || !workerId.startsWith(WORKER_PREFIX)) return null;
  const id = workerId.slice(WORKER_PREFIX.length);
  return isValidAccountId(id) ? id : null;
}

/** Strict allowlist validation: unknown fields, bad IDs, duplicate IDs/names are rejected. List order is routing order. */
export function validateAccounts(accounts) {
  if (!Array.isArray(accounts)) return false;
  const ids = new Set();
  const names = new Set();
  for (const account of accounts) {
    if (!account || typeof account !== "object" || Array.isArray(account)) return false;
    if (Object.keys(account).some((key) => !ALLOWED_FIELDS.includes(key))) return false;
    if (!isValidAccountId(account.id) || normalizeAccountName(account.name) === null || typeof account.enabled !== "boolean") return false;
    const nameKey = accountNameKey(account.name);
    if (ids.has(account.id) || names.has(nameKey)) return false;
    ids.add(account.id);
    names.add(nameKey);
  }
  return true;
}

export function getAccounts() {
  try {
    const parsed = JSON.parse(getSetting(ACCOUNTS_SETTING, "[]"));
    return validateAccounts(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
