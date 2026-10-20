import { cors } from "hono/cors";
import { getSetting } from "./services/settings.js";
import { extractClientApiKey, verifyApiKey } from "./services/apiKeys.js";
import {
  hasValidAdminToken,
  isAdminProtected,
} from "./services/adminAuth.js";
import {
  hasValidDashboardSession,
  isLoginRequired,
} from "./services/dashboardAuth.js";
import { renderDashboardLoginPage } from "./ui/pages/login.js";

const DASHBOARD_AUTH_EXEMPT_PATHS = new Set(["/dashboard/login", "/dashboard/logout"]);

function dashboardChallenge(c) {
  const acceptsHtml = String(c.req.header("accept") || "").includes("text/html");
  const isHtml = (c.req.method === "GET" || c.req.method === "HEAD") && acceptsHtml;
  const { pathname, search } = new URL(c.req.url);

  // Jika ZENITH_ADMIN_TOKEN aktif, kembalikan 403 Forbidden sesuai kontrak F-14
  if (isAdminProtected()) {
    if (isHtml) {
      return c.html(renderDashboardLoginPage({ next: pathname + search }), 403);
    }
    return c.text("Forbidden", 403);
  }

  // Jika require_login aktif biasa
  if (isHtml) {
    return c.redirect(`/dashboard/login?next=${encodeURIComponent(pathname + search)}`);
  }
  return c.text("Unauthorized", 401);
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Address the server binds to. Defaults to loopback so the gateway is not reachable from the LAN.
 */
export function getBindHost() {
  return process.env.HOST || "127.0.0.1";
}

/**
 * Base URL that local clients should use. Wildcard binds are reached through 127.0.0.1.
 */
export function getLocalBaseUrl(port) {
  const host = getBindHost();
  const local = host === "0.0.0.0" || host === "::" || isLoopbackHost(host) ? "127.0.0.1" : host;
  return `http://${local.includes(":") ? `[${local}]` : local}:${port}`;
}

export function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  // Only a literal 127.x.x.x address: a domain like 127.attacker.example can be
  // rebound to 127.0.0.1 and must not pass as loopback.
  return LOOPBACK_HOSTNAMES.has(h) || /^127(\.\d{1,3}){3}$/.test(h);
}

function isLoopbackAddress(address) {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || a.startsWith("127.");
}

function listFromEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Gateway keys are mandatory when the user enables them, and always when the server is exposed beyond loopback.
 */
export function isApiKeyRequired() {
  return getSetting("require_api_key", "false") === "true" || !isLoopbackHost(getBindHost());
}

function isAnthropicPath(path) {
  return path.startsWith("/v1/messages");
}

function gatewayError(c, status, type, message) {
  if (isAnthropicPath(c.req.path)) {
    return c.json({ type: "error", error: { type, message } }, status);
  }
  return c.json({ error: { message, type, code: type } }, status);
}

/**
 * Reject requests whose Host is not loopback while bound to loopback.
 * Blocks DNS rebinding, where a malicious site resolves its own domain to 127.0.0.1.
 */
export async function hostGuard(c, next) {
  if (isLoopbackHost(getBindHost())) {
    const hostname = new URL(c.req.url).hostname.toLowerCase();
    const allowed = listFromEnv("ZENITH_ALLOWED_HOSTS").map((h) => h.toLowerCase());
    if (!isLoopbackHost(hostname) && !allowed.includes(hostname)) {
      return c.text("Forbidden host", 403);
    }
  }
  await next();
}

function isControlPlanePath(path) {
  // /callback receives OAuth codes, so it is as local-only as the dashboard.
  return (
    path === "/" ||
    path === "/dashboard" ||
    path === "/callback" ||
    path.startsWith("/dashboard/") ||
    path.startsWith("/api/")
  );
}

/**
 * Dashboard and /api are only reachable from this machine, and state-changing
 * requests must come from the dashboard itself (CSRF protection).
 * With ZENITH_ADMIN_TOKEN set they additionally require the admin token, so a
 * container that reaches the host through loopback cannot read credentials.
 */
export async function controlPlaneGuard(c, next) {
  if (!isControlPlanePath(c.req.path)) {
    return next();
  }

  // Dashboard & control-plane responses must never be cached by browser or proxy.
  c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  // In-process requests (app.request in tests) have no socket.
  const remote = c.env?.incoming?.socket?.remoteAddress;
  if (remote && !isLoopbackAddress(remote)) {
    return c.text("Dashboard is only available from localhost", 403);
  }

  // Wajib login dashboard:
  // Aktif bila:
  // 1. ZENITH_ADMIN_TOKEN diset, ATAU
  // 2. Akses dari HTTP server nyata (remote terdefinisi) dan require_login aktif (default true), ATAU
  // 3. require_login eksplisit diset "true" di DB / env.
  const isRealHttp = Boolean(remote);
  const requireLoginVal = getSetting("require_login", isRealHttp ? "true" : "false");
  const mustAuthenticate = isAdminProtected() || (requireLoginVal !== "false" && requireLoginVal !== "0");

  if (mustAuthenticate && !DASHBOARD_AUTH_EXEMPT_PATHS.has(c.req.path)) {
    let isAuthenticated = hasValidDashboardSession(c);
    if (!isAuthenticated && isAdminProtected() && hasValidAdminToken(c)) {
      isAuthenticated = true;
    }
    if (!isAuthenticated) {
      return dashboardChallenge(c);
    }
  }

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return c.text("Cross-site request blocked", 403);
    }

    const origin = c.req.header("origin");
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {}
      if (!originHost || originHost !== new URL(c.req.url).host) {
        return c.text("Cross-site request blocked", 403);
      }
    }
  }

  await next();
}

/**
 * CORS is opt-in for /v1 via ZENITH_CORS_ORIGINS. CLI agents do not need it.
 */
export async function corsOptIn(c, next) {
  const origins = listFromEnv("ZENITH_CORS_ORIGINS");
  if (origins.length === 0) {
    return next();
  }
  return cors({
    origin: origins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "x-api-key", "anthropic-version", "anthropic-beta", "x-zenith-token-saver"],
  })(c, next);
}

/**
 * Require a JSON body on /v1 POSTs. A browser can only send JSON cross-origin after a
 * CORS preflight, so this stops websites from firing "simple" requests at the gateway.
 */
export async function requireJsonBody(c, next) {
  if (c.req.method === "POST") {
    // Compare the MIME essence exactly: `text/plain; x=application/json` is still a
    // CORS-safelisted type and would otherwise slip through without a preflight.
    const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return gatewayError(c, 415, "invalid_request_error", "Content-Type must be application/json");
    }
  }
  await next();
}

/**
 * Validate the zenith-router gateway key. The key never travels upstream; provider
 * credentials come from the stored connection.
 */
export async function gatewayAuth(c, next) {
  if (c.req.method === "OPTIONS") {
    return next();
  }

  const key = extractClientApiKey(c.req.raw.headers);
  if (key) {
    const verified = verifyApiKey(key);
    if (verified) {
      c.set("apiKeyId", verified.id);
      c.set("apiKeyName", verified.name);
    } else if (isApiKeyRequired()) {
      return gatewayError(c, 401, "authentication_error", "Invalid Zenith Router API key");
    }
  } else if (isApiKeyRequired()) {
    return gatewayError(c, 401, "authentication_error", "Missing Zenith Router API key");
  }

  await next();
}
