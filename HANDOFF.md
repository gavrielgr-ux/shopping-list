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
- **The live page still works after the `list-model.js` change.** Rendered in headless Chromium
  against the deployed site: it synced from Firebase in about two seconds, showed the real list
  name, all 9 categories and 33/47 progress, matching what the MCP tools report, with no page
  errors. The deployed `list-model.js` is byte-identical to `main`, and `mcp-server/` returns 404
  on the published site, so the Jekyll exclude works.

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

### A. Does this session already have the tools? (cheapest, try first, but expect no)

Check whether tools named `shopping_*` are available to you. If they are, the problem is
solved: confirm with `shopping_get_list` and tell the owner.

**Expect this to fail in Cowork and claude.ai.** Anthropic's own documentation is explicit:
"Local MCP servers configured in Claude Desktop via claude_desktop_config.json are a separate
mechanism and do use your local network, but those aren't available in Cowork or claude.ai."
So the committed `.mcp.json` is unlikely to be picked up outside Claude Code. It is still worth
one message to confirm, because it costs nothing and would end the whole problem.

**It does work in Claude Code**, including Claude Code on the web, which runs in a phone
browser. That is the one surface where this is already solved.

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

### C. Ask the work org's Claude Owner to add it

Only if the owner actually wants this on the work account. Per Anthropic's documentation this is
not a switch the member can flip: **"only Owners can add them to Team and Enterprise plans."**
An Owner or Primary Owner must:

1. Go to Organization settings → Connectors.
2. Click Add, hover Custom, select Web.
3. Enter the remote MCP server URL. OAuth Client ID and Secret are optional, under Advanced
   settings, so a server guarded by a bearer or path token is acceptable.

The member then goes to Customize → Connectors and clicks Connect on the entry the Owner added.

## Facts confirmed against Anthropic's documentation

Read first-hand from
<https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
(dated August 11, 2026), so these supersede any guess earlier in this file:

- Custom connectors using remote MCP are available on **Claude, Cowork and Claude Desktop**, for
  **Free, Pro, Max, Team and Enterprise**. **Free is limited to one custom connector**, which is
  why a personal account is a viable route.
- **Only Owners can add them on Team and Enterprise plans.** Members connect to what an Owner
  added; they cannot add their own.
- On Pro and Max, a member adds one themselves with **"+" then "Add custom connector"**.
- **Claude connects to the server from Anthropic's cloud infrastructure, not from your device**,
  across every client including the mobile apps. The server must be reachable over the public
  internet from Anthropic's IP ranges. A Cloudflare Worker satisfies this; anything on a private
  network or behind a VPN does not.
- OAuth is optional. A server authenticating by shared token is acceptable.

One further correction: the "Projects redesigned" announcement of 17 September 2026 is a
**Claude Code** feature, in beta for select Pro and Max subscribers using cloud sessions. It is
not a claude.ai chat feature, so it does not provide a route around the connector restriction,
though it would suit this repository well, since Claude Code is where the committed `.mcp.json`
already works.

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

## Starting a fresh session

Two prompts to paste, depending on the surface. Both assume this file is readable, so the new
session is not briefed by hand.

### Claude chat, or the mobile app

A chat session cannot do the integration. It has no shell, no local MCP server and no generic
HTTP tool, so it cannot touch the database. Its useful job is diagnosis, and walking the owner
through dashboard screens one step at a time from a phone.

```
I need you to help me finish a setup from my phone. I have no computer.
Read the context first, then guide me one step at a time.

CONTEXT TO READ
If you have a GitHub connector, read these from the private repo
gavrielgr-ux/shopping-list on branch claude/shopping-list-mcp-server-qvddyz
(not main; PR #1 is still open):
  - HANDOFF.md          <- start here, it has the full state
  - mcp-server/README.md

If you do NOT have a GitHub connector, say so immediately and I will
paste the contents instead. Do not guess at what the files contain.

THE GOAL
I have a Hebrew family shopping list at
https://gavrielgr-ux.github.io/shopping-list/ backed by a Firebase
Realtime Database. A finished, tested MCP server with 16 tools reads and
writes that same database, so its edits appear live in the page. I want
to use those tools by talking to you in the Claude mobile app.

WHAT IS BLOCKING
My Claude account is a work account. The "Allow custom connectors" org
setting appears to be off, which is the Enterprise default, so I have no
"Add custom connector" option at all. Only an org Owner can enable it.
Separately, connectors cannot be added from the mobile app even when
allowed; that is a browser action at claude.ai.

WHAT YOU CANNOT DO, so please don't propose it
You have no generic HTTP tool. Web fetch is read-only GETs of public
pages, and the database requires authentication. So you cannot read or
write my lists in this conversation, and no amount of custom
instructions will change that. A connector is the only mechanism.
Previous attempts already ruled out: instructing you to call the REST
API, and using GitHub as the datastore instead of Firebase.

WHAT I WANT FROM YOU
1. First, tell me exactly which connectors and tools you have available
   in this conversation. I genuinely don't know what my org allows.
2. Confirm or correct my diagnosis above, using web search on current
   Anthropic documentation rather than memory. Cite what you find.
3. Then walk me through the most viable route from HANDOFF.md section
   "Try these, in this order", which is likely B: a personal free Claude
   account plus deploying the Cloudflare Worker from the Cloudflare
   dashboard in my phone browser.

HOW TO WORK WITH ME
Give me ONE step at a time and wait. I will tell you what I actually see
on screen, which may not match the docs. Menu labels change.
Don't tell me what I want to hear. If my plan is wrong, say so and give
me your recommendation. Never invent a menu path you haven't verified.
One thing you must not do: do not ask me to paste any access token or
API key into this chat. Anything secret I will set in a dashboard
myself.
```

### Cowork, or Claude Code

These can run commands, so they may be able to host the MCP server directly and skip connectors
entirely. Test that first.

```
Read HANDOFF.md in the GitHub repo gavrielgr-ux/shopping-list, on the
branch claude/shopping-list-mcp-server-qvddyz (it is not on main yet,
PR #1 is still open). Use the GitHub connector. Also read
mcp-server/README.md for detail.

Goal: let me create and edit my family shopping lists by talking to you,
from the Claude mobile app and from Cowork. I only have a phone, no
computer. The MCP server is already written and tested. What is not
solved is reaching its tools from a phone.

Before anything else, tell me two things:

1. Do you already have tools named shopping_* available in this session?
   If yes, call shopping_get_list and show me what is on the list. That
   would mean the problem is already solved and nothing else is needed.

2. Can you run shell commands and clone a repository in this session?
   If yes, say so, because that opens options the handoff describes.

Then work section "Try these, in this order" in HANDOFF.md, starting at A.
Tell me what you find before changing any code. Do not redesign the
server and do not re-review it. The section listing what has been ruled
out is there to stop you retrying dead ends, so read it first.

Contradict me if my plan is wrong. Verify claims rather than assuming.
```

### Never put a secret in a prompt

Neither prompt asks for the Worker's access token, and no future one should. A session will
offer to "check" it; a credential pasted into a transcript stays there. The token is set in the
Cloudflare dashboard by the owner and read by nobody else.
