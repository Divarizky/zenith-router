import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
// Versi tampilan (banner CLI, /health, sidebar) dibaca dari package.json agar tidak basi saat bump.
import pkg from "../package.json" with { type: "json" };
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import { handleListModels, handleGetModelOptions } from "./gateway/models.js";
import { handleChat } from "./gateway/chat.js";
import { handleMessages } from "./gateway/messages.js";
import { handleResponses } from "./gateway/responses.js";
import { handleGetUsage, getLastProvider, getRecentUsage } from "./services/usage.js";
import { getActiveProviders } from "./services/trafficGuard.js";
import { handleGetQuota, handleSyncQuotaForm } from "./services/quota.js";
import { getVersionInfo } from "./services/version.js";
import { handleUpgradeRequest, getUpgradeCapability } from "./services/upgrade.js";
import {
  initConsoleLogCapture,
  getConsoleLogs,
  clearConsoleLogs,
  getConsoleEmitter,
  captureLine,
} from "./services/logger.js";
import { renderOverviewPage } from "./ui/pages/overview.js";
import {
  renderProvidersPage,
  renderProviderDetailPage,
  handleAddAccount,
  handleSetAccountProxy,
  handleSetProxyRotation,
  handleSetProviderConcurrency,
  handleDeleteAccount,
  handleCheckSession,
  handleUpdateSession,
  handleMoveAccount,
  handleAddCustomModel,
  handleDeleteCustomModel,
  handleDisableModel,
  handleEnableModel,
  handleImportModels,
  handleClearImported,
  handleDeleteImported,
  handleSyncFreeModels,
  handleTestConnection,
} from "./ui/pages/providers.js";
import {
  renderProxiesPage,
  handleAddProxy,
  handleImportProxies,
  handleTestProxy,
  handleUpdateProxy,
  handleDeleteProxy,
  handleToggleProxy,
  handleBulkEnableProxies,
  handleBulkDisableProxies,
  handleBulkDeleteProxies,
} from "./ui/pages/proxies.js";
import {
  handleOAuthStart,
  handleOAuthPoll,
  handleOAuthManual,
  handleOAuthCancel,
  handleOAuthCallback,
  handleImportLocalLogin,
} from "./ui/pages/oauth.js";
import { handleSessionLoginCancel, handleSessionLoginPoll, handleSessionLoginStart } from "./ui/pages/sessionLogin.js";
import { renderUsagePage } from "./ui/pages/usage.js";
import {
  handleCreateCombo,
  handleUpdateCombo,
  handleReorderCombo,
  handleRenameCombo,
  handleToggleCombo,
  handleDeleteCombo,
} from "./ui/pages/combos.js";
import { renderTokenSaverPage, handleSaveTokenSaver } from "./ui/pages/tokenSaver.js";
import {
  renderSettingsPage,
  handleSaveSettings,
  handleResetDashboardPassword,
} from "./ui/pages/settings.js";
import {
  renderApiKeysPage,
  handleCreateApiKey,
  handleToggleApiKey,
  handleDeleteApiKey,
} from "./ui/pages/apiKeys.js";
import {
  handleDashboardLoginPage,
  handleDashboardLogin,
  handleDashboardLogout,
} from "./ui/pages/login.js";
import {
  getBindHost,
  isLoopbackHost,
  hostGuard,
  controlPlaneGuard,
  corsOptIn,
  requireJsonBody,
  gatewayAuth,
} from "./security.js";
import { isAdminProtected } from "./services/adminAuth.js";
import { getConnections } from "./db/index.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import { ensureSessionHealth } from "./services/deepseekWeb/turns.js";
import { startModelSyncScheduler } from "./services/modelSync.js";
import { startOpencodeCatalogRefresh } from "./services/opencodeCatalog.js";
import { startQuotaSyncScheduler, syncAllQuotas } from "./services/quotaSync.js";
import { startTokenRefreshScheduler } from "./services/tokenRefresh.js";

export const app = new Hono();
export const PORT = Number(process.env.PORT || 20120);

// Initialize console capture eagerly so all gateway activity is captured from launch
initConsoleLogCapture();

// Unhandled handler errors go to the dashboard console only: Hono's default
// handler prints a raw stack to the terminal, which polluted the CLI whenever
// background polling hit a handler bug.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  captureLine(`[zenith] Unhandled error on ${c.req.method} ${c.req.path}: ${err?.stack || err?.message || err}`, "error");
  return c.json(
    {
      error: {
        message: "Internal gateway error",
        type: "gateway_error",
        code: "internal_error",
      },
    },
    500
  );
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

// Security middleware: host check, localhost-only control plane, then gateway auth for /v1
app.use("*", hostGuard);
app.use("*", controlPlaneGuard);
app.use("/v1/*", corsOptIn);
app.use("/v1/*", requireJsonBody);
app.use("/v1/*", gatewayAuth);

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "zenith-router", version: pkg.version, timestamp: Date.now() }));

// Serve static assets
app.get("/logo.png", (c) => {
  try {
    const file = path.join(PUBLIC_DIR, "logo.png");
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      return new Response(buf, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }
  } catch {}
  return c.text("Not found", 404);
});
app.get("/favicon.ico", (c) => c.redirect("/logo.png"));
// Absolute root: a cwd-relative "./public" 404s every /providers/*.png whenever the
// process is started from outside the package directory (e.g. the global `zenith` shim).
app.use("/*", serveStatic({ root: PUBLIC_DIR }));

// Dashboard login (proteksi password dashboard / ZENITH_ADMIN_TOKEN)
app.get("/dashboard/login", handleDashboardLoginPage);
app.post("/dashboard/login", handleDashboardLogin);
app.post("/dashboard/logout", handleDashboardLogout);

// Home & Dashboard Overview
app.get("/", (c) => c.html(renderOverviewPage(PORT)));
app.get("/dashboard", (c) => c.html(renderOverviewPage(PORT)));

// Dashboard Providers: accounts + models per provider, list and detail views
app.get("/dashboard/providers", (c) => {
  if (c.req.query("tab") === "proxy") {
    const q = new URLSearchParams(c.req.query());
    q.delete("tab");
    const qs = q.toString();
    return c.redirect(qs ? `/dashboard/proxies?${qs}` : "/dashboard/proxies");
  }
  return c.html(renderProvidersPage(PORT, c.req.query()));
});
app.post("/dashboard/providers/accounts/add", handleAddAccount);
app.post("/dashboard/providers/accounts/delete", handleDeleteAccount);
app.post("/dashboard/providers/accounts/check-session", handleCheckSession);
app.post("/dashboard/providers/accounts/update-session", handleUpdateSession);
app.post("/dashboard/providers/accounts/move", handleMoveAccount);
app.post("/dashboard/providers/accounts/set-proxy", handleSetAccountProxy);
app.post("/dashboard/providers/proxy-rotation", handleSetProxyRotation);
app.post("/dashboard/providers/concurrency", handleSetProviderConcurrency);
app.post("/dashboard/providers/test-connection", handleTestConnection);
app.post("/dashboard/providers/accounts/import-local", handleImportLocalLogin);
// One-click login: the server opens a browser and the page polls the capture.
app.post("/dashboard/providers/accounts/login/start", handleSessionLoginStart);
app.post("/dashboard/providers/accounts/login/poll", handleSessionLoginPoll);
app.post("/dashboard/providers/accounts/login/cancel", handleSessionLoginCancel);

// OAuth login flows: browser redirect to /callback, or device code polling
app.post("/dashboard/oauth/start", handleOAuthStart);
app.post("/dashboard/oauth/poll", handleOAuthPoll);
app.post("/dashboard/oauth/manual", handleOAuthManual);
app.post("/dashboard/oauth/cancel", handleOAuthCancel);
app.get("/callback", handleOAuthCallback);
app.post("/dashboard/providers/models/custom/add", handleAddCustomModel);
app.post("/dashboard/providers/models/custom/delete", handleDeleteCustomModel);
app.post("/dashboard/providers/models/disable", handleDisableModel);
app.post("/dashboard/providers/models/enable", handleEnableModel);
app.post("/dashboard/providers/models/import", handleImportModels);
app.post("/dashboard/providers/models/import/clear", handleClearImported);
app.post("/dashboard/providers/models/import/delete", handleDeleteImported);
app.post("/dashboard/providers/models/sync", handleSyncFreeModels);
app.get("/dashboard/providers/:id", async (c) => {
  const provider = getProvider(c.req.param("id"));
  // Session tokens cannot be refreshed by the gateway, so the detail page asks
  // the upstream once (the result is cached) instead of showing a stale claim.
  if (provider?.category === "session") {
    const accounts = getConnections(provider.id).filter((connection) => connection.auth_type === "session");
    await Promise.all(accounts.map((connection) => ensureSessionHealth(connection)));
  }
  const html = renderProviderDetailPage(PORT, c.req.param("id"), c.req.query());
  return html ? c.html(html) : c.redirect("/dashboard/providers");
});
// Old pages merged into Providers; keep bookmarks working.
app.get("/dashboard/connections", (c) => c.redirect("/dashboard/providers"));
app.get("/dashboard/models", (c) => c.redirect("/dashboard/providers"));

// Dashboard Usage & Settings UI & Actions
app.get("/dashboard/usage", (c) => c.html(renderUsagePage(PORT, c.req.query())));
app.get("/dashboard/token-saver", (c) => c.html(renderTokenSaverPage(PORT, c.req.query())));
app.post("/dashboard/token-saver", handleSaveTokenSaver);
app.get("/dashboard/settings", (c) => c.html(renderSettingsPage(PORT, c.req.query())));
app.post("/dashboard/settings", handleSaveSettings);
app.post("/dashboard/settings/password/reset", handleResetDashboardPassword);

// Dashboard Combos UI & Actions
app.get("/dashboard/combos", (c) => {
  const qs = new URLSearchParams(c.req.query()).toString();
  return c.redirect(qs ? `/dashboard/providers?tab=combos&${qs}` : "/dashboard/providers?tab=combos");
});
app.post("/dashboard/combos/create", (c) => handleCreateCombo(c));
app.post("/dashboard/combos/update", (c) => handleUpdateCombo(c));
app.post("/dashboard/combos/reorder", (c) => handleReorderCombo(c));
app.post("/dashboard/combos/rename", (c) => handleRenameCombo(c));
app.post("/dashboard/combos/toggle", (c) => handleToggleCombo(c));
app.post("/dashboard/combos/delete", (c) => handleDeleteCombo(c));

// Dashboard Proxy Tab UI & Actions
// Dashboard Proxy Pools UI & Actions
app.get("/dashboard/proxies", (c) => c.html(renderProxiesPage(PORT, c.req.query())));
app.get("/dashboard/proxy-pools", (c) => c.redirect("/dashboard/proxies"));
app.post("/dashboard/proxies/add", (c) => handleAddProxy(c));
app.post("/dashboard/proxies/import", (c) => handleImportProxies(c));
app.post("/dashboard/proxies/test", (c) => handleTestProxy(c));
app.post("/dashboard/proxies/update", (c) => handleUpdateProxy(c));
app.post("/dashboard/proxies/delete", (c) => handleDeleteProxy(c));
app.post("/dashboard/proxies/toggle", (c) => handleToggleProxy(c));
app.post("/dashboard/proxies/bulk-enable", (c) => handleBulkEnableProxies(c));
app.post("/dashboard/proxies/bulk-disable", (c) => handleBulkDisableProxies(c));
app.post("/dashboard/proxies/bulk-delete", (c) => handleBulkDeleteProxies(c));

// Kompatibilitas mundur rute proxy lama
app.post("/dashboard/providers/proxies/add", (c) => handleAddProxy(c));
app.post("/dashboard/providers/proxies/import", (c) => handleImportProxies(c));
app.post("/dashboard/providers/proxies/test", (c) => handleTestProxy(c));
app.post("/dashboard/providers/proxies/update", (c) => handleUpdateProxy(c));
app.post("/dashboard/providers/proxies/delete", (c) => handleDeleteProxy(c));

// Dashboard API Keys UI & Actions
app.get("/dashboard/keys", (c) => c.html(renderApiKeysPage(PORT, null, c.req.query())));
app.post("/dashboard/keys/create", (c) => handleCreateApiKey(c, PORT));
app.post("/dashboard/keys/toggle", handleToggleApiKey);
app.post("/dashboard/keys/delete", handleDeleteApiKey);

// Models Discovery
app.get("/v1/models", handleListModels);

// Chat Completions
app.post("/v1/chat/completions", handleChat);

// Anthropic Messages API
app.post("/v1/messages", handleMessages);

// OpenAI Responses API
app.post("/v1/responses", handleResponses);

// Analytics & Usage
app.get("/api/usage", handleGetUsage);
app.get("/api/quota", handleGetQuota);
app.get("/api/models", handleGetModelOptions);
app.get("/api/version", async (c) => {
  const info = await getVersionInfo();
  const upgrade = await getUpgradeCapability();
  return c.json({ ...info, upgrade });
});
app.post("/api/version/upgrade", (c) => handleUpgradeRequest(c));
// Recent usage entries consumed by the live "Recent Requests" panel (no page reload).
app.get("/api/usage/recent", (c) => {
  const raw = String(c.req.query("limit") || "10");
  const limit = Math.min(Math.max(Number.parseInt(raw, 10) || 10, 1), 50);
  return c.json({ recent: getRecentUsage(limit) });
});
// Live topology state: provider yang sedang memproses request + provider terakhir dipakai.
app.get("/api/topology/active", (c) =>
  c.json({ active: [...getActiveProviders()], last: getLastProvider() })
);
app.post("/dashboard/quota/sync", handleSyncQuotaForm);
// Manual counterpart of the auto-sync job: refresh every linked provider at once.
app.post("/dashboard/quota/sync/all", async (c) => {
  try {
    await syncAllQuotas({ minAgeMs: 0 });
  } catch (err) {
    console.error("[zenith] Quota bulk sync failed:", err.message);
  }
  return c.redirect("/dashboard/usage?synced=1");
});

// Console Logs API
app.get("/api/console-logs", (c) => c.json({ logs: getConsoleLogs() }));
app.delete("/api/console-logs", (c) => {
  clearConsoleLogs();
  return c.json({ ok: true });
});
app.get("/api/console-logs/stream", async (c) => {
  initConsoleLogCapture();
  const emitter = getConsoleEmitter();
  return streamSSE(c, async (stream) => {
    // Send initial backlog
    const initialLogs = getConsoleLogs();
    await stream.writeSSE({
      data: JSON.stringify({ type: "init", logs: initialLogs }),
    });

    const onLines = async (lines) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify({ type: "lines", lines }),
        });
      } catch {}
    };

    const onClear = async () => {
      try {
        await stream.writeSSE({
          data: JSON.stringify({ type: "clear" }),
        });
      } catch {}
    };

    emitter.on("lines", onLines);
    emitter.on("clear", onClear);

    // Keep connection alive with periodic ping
    const pingInterval = setInterval(async () => {
      try {
        await stream.writeSSE({ event: "ping", data: "" });
      } catch {
        clearInterval(pingInterval);
      }
    }, 15000);

    // Hono closes the SSE response as soon as this callback resolves, so keep
    // it pending until the client disconnects; otherwise EventSource loops
    // reconnecting and the console panel shows Offline.
    await new Promise((resolve) => {
      stream.onAbort(() => {
        clearInterval(pingInterval);
        emitter.off("lines", onLines);
        emitter.off("clear", onClear);
        resolve();
      });
    });
  });
});

// Start server ONLY when executed directly as entrypoint (not when imported in tests)
export function startServer() {
  initConsoleLogCapture();
  if (!startModelSyncScheduler()) startOpencodeCatalogRefresh();
  startQuotaSyncScheduler();
  startTokenRefreshScheduler();
  const hostname = getBindHost();
  const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  const base = `http://${displayHost}:${PORT}`;
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  console.log(`\n${bold}Zenith Router${reset} ${dim}v${pkg.version}${reset}\n`);
  console.log(`  Dashboard:  ${base}/dashboard`);
  console.log(`  Endpoint:   ${base}/v1`);
  console.log(`  Health:     ${base}/health`);
  if (isAdminProtected()) {
    console.log(`  Admin:      token aktif (ZENITH_ADMIN_TOKEN) — /dashboard dan /api butuh token admin`);
  }
  console.log(`  Providers:  ${getAllProviders().length} registered, ${getConnections().length} connection(s)`);
  console.log(`\n  ${dim}Ctrl+C untuk berhenti. Setup awal lewat dashboard.${reset}\n`);
  if (!isLoopbackHost(hostname)) {
    console.warn(
      "[zenith] Bound to a non-loopback address: Zenith Router API keys are required on /v1 and the dashboard stays localhost-only."
    );
  }
  return serve({
    fetch: app.fetch,
    port: PORT,
    hostname,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer();
}
