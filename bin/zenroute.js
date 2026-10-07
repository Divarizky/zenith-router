#!/usr/bin/env node
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
