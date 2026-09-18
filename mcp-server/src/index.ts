#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { fileBackend } from "./state-file.js";
import { useStateBackend } from "./state.js";

/**
 * stdio entry point.
 *
 * Nothing may be written to stdout: that stream carries the JSON-RPC framing, so any stray
 * log line would corrupt the protocol. Diagnostics go to stderr.
 */
async function main(): Promise<void> {
  // This build has a filesystem, so reuse one anonymous identity across restarts.
  useStateBackend(fileBackend);
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("shopping-list-mcp-server ready on stdio\n");
}

main().catch(error => {
  process.stderr.write(`shopping-list-mcp-server failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
