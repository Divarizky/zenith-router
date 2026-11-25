import { createHash } from "node:crypto";
import { getSetting } from "./settings.js";

// Kiro's GenerateAssistantResponse gate accepts the current streaming client
// identity used by 9router v0.5.123. The setting/env override remains available
// for controlled compatibility changes without mutating process.env in tests.
export const DEFAULT_KIRO_IDE_VERSION = "1.4.154";
export const KIRO_IDE_VERSION = DEFAULT_KIRO_IDE_VERSION;
const LEGACY_KIRO_IDE_VERSION = "1.0.0";
const KIRO_CONNECTION_NAMESPACE = "zenith-kiro-connection:";
const KIRO_FALLBACK_CONNECTION_ID = "anonymous";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SDK_VERSION = "1.0.0";
const STREAMING_API = "codewhispererstreaming";
const STREAMING_METRICS = "E";

function validVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

function configuredVersion(fallback = KIRO_IDE_VERSION) {
  const settingVersion = validVersion(getSetting("kiro_ide_version", ""));
  if (settingVersion) return settingVersion;

  const envVersion = validVersion(process.env.ZENITH_KIRO_IDE_VERSION);
  if (envVersion) return envVersion;

  return fallback;
}

function normalizedConnectionId(connectionId) {
  if (typeof connectionId === "string" && connectionId.trim()) return connectionId.trim();
  if (typeof connectionId === "number" && Number.isSafeInteger(connectionId)) return String(connectionId);
  return KIRO_FALLBACK_CONNECTION_ID;
}

export function kiroMachineId(connectionId) {
  const seed = `${KIRO_CONNECTION_NAMESPACE}${normalizedConnectionId(connectionId)}`;
  return createHash("sha256").update(seed).digest("hex");
}

function streamingIdentityHeaders(connectionId) {
  const version = configuredVersion();
  const identity = `KiroIDE-${version}-${kiroMachineId(connectionId)}`;
  return {
    "User-Agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/${STREAMING_API}#${SDK_VERSION} m/${STREAMING_METRICS} ${identity}`,
    "X-Amz-User-Agent": `aws-sdk-js/${SDK_VERSION} ${identity}`,
  };
}

/**
 * Build a Kiro identity for one HTTP surface. GenerateAssistantResponse uses
 * the official streaming UA shape; refresh and quota retain their existing
 * endpoint-specific formats and auth semantics.
 */
export function buildKiroIdentityHeaders({ kind = "inference", connectionId } = {}) {
  if (kind === "executor" || kind === "inference") {
    return streamingIdentityHeaders(connectionId);
  }

  const version = configuredVersion(LEGACY_KIRO_IDE_VERSION);
  if (kind === "quota") {
    const quotaIdentity = `aws-sdk-js/${version} KiroIDE`;
    return {
      "User-Agent": quotaIdentity,
      "X-Amz-User-Agent": quotaIdentity,
    };
  }

  if (kind === "refresh") {
    return { "User-Agent": `kiro-cli/${version}` };
  }

  // The registry transport is the same inference lane, but has no local
  // connection id available yet; use the stable fallback.
  return streamingIdentityHeaders(undefined);
}
