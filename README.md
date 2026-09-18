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
| `HANDOFF.md` | Context for a fresh AI session continuing the connector setup |

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

### From the Claude mobile app, Cowork or claude.ai

Those surfaces connect outward to a URL rather than running anything locally, so the same tools
are also deployable as a Cloudflare Worker, on the free tier with no credit card and **without a
terminal**: Cloudflare Workers Builds imports this repository and deploys on push, all from the
dashboard in a mobile browser.

Point it at the `mcp-server` root directory, then add a `SHOPPING_LIST_ACCESS_TOKEN` secret.
Until that secret exists the Worker serves nothing, since a public URL would otherwise let
anyone who found it rewrite every list. Register the resulting `https://…workers.dev/mcp` URL as
a custom connector. Note that a connector cannot be **added** from the Claude mobile app, only
used there, so register it from claude.ai in a browser (a mobile browser is fine) and sign in to
the app again afterwards. It is then available in the app, in Cowork and on claude.ai.

Full steps, including the checkout-based alternative, are in
[`mcp-server/README.md`](mcp-server/README.md).

### From Siri, ChatGPT, or anything that speaks HTTP

The Worker also serves a plain REST API under `/api/`, described by `/api/openapi.json`, behind
the same token. That covers the things that cannot speak MCP: an iOS Shortcut triggered by Siri
("add milk to the shopping list"), a ChatGPT custom action, or `curl`. The Shortcut route needs
no AI subscription and no organisation permission, which makes it the simplest thing to share
with family.

For the tool reference, the HTTP API, the design notes and how to use it from Claude Desktop or
a local checkout, see [`mcp-server/README.md`](mcp-server/README.md).
