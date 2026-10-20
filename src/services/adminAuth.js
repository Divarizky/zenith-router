import { createHash, timingSafeEqual } from "node:crypto";
import { getCookie } from "hono/cookie";

export const ADMIN_COOKIE_NAME = "zenith_admin_token";
export const ADMIN_LOGIN_PATH = "/dashboard/login";
export const ADMIN_LOGOUT_PATH = "/dashboard/logout";
// Tujuh hari: dashboard dipakai berulang, token admin tidak berputar sendiri.
const ADMIN_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Token admin control plane dari env ZENITH_ADMIN_TOKEN.
 * Kosong berarti proteksi admin nonaktif dan perilaku lama (loopback-only) tetap berlaku.
 */
export function getAdminToken() {
  return String(process.env.ZENITH_ADMIN_TOKEN || "").trim();
}

export function isAdminProtected() {
  return getAdminToken().length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

// Hash kedua sisi agar timingSafeEqual menerima panjang berapa pun dan
// perbandingan tidak membocorkan panjang token yang benar.
function tokenEquals(candidate, expected) {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

/**
 * Kandidat token dari header x-zenith-admin-token, Authorization Bearer, dan cookie dashboard.
 * Cookie dipakai browser karena navigasi halaman tidak bisa mengirim header kustom.
 */
function adminTokenCandidates(c) {
  const candidates = [];
  const headerToken = String(c.req.header("x-zenith-admin-token") || "").trim();
  if (headerToken) candidates.push(headerToken);
  const authorization = String(c.req.header("authorization") || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) {
    const bearer = authorization.slice(7).trim();
    if (bearer) candidates.push(bearer);
  }
  const cookieToken = String(getCookie(c, ADMIN_COOKIE_NAME) || "").trim();
  if (cookieToken) candidates.push(cookieToken);
  return candidates;
}

export function hasValidAdminToken(c) {
  const expected = getAdminToken();
  if (!expected) return true;
  return adminTokenCandidates(c).some((candidate) => tokenEquals(candidate, expected));
}

export function verifyAdminToken(candidate) {
  const expected = getAdminToken();
  if (!expected) return false;
  return typeof candidate === "string" && candidate.length > 0 && tokenEquals(candidate, expected);
}

export function buildAdminCookieHeader() {
  return `${ADMIN_COOKIE_NAME}=${getAdminToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_COOKIE_MAX_AGE_SECONDS}`;
}

export function buildAdminCookieClearHeader() {
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Tujuan redirect setelah login harus tetap di host yang sama.
 * Nilai seperti //evil.example dibuang supaya tidak jadi open redirect.
 */
export function sanitizeAdminNext(raw, fallback = "/dashboard") {
  const value = String(raw || "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.includes("\\") || /[\r\n]/.test(value)) return fallback;
  return value;
}
