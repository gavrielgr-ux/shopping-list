#!/bin/sh
# Launcher for the MCP server, used by .mcp.json.
#
# dist/ is not committed, so build it on demand when it is missing. Normally the SessionStart
# hook has already done this and the check is a no-op; this keeps the server startable in a
# checkout where the hook did not run.
#
# Nothing may reach stdout: that stream carries the JSON-RPC framing. Build output goes to
# stderr, where the MCP client shows it as server logs.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ ! -f "$dir/dist/src/index.js" ]; then
  echo "shopping-list-mcp-server: dist/ missing, building it now (this happens once)" >&2
  (cd "$dir" && npm install --no-audit --no-fund) >&2
fi

exec node "$dir/dist/src/index.js"
