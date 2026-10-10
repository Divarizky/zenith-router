import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
// Versi tampilan (banner CLI, /health, sidebar) dibaca dari package.json agar tidak basi saat bump.
import pkg from "../package.json" with { type: "json" };
import { streamSSE } from "hono/streaming";
import { handleListModels } from "./gateway/models.js";
import { handleChat } from "./gateway/chat.js";
import { handleMessages } from "./gateway/messages.js";
import { handleResponses } from "./gateway/responses.js";
import { handleGetUsage, getLastProvider } from "./services/usage.js";
import { getActiveProviders } from "./services/trafficGuard.js";
import { handleGetQuota, handleSyncQuotaForm } from "./services/quota.js";
import {
  initConsoleLogCapture,
  getConsoleLogs,
  clearConsoleLogs,
  getConsoleEmitter,
} from "./services/logger.js";
import { renderOverviewPage } from "./ui/pages/overview.js";
import {
  renderProvidersPage,
  renderProviderDetailPage,
  handleAddAccount,
  handleDeleteAccount,
  handleAddCustomModel,
  handleDeleteCustomModel,
  handleDisableModel,
  handleEnableModel,
  handleImportModels,
  handleClearImported,
  handleDeleteImported,
  handleSyncFreeModels,
} from "./ui/pages/providers.js";
import {
  handleOAuthStart,
  handleOAuthPoll,
  handleOAuthManual,
  handleOAuthCancel,
  handleOAuthCallback,
  handleImportLocalLogin,
} from "./ui/pages/oauth.js";
import { renderUsagePage } from "./ui/pages/usage.js";
import { renderTokenSaverPage, handleSaveTokenSaver } from "./ui/pages/tokenSaver.js";
import {
  renderSettingsPage,
  handleSaveSettings,
} from "./ui/pages/settings.js";
import {
  renderApiKeysPage,
  handleCreateApiKey,
  handleToggleApiKey,
  handleDeleteApiKey,
} from "./ui/pages/apiKeys.js";
import {
  getBindHost,
  isLoopbackHost,
  hostGuard,
  controlPlaneGuard,
  corsOptIn,
  requireJsonBody,
  gatewayAuth,
} from "./security.js";
import { getConnections } from "./db/index.js";
import { getAllProviders } from "./providers/index.js";
import { startModelSyncScheduler } from "./services/modelSync.js";
import { startQuotaSyncScheduler, syncAllQuotas } from "./services/quotaSync.js";

export const app = new Hono();
export const PORT = Number(process.env.PORT || 20120);

// Initialize console capture eagerly so all gateway activity is captured from launch
initConsoleLogCapture();

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

// Home & Dashboard Overview
app.get("/", (c) => c.html(renderOverviewPage(PORT)));
app.get("/dashboard", (c) => c.html(renderOverviewPage(PORT)));

// Dashboard Providers: accounts + models per provider (9router-style list and detail)
app.get("/dashboard/providers", (c) => c.html(renderProvidersPage(PORT)));
app.post("/dashboard/providers/accounts/add", handleAddAccount);
app.post("/dashboard/providers/accounts/delete", handleDeleteAccount);
app.post("/dashboard/providers/accounts/import-local", handleImportLocalLogin);

// OAuth login flows (9router-style): browser redirect to /callback, or device code polling
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
app.get("/dashboard/providers/:id", (c) => {
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
  startModelSyncScheduler();
  startQuotaSyncScheduler();
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
