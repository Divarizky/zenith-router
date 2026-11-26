import { getSetting, setSetting } from "../settings.js";
import { getAntigravityAcpWorker } from "./workers.js";

const ENABLED_SETTING = "antigravity_acp_enabled";
const PROFILES_SETTING = "antigravity_acp_profiles";
const MAX_PROFILES = 2;
const WORKER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const VALID_STATUSES = new Set(["ready", "needs_login", "unavailable"]);
const profileStatuses = new Map();
let configGeneration = 0;

/** Synchronously snapshots enabled candidates (priority order) with bindings from one config read. */
export function snapshotAntigravityAcpCandidates() {
  const generation = configGeneration;
  return getAntigravityAcpProfiles().filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)
    .map((profile) => ({ profile, binding: { profileId: profile.id, workerId: profile.workerId, generation } }));
}

/** True only while the binding still matches the live slot configuration. */
export function isAntigravityAcpBindingCurrent(binding) {
  if (!binding || binding.generation !== configGeneration) return false;
  const profile = getAntigravityAcpProfiles().find(({ id }) => id === binding.profileId);
  return profile?.enabled === true && profile.workerId === binding.workerId;
}

/** ACP stays opt-in even when profiles have been provisioned. */
export function isAntigravityAcpEnabled() {
  return getSetting(ENABLED_SETTING, "false") === "true";
}

export function setAntigravityAcpEnabled(enabled) {
  if (typeof enabled !== "boolean") return false;
  if (enabled && !getAntigravityAcpProfiles().some((profile) => profile.enabled)) return false;
  return setSetting(ENABLED_SETTING, enabled ? "true" : "false") !== null;
}

function parseProfiles(raw) {
  try {
    const parsed = JSON.parse(raw);
    return validateAntigravityAcpProfiles(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Profiles contain only allowlisted local worker IDs and routing priority.
 * Commands, arguments, environment, cwd, and credentials are never accepted here.
 */
export function validateAntigravityAcpProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) return false;
  const workerIds = new Set();
  const ids = new Set();
  const priorities = new Set();
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
    if (Object.keys(profile).some((key) => !["id", "workerId", "priority", "enabled"].includes(key))) return false;
    if (typeof profile.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(profile.id)) return false;
    if (typeof profile.workerId !== "string" || !WORKER_ID_PATTERN.test(profile.workerId)) return false;
    if (!Number.isInteger(profile.priority) || profile.priority < 0 || profile.priority > 1) return false;
    if (typeof profile.enabled !== "boolean") return false;
    if (ids.has(profile.id) || workerIds.has(profile.workerId) || priorities.has(profile.priority)) return false;
    ids.add(profile.id);
    workerIds.add(profile.workerId);
    priorities.add(profile.priority);
  }
  return true;
}

export function getAntigravityAcpProfiles() {
  return parseProfiles(getSetting(PROFILES_SETTING, "[]"));
}

export function getAntigravityAcpConfigGeneration() {
  return configGeneration;
}

function applyProfilesUpdate(profiles) {
  const serialized = JSON.stringify(profiles);
  const changed = getSetting(PROFILES_SETTING, "[]") !== serialized;
  const result = setSetting(PROFILES_SETTING, serialized);
  if (result === null) return false;
  if (changed) configGeneration += 1;
  profileStatuses.clear();
  return true;
}

/**
 * Registers a trusted worker after an out-of-band bootstrap (for example Agy
 * login) without replacing another slot. The generation and worker snapshot
 * make the commit fail closed when an admin changed the mapping mid-attempt.
 */
export async function registerAntigravityAcpWorker(workerId, {
  expectedGeneration = configGeneration,
  expectedWorker = null,
  shouldCommit = null,
} = {}) {
  if (typeof workerId !== "string" || expectedGeneration !== configGeneration) return { ok: false, reason: "stale" };
  const worker = await getAntigravityAcpWorker(workerId);
  if (!worker || expectedGeneration !== configGeneration) return { ok: false, reason: "stale" };
  if (expectedWorker && (worker.launcher !== expectedWorker.launcher || worker.workspace !== expectedWorker.workspace || worker.loginLauncher !== expectedWorker.loginLauncher || worker.isolatedHome !== expectedWorker.isolatedHome || JSON.stringify(worker.launcherArgs || []) !== JSON.stringify(expectedWorker.launcherArgs || []) || JSON.stringify(worker.loginLauncherArgs || []) !== JSON.stringify(expectedWorker.loginLauncherArgs || []))) {
    return { ok: false, reason: "stale" };
  }
  if (typeof shouldCommit === "function" && !shouldCommit()) return { ok: false, reason: "cancelled" };
  if (expectedGeneration !== configGeneration) return { ok: false, reason: "stale" };
  const profiles = getAntigravityAcpProfiles();
  const existing = profiles.find((profile) => profile.workerId === workerId);
  if (existing) return { ok: true, added: false, profile: { ...existing } };
  if (profiles.length >= MAX_PROFILES) return { ok: false, reason: "full" };
  const usedIds = new Set(profiles.map((profile) => profile.id));
  const usedPriorities = new Set(profiles.map((profile) => profile.priority));
  const priority = [0, 1].find((candidate) => !usedPriorities.has(candidate));
  if (priority === undefined) return { ok: false, reason: "full" };
  let suffix = 1;
  while (usedIds.has(`worker-${suffix}`)) suffix += 1;
  const profile = { id: `worker-${suffix}`, workerId, priority, enabled: true };
  const nextProfiles = [...profiles, profile];
  if (!validateAntigravityAcpProfiles(nextProfiles)) return { ok: false, reason: "stale" };
  if (typeof shouldCommit === "function" && !shouldCommit()) return { ok: false, reason: "cancelled" };
  if (expectedGeneration !== configGeneration) return { ok: false, reason: "stale" };
  if (!applyProfilesUpdate(nextProfiles)) return { ok: false, reason: "stale" };
  return { ok: true, added: true, profile };
}

export async function setAntigravityAcpProfiles(profiles, { expectedGeneration = null } = {}) {
  if (!validateAntigravityAcpProfiles(profiles)) return false;
  for (const profile of profiles) {
    if (!await getAntigravityAcpWorker(profile.workerId)) return false;
  }
  if (expectedGeneration !== null && expectedGeneration !== configGeneration) return false;
  return applyProfilesUpdate(profiles);
}

/** Status is runtime-only and contains no process output or secret-bearing details. */
export function setAntigravityAcpProfileStatus(profileId, status, binding = undefined) {
  if (!VALID_STATUSES.has(status)) return false;
  const profile = getAntigravityAcpProfiles().find(({ id }) => id === profileId);
  if (!profile) return false;
  if (binding !== undefined && (!binding || binding.profileId !== profileId || !isAntigravityAcpBindingCurrent(binding))) return false;
  profileStatuses.set(profileId, status);
  return true;
}

export function getAntigravityAcpProfileStatus(profileId) {
  const profile = getAntigravityAcpProfiles().find(({ id }) => id === profileId);
  if (!profile || !profile.enabled) return "unavailable";
  return profileStatuses.get(profileId) || "unavailable";
}

export function listAntigravityAcpProfiles() {
  return getAntigravityAcpProfiles().map((profile) => ({
    id: profile.id,
    workerId: profile.workerId,
    priority: profile.priority,
    enabled: profile.enabled,
    status: getAntigravityAcpProfileStatus(profile.id),
  }));
}
