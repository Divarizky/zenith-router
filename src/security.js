import { cors } from "hono/cors";
import { getSetting } from "./services/settings.js";
import { extractClientApiKey, verifyApiKey } from "./services/apiKeys.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Address the server binds to. Defaults to loopback so the gateway is not reachable from the LAN.
 */
export function getBindHost() {
  return process.env.HOST || "127.0.0.1";
}

export function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return LOOPBACK_HOSTNAMES.has(h) || h.startsWith("127.");
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
    const allowed = listFromEnv("ZENROUTE_ALLOWED_HOSTS").map((h) => h.toLowerCase());
    if (!isLoopbackHost(hostname) && !allowed.includes(hostname)) {
      return c.text("Forbidden host", 403);
    }
  }
  await next();
}

function isControlPlanePath(path) {
  return path === "/" || path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/api/");
}

/**
 * Dashboard and /api are only reachable from this machine, and state-changing
 * requests must come from the dashboard itself (CSRF protection).
 */
export async function controlPlaneGuard(c, next) {
  if (!isControlPlanePath(c.req.path)) {
    return next();
  }

  // In-process requests (app.request in tests) have no socket.
  const remote = c.env?.incoming?.socket?.remoteAddress;
  if (remote && !isLoopbackAddress(remote)) {
    return c.text("Dashboard is only available from localhost", 403);
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
 * CORS is opt-in for /v1 via ZENROUTE_CORS_ORIGINS. CLI agents do not need it.
 */
export async function corsOptIn(c, next) {
  const origins = listFromEnv("ZENROUTE_CORS_ORIGINS");
  if (origins.length === 0) {
    return next();
  }
  return cors({
    origin: origins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "x-api-key", "anthropic-version", "anthropic-beta", "x-zenroute-token-saver"],
  })(c, next);
}

/**
 * Require a JSON body on /v1 POSTs. A browser can only send JSON cross-origin after a
 * CORS preflight, so this stops websites from firing "simple" requests at the gateway.
 */
export async function requireJsonBody(c, next) {
  if (c.req.method === "POST") {
    const contentType = (c.req.header("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return gatewayError(c, 415, "invalid_request_error", "Content-Type must be application/json");
    }
  }
  await next();
}

/**
 * Validate the zenroute gateway key. The key never travels upstream; provider
 * credentials come from the stored connection.
 */
export async function gatewayAuth(c, next) {
  if (c.req.method === "OPTIONS" || !isApiKeyRequired()) {
    return next();
  }

  const key = extractClientApiKey(c.req.raw.headers);
  if (!key) {
    return gatewayError(c, 401, "authentication_error", "Missing zenroute API key");
  }
  if (!verifyApiKey(key)) {
    return gatewayError(c, 401, "authentication_error", "Invalid zenroute API key");
  }

  await next();
}
