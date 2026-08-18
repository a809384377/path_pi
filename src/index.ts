#!/usr/bin/env node

import { runStdioServer } from "./server.js";

runStdioServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`pi-agent-mcp failed: ${message}\n`);
  process.exitCode = 1;
});
