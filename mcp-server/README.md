# shopping-list-mcp-server

An MCP server that gives an AI assistant full read/write access to the shared shopping list
behind <https://gavrielgr-ux.github.io/shopping-list/>.

## How it works

The site is a static page with no backend of its own. `app.js` talks straight to a Firebase
Realtime Database and subscribes to its list with `onValue`:

```
index.html + app.js  ──┐
 (browser, GitHub Pages)│
                        ├──►  Firebase Realtime Database
this MCP server      ──┘        shared-lists/{listId}
 (your machine, stdio)
```

So this server does **not** drive the web page or scrape HTML. It reads and writes the same
database node the page is bound to, which means:

- a write here appears in any open tab within moments, with no refresh and no deploy;
- an edit made in the browser is visible to the next tool call;
- nothing about the site needs to change.

It authenticates the same way the page does — anonymous Firebase sign-in — so it has exactly
the access an ordinary visitor has, no more.

## Data model

One database node per list, at `shared-lists/{listId}`:

```jsonc
{
  "name": "רשימת קניות",
  "updatedAt": 1789724150123,      // epoch ms; the page only adopts a snapshot whose value grew
  "departments": [                 // "categories" in the tool names
    {
      "title": "חלב וביצים",
      "hint": "מקררים",            // aisle hint under the heading
      "items": [
        { "name": "חלב", "note": "2 יחידות", "checked": false, "blank": false }
      ]
    }
  ]
}
```

`blank: true` marks the placeholder row the page keeps so there is always somewhere to type;
those rows are hidden from tool output and excluded from the progress count. A deleted list is
replaced by `{ "deleted": true, "deletedAt": … }`, which is what makes open tabs clear their
local copy.

## Setup

Nothing to do by hand. `.claude/hooks/session-start.sh` installs and builds this directory
before a Claude Code on the web session starts, and the container is cached afterwards, so a
cold start costs a few seconds and later sessions are instant. `.mcp.json` then launches the
server through `bin/launch.sh`, which rebuilds on demand if the hook never ran.

To work on it in a checkout of your own (Node.js 20 or newer):

```bash
cd mcp-server
npm install        # also builds, via the prepare script
npm test           # 97 tests
npm run doctor     # check authentication, database access and rules
```

### The one thing that does need configuring

The server reaches the database over the public internet, so wherever it runs has to be allowed
to connect to:

```
shopping-list-27ffd-default-rtdb.firebaseio.com
```

Claude Code on the web restricts outbound network access to an allowlist chosen per
environment, and that host is not on it by default. Until it is added, every tool call fails
with `HTTP 403` and the server says so explicitly:

```
A network policy between this machine and the database refused the request (HTTP 403):
Host not in allowlist: shopping-list-27ffd-default-rtdb.firebaseio.com. Add this host to your
network egress settings to allow access. …
```

Add it under the environment's network egress settings — see
[the Claude Code on the web docs](https://code.claude.com/docs/en/claude-code-on-the-web). The
SessionStart hook probes for this and prints a warning at session start, so a blocked
environment announces itself rather than looking like a broken server.

`npm run doctor` gives the full picture and tells apart the three things that look alike:

```
1. authentication      ok (credential length 858)
2. read default list   ok — "רשימת קניות", 9 categories, 3/41 checked
3. enumerate lists     not permitted by the database rules — … (this is fine)
```

A refusal by the *network* and a refusal by Firebase's *security rules* produce different
messages, because they need fixing in different places: the first in the environment's egress
settings, the second in the Firebase console.

## Connect it

### Claude Code (web or CLI)

Already wired: `.mcp.json` at the repository root registers this server, so opening the repo
offers it — approve it once when prompted. Nothing else to install.

To register it globally for a checkout instead:

```bash
claude mcp add shopping-list --scope user -- sh /absolute/path/to/shopping-list/mcp-server/bin/launch.sh
```

### Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows:
`%APPDATA%\Claude\claude_desktop_config.json`), then restart the app:

```json
{
  "mcpServers": {
    "shopping-list": {
      "command": "sh",
      "args": ["/absolute/path/to/shopping-list/mcp-server/bin/launch.sh"]
    }
  }
}
```

Use an absolute path — the app does not start in this directory.

### Anything else

It is a standard stdio server: run `sh bin/launch.sh`, or `node dist/src/index.js` once built.
To poke at it by hand:

```bash
npm run inspect     # opens the MCP Inspector
```

## Use it from the Claude mobile app, Cowork and claude.ai

Those surfaces do not run anything locally. Anthropic's servers connect outward to a URL, so the
server has to be publicly reachable rather than a subprocess on a machine. `src/worker.ts` is
that deployment: the same sixteen tools, served over HTTPS from a Cloudflare Worker.

It runs on Cloudflare's **free tier with no credit card**. Two choices keep it there:

- **Stateless transport.** No session id generator is passed, so each request is handled on its
  own and no Durable Object is needed. That suits a tool server where every call is already an
  independent read or compare-and-swap.
- **No storage.** The state file that the Node build uses to cache an anonymous identity is
  replaced by the in-memory default, because the Worker authenticates with a stored credential
  instead. `shopping_list_lists` then reports the default list rather than a remembered set,
  which is the fallback it already documents.

### Already deployed

**<https://shopping-list-mcp.gavrielgr.workers.dev>**, via the Cloudflare dashboard's Git
integration, so every push to `main` redeploys it. The steps below are how that was set up, and
what to repeat for a fresh deployment.

### Deploy from a phone, with no terminal

Everything below happens in the Cloudflare dashboard in a mobile browser. Cloudflare Workers
Builds watches the repository and deploys on push, so there is no command line at any point, and
every later change to this server deploys itself.

1. Create a free Cloudflare account. No card is required for the Workers free tier.
2. **Workers & Pages → Create → Workers → Import a repository**, and authorise GitHub for
   `gavrielgr-ux/shopping-list`.
3. Set **root directory** to `mcp-server`. Leave the build and deploy commands at their
   defaults: `wrangler.toml` already carries a `[build]` command that installs and compiles, so
   nothing else needs filling in.
4. Deploy. The Worker answers on `https://shopping-list-mcp.<your-subdomain>.workers.dev`, and
   `GET /` should return `shopping-list-mcp-server`.
5. **Settings → Variables and Secrets → Add**, type **Secret**, name
   `SHOPPING_LIST_ACCESS_TOKEN`, value a long random string. A password manager will generate
   one; 32 or more random characters is plenty. Save, which redeploys.

Until step 5 the Worker returns `503` to everything and serves no data, which is deliberate.

Keep that token out of any chat transcript, including a conversation with Claude. Setting it in
the dashboard rather than pasting it anywhere is the reason this step is yours and not
something to delegate.

Optionally add a second secret, `SHOPPING_LIST_DB_SECRET`, to authenticate to Firebase with a
stored credential instead of creating an anonymous user per cold start. That also lets you
tighten the database rules, since the Worker would no longer need anonymous write access.

### Deploy from a checkout

If you do have a terminal:

```bash
cd mcp-server
npm install
npm run worker:token                                 # generate a token, copy it
npx wrangler secret put SHOPPING_LIST_ACCESS_TOKEN   # paste it when prompted
npm run worker:deploy
```

### Add it as a custom connector, which the mobile app cannot do

A connector cannot be **added** from the Claude iOS or Android app. Adding one is a claude.ai
web action, and the apps only *use* connectors that already exist on the account. A phone is
still enough, because the browser works.

Wrangler, or the dashboard, prints a URL like
`https://shopping-list-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is `/mcp`, and the
token can travel two ways:

| Where the token goes | URL to register |
| --- | --- |
| `Authorization: Bearer <token>` header | `https://…workers.dev/mcp` |
| A secret path segment | `https://…workers.dev/<token>/mcp` |

Use the header if the connector dialog lets you add one. Use the path form if it only accepts a
URL: that is the same "unguessable URL" protection the shopping lists already rely on, since
anyone holding a `?list=` link can edit that list.

Then:

1. Open <https://claude.ai/settings/connectors?modal=add-custom-connector> in a browser, not the
   app. Failing that, go to Settings → Connectors (Customize → Connectors on Pro/Max) and press
   **+**, then **Add custom connector**. Turn on the browser's "Request desktop site" if the
   mobile layout hides the control.
2. Give it the URL from the table above.
3. Sign in to the mobile app again. A newly added connector appears on the next login, and in
   Cowork, since an authorised connector stays live across chat, Projects and Cowork.

Custom connectors are available on every plan, though a Free plan is limited to one.

### It fails closed

With no `SHOPPING_LIST_ACCESS_TOKEN` set, the Worker serves nothing and returns `503` explaining
how to set one. A wrong or missing token gets `401`. Only `/` answers unauthenticated, with a
fixed string that reveals nothing about the configuration. Tokens are compared by digest rather
than byte by byte, so the comparison does not short-circuit on the first wrong character.

This matters more than it looks: without it, a public URL would let anyone who found it read and
rewrite every list.

## The HTTP API, for things that cannot speak MCP

The Worker also serves a plain REST interface under `/api/`, behind the same access token. It
exists because most things that can call an API cannot speak MCP: a ChatGPT custom action, an
iOS Shortcut driven by Siri, a cron job, `curl`.

It is a thin adapter, not a second implementation. Each route calls the corresponding MCP tool
in-process, so matching, confirmation guards and compare-and-swap writes are the tools' own and
the two interfaces cannot drift apart. A test asserts that a write through REST is visible
through MCP.

| Route | Does |
| --- | --- |
| `GET /api/list` | Read the list. `?pending_only=true`, `?category=`, `?list_id=` |
| `POST /api/items` | Add items. `items` accepts plain strings or objects with `note`/`category` |
| `POST /api/items/check` | Tick off or un-tick. `checked=false` to clear, `all=true` to reset |
| `POST /api/items/remove` | Delete rows |
| `POST /api/reset` | `mode=untick` keeps rows, `mode=remove` needs `confirm=true` |
| `GET /api/link` | Shareable link plus a pasteable message |
| `GET /api/openapi.json` | OpenAPI 3.1 description of the above |

Only the operations worth having on a phone are exposed. MCP remains the full sixteen-tool
interface; a sprawling OpenAPI document makes an assistant worse at choosing, not better.

```bash
BASE=https://shopping-list-mcp.gavrielgr.workers.dev

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/list?pending_only=true"

curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"items":["חלב","ביצים"],"category":"חלב וביצים"}' \
  "$BASE/api/items"
```

The token can also ride in the path, which is how to check something from a phone browser where
there is nowhere to put a header:

```
https://shopping-list-mcp.gavrielgr.workers.dev/<token>/api/list?pending_only=true
```

Bear in mind that a URL carrying a token lands in browser history and possibly in browser sync,
so prefer the header form for anything permanent. Rotating the token is just editing the secret
in the Cloudflare dashboard.

### Siri, via an iOS Shortcut

This needs no AI subscription, no connector and no organisation permission, and it is the
fastest route while actually standing in a shop. Each family member installs it once.

1. Shortcuts → new shortcut → add **Dictate Text**.
2. Add **Get Contents of URL**:
   - URL `https://<your-worker>.workers.dev/api/items`
   - Method **POST**
   - Header `Authorization` = `Bearer <your token>`
   - Request Body **JSON**, with a field `items` of type Array containing the Dictated Text, and
     a field `category` set to whichever category you want new items to land in.
3. Name it something Siri can hear, such as "add to shopping list".

Ticking things off works the same way against `/api/items/check`.

### A ChatGPT custom action

1. Create a GPT, then Configure → **Actions**.
2. Paste the contents of `GET /api/openapi.json`. Fetch it in a browser using the secret-path
   form of the URL, `https://…workers.dev/<token>/api/openapi.json`, and copy what it returns.
   The document's `servers` entry keeps whatever path prefix you fetched it through, so the URL
   it gives is one that works.
3. Authentication → **API Key**, type **Bearer**, and paste the token. Then the `servers` URL can
   be the plain origin instead.

Anyone you share the GPT with can edit the list, which for a household list is the point. Treat
it as you would the `?list=` link.

## Tools

Every tool is prefixed `shopping_`, takes an optional `list_id` (defaulting to
`rehovot-family-4d7f8c12`, the list the site opens), and accepts
`response_format: "markdown" | "json"`.

### Lists

| Tool | Purpose |
| --- | --- |
| `shopping_list_lists` | Known lists with ids, links and progress |
| `shopping_get_list` | Read a list; `pending_only` for what is left to buy |
| `shopping_share_list` | Shareable link plus a ready-to-paste message for a DM |
| `shopping_create_list` | New list, returns its shareable link |
| `shopping_rename_list` | Rename a list |
| `shopping_delete_list` | Delete a list — needs `confirm: true` |

### Categories

| Tool | Purpose |
| --- | --- |
| `shopping_add_category` | Add a category, optionally with items |
| `shopping_update_category` | Change a category's name or aisle hint |
| `shopping_remove_category` | Remove a category — `confirm: true` if it holds items |
| `shopping_move_category` | Reorder categories to match the walk through the shop |

### Items

| Tool | Purpose |
| --- | --- |
| `shopping_add_items` | Add items in bulk, across categories, creating them if needed |
| `shopping_set_checked` | Tick off or un-tick by name; `all: true` resets everything |
| `shopping_update_item` | Change one row's name, note or tick |
| `shopping_remove_items` | Delete rows in bulk |
| `shopping_move_item` | Move a row between categories, or reorder within one |
| `shopping_clear_checked` | After a shop: `untick` (keep rows) or `remove` (needs `confirm`) |

### Examples

```
"What's left to buy?"           → shopping_get_list { pending_only: true }
"Send me a link to the list"    → shopping_share_list { include_items: true }
"Add milk, eggs and bread"      → shopping_add_items { items: [...], category: "חלב וביצים" }
"Got the milk and the carrots"  → shopping_set_checked { items: ["חלב", "גזר"] }
"Make it 3 bottles of olive oil"→ shopping_update_item { item: "שמן זית", new_note: "3 בקבוקים" }
"Reset the list for next week"  → shopping_clear_checked { mode: "untick" }
"Put produce first"             → shopping_move_category { category: "פירות וירקות", to_index: 0 }
```

## Design notes

**Names are matched loosely.** Item and category names are compared with case, Hebrew niqqud,
geresh/gershayim variants and surrounding whitespace folded away, then by exact match, prefix
and finally substring — so `חלב` finds `חלב 3%`. The tiers are ordered, so an exact name never
becomes ambiguous just because a longer name contains it. When a name really does match several
rows, the tool **says so and skips it** rather than guessing; the unambiguous names in the same
call are still applied.

**Concurrent edits are not clobbered.** The page saves with `set()`, replacing the whole list,
so a naive read-modify-write here would discard anything typed in a browser in between. Every
write is instead a compare-and-swap: the read asks for the node's ETag and the write sends it as
`if-match`. On a `412` the list is re-read and the *intent* is re-applied to the newer state, up
to four times. The `retries` field in each response reports how often that happened.

**`updatedAt` always increases.** `shouldApplyRemoteUpdate` in `list-model.js` only adopts an
incoming snapshot when `updatedAt` grew, so writes force it strictly above the stored value.
Without that, a device with a fast clock could leave an open tab ignoring real changes.

**Sparse arrays come back as objects.** The Realtime Database stores arrays as maps of
stringified indices and only returns a JSON array when the keys are contiguous from zero. A list
whose middle entry was removed arrives as `{"0":…,"2":…}`. Everything read is collapsed to a
dense array in index order before use.

**Enumerating lists is best-effort.** The database holds no index of lists, and the page keeps
its "recent lists" only in `localStorage`. `shopping_list_lists` therefore merges three sources:
a local registry of every list this server has touched, the default list, and — only if the
security rules permit reading the `shared-lists` root — a direct enumeration. A list created in a
browser and never edited here will not show up; address it by the `?list=` value in its URL.

**Destructive tools require confirmation.** `shopping_delete_list`, `shopping_remove_category`
on a non-empty category, and `shopping_clear_checked` with `mode: "remove"` all refuse unless
`confirm: true`, and say what would be lost.

**A mutation that changes nothing is not written.** The page re-renders by replacing the list's
`innerHTML` whenever it adopts a remote update, which takes focus out of whatever row someone is
typing in. Bumping `updatedAt` for a write that changed nothing would do that for no reason.

**Local failures are never fatal.** The state file holding the reusable anonymous identity and
the known-list registry is a convenience. If it cannot be written the server warns once on
stderr and carries on, because reporting a failure after the database write has committed would
invite a retry of an edit that is not idempotent.

## Configuration

Everything has a working default; nothing needs setting for normal use.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHOPPING_LIST_DEFAULT_ID` | `rehovot-family-4d7f8c12` | List used when a tool gets no `list_id` |
| `SHOPPING_LIST_DATABASE_URL` | the project's RTDB URL | Realtime Database origin |
| `SHOPPING_LIST_API_KEY` | the key from `app.js` | Firebase web API key for anonymous sign-in |
| `SHOPPING_LIST_SITE_URL` | the GitHub Pages URL | Base for generated share links |
| `SHOPPING_LIST_ROOT` | `shared-lists` | Database path holding the lists |
| `SHOPPING_LIST_STATE_DIR` | `~/.shopping-list-mcp` | Token cache and known-list registry |
| `SHOPPING_LIST_DB_SECRET` | — | Database secret / admin token; bypasses security rules |
| `SHOPPING_LIST_ID_TOKEN` | — | Use a pre-minted Firebase ID token instead of signing in |
| `SHOPPING_LIST_TIMEOUT_MS` | `15000` | Per-request timeout |

### On the API key

The Firebase web API key in `src/constants.ts` is the same one published in the site's `app.js`.
A Firebase web API key identifies a project; it is not a credential. What anyone can actually do
is decided by the database security rules, so having it here grants nothing that loading the
public page does not. Override it if the project is ever rotated.

The state file holds a refresh token for the server's own anonymous identity, and is written
`0600`. Keeping it is what stops a new anonymous user being created on every start.

## Tests

```bash
npm test        # 73 tests
```

The tests run the real server over an in-memory MCP transport against a fake Realtime Database
that reproduces ETag compare-and-swap, empty-value pruning and the numeric-key array quirk. Because the calls go
through an actual MCP client, they also check the SDK's own input coercion and validate every
response against its declared output schema. Covered, among others: concurrent-edit retry, `updatedAt` monotonicity, token refresh after a
`401`, ambiguous-name handling, telling a network block apart from a rules denial, a committed
write surviving an unwritable local state file, no-op mutations not being written at all, and
every confirmation guard.

`test/app-contract.test.ts` imports the page's own `list-model.js` and asserts it can read what
this server writes. That is not decoration: an empty list is stored without a `departments` key
(the database deletes a key whose value is an empty array), and the page used to treat such a
payload as unreadable, skip the update while still displaying "synced", then save its own stale
categories back over it. The page now tolerates it, and this test fails if that regresses.

`test/worker.test.ts` drives the Worker's `fetch` handler directly, covering the fail-closed
default, a missing, wrong and prefix-of-correct token, both places a valid token may travel, and
an authenticated request to an unknown path.

Nothing in the suite touches the network or the real list.

The Worker was additionally verified by running it under `wrangler dev` in `workerd`, Cloudflare's
own runtime, completing an MCP handshake over HTTP and calling a tool that read the live database.
