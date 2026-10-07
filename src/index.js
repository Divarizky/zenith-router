import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { handleListModels } from "./gateway/models.js";
import { handleChat } from "./gateway/chat.js";
import { handleMessages } from "./gateway/messages.js";
import { handleGetUsage } from "./services/usage.js";
import { handleGetQuota } from "./services/quota.js";
import { renderOverviewPage } from "./ui/pages/overview.js";
import {
  renderConnectionsPage,
  handleAddConnection,
  handleDeleteConnection,
} from "./ui/pages/connections.js";
import { renderUsagePage } from "./ui/pages/usage.js";
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

export const app = new Hono();
const PORT = Number(process.env.PORT || 20120);

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

// Dashboard Connections UI & Actions
app.get("/dashboard/connections", (c) => c.html(renderConnectionsPage(PORT)));
app.post("/dashboard/connections/add", handleAddConnection);
app.post("/dashboard/connections/delete", handleDeleteConnection);

// Dashboard Usage & Settings UI & Actions
app.get("/dashboard/usage", (c) => c.html(renderUsagePage(PORT)));
app.get("/dashboard/settings", (c) => c.html(renderSettingsPage(PORT)));
app.post("/dashboard/settings", handleSaveSettings);

// Dashboard API Keys UI & Actions
app.get("/dashboard/keys", (c) => c.html(renderApiKeysPage(PORT)));
app.post("/dashboard/keys/create", (c) => handleCreateApiKey(c, PORT));
app.post("/dashboard/keys/toggle", handleToggleApiKey);
app.post("/dashboard/keys/delete", handleDeleteApiKey);

// Models Discovery
app.get("/v1/models", handleListModels);

// Chat Completions
app.post("/v1/chat/completions", handleChat);

// Anthropic Messages API
app.post("/v1/messages", handleMessages);

// Analytics & Usage
app.get("/api/usage", handleGetUsage);
app.get("/api/quota", handleGetQuota);

// Start server ONLY when executed directly as entrypoint (not when imported in tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const hostname = getBindHost();
  const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  console.log(`[zenroute] Starting on http://${displayHost}:${PORT}`);
  if (!isLoopbackHost(hostname)) {
    console.warn(
      "[zenroute] Bound to a non-loopback address: zenroute API keys are required on /v1 and the dashboard stays localhost-only."
    );
  }
  serve({
    fetch: app.fetch,
    port: PORT,
    hostname,
  });
}
