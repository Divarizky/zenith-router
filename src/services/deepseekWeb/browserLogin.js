/**
 * One-click login flow for browser-session providers.
 *
 * The dashboard starts a flow, the browser opens on the provider's login page,
 * and the capture runs in the background; the page polls the flow until it is
 * done. The driver (services/deepseekWeb/cdpLogin.js) is injectable so tests can
 * exercise the state machine without launching a browser.
 */
import crypto from "node:crypto";
import { addConnection, getConnections, mergeConnectionCredentials } from "../../db/index.js";
import { getProvider } from "../../providers/index.js";
import { captureBrowserSession } from "./cdpLogin.js";
import { normalizeSessionToken } from "./token.js";

// The flow lives slightly longer than the browser budget so the driver, not the
// pruning, is what reports a timeout.
const LOGIN_BUDGET_MS = () => (Number(process.env.ZENITH_LOGIN_TIMEOUT_MS) > 0 ? Number(process.env.ZENITH_LOGIN_TIMEOUT_MS) : 5 * 60 * 1000);
// After it settles, keep the result around briefly so the dashboard can read it.
const RESULT_TTL_MS = 2 * 60 * 1000;

const flows = new Map();

const defaultDriver = () => ({ captureSession: captureBrowserSession });
let driverFactory = defaultDriver;

/** Swap the browser driver; tests use this to avoid starting a real browser. */
export function setBrowserLoginDriver(factory) {
  driverFactory = typeof factory === "function" ? factory : defaultDriver;
}

export function resetBrowserLoginDriver() {
  driverFactory = defaultDriver;
}

function prune(now = Date.now()) {
  for (const [id, flow] of flows) {
    if (flow.expiresAt > now) continue;
    flow.controller?.abort();
    flows.delete(id);
  }
}

function finish(flow, patch) {
  Object.assign(flow, patch);
  flow.expiresAt = Math.min(flow.expiresAt, Date.now() + RESULT_TTL_MS);
}

/**
 * The account that already holds this session token, if any. Logging in twice
 * from the same browser profile yields the same token, and a second row would
 * double the parallel turns one web login is allowed.
 */
export function findSessionAccount(providerId, token) {
  const wanted = normalizeSessionToken(token);
  if (!wanted) return null;
  return (
    getConnections(providerId).find(
      (connection) => normalizeSessionToken(connection?.credentials?.token || "") === wanted
    ) || null
  );
}

function defaultName(provider) {
  const stamp = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `Sesi web ${stamp}`;
}

/**
 * Start a login. Rejects when the provider does not use session auth or when a
 * login for the same provider is still waiting, so only one browser opens.
 */
export function startBrowserLogin({ providerId, name = "", proxyUrl = "" } = {}) {
  prune();
  const provider = getProvider(providerId);
  if (!provider) throw new Error("Provider tidak dikenal.");
  if (!(provider.authMethods || []).includes("session")) {
    throw new Error("Provider ini tidak memakai token sesi browser.");
  }
  for (const flow of flows.values()) {
    if (flow.providerId === provider.id && flow.status === "pending") {
      throw new Error("Login untuk provider ini masih berjalan. Selesaikan atau batalkan dulu.");
    }
  }

  const flowId = crypto.randomBytes(16).toString("base64url");
  const controller = new AbortController();
  const flow = {
    id: flowId,
    providerId: provider.id,
    name: String(name || "").trim(),
    proxyUrl: String(proxyUrl || "").trim(),
    status: "pending",
    controller,
    expiresAt: Date.now() + LOGIN_BUDGET_MS() + 30 * 1000,
  };
  flows.set(flowId, flow);

  // Run the driver now rather than on a later tick: the flow is only useful once
  // the browser is actually starting, and a failure should be visible at once.
  let capture;
  try {
    capture = Promise.resolve(
      driverFactory().captureSession({
        proxyUrl: flow.proxyUrl,
        signal: controller.signal,
        // Surfaced by the poll so the dialog can say what the browser is doing.
        onStatus: (phase) => {
          flow.phase = String(phase || "");
        },
      })
    );
  } catch (err) {
    finish(flow, { status: "error", error: err?.message || "Login browser gagal." });
    return { flowId };
  }

  capture
    .then((session) => {
      if (flow.status !== "pending") return;
      const token = normalizeSessionToken(session?.token);
      if (!token) throw new Error("Token sesi tidak ditemukan setelah login.");
      const cookies = String(session?.cookies || "").trim();
      const existing = findSessionAccount(provider.id, token);
      if (existing) {
        // Same login: refresh its cookies instead of adding a twin.
        if (cookies) mergeConnectionCredentials(existing.id, { cookies });
        finish(flow, { status: "done", account: existing.name || "", existing: true });
        return;
      }
      const connection = addConnection({
        provider: provider.id,
        name: flow.name || defaultName(provider),
        auth_type: "session",
        credentials: { token, cookies },
        proxy_url: flow.proxyUrl || null,
        proxy_pool_id: null,
      });
      finish(flow, { status: "done", account: connection?.name || "" });
    })
    .catch((err) => {
      if (flow.status !== "pending") return;
      finish(flow, { status: "error", error: err?.message || "Login browser gagal." });
    });

  return { flowId };
}

/** Status for the dashboard poll. Never includes the token. */
export function pollBrowserLogin(flowId) {
  prune();
  const flow = flows.get(String(flowId || ""));
  if (!flow) return { status: "error", error: "Sesi login kedaluwarsa. Ulangi login." };
  return { status: flow.status, phase: flow.phase || "", error: flow.error, account: flow.account, existing: Boolean(flow.existing) };
}

export function cancelBrowserLogin(flowId) {
  const flow = flows.get(String(flowId || ""));
  if (!flow) return false;
  flow.controller.abort();
  flows.delete(flow.id);
  return true;
}

/** Test helper: drop every flow and stop the browsers behind them. */
export function resetBrowserLogins() {
  for (const flow of flows.values()) flow.controller?.abort();
  flows.clear();
}
