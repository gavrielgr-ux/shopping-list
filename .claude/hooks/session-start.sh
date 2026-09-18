#!/bin/bash
# SessionStart hook: prepare the shopping-list MCP server.
#
# The site at the repository root is static and needs no build. Only mcp-server/ does, and its
# node_modules/ and dist/ are not committed, so a fresh container has to install and build them
# before the MCP server can start. Running synchronously means that work is finished before the
# session begins; the container state is cached afterwards, so later sessions re-run this
# against a warm node_modules and return quickly.
set -euo pipefail

# Locally a developer manages their own checkout, so only do this in a remote container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}/mcp-server"

# `npm install` reuses a cached node_modules, unlike `npm ci`, which deletes it first.
npm install --no-audit --no-fund
npm run build

# Report whether the database is actually reachable from this container. A failure here is not a
# setup error and must not fail the hook: the server is built either way and its tools will
# load, they simply cannot reach the list until the host is allowed out.
set +e
probe=$(node bin/probe-egress.mjs 2>/dev/null)
set -e
status=$(printf '%s\n' "$probe" | sed -n 1p)
host=$(printf '%s\n' "$probe" | sed -n 2p)

case "$status" in
  OK)
    echo "shopping-list MCP server: ready, and $host is reachable."
    ;;
  DENIED)
    echo "shopping-list MCP server: ready, and $host is reachable. It refused an unauthenticated read, which is expected when the security rules require sign-in. Run 'cd mcp-server && npm run doctor' to check the authenticated path."
    ;;
  BLOCKED)
    echo "shopping-list MCP server: ready, but $host is NOT in this environment's network egress allowlist, so every tool call will fail with HTTP 403. Add that host to the environment's egress settings to fix it. Nothing is wrong with the code or with Firebase. Run 'cd mcp-server && npm run doctor' for the full diagnosis."
    ;;
  *)
    echo "shopping-list MCP server: ready, but ${host:-the database host} did not answer, so tool calls may fail. If this environment restricts outbound network access, add that host to its egress allowlist. Run 'cd mcp-server && npm run doctor' for the full diagnosis."
    ;;
esac
