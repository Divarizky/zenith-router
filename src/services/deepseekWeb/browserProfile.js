/**
 * Reuse the user's real browser session without touching their running browser.
 *
 * A Chromium profile directory cannot be opened by two processes at once, so
 * launching with the live profile would either be ignored (Chrome hands the URL
 * to the running instance) or corrupt it. Instead the few files that carry a
 * web session are copied into the throwaway profile:
 *
 *   Local State                  cookies encryption key (DPAPI, same user + PC)
 *   Default/Network/Cookies      cookies, including the DeepSeek session
 *   Default/Cookies              same file on older Chromium versions
 *   Default/Local Storage/leveldb  where the web app keeps `userToken`
 *
 * Everything else (history, extensions, preferences, passwords) is left behind,
 * so the temporary window is small and does not inherit the user's setup.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROFILE_DIR = "Default";

/** Browser family implied by the executable that is about to be launched. */
export function familyFromExecutable(executable) {
  const value = String(executable || "").toLowerCase();
  if (value.includes("msedge")) return "edge";
  if (value.includes("brave")) return "brave";
  if (value.includes("vivaldi")) return "vivaldi";
  if (value.includes("chromium")) return "chromium";
  if (value.includes("chrome")) return "chrome";
  return "";
}

/** Root `User Data` directory of an installed browser, whether or not it runs. */
export function systemUserDataDir(family, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const app = { edge: "Microsoft/Edge", chrome: "Google/Chrome", brave: "BraveSoftware/Brave-Browser", vivaldi: "Vivaldi", chromium: "Chromium" }[family];
  if (!app) return "";
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(local, ...app.split("/"), "User Data");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", ...app.split("/"));
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(config, ...app.split("/"));
}

/** Session files worth copying, relative to the `User Data` root. */
const sessionFiles = (profile) => ["Local State", `${profile}/Network/Cookies`, `${profile}/Cookies`];

/** Directories copied wholesale (LevelDB is a set of small files). */
const sessionDirs = (profile) => [`${profile}/Local Storage/leveldb`];

/** Does this profile's cookie database mention the given host at all? */
function cookieDbHasHost(profilePath, host) {
  try {
    const db = new DatabaseSync(path.join(profilePath, "Network", "Cookies"), { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS total FROM cookies WHERE host_key LIKE ?").get(`%${host}%`);
    db.close();
    return Number(row?.total || 0) > 0;
  } catch {
    return false;
  }
}

/** Does the profile's web storage mention the host? Used when the DB is locked. */
function webStorageMentions(profilePath, needle) {
  const dir = path.join(profilePath, "Local Storage", "leveldb");
  try {
    return readdirSync(dir).some((entry) => {
      try {
        return readFileSync(path.join(dir, entry), "latin1").includes(needle);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Which profile directory inside `User Data` holds the session. People often run
 * a second profile (`Profile 1`), so copying a hardcoded `Default` would miss the
 * login they actually use; the one that knows the host wins, then `Default`.
 */
export function pickLoginProfile(userDataDir, host = "deepseek") {
  let entries = [];
  try {
    entries = readdirSync(userDataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return "";
  }
  if (entries.length === 0) return "";
  const ranked = entries
    .map((name) => {
      const profilePath = path.join(userDataDir, name);
      const score = cookieDbHasHost(profilePath, host) ? 2 : webStorageMentions(profilePath, host) ? 1 : 0;
      return { name, score, isDefault: name === PROFILE_DIR };
    })
    .sort((a, b) => b.score - a.score || Number(b.isDefault) - Number(a.isDefault));
  return ranked[0]?.name || "";
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = path.join(from, entry);
    const target = path.join(to, entry);
    if (statSync(source).isDirectory()) copyDir(source, target);
    else copyFileSync(source, target);
  }
}

/**
 * Copy the session bits from `userDataDir` into the throwaway profile at
 * `destUserDataDir`. Returns the copied relative paths; an unreadable or
 * half-written file is skipped instead of failing the whole login, because the
 * user can still sign in by hand in the window that opens.
 */
export function copyProfileSnapshot(userDataDir, destUserDataDir, profile = PROFILE_DIR) {
  const copied = [];
  for (const relative of sessionFiles(profile)) {
    const source = path.join(userDataDir, relative);
    const target = path.join(destUserDataDir, relative);
    try {
      if (!existsSync(source)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied.push(path.normalize(relative));
    } catch {
      // Locked or torn file: the login still works, just without that cookie.
    }
  }
  for (const relative of sessionDirs(profile)) {
    const source = path.join(userDataDir, relative);
    if (!existsSync(source)) continue;
    try {
      copyDir(source, path.join(destUserDataDir, relative));
      copied.push(path.normalize(relative));
    } catch {
      // Same reasoning as above.
    }
  }
  return copied;
}

/** Session snapshot for the browser that is about to be launched, if any. */
export function restoreSystemProfile(executable, destUserDataDir, options = {}) {
  const empty = { profile: "", copied: [] };
  if (String(process.env.ZENITH_LOGIN_PROFILE || "").toLowerCase() === "isolated") return empty;
  const family = familyFromExecutable(executable);
  const userDataDir = systemUserDataDir(family, options);
  if (!userDataDir || !existsSync(userDataDir)) return empty;
  const profile = pickLoginProfile(userDataDir);
  if (!profile) return empty;
  return { profile, copied: copyProfileSnapshot(userDataDir, destUserDataDir, profile) };
}
