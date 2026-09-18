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
npm test           # 88 tests
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

Nothing in the suite touches the network or the real list.
