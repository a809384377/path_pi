#!/usr/bin/env node

import { runStdioServer, startupErrorMessage } from "./server.js";

runStdioServer().catch((error: unknown) => {
  process.stderr.write(`pi-agent-mcp failed: ${startupErrorMessage(error)}\n`);
  process.exitCode = 1;
});
