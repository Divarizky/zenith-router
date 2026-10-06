import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { handleListModels } from "./gateway/models.js";
import { handleChat } from "./gateway/chat.js";
import { handleMessages } from "./gateway/messages.js";
import { handleGetUsage } from "./services/usage.js";
import { handleGetQuota } from "./services/quota.js";

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

// Home status
app.get("/", (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>zenroute</title>
        <style>
          body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2rem 2.5rem; border-radius: 0.75rem; border: 1px solid #334155; text-align: center; max-width: 420px; }
          h1 { margin: 0 0 0.5rem; font-size: 1.75rem; color: #38bdf8; }
          p { color: #94a3b8; font-size: 0.95rem; margin: 0 0 1.5rem; }
          .tag { display: inline-block; background: #0369a1; color: #e0f2fe; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>zenroute</h1>
          <p>Ultra-lightweight personal AI gateway for coding agents.</p>
          <span class="tag">Port ${PORT} &middot; Ready</span>
        </div>
      </body>
    </html>
  `);
});

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
