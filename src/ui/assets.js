import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.resolve(__dirname, "../../public/providers");

/**
 * Get public URL for a provider icon if available (e.g. /providers/claude.png)
 */
export function getProviderIconPath(providerId) {
  if (!providerId) return null;
  const id = String(providerId).toLowerCase().trim();
  try {
    const file = path.join(PROVIDERS_DIR, `${id}.png`);
    if (fs.existsSync(file)) return `/providers/${id}.png`;
    const baseId = id === "kilo-free" ? "kilocode" : id;
    const fallbackFile = path.join(PROVIDERS_DIR, `${baseId}.png`);
    if (fs.existsSync(fallbackFile)) return `/providers/${baseId}.png`;
  } catch {}
  return null;
}
