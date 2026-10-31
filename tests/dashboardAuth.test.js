import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import {
  checkLoginLock,
  createSessionToken,
  DEFAULT_INITIAL_PASSWORD,
  hashPassword,
  isLoginRequired,
  isUsingDefaultPassword,
  MIN_PASSWORD_LENGTH,
  recordLoginFailure,
  recordLoginSuccess,
  resetDashboardPassword,
  revokeAllDashboardSessions,
  setDashboardPassword,
  setLoginRequired,
  verifyDashboardPassword,
  verifyPasswordHash,
  verifySessionToken,
  getSessionEpoch,
  _resetLoginAttempts,
} from "../src/services/dashboardAuth.js";

function form(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return body;
}

test("Dashboard Auth - verifikasi password default dan hash scrypt", () => {
  initDb(":memory:");
  assert.strictEqual(isUsingDefaultPassword(), true);
  assert.strictEqual(verifyDashboardPassword(DEFAULT_INITIAL_PASSWORD), true);
  assert.strictEqual(verifyDashboardPassword("wrongpass"), false);

  const hash = hashPassword("rahasia123");
  assert.ok(hash.startsWith("scrypt$"));
  assert.strictEqual(verifyPasswordHash("rahasia123", hash), true);
  assert.strictEqual(verifyPasswordHash("salah", hash), false);

  // Ubah password dari default
  setDashboardPassword("passwordBaru123", DEFAULT_INITIAL_PASSWORD);
  assert.strictEqual(isUsingDefaultPassword(), false);
  assert.strictEqual(verifyDashboardPassword("passwordBaru123"), true);
  assert.strictEqual(verifyDashboardPassword(DEFAULT_INITIAL_PASSWORD), false);

  // Reset ke default (tetap butuh password lama saat ini)
  resetDashboardPassword("passwordBaru123");
  assert.strictEqual(isUsingDefaultPassword(), true);
  assert.strictEqual(verifyDashboardPassword(DEFAULT_INITIAL_PASSWORD), true);
});

test("Dashboard Auth - rate limiter 5x percobaan gagal", () => {
  _resetLoginAttempts();
  const id = "test-client-ip";

  assert.strictEqual(checkLoginLock(id).locked, false);
  for (let i = 1; i <= 4; i++) {
    const res = recordLoginFailure(id);
    assert.strictEqual(res.locked, false);
    assert.strictEqual(res.remaining, 5 - i);
  }

  // Percobaan ke-5 memicu lock
  const lockedRes = recordLoginFailure(id);
  assert.strictEqual(lockedRes.locked, true);
  assert.strictEqual(lockedRes.remaining, 0);
  assert.ok(lockedRes.retryAfter > 0);

  // checkLoginLock melaporkan status locked
  const lockStatus = checkLoginLock(id);
  assert.strictEqual(lockStatus.locked, true);

  // Reset setelah sukses
  recordLoginSuccess(id);
  assert.strictEqual(checkLoginLock(id).locked, false);
});

test("Dashboard Auth - sesi cookie HMAC 24 jam", () => {
  const token = createSessionToken({ role: "owner" });
  assert.ok(token.includes("."));
  const payload = verifySessionToken(token);
  assert.ok(payload);
  assert.strictEqual(payload.sub, "dashboard_owner");
  assert.ok(payload.exp > payload.iat);

  // Token rusak / signature invalid
  assert.strictEqual(verifySessionToken("invalid.token"), null);
  assert.strictEqual(verifySessionToken(`${token}corrupted`), null);
});

test("Dashboard Auth - alur HTTP: redirect ke /dashboard/login jika belum login dan require_login aktif", async () => {
  initDb(":memory:");
  setLoginRequired(true);

  // Simulasikan request HTTP loopback nyata (remote terdefinisi)
  const remote = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

  const res = await app.request(
    "/dashboard/usage",
    { headers: { Accept: "text/html" } },
    remote
  );
  assert.strictEqual(res.status, 302);
  assert.ok(res.headers.get("location").includes("/dashboard/login?next="));

  // Request non-HTML ke control plane mengembalikan 401
  const apiRes = await app.request(
    "/api/usage",
    { headers: { Accept: "application/json" } },
    remote
  );
  assert.strictEqual(apiRes.status, 401);
});

test("Dashboard Auth - login form dengan password default sukses dan pasang cookie", async () => {
  initDb(":memory:");
  setLoginRequired(true);
  _resetLoginAttempts();

  const remote = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

  // Password salah
  const failRes = await app.request(
    "/dashboard/login",
    {
      method: "POST",
      body: form({ password: "wrong", next: "/dashboard/usage" }),
    },
    remote
  );
  assert.strictEqual(failRes.status, 401);
  const failHtml = await failRes.text();
  assert.ok(failHtml.includes("Password salah"));

  // Password default benar
  const okRes = await app.request(
    "/dashboard/login",
    {
      method: "POST",
      body: form({ password: DEFAULT_INITIAL_PASSWORD, next: "/dashboard/usage" }),
    },
    remote
  );
  assert.strictEqual(okRes.status, 302);
  assert.strictEqual(okRes.headers.get("location"), "/dashboard/usage");
  const cookie = okRes.headers.get("set-cookie") || "";
  assert.ok(cookie.includes("zenith_session="));
  assert.ok(cookie.includes("HttpOnly"));

  // Akses dengan cookie yang terpasang
  const tokenMatch = cookie.match(/zenith_session=([^;]+)/);
  const sessionCookie = tokenMatch ? tokenMatch[1] : "";
  const authRes = await app.request(
    "/dashboard/usage",
    { headers: { Cookie: `zenith_session=${sessionCookie}` } },
    remote
  );
  assert.strictEqual(authRes.status, 200);
});

test("Dashboard Auth - banner password default muncul bila belum diganti", async () => {
  initDb(":memory:");
  const token = createSessionToken();
  const remote = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

  const html = await (
    await app.request(
      "/dashboard",
      { headers: { Cookie: `zenith_session=${token}` } },
      remote
    )
  ).text();
  assert.ok(html.includes('<div class="banner banner-warning">'), "banner peringatan terpasang");
  assert.ok(html.includes("dashboard masih memakai password awal"));
  assert.ok(html.includes("123456"));

  // Ganti password: secret sesi dirotasi, token lama ditolak (F-03).
  setDashboardPassword("newSecretPassword", DEFAULT_INITIAL_PASSWORD);
  const revoked = await app.request(
    "/dashboard",
    { headers: { Accept: "text/html", Cookie: `zenith_session=${token}` } },
    remote
  );
  assert.strictEqual(revoked.status, 302, "token terbit sebelum ganti password tidak lagi sah");
  assert.ok(revoked.headers.get("location").includes("/dashboard/login"));

  // Sesi baru dengan password baru tetap bisa masuk dan banner hilang.
  const freshToken = createSessionToken();
  const updatedHtml = await (
    await app.request(
      "/dashboard",
      { headers: { Cookie: `zenith_session=${freshToken}` } },
      remote
    )
  ).text();
  assert.ok(!updatedHtml.includes('<div class="banner banner-warning">'), "banner hilang setelah password diganti");
});

test("Dashboard Auth - password baru minimal 12 karakter dan password lama selalu wajib (F-02)", () => {
  initDb(":memory:");

  // Terlalu pendek: ditolak bahkan saat masih password default.
  assert.throws(
    () => setDashboardPassword("pendek123", DEFAULT_INITIAL_PASSWORD),
    /minimal 12 karakter/
  );

  // Password lama kosong atau salah saat masih default: ditolak.
  assert.throws(() => setDashboardPassword("passwordPanjang123", ""), /Password lama salah/);
  assert.throws(() => setDashboardPassword("passwordPanjang123", "bukan-default"), /Password lama salah/);
  assert.throws(() => setDashboardPassword("passwordPanjang123"), /Password lama salah/);
  assert.strictEqual(MIN_PASSWORD_LENGTH, 12);

  // Password lama benar, panjang cukup: diterima.
  setDashboardPassword("passwordPanjang123", DEFAULT_INITIAL_PASSWORD);
  assert.strictEqual(verifyDashboardPassword("passwordPanjang123"), true);

  // Setelah hash ada, password lama tetap wajib diverifikasi ulang.
  assert.throws(() => setDashboardPassword("passwordLainPanjang1", "salah total"), /Password lama salah/);
  assert.throws(() => setDashboardPassword("passwordLainPanjang1"), /Password lama salah/);
  setDashboardPassword("passwordLainPanjang1", "passwordPanjang123");
  assert.strictEqual(verifyDashboardPassword("passwordLainPanjang1"), true);

  // Reset darurat tetap butuh password lama.
  assert.throws(() => resetDashboardPassword("passwordLainPanjang1x"), /Password lama salah/);
  assert.throws(() => resetDashboardPassword(), /Password lama salah/);
});

test("Dashboard Auth - token sesi ditolak setelah logout-all atau ganti password (F-03)", () => {
  initDb(":memory:");
  const epochAwal = getSessionEpoch();
  const token = createSessionToken();
  assert.ok(verifySessionToken(token), "token baru sah");

  revokeAllDashboardSessions();
  assert.strictEqual(getSessionEpoch(), epochAwal + 1, "epoch naik setelah revoke");
  assert.strictEqual(verifySessionToken(token), null, "token dari epoch lama ditolak");

  // Ganti password juga menaikkan epoch (revoke semua sesi).
  setDashboardPassword("passwordPraRevoke1", "123456");
  const token2 = createSessionToken();
  assert.ok(verifySessionToken(token2), "token sesudah revoke sah");
  setDashboardPassword("passwordPraRevoke2", "passwordPraRevoke1");
  assert.strictEqual(verifySessionToken(token2), null, "ganti password membatulkan token lama");

  // Reset password juga menaikkan epoch.
  const token3 = createSessionToken();
  resetDashboardPassword("passwordPraRevoke2");
  assert.strictEqual(verifySessionToken(token3), null, "reset password membatulkan token lama");
});

test("Dashboard Auth - logout HTTP menolak token sesi lain (F-03)", async () => {
  initDb(":memory:");
  const token = createSessionToken();
  assert.ok(verifySessionToken(token), "token awal sah");

  const res = await app.request("/dashboard/logout", { method: "POST" });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(verifySessionToken(token), null, "token pemakai lain ikut mati saat logout");
});

test("Dashboard Auth - logout mencabut cookie", async () => {
  initDb(":memory:");
  const res = await app.request("/dashboard/logout", { method: "POST" });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/login");
  const cookie = res.headers.get("set-cookie") || "";
  assert.ok(cookie.includes("zenith_session="));
  assert.ok(cookie.includes("Max-Age=0"));
});
