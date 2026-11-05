#!/usr/bin/env node
// Memory optimization: cap V8 heap for low-memory footprint (< 100 MB RSS)
if (!process.env.NODE_OPTIONS || !process.env.NODE_OPTIONS.includes("--max-old-space-size")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --max-old-space-size=48`.trim();
}

import { startServer, PORT } from "../src/index.js";
import { getBindHost } from "../src/security.js";
import { showInterfaceMenu } from "../src/ui/cliMenu.js";

startServer();

if (process.stdin.isTTY) {
  const hostname = getBindHost();
  const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  // Give @hono/node-server a tick, then show the interactive menu.
  setTimeout(() => {
    showInterfaceMenu({ port: PORT, displayHost });
  }, 300);
}
