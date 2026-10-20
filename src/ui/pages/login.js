import { escapeHtml } from "../html.js";
import {
  buildSessionCookieClearHeader,
  buildSessionCookieHeader,
  checkLoginLock,
  createSessionToken,
  DEFAULT_INITIAL_PASSWORD,
  hasValidDashboardSession,
  isLoginRequired,
  isUsingDefaultPassword,
  recordLoginFailure,
  recordLoginSuccess,
  verifyDashboardPassword,
} from "../../services/dashboardAuth.js";
import {
  hasValidAdminToken,
  isAdminProtected,
  sanitizeAdminNext,
  verifyAdminToken,
  buildAdminCookieHeader,
  buildAdminCookieClearHeader,
} from "../../services/adminAuth.js";

function getClientIdentifier(c) {
  const remote = c.env?.incoming?.socket?.remoteAddress;
  return remote || "local";
}

/**
 * Halaman login dashboard:
 * - Menampilkan hint password default 123456 bila belum diganti.
 * - Menampilkan lockout bila terkena rate limiter.
 * - Form action ke /dashboard/login.
 */
export function renderDashboardLoginPage({
  next = "/dashboard",
  error = "",
  remaining = null,
  lockout = false,
  retryAfter = 0,
} = {}) {
  const safeNext = sanitizeAdminNext(next);
  const isAdminMode = isAdminProtected();
  const showDefaultHint = isUsingDefaultPassword() && !isAdminMode;
  const fieldId = isAdminMode ? "token" : "password";

  let alertHtml = "";
  if (lockout) {
    alertHtml = `<div class="alert alert-danger" role="alert">Terlalu banyak percobaan gagal. Coba lagi dalam <strong>${escapeHtml(retryAfter)} detik</strong>.</div>`;
  } else if (error) {
    const attemptsText = remaining !== null ? ` Sisa ${escapeHtml(remaining)} percobaan sebelum terkunci.` : "";
    alertHtml = `<div class="alert alert-danger" role="alert">${escapeHtml(error)}.${attemptsText}</div>`;
  } else if (showDefaultHint) {
    alertHtml = `<div class="alert alert-info">Password awal: <code>${escapeHtml(DEFAULT_INITIAL_PASSWORD)}</code>. Ganti lewat menu Settings setelah masuk.</div>`;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/logo.png">
  <title>Login &middot; Zenith Router</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --surface: #161616;
      --surface-2: #1f1f1f;
      --border: #2a2a2a;
      --border-subtle: #222222;
      --text: #fafafa;
      --text-muted: #a3a3a3;
      --text-subtle: #737373;
      --accent: #fafafa;
      --danger: #f87171;
      --info: #93c5fd;
      --radius: 10px;
      --radius-lg: 14px;
      --shadow: 0 12px 28px -4px rgba(0, 0, 0, 0.5);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    code {
      background: var(--surface-2); padding: 0.15rem 0.4rem; border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.82rem; color: var(--text);
    }
    .login-card {
      width: 100%; max-width: 360px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: 1.5rem;
    }
    .brand { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem; }
    .brand img { width: 36px; height: 36px; border-radius: 8px; object-fit: cover; display: block; }
    .brand h1 { font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
    .brand p { font-size: 0.78rem; color: var(--text-subtle); }
    .alert {
      padding: 0.6rem 0.75rem; border-radius: 8px; font-size: 0.82rem;
      border: 1px solid var(--border); margin-bottom: 1rem;
    }
    .alert-info { color: var(--info); border-color: rgba(147, 197, 253, 0.3); background: rgba(147, 197, 253, 0.08); }
    .alert-danger { color: var(--danger); border-color: rgba(248, 113, 113, 0.3); background: rgba(248, 113, 113, 0.08); }
    .alert strong { font-weight: 600; }
    form { display: flex; flex-direction: column; gap: 0.9rem; }
    label { font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-bottom: -0.4rem; }
    input[type="password"] {
      width: 100%; background: #0d0d0d; border: 1px solid var(--border); color: var(--text);
      padding: 0.55rem 0.75rem; border-radius: 8px; font-size: 0.88rem; font-family: inherit;
    }
    input[type="password"]:focus {
      outline: none; border-color: var(--text-subtle); box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.08);
    }
    input[type="password"]:disabled { opacity: 0.6; }
    button {
      margin-top: 0.15rem; padding: 0.55rem 0.95rem; border-radius: 8px;
      border: 1px solid var(--accent); background: var(--accent); color: #0a0a0a;
      font-size: 0.85rem; font-weight: 500; font-family: inherit; cursor: pointer;
      transition: background 0.12s;
    }
    button:hover:not(:disabled) { background: #d4d4d4; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .foot {
      margin-top: 1.1rem; padding-top: 0.9rem; border-top: 1px solid var(--border-subtle);
      font-size: 0.75rem; color: var(--text-subtle); text-align: center;
    }
  </style>
</head>
<body>
  <main class="login-card">
    <div class="brand">
      <img src="/logo.png" alt="" />
      <div>
        <h1>Zenith Router</h1>
        <p>Personal AI Gateway</p>
      </div>
    </div>

    ${alertHtml}

    <form action="/dashboard/login" method="post">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}">
      <label for="${fieldId}">${isAdminMode ? "Token admin" : "Password dashboard"}</label>
      <input type="password" id="${fieldId}" name="${fieldId}" autocomplete="current-password" autofocus required ${lockout ? "disabled" : ""}>
      <button type="submit" ${lockout ? "disabled" : ""}>Masuk</button>
    </form>

    <p class="foot">Hanya dari loopback &middot; Sesi berlaku 24 jam</p>
  </main>
</body>
</html>`;
}

/** GET /dashboard/login: jika sudah punya sesi sah atau login tidak diwajibkan, langsung arahkan ke dashboard. */
export function handleDashboardLoginPage(c) {
  const next = sanitizeAdminNext(c.req.query("next"));
  const isReal = Boolean(c.env?.incoming?.socket?.remoteAddress);
  const required = isAdminProtected() || isLoginRequired(isReal);
  const alreadyAuth = (isAdminProtected() && hasValidAdminToken(c)) || hasValidDashboardSession(c);

  if (!required || alreadyAuth) {
    return c.redirect(next);
  }
  return c.html(renderDashboardLoginPage({ next }), 200);
}

/**
 * POST /dashboard/login: memvalidasi password atau token admin.
 * Memasang cookie sesi HMAC `zenith_session` (24 jam) bila berhasil.
 */
export async function handleDashboardLogin(c) {
  const body = await c.req.parseBody().catch(() => ({}));
  const next = sanitizeAdminNext(body.next);
  const passwordInput = String(body.password || body.token || "").trim();
  const clientId = getClientIdentifier(c);

  // Periksa apakah IP sedang terkunci oleh limiter
  const lock = checkLoginLock(clientId);
  if (lock.locked) {
    return c.html(
      renderDashboardLoginPage({ next, lockout: true, retryAfter: lock.retryAfter }),
      429
    );
  }

  let isValid = false;

  // 1. Cek token admin jika ZENITH_ADMIN_TOKEN terpasang
  if (isAdminProtected() && verifyAdminToken(passwordInput)) {
    isValid = true;
    c.header("Set-Cookie", buildAdminCookieHeader());
  }

  // 2. Cek password dashboard normal
  if (!isValid && verifyDashboardPassword(passwordInput)) {
    isValid = true;
  }

  if (isValid) {
    recordLoginSuccess(clientId);
    const sessionToken = createSessionToken();
    const sessionCookie = buildSessionCookieHeader(sessionToken);

    if (isAdminProtected()) {
      const adminCookie = buildAdminCookieHeader();
      c.header("Set-Cookie", adminCookie);
      c.res.headers.append("Set-Cookie", sessionCookie);
    } else {
      c.header("Set-Cookie", sessionCookie);
    }

    return c.redirect(next);
  }

  // Jika proteksi admin aktif, kembalikan 403 Forbidden dengan pesan token admin salah
  if (isAdminProtected()) {
    return c.html(
      renderDashboardLoginPage({ next, error: "Token admin salah" }),
      403
    );
  }

  // Gagal password biasa: catat ke limiter dan tampilkan error 401
  const fail = recordLoginFailure(clientId);
  if (fail.locked) {
    return c.html(
      renderDashboardLoginPage({ next, lockout: true, retryAfter: fail.retryAfter }),
      429
    );
  }

  return c.html(
    renderDashboardLoginPage({
      next,
      error: "Password salah",
      remaining: fail.remaining,
    }),
    401
  );
}

/** POST /dashboard/logout: cabut cookie sesi. */
export async function handleDashboardLogout(c) {
  const sessionClear = buildSessionCookieClearHeader();
  const adminClear = buildAdminCookieClearHeader();
  c.header("Set-Cookie", sessionClear);
  c.res.headers.append("Set-Cookie", adminClear);
  return c.redirect("/dashboard/login");
}
