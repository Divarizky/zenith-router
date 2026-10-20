import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCookie } from "hono/cookie";
import { getSetting, setSetting } from "./settings.js";

export const SESSION_COOKIE_NAME = "zenith_session";
export const DEFAULT_INITIAL_PASSWORD = "123456";
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60; // 24 jam

// Tangga penguncian: 30d, 2m, 10m, 30m setelah 5x gagal berturut-turut.
const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000];
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 jam tanpa fail mereset counter

const loginAttempts = new Map();

export function _resetLoginAttempts() {
  loginAttempts.clear();
}

function now() {
  return Date.now();
}

/** Limiter berbasis identifier (IP/klien). */
export function checkLoginLock(identifier = "local") {
  const e = loginAttempts.get(identifier);
  if (!e) return { locked: false, remaining: MAX_FAILS_BEFORE_LOCK };

  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    loginAttempts.delete(identifier);
    return { locked: false, remaining: MAX_FAILS_BEFORE_LOCK };
  }

  if (e.lockUntil && now() < e.lockUntil) {
    const retryAfter = Math.max(1, Math.ceil((e.lockUntil - now()) / 1000));
    return { locked: true, retryAfter, remaining: 0 };
  }

  return { locked: false, remaining: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordLoginFailure(identifier = "local") {
  const current = loginAttempts.get(identifier) || { fails: 0, lockLevel: 0, lastFailAt: 0, lockUntil: 0 };
  current.fails += 1;
  current.lastFailAt = now();

  if (current.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(current.lockLevel, LOCK_STEPS_MS.length - 1)];
    current.lockUntil = now() + step;
    current.lockLevel += 1;
    loginAttempts.set(identifier, current);
    const retryAfter = Math.ceil(step / 1000);
    return { locked: true, retryAfter, remaining: 0 };
  }

  loginAttempts.set(identifier, current);
  return { locked: false, remaining: Math.max(0, MAX_FAILS_BEFORE_LOCK - current.fails) };
}

export function recordLoginSuccess(identifier = "local") {
  loginAttempts.delete(identifier);
}

// Secret sesi: dibaca dari env atau file data/session-secret yang dibuat otomatis.
let cachedSessionSecret = null;

export function getSessionSecret() {
  if (process.env.ZENITH_SESSION_SECRET) return process.env.ZENITH_SESSION_SECRET;
  if (cachedSessionSecret) return cachedSessionSecret;

  const dataDir = process.env.ZENITH_DATA_DIR || "data";
  const file = join(dataDir, "session-secret");
  try {
    if (existsSync(file)) {
      cachedSessionSecret = readFileSync(file, "utf8").trim();
      if (cachedSessionSecret) return cachedSessionSecret;
    }
  } catch {}

  try {
    mkdirSync(dataDir, { recursive: true });
    cachedSessionSecret = randomBytes(32).toString("hex");
    writeFileSync(file, cachedSessionSecret, { mode: 0o600 });
    return cachedSessionSecret;
  } catch {
    // Fallback in-memory bila filesystem readonly
    cachedSessionSecret = randomBytes(32).toString("hex");
    return cachedSessionSecret;
  }
}

export function _setSessionSecretForTests(secret) {
  cachedSessionSecret = secret;
}

/** Hash password menggunakan scrypt bawaan node:crypto (zero external dependencies). */
export function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPasswordHash(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHash] = parts;
  try {
    const derived = scryptSync(plain, salt, 64).toString("hex");
    const a = Buffer.from(derived, "hex");
    const b = Buffer.from(expectedHash, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Password default yang berlaku sebelum pengguna mengubahnya. */
export function getInitialPassword() {
  return String(process.env.ZENITH_INITIAL_PASSWORD || DEFAULT_INITIAL_PASSWORD);
}

/** Cek apakah dashboard masih memakai password default (perlu banner peringatan). */
export function isUsingDefaultPassword() {
  const storedHash = getSetting("dashboard_password_hash", null);
  if (!storedHash) return true; // Belum pernah ganti password
  return false;
}

/**
 * Verifikasi password yang dimasukkan:
 * - Bila pernah disimpan hash di DB, cek terhadap hash itu.
 * - Bila belum, cek terhadap INITIAL_PASSWORD (default 123456).
 */
export function verifyDashboardPassword(input) {
  if (typeof input !== "string" || !input) return false;
  const storedHash = getSetting("dashboard_password_hash", null);
  if (storedHash) {
    return verifyPasswordHash(input, storedHash);
  }
  return input === getInitialPassword();
}

/** Ganti password dashboard. Wajib menyertakan currentPassword bila sudah ada hash di DB. */
export function setDashboardPassword(newPlain, currentPlain = null) {
  if (typeof newPlain !== "string" || newPlain.length < 4) {
    throw new Error("Password baru minimal 4 karakter");
  }
  const storedHash = getSetting("dashboard_password_hash", null);
  if (storedHash) {
    if (!currentPlain || !verifyPasswordHash(currentPlain, storedHash)) {
      throw new Error("Password lama salah");
    }
  } else {
    // Masih memakai password default, validasi terhadap default
    if (currentPlain && currentPlain !== getInitialPassword()) {
      throw new Error("Password lama salah");
    }
  }
  const newHash = hashPassword(newPlain);
  setSetting("dashboard_password_hash", newHash);
  return true;
}

/** Reset password ke default (menghapus hash di settings) untuk menu CLI atau darurat. */
export function resetDashboardPassword() {
  setSetting("dashboard_password_hash", "");
  return true;
}

/** Cek setting require_login: default aktif (true) untuk HTTP nyata, false untuk in-process test tanpa socket. */
export function isLoginRequired(isRealHttp = false) {
  const val = getSetting("require_login", isRealHttp ? "true" : "false");
  return val !== "false" && val !== "0";
}

export function setLoginRequired(required) {
  setSetting("require_login", required ? "true" : "false");
}

/** Buat token sesi bertanda HMAC: payload base64url + titik + signature base64url. */
export function createSessionToken(claims = {}) {
  const payload = {
    sub: "dashboard_owner",
    iat: Math.floor(now() / 1000),
    exp: Math.floor(now() / 1000) + SESSION_MAX_AGE_SECONDS,
    ...claims,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const expectedSig = createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookieHeader(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function buildSessionCookieClearHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Validasi apakah request membawa sesi dashboard yang sah:
 * 1. Token admin (ZENITH_ADMIN_TOKEN atau header x-zenith-admin-token) selalu diterima.
 * 2. Cookie zenith_session yang sah.
 * 3. Cookie legacy zenith_admin_token (dari F-14) bila masih ada.
 */
export function hasValidDashboardSession(c) {
  const cookieVal = getCookie(c, SESSION_COOKIE_NAME);
  if (cookieVal && verifySessionToken(cookieVal)) return true;

  // Kompatibilitas dengan F-14 admin cookie
  const legacyAdminCookie = getCookie(c, "zenith_admin_token");
  if (legacyAdminCookie) {
    const expected = String(process.env.ZENITH_ADMIN_TOKEN || "").trim();
    if (expected && legacyAdminCookie === expected) return true;
  }

  return false;
}
