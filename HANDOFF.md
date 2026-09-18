# Handoff: getting the shopping-list MCP tools usable from a phone

Written for a fresh Claude (Cowork or Claude Code) session picking this up with no prior
context. The code is finished and tested. **The only unsolved problem is reaching those tools
from a phone**, which is an access and configuration problem, not a code problem.

Do not redesign the server or re-review the code. Read this, then work the open problem.

## The goal

Let the owner create and edit the family shopping lists conversationally from the **Claude
mobile app** and **Cowork**. They have no computer at all: a phone is the only device.

## What exists

`gavrielgr-ux/shopping-list` (private). The live site is
<https://gavrielgr-ux.github.io/shopping-list/>.

| Path | What it is |
| --- | --- |
| `index.html`, `app.js`, `list-model.js` | The static site, served by GitHub Pages. Hebrew, RTL. |
| `mcp-server/` | TypeScript MCP server, 16 tools, 97 tests |
| `mcp-server/src/index.ts` | stdio entry point |
| `mcp-server/src/worker.ts` | Cloudflare Worker entry point (HTTPS) |
| `mcp-server/wrangler.toml` | Worker deploy config, self-building |
| `.mcp.json` | Registers the stdio server for Claude Code, via `mcp-server/bin/launch.sh` |
| `.claude/hooks/session-start.sh` | Installs and builds `mcp-server/` before a remote session starts |

Work is on branch `claude/shopping-list-mcp-server-qvddyz`, open as **PR #1**, not yet merged.

### Architecture, in one paragraph

The site has no backend. `app.js` talks straight to a Firebase Realtime Database and subscribes
to its list with `onValue`. The MCP server reads and writes **the same** database node,
`shared-lists/{listId}`, so a tool call shows up in any open browser tab within moments. It
authenticates with anonymous Firebase sign-in, the same as the page does. Default list id is
`rehovot-family-4d7f8c12`.

Database: `https://shopping-list-27ffd-default-rtdb.firebaseio.com`. The Firebase web API key in
`mcp-server/src/constants.ts` is the same one published in the site's `app.js`; it identifies a
project and is not a secret.

### The 16 tools

`shopping_list_lists`, `shopping_get_list`, `shopping_share_list`, `shopping_create_list`,
`shopping_rename_list`, `shopping_delete_list`, `shopping_add_category`,
`shopping_update_category`, `shopping_remove_category`, `shopping_move_category`,
`shopping_add_items`, `shopping_set_checked`, `shopping_update_item`, `shopping_remove_items`,
`shopping_move_item`, `shopping_clear_checked`.

## What is already proven to work

- **Claude Code on the web**, right now. The committed `.mcp.json` plus the SessionStart hook
  make all 16 tools available with no manual setup. Verified by reading the owner's real list
  and by full create/add/check/delete on a throwaway list.
- **The Worker**, run under `wrangler dev` in `workerd`: MCP handshake over HTTP, `tools/list`
  returning all 16, and a tool call that read the live database.
- 97 tests pass. `cd mcp-server && npm test`.

## What is blocking, and what has been ruled out

**1. Custom connectors are unavailable on the owner's account.** They use a work account
(`@moovit.com`). The "Allow custom connectors" org switch is off by default on Enterprise, and
when off, members cannot add or authorize custom connectors at all. Only an org Owner can.

So the Cloudflare Worker is built and tested but **cannot currently be registered** as a
connector on that account.

**2. Connectors cannot be added from the mobile app**, only used there. Adding one is a
claude.ai browser action. A newly added connector appears in the app on the next login.

**3. Ruled out, do not retry these:**

- *Telling Claude in chat to call the Firebase or Worker REST API from instructions.* Chat and
  Projects have no generic HTTP tool. Web fetch does read-only GETs of public pages; the
  analysis sandbox has no external network. Writes are impossible, and writes are the point.
- *Using GitHub as the datastore instead of Firebase.* The live list is in Firebase. Writing a
  repo file would not change it, and re-pointing the app at the repo would cost the live sync
  between family members and add a commit-plus-deploy delay per tick.
- *Deploying from a Claude Code container.* `api.cloudflare.com` and `dash.cloudflare.com` are
  refused by that container's egress policy.

## Try these, in this order

### A. Does this Cowork session already have the tools? (cheapest, try first)

If Cowork can run a local MCP server from a repository, the committed `.mcp.json` should give
you all 16 tools with no connector, no Cloudflare and no token. Check whether tools named
`shopping_*` are available to you. If they are, the problem is solved: confirm with
`shopping_get_list` and tell the owner.

If they are not, find out whether this session can (a) clone the repo and (b) run shell
commands. If both, then `cd mcp-server && npm install && npm run doctor` will say whether the
database is reachable, and the tools can be driven directly.

You may need `shopping-list-27ffd-default-rtdb.firebaseio.com` added to the environment's
network egress allowlist. The server distinguishes that failure from a Firebase permissions
failure and says which is which, so read its error text rather than guessing.

### B. Personal Claude account plus the Worker

The recommended route if A fails. A Free personal account allows one custom connector, and a
family shopping list arguably belongs there rather than in an employer's Claude org.

1. Deploy the Worker with **no terminal**: Cloudflare dashboard in a mobile browser,
   Workers & Pages → Create → Workers → Import a repository, root directory `mcp-server`.
   `wrangler.toml` carries its own build command, so nothing else needs filling in.
2. Add a secret `SHOPPING_LIST_ACCESS_TOKEN`, a long random string. **Until this exists the
   Worker returns 503 to everything by design.** Do not generate this token inside a chat; it
   would live in the transcript forever. The owner sets it in the dashboard.
3. Register `https://<name>.<subdomain>.workers.dev/mcp` as a custom connector at claude.ai in a
   browser, with `Authorization: Bearer <token>`. If the dialog has no header field, use
   `https://<name>.<subdomain>.workers.dev/<token>/mcp` instead; the Worker accepts the token in
   either place.

Details in `mcp-server/README.md`.

### C. Ask the work org's Claude Owner to enable custom connectors

Only if the owner actually wants this on the work account.

## Notes for whoever continues

- The owner prefers being contradicted over being agreed with. If a plan is wrong, say so.
- Verify before claiming. This work has already produced several confident wrong answers that
  turned out to be assumptions: that they had a machine, that the mobile app could add a
  connector, that Cloud Run was appropriate when billing was unwanted.
- These hosts are blocked from Claude Code containers, so first-hand documentation may be
  unreadable and search summaries may be all that is available: `claude.com`,
  `support.claude.com`, `api.cloudflare.com`, `dash.cloudflare.com`.
- Merging PR #1 is a prerequisite for the Cloudflare dashboard route, since Workers Builds
  deploys from the default branch.
