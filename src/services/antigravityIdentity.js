import { arch, platform } from "node:os";

// Single source for the Antigravity client identity. The User-Agent OS and CPU
// must match the platform sent to loadCodeAssist (ClientMetadata.Platform), so
// both are derived from the same host instead of a hard-coded darwin/arm64.
export const ANTIGRAVITY_VERSION = "2.11.0";

const OS_NAMES = { win32: "windows", darwin: "darwin", linux: "linux" };
const CPU_NAMES = { x64: "amd64", arm64: "arm64" };

export function antigravityUserAgent() {
  const os = OS_NAMES[platform()] || platform();
  const cpu = CPU_NAMES[arch()] || arch();
  return `antigravity/ide/${ANTIGRAVITY_VERSION} ${os}/${cpu}`;
}
