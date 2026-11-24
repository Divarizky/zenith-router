import { getSetting } from "./settings.js";

// Kiro currently uses 1.0.0 on every supported surface. The release
// coordinator may change this one value after a future upstream probe.
export const DEFAULT_KIRO_IDE_VERSION = "1.0.0";
export const KIRO_IDE_VERSION = DEFAULT_KIRO_IDE_VERSION;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function validVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

function configuredVersion() {
  const settingVersion = validVersion(getSetting("kiro_ide_version", ""));
  if (settingVersion) return settingVersion;

  const envVersion = validVersion(process.env.ZENITH_KIRO_IDE_VERSION);
  if (envVersion) return envVersion;

  return KIRO_IDE_VERSION;
}

/**
 * Build the Kiro identity for one HTTP surface. The version is shared, while
 * the surrounding client string remains the exact shape accepted by that
 * surface: inference/registry, OAuth refresh, and quota are not interchangeable.
 */
export function buildKiroIdentityHeaders({ kind = "inference" } = {}) {
  const version = configuredVersion();

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

  return {
    "User-Agent": `AWS-SDK-JS/3.0.0 kiro-ide/${version}`,
    "X-Amz-User-Agent": `aws-sdk-js/3.0.0 kiro-ide/${version}`,
  };
}
