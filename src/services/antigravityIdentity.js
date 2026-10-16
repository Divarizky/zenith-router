import { arch, platform } from "node:os";

// Single source for the Antigravity client identity. The OS and CPU come from
// the host instead of being hard-coded, and the User-Agent is the CLI shape:
// the server keys the model catalog off it. An "antigravity/ide/*" agent string
// gets a catalog without gemini-4-argon; the CLI string gets the full list.
// Verified against a live Pro account.
export const ANTIGRAVITY_VERSION = "1.4.0";

const OS_NAMES = { win32: "windows", darwin: "darwin", linux: "linux" };
const CPU_NAMES = { x64: "amd64", arm64: "arm64" };

export function antigravityUserAgent() {
  const os = OS_NAMES[platform()] || platform();
  const cpu = CPU_NAMES[arch()] || arch();
  return `antigravity/cli/${ANTIGRAVITY_VERSION} (aidev_client; os_type=${os}; arch=${cpu}; cl=1000494485; auth_method=consumer)`;
}
