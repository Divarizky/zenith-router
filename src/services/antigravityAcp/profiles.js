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

export async function setAntigravityAcpProfiles(profiles) {
  if (!validateAntigravityAcpProfiles(profiles)) return false;
  for (const profile of profiles) {
    if (!await getAntigravityAcpWorker(profile.workerId)) return false;
  }
  const serialized = JSON.stringify(profiles);
  const changed = getSetting(PROFILES_SETTING, "[]") !== serialized;
  const result = setSetting(PROFILES_SETTING, serialized);
  if (result === null) return false;
  if (changed) configGeneration += 1;
  profileStatuses.clear();
  return true;
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
