# רשימת קניות — shared shopping list

A single-page shopping list, grouped by supermarket department, that syncs live between
everyone holding its link.

**Live site:** <https://gavrielgr-ux.github.io/shopping-list/>

## What is here

| Path | Purpose |
| --- | --- |
| `index.html` | The page: markup, styles and RTL layout |
| `app.js` | Application logic and Firebase Realtime Database sync |
| `list-model.js` | Pure helpers for list ids, payload normalization and merge rules |
| `mcp-server/` | MCP server letting an AI assistant read and edit the lists — see its [README](mcp-server/README.md) |
| `.mcp.json` | Registers that server for Claude Code when this repo is opened |
| `.claude/hooks/` | SessionStart hook that builds the server before a web session starts |

The site is static, with no build step: GitHub Pages serves the repository root, and `app.js`
loads the Firebase SDK straight from `gstatic.com`. Lists live in a Firebase Realtime Database
under `shared-lists/{listId}`, one node per list, and the page subscribes with `onValue` so
every open tab re-renders as soon as anything changes.

Each list is addressed by the `?list=` parameter in its URL. Visiting the site with no
parameter shows the landing view; the list of lists a device has opened is kept in that
browser's `localStorage` only, which is why the database has no index of lists.

## Editing the list with an AI assistant

`mcp-server/` is an MCP server that speaks to the same database as the page, so its edits show
up in an open tab within moments — nothing to refresh or deploy. It offers full CRUD over
lists, categories and items.

It needs no installing. A SessionStart hook builds it before a Claude Code on the web session
starts, and `.mcp.json` registers it, so opening this repository is enough.

**One setting is required.** The server reaches Firebase over the public internet, and Claude
Code on the web only allows outbound connections to an allowlisted set of hosts. Add

```
shopping-list-27ffd-default-rtdb.firebaseio.com
```

to the environment's network egress settings
([docs](https://code.claude.com/docs/en/claude-code-on-the-web)). Until then every tool call
fails with `HTTP 403`, and the hook warns about it at session start.

For the tool reference, the design notes and how to use it from Claude Desktop or a local
checkout, see [`mcp-server/README.md`](mcp-server/README.md).
