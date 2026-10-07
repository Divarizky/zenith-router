import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { handleListModels } from "./gateway/models.js";
import { handleChat } from "./gateway/chat.js";
import { handleMessages } from "./gateway/messages.js";
import { handleResponses } from "./gateway/responses.js";
import { handleGetUsage } from "./services/usage.js";
import { handleGetQuota } from "./services/quota.js";
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

export const app = new Hono();
export const PORT = Number(process.env.PORT || 20120);

// Security middleware: host check, localhost-only control plane, then gateway auth for /v1
app.use("*", hostGuard);
app.use("*", controlPlaneGuard);
app.use("/v1/*", corsOptIn);
app.use("/v1/*", requireJsonBody);
app.use("/v1/*", gatewayAuth);

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "zenroute", timestamp: Date.now() }));

// Home & Dashboard Overview
app.get("/", (c) => c.html(renderOverviewPage(PORT)));
app.get("/dashboard", (c) => c.html(renderOverviewPage(PORT)));

// Dashboard Providers: accounts + models per provider (9router-style list and detail)
app.get("/dashboard/providers", (c) => c.html(renderProvidersPage(PORT)));
app.post("/dashboard/providers/accounts/add", handleAddAccount);
app.post("/dashboard/providers/accounts/delete", handleDeleteAccount);
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
app.get("/dashboard/usage", (c) => c.html(renderUsagePage(PORT)));
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

// Start server ONLY when executed directly as entrypoint (not when imported in tests)
export function startServer() {
  startModelSyncScheduler();
  const hostname = getBindHost();
  const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  const base = `http://${displayHost}:${PORT}`;
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  console.log(`\n${bold}zenroute${reset} ${dim}v0.1.0${reset}\n`);
  console.log(`  Dashboard:  ${base}/dashboard`);
  console.log(`  Endpoint:   ${base}/v1`);
  console.log(`  Health:     ${base}/health`);
  console.log(`  Providers:  ${getAllProviders().length} registered, ${getConnections().length} connection(s)`);
  console.log(`\n  ${dim}Ctrl+C untuk berhenti. Setup awal lewat dashboard.${reset}\n`);
  if (!isLoopbackHost(hostname)) {
    console.warn(
      "[zenroute] Bound to a non-loopback address: zenroute API keys are required on /v1 and the dashboard stays localhost-only."
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
