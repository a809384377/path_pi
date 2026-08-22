#!/usr/bin/env node

import { runStdioServer, startupErrorMessage } from "./server.js";

if (process.argv.length > 2) {
  process.stderr.write("pi-agent-mcp is a stdio MCP server and does not accept command-line arguments.\n");
  process.exitCode = 2;
} else {
  runStdioServer().catch((error: unknown) => {
    process.stderr.write(`pi-agent-mcp failed: ${startupErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
