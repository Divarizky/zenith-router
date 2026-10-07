import { Hono } from "hono";
import { cors } from "hono/cors";
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

export const app = new Hono();
const PORT = Number(process.env.PORT || 20128);

// Explicit CORS middleware for all endpoints
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["*"],
  })
);

// Fallback OPTIONS handler to guarantee CORS headers on any raw OPTIONS preflight
app.options("*", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "*");
  return c.text("", 204);
});

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
  console.log(`[zenroute] Starting on http://localhost:${PORT}`);
  serve({
    fetch: app.fetch,
    port: PORT,
  });
}
