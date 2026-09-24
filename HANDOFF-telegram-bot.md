# Handoff: a Telegram bot for the family shopping list

> **Status (September 2026): built.** The code is in `mcp-server/src/telegram/`, the phone-only
> setup and the troubleshooting steps are in `mcp-server/README.md` under "The family Telegram
> bot", and the tests are `mcp-server/test/telegram*.test.ts`. The original brief follows,
> unchanged. Where the build deliberately differs from it:
>
> - **The tool declarations are generated at build time**, not by `listTools()` on each turn.
>   Measured: one `listTools()` costs about 30 ms of CPU, three times the free plan's budget,
>   because the SDK converts every zod schema on each call. `build-catalog.js` runs after `tsc`
>   and writes them from the server itself, so there is still no hand-written copy.
> - **`shopping_delete_list` is left out**, not just "considered", and is unreachable even if a
>   model names it.
> - **Destructive calls wait for a button press.** The `confirm` flag is set by the model, and
>   item names are text anyone with the list link can type, so the flag alone was an honour
>   system. The bot holds a `confirm=true` call and runs it only when a family member presses
>   "✅ כן, לבצע". This adds `callback_query` to `allowed_updates` and a `pending` table.
> - **The deploy check is 405 vs 401, not 405 vs 404.** On an older build, `/telegram/webhook`
>   has two path segments, so the existing token parser reads `telegram` as the token and answers
>   401.
> - **Allowlists should be secrets**, and `wrangler.toml` now has `keep_vars = true`. Workers
>   Builds deploys with `wrangler deploy`, which deletes dashboard variables not listed in
>   `wrangler.toml`; that would have emptied the allowlists on every push.
> - **D1 needs no manual step.** The binding is declared without an id; wrangler 4.134 creates the
>   database on the first deploy and reuses it. If the deploy token may not create it, the bot
>   falls back to memory and the status route says so.
> - **Update de-duplication has its own table**, `updates`, since module memory does not survive
>   across isolates.
> - **The setup route also sets the command menu**, so step 1's `/setcommands` is unnecessary, and
>   it refuses a webhook secret containing characters Telegram rejects.
> - **`BOT_MODEL` defaults to three models**, `gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite`,
>   all listed as free on Google's pricing page in September 2026.
> - **CPU is measured locally only** (2.7 ms warm per three-step turn). The production number
>   still has to be read from the Cloudflare dashboard after real use.

Written for a fresh Claude Code session working in `gavrielgr-ux/shopping-list`, with no prior
context. Read it once, then build. Put this file in the repo root as `HANDOFF-telegram-bot.md`.

## The goal

Let family members manage the shopping list by chatting with a private Telegram bot, in Hebrew:
"תוסיף חלב, ביצים ולחם", "מה חסר?", "סימנתי שקניתי את הלחם", "תנקה את מה שקנינו".
Only family members can use it. It must run for free.

The owner has **no computer, only a phone**. Every setup step must be doable from a phone
browser: the Cloudflare dashboard, Google AI Studio, and Telegram itself. Never tell them to run
`wrangler`, `curl` or a terminal.

## What already exists (do not rebuild it)

Read `README.md`, `HANDOFF.md` and `mcp-server/README.md` first. In short:

- A static site (GitHub Pages) over a Firebase Realtime Database, lists at `shared-lists/{id}`.
- `mcp-server/`: a TypeScript MCP server with 16 tools (`shopping_add_items`,
  `shopping_get_list`, `shopping_set_checked`, `shopping_clear_checked`, ...). They already do
  Hebrew-aware loose matching, compare-and-swap writes and `confirm` guards on destructive ops.
- It is deployed as a Cloudflare Worker, `https://shopping-list-mcp.gavrielgr.workers.dev`,
  redeployed on every push to `main` by Workers Builds. `src/worker.ts` serves `/mcp` and
  `/api/*` behind `SHOPPING_LIST_ACCESS_TOKEN`.
- `src/rest.ts` already shows the key pattern: call a tool **in-process** through an MCP
  `Client` over `InMemoryTransport.createLinkedPair()`. The bot does exactly this.
- Tests: `npm test` (node:test on the compiled `dist/`), with a fake RTDB in `test/fake-rtdb.ts`.

## The design

Add the bot to the **existing Worker**. There is no new service.

```
Telegram ──POST /telegram/webhook──▶ worker.ts ──▶ src/telegram/bot.ts   access control, commands
                                                          │
                                                          ▼
                                                   src/telegram/agent.ts  Gemini tool loop
                                                          │
                                        MCP Client ─InMemoryTransport─▶ createServer()  (the 16 tools)
```

1. **Route.** `POST /telegram/webhook` is handled in `worker.ts` **before** the access-token
   check, because Telegram cannot send that token. Instead it must match the
   `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`, compared by
   digest like `secretsMatch`. Return 404 when the bot is not configured, 403 on a wrong secret.
   The route is POST-only, so a GET gets 405. That is useful: GET → 405 means "deployed", while
   GET → 404 means an old build is still live.
2. **Answer fast, work in the background.** Return 200 at once and do the work in
   `ctx.waitUntil(...)`. Add `ctx: ExecutionContext` to the `fetch` signature. Dedupe on
   `update_id`, because Telegram re-delivers updates it thinks failed.
3. **Tools come from the MCP server itself.** At the start of a turn, run `client.listTools()`
   and turn each tool into a Gemini function declaration (name, description, `inputSchema`). Run
   each call with `client.callTool()` and pass the tool's text result back. Never hand-write a
   second copy of the tools; `rest.ts` explains why (the two would drift apart).
   Expose all 16 tools. The existing `confirm` guards already make the model ask before
   deleting, so keep them. Consider leaving `shopping_delete_list` out.
4. **Model: Gemini free tier** (no credit card), through its **OpenAI-compatible** endpoint with
   plain `fetch`, so no SDK is needed: `POST
   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, with
   `Authorization: Bearer <GEMINI_API_KEY>`, `tools`, `tool_choice: "auto"` and
   `reasoning_effort`.
5. **Memory.** Keep only the plain text of the last ~10 turns per chat, never tool calls. Workers
   have no disk, so use **D1** (SQLite, free tier) for `chats(chat_id, history, updated_at)` and
   `users(user_id, phone, verified_at)`. KV is the fallback, but it is eventually consistent, so
   two quick messages can read stale history. Do not store chats in the Firebase database: anyone
   who can read a list can read everything under `shared-lists`.
6. **Who gets in.** Two env allowlists: `BOT_ALLOWED_USER_IDS` (Telegram numeric ids) and
   `BOT_ALLOWED_PHONES`. An unknown user gets a "share my phone number" button
   (`request_contact: true`). Accept the contact **only if `contact.user_id === from.id`**, so a
   forwarded contact card doesn't work. Normalize phones to international digits and read `05x`
   as Israeli (`052-1234567` = `972521234567`). Answer private chats only. Log the id of each
   refused user, so the owner can copy it from the Cloudflare logs.
7. **Commands.** `/start` (how-to), `/list` (shows the list directly through
   `shopping_get_list`, with **no model call**, so it's instant and uses no quota), `/reset`
   (clears history), `/forget`.

## Lessons from the book-recommender bot (all were real bugs or incidents)

The same owner built this before, in `gavrielgr-ux/Mazkeret-Batya-Book-Recommender`, as a Python
version (`app/telegram_bot.py`, `app/bot_gemini.py`, `app/telegram_api.py`). Port the behaviour,
not the language. Every item below cost a round-trip there:

1. **Gemini's newest Flash answers 503 "high demand" on the free tier.** Make `BOT_MODEL` a
   comma-separated list, defaulting to `gemini-3.8-flash,gemini-3.5-flash-lite` (both free per
   Google's pricing page; re-check it). On 429 or 503, try the next model. When every model is
   busy, reply "המודל עמוס כרגע או שהגעתי למגבלת השימוש החינמית. נסו שוב בעוד דקה." instead of
   failing.
2. **Once a model answers, keep that model for the rest of the turn.** Gemini 3 attaches thought
   signatures to tool calls (`tool_calls[].extra_content.google.thought_signature`), and they
   belong to the model that made them. The next turn starts from the top of the list again.
3. **Send the assistant's tool-call message back exactly as received.** Rebuilding it drops the
   signature, and Gemini rejects the turn.
4. **Clean the tool schemas before sending them.** Gemini's schema format rejects some JSON
   Schema features. Recursively:
   - replace `anyOf: [X, {type: "null"}]` with `X` and drop a `default: null`
   - drop the string `title` labels
   - drop `additionalProperties` and `$schema`

   **Only drop `title` when its value is a string.** The book bot first dropped *everything*
   named `title`, which deleted a real parameter called `title` from a tool. A test caught it.
   Here, zod v4 output may also carry `$schema`/`$defs`, so inspect `listTools()` output before
   writing the cleaner.
5. **A `tool_call` may arrive without an `id`.** Generate one before replying to it.
6. **Arguments arrive as a JSON string.** A parse failure goes back to the model as an
   `"Error: ..."` tool result. It must never crash the turn.
7. **Keys go in headers, never in URLs.** The Telegram Bot API puts the bot token in the URL
   (`/bot<TOKEN>/sendMessage`), so never log a Telegram request URL or include it in an error.
8. **Telegram formatting.** Convert `**bold**` and `[text](url)` to Telegram HTML. If Telegram
   rejects the HTML, resend as plain text. Split at 4096 characters. Show "typing…" every ~4
   seconds while working.
9. **Log which backend is live** at the first request, e.g.
   `telegram bot answering with gemini (gemini-3.8-flash,gemini-3.5-flash-lite)`. It made "is the
   new build even deployed?" a one-glance check.
10. **Free-tier privacy.** Google may use free-tier prompts to improve its products. Say so in
    the docs. Shopping lists are low-risk, but the family should know.
11. **Cap the loop**: at most 8 model calls per message.

## Cloudflare free-tier limits (verify these first; they are the main risk)

- **CPU time.** The free plan allows about 10 ms of CPU per request; waiting on `fetch` does not
  count. A Gemini tool loop is mostly waiting, but building the MCP server and serializing
  schemas on every turn costs CPU. **Measure it early** (Observability → CPU time) with a real
  3-step turn. If it keeps hitting error 1102 (exceeded CPU), the options are:
  - cache `listTools()` output at module scope
  - trim the number of tools
  - Workers Paid ($5 a month), with the owner's agreement
  - run the bot on Railway like the book bot, calling the existing `/api/` over HTTP
- **`waitUntil` gets about 30 seconds after the response.** Gemini Flash turns are normally a few
  seconds, but set a per-call timeout (~20 s) and send the friendly "try again" text on timeout.
- **D1:** create the database in the dashboard (Workers → D1), bind it in `wrangler.toml` as
  `DB`, and create the tables with `CREATE TABLE IF NOT EXISTS` on first use. No migrations step.

## Setup the owner does from a phone (write this into the README, in this order)

1. Telegram → `@BotFather` → `/newbot`, then copy the token. Then `/setcommands`:
   `start - איך זה עובד`, `list - הצג את הרשימה`, `reset - שיחה חדשה`, `forget - מחק הכול`.
2. Get a Gemini key at <https://aistudio.google.com/apikey> (Google account only, no card).
3. Cloudflare dashboard → the `shopping-list-mcp` Worker → Settings → Variables and Secrets. Add
   these as **secrets**: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, and `TELEGRAM_WEBHOOK_SECRET`
   (any long random string). Add as plain variables: `BOT_ALLOWED_PHONES` and/or
   `BOT_ALLOWED_USER_IDS`, and optionally `BOT_MODEL`.
4. Register the webhook **without a terminal**. Add a route `GET /<ACCESS_TOKEN>/telegram/setup`,
   behind the existing token, that calls Telegram's `setWebhook` with
   `url=https://<worker>/telegram/webhook`, `secret_token`, and
   `allowed_updates=["message"]`, and returns Telegram's answer. The owner opens that URL once in
   the phone browser. Also add `/<ACCESS_TOKEN>/telegram/status` (Telegram's `getWebhookInfo`,
   with the token removed), which is the first thing to check when "the bot does nothing".
5. Message the bot.

## Tests (match the existing style: node:test on `dist/`)

- Telegram as a fake `fetch` that records calls. Gemini as a scripted fake returning tool calls,
  then text. The tools through the existing fake RTDB, so tool calls really change a list.
- Cover:
  - a wrong or missing secret gets 403
  - no config gets 404
  - a stranger gets the phone button and never reaches the model
  - a forwarded contact is refused
  - an allowed phone gets in
  - `/list` makes no model call
  - "add milk and eggs" → `shopping_add_items` → the fake list contains them
  - parallel tool calls
  - the signature round-trips unchanged
  - 503 on the first model falls back to the second
  - a turn stays on the model that answered
  - all models busy → the friendly text
  - a missing tool-call id
  - bad JSON arguments
  - the step cap
  - `update_id` dedupe
  - HTML fallback and message splitting
  - the schema cleaner: `anyOf` removed and **a parameter named `title` survives**
- Keep the existing tests passing, especially `worker.test.ts`'s "fails closed without a token".
  The webhook route must not weaken that.

## Nice to have, after the core works

- **Voice messages**: send the `.ogg` to Gemini as audio and treat the transcript as the message.
  This fits a shopping list well ("add tomatoes" while driving).
- **A photo of a recipe or a receipt**: extract the items, confirm them, then add.
- **A morning digest** via a Cron Trigger: "7 items left on the list".

## Definition of done

- A family member says "תוסיף חלב וביצים" and sees them appear in the open site tab within
  seconds.
- A stranger gets nothing but the phone button.
- `npm test` is green.
- The README has the phone-only setup steps.
- No secret appears in code, logs or errors.
- Real CPU time per turn is measured and written down in the README.
