import assert from "node:assert/strict";
import test from "node:test";
import { installFakeRtdb } from "./fake-rtdb.js";
import { LIST_PATH, seedList } from "./harness.js";
import {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  callbackUpdate,
  contactUpdate,
  fakeTelegram,
  say,
  scriptedModel,
  sqliteD1,
  textUpdate,
  toolCall,
  webhookRequest,
  type FakeTelegram
} from "./telegram-fakes.js";
import worker from "../src/worker.js";
import { MAX_MODEL_CALLS, STEP_LIMIT_REPLY } from "../src/telegram/agent.js";
import { BUSY_REPLY, handleTelegramWebhook, type BotDeps } from "../src/telegram/bot.js";
import type { BotEnv } from "../src/telegram/config.js";
import { geminiClient, type ChatMessage } from "../src/telegram/gemini.js";
import { d1Store, memoryStore, type BotStore } from "../src/telegram/store.js";

const ALLOWED = 42;
const STRANGER = 99;
const PHONE_USER = 55;

const botEnv = (extra: Partial<BotEnv> = {}): BotEnv => ({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  GEMINI_API_KEY: "test-gemini-key",
  BOT_ALLOWED_USER_IDS: String(ALLOWED),
  BOT_ALLOWED_PHONES: "052-1234567",
  ...extra
});

interface Fixture {
  tg: FakeTelegram;
  store: BotStore;
  deps: BotDeps;
  /** Deliver an update through the webhook and wait for the work to finish. */
  deliver(update: unknown, env?: BotEnv): Promise<Response>;
  /** Department names and items as stored, for asserting on real list changes. */
  items(): { name: string; checked: boolean }[];
}

async function withBot(
  run: (fixture: Fixture) => Promise<void>,
  overrides: Partial<BotDeps> = {}
): Promise<void> {
  const rtdb = installFakeRtdb({ data: { [LIST_PATH]: seedList() } });
  try {
    const tg = fakeTelegram();
    const store = overrides.store ?? memoryStore();
    const deps: BotDeps = { fetch: tg.fetch, store, typingIntervalMs: 60_000, ...overrides };
    await run({
      tg,
      store,
      deps,
      deliver: (update, env = botEnv()) => handleTelegramWebhook(webhookRequest(update), env, undefined, deps),
      items: () => {
        const list = rtdb.get<{ departments: { items: { name: string; checked: boolean }[] }[] }>(LIST_PATH);
        return (list?.departments ?? []).flatMap(department => department.items ?? []).filter(item => item.name);
      }
    });
  } finally {
    rtdb.restore();
  }
}

// --- The webhook route ---------------------------------------------------------------------

test("a webhook call with a wrong or missing secret gets 403", async () => {
  for (const secret of ["wrong-secret", null, `${WEBHOOK_SECRET}x`]) {
    const response = await worker.fetch(webhookRequest(textUpdate(ALLOWED, "hi"), secret), botEnv());
    assert.equal(response.status, 403, `secret ${secret}`);
  }
});

test("the webhook is a 404 when the bot is not configured", async () => {
  const response = await worker.fetch(webhookRequest(textUpdate(ALLOWED, "hi")), {});
  assert.equal(response.status, 404);
});

test("a GET on the webhook is a 405 whether or not the bot is configured", async () => {
  // This is the deploy check from a phone browser: an older build answers 401 here instead.
  for (const env of [{}, botEnv()]) {
    const response = await worker.fetch(new Request("https://example.workers.dev/telegram/webhook"), env);
    assert.equal(response.status, 405);
  }
});

test("the webhook answers at once and does the work in waitUntil", async () => {
  await withBot(async ({ tg, deps }) => {
    const pending: Promise<unknown>[] = [];
    const response = await handleTelegramWebhook(
      webhookRequest(textUpdate(ALLOWED, "/start")),
      botEnv(),
      { waitUntil: promise => pending.push(promise) },
      deps
    );
    assert.equal(response.status, 200);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.match(tg.sent()[0] ?? "", /רשימת הקניות/);
  });
});

test("the webhook does not weaken the access token on every other route", async () => {
  // With the bot configured but no access token, the Worker still fails closed elsewhere.
  for (const path of ["/mcp", "/telegram/setup", "/telegram/status", "/api/list"]) {
    const response = await worker.fetch(new Request(`https://example.workers.dev${path}`), botEnv());
    assert.equal(response.status, 503, path);
  }
});

// --- Who gets in ---------------------------------------------------------------------------

test("a stranger gets the phone button and never reaches the model", async () => {
  const model = scriptedModel([say("should never be called")]);
  await withBot(
    async ({ tg, deliver }) => {
      await deliver(textUpdate(STRANGER, "תוסיף חלב"));
      assert.equal(model.requests.length, 0);
      const [message] = tg.messages();
      const markup = message?.reply_markup as { keyboard: { request_contact?: boolean }[][] };
      assert.equal(markup.keyboard[0]?.[0]?.request_contact, true);

      await deliver(textUpdate(STRANGER, "/list"));
      assert.equal(tg.messages().length, 2);
      assert.ok(tg.messages()[1]?.reply_markup, "a stranger's /list gets the button again, not the list");
    },
    { model }
  );
});

test("a forwarded contact card is refused", async () => {
  const model = scriptedModel([say("hi")]);
  await withBot(
    async ({ tg, store, deliver }) => {
      // The phone is allowed, but the contact belongs to someone else.
      await deliver(contactUpdate(STRANGER, "+972521234567", PHONE_USER));
      assert.match(tg.sent()[0] ?? "", /רק את מספר הטלפון שלך/);
      assert.equal(await store.getVerifiedPhone(STRANGER), null);
      // A contact with no user id at all is refused the same way.
      await deliver(contactUpdate(STRANGER, "+972521234567"));
      assert.equal(await store.getVerifiedPhone(STRANGER), null);
      await deliver(textUpdate(STRANGER, "שלום"));
      assert.equal(model.requests.length, 0);
    },
    { model }
  );
});

test("an allowed phone gets in, however the number is written", async () => {
  const model = scriptedModel([say("שלום!")]);
  await withBot(
    async ({ tg, store, deliver }) => {
      await deliver(contactUpdate(PHONE_USER, "+972 52-123-4567", PHONE_USER));
      assert.equal(await store.getVerifiedPhone(PHONE_USER), "972521234567");
      assert.match(tg.sent()[0] ?? "", /אומתת/);
      await deliver(textUpdate(PHONE_USER, "שלום"));
      assert.equal(model.requests.length, 1);
      assert.equal(tg.sent().at(-1), "שלום!");
    },
    { model }
  );
});

test("a phone not on the allowlist is refused", async () => {
  await withBot(async ({ tg, store, deliver }) => {
    await deliver(contactUpdate(STRANGER, "+972500000000", STRANGER));
    assert.equal(await store.getVerifiedPhone(STRANGER), null);
    assert.match(tg.sent()[0] ?? "", /לא ברשימת המורשים/);
  });
});

test("removing a phone from the allowlist revokes a verified user", async () => {
  const model = scriptedModel([say("שלום!")]);
  await withBot(
    async ({ deliver }) => {
      await deliver(contactUpdate(PHONE_USER, "972521234567", PHONE_USER));
      await deliver(textUpdate(PHONE_USER, "שלום"), botEnv({ BOT_ALLOWED_PHONES: "" }));
      assert.equal(model.requests.length, 0);
    },
    { model }
  );
});

test("group chats are ignored", async () => {
  const model = scriptedModel([say("hi")]);
  await withBot(
    async ({ tg, deliver }) => {
      await deliver(textUpdate(ALLOWED, "תוסיף חלב", "group"));
      assert.equal(tg.calls.length, 0);
      assert.equal(model.requests.length, 0);
    },
    { model }
  );
});

// --- Commands ------------------------------------------------------------------------------

test("/list shows what is left without calling the model", async () => {
  const model = scriptedModel([say("should never be called")]);
  await withBot(
    async ({ tg, deliver }) => {
      await deliver(textUpdate(ALLOWED, "/list"));
      assert.equal(model.requests.length, 0);
      const text = tg.sent()[0] ?? "";
      assert.match(text, /גזר/);
      assert.match(text, /חמאה \(2 יחידות\)/);
      // Already bought, so not listed, only counted.
      assert.doesNotMatch(text, /תפוח עץ/);
      assert.match(text, /נשארו 4 מתוך 5/);
      assert.equal(tg.messages()[0]?.parse_mode, "HTML");
    },
    { model }
  );
});

test("/reset clears the history and /forget clears the verification too", async () => {
  const model = scriptedModel([say("שלום!")]);
  await withBot(
    async ({ store, deliver }) => {
      await deliver(contactUpdate(PHONE_USER, "0521234567", PHONE_USER));
      await deliver(textUpdate(PHONE_USER, "שלום"));
      assert.equal((await store.getHistory(PHONE_USER)).length, 2);
      await deliver(textUpdate(PHONE_USER, "/reset"));
      assert.equal((await store.getHistory(PHONE_USER)).length, 0);
      await deliver(textUpdate(PHONE_USER, "/forget"));
      assert.equal(await store.getVerifiedPhone(PHONE_USER), null);
    },
    { model }
  );
});

// --- A conversation ------------------------------------------------------------------------

test("asking to add items really adds them to the list", async () => {
  const model = scriptedModel([
    toolCall("shopping_add_items", {
      items: [{ name: "עגבניות" }, { name: "מלפפון", note: "3" }],
      category: "פירות וירקות"
    }),
    request => {
      const result = request.messages.at(-1);
      assert.equal(result?.role, "tool");
      return say("הוספתי עגבניות ומלפפון.");
    }
  ]);
  await withBot(
    async ({ tg, store, deliver, items }) => {
      await deliver(textUpdate(ALLOWED, "תוסיף עגבניות ו-3 מלפפונים"));
      const names = items().map(item => item.name);
      assert.ok(names.includes("עגבניות"));
      assert.ok(names.includes("מלפפון"));
      assert.equal(tg.sent().at(-1), "הוספתי עגבניות ומלפפון.");
      assert.ok(tg.calls.some(call => call.method === "sendChatAction"));

      // Only plain text is remembered, never the tool calls.
      assert.deepEqual(await store.getHistory(ALLOWED), [
        { role: "user", content: "תוסיף עגבניות ו-3 מלפפונים" },
        { role: "assistant", content: "הוספתי עגבניות ומלפפון." }
      ]);
      // The tools offered are the MCP server's own, minus deleting a list.
      const offered = model.requests[0]!.tools.map(tool => tool.function.name);
      assert.ok(offered.includes("shopping_add_items"));
      assert.ok(!offered.includes("shopping_delete_list"));
      assert.equal(offered.length, 15);
    },
    { model }
  );
});

test("history from earlier turns is sent to the model as plain text", async () => {
  const model = scriptedModel([say("ראשון"), say("שני")]);
  await withBot(
    async ({ deliver }) => {
      await deliver(textUpdate(ALLOWED, "הודעה 1"));
      await deliver(textUpdate(ALLOWED, "הודעה 2"));
      const second = model.requests[1]!.messages.map(message => [message.role, message.content]);
      assert.deepEqual(second.slice(1), [
        ["user", "הודעה 1"],
        ["assistant", "ראשון"],
        ["user", "הודעה 2"]
      ]);
    },
    { model }
  );
});

test("several tool calls in one message all run, in order, each with its own reply", async () => {
  const both: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "shopping_set_checked", arguments: JSON.stringify({ items: ["גזר"], checked: true }) } },
      { id: "b", type: "function", function: { name: "shopping_add_items", arguments: JSON.stringify({ items: [{ name: "לחם" }], category: "חלב וביצים" }) } }
    ]
  };
  const model = scriptedModel([both, say("עשיתי את שניהם.")]);
  await withBot(
    async ({ deliver, items }) => {
      await deliver(textUpdate(ALLOWED, "קניתי גזר, ותוסיף לחם"));
      assert.equal(items().find(item => item.name === "גזר")?.checked, true);
      assert.ok(items().some(item => item.name === "לחם"));
      const replies = model.requests[1]!.messages.filter(message => message.role === "tool");
      assert.deepEqual(replies.map(reply => reply.tool_call_id), ["a", "b"]);
    },
    { model }
  );
});

test("the tool-call message goes back exactly as received, thought signature included", async () => {
  const signed = toolCall("shopping_get_list", {}, {
    extra_content: { google: { thought_signature: "c2lnbmF0dXJlLWJ5dGVz" } }
  });
  signed.extra_top_level = { kept: true };
  const model = scriptedModel([signed, say("הנה.")]);
  await withBot(
    async ({ deliver }) => {
      await deliver(textUpdate(ALLOWED, "מה ברשימה?"));
      const echoed = model.requests[1]!.messages.find(message => message.role === "assistant");
      assert.deepEqual(echoed, signed);
    },
    { model }
  );
});

test("a tool call without an id gets one, and its reply references it", async () => {
  const noId: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [{ type: "function", function: { name: "shopping_get_list", arguments: "{}" } }]
  };
  const model = scriptedModel([noId, say("הנה.")]);
  await withBot(
    async ({ deliver }) => {
      await deliver(textUpdate(ALLOWED, "מה ברשימה?"));
      const messages = model.requests[1]!.messages;
      const id = messages.find(message => message.role === "assistant")?.tool_calls?.[0]?.id;
      assert.ok(id, "an id was generated");
      assert.equal(messages.find(message => message.role === "tool")?.tool_call_id, id);
    },
    { model }
  );
});

test("unreadable arguments go back to the model as an error and the turn continues", async () => {
  const model = scriptedModel([toolCall("shopping_add_items", "{not json"), say("סליחה, ננסה שוב.")]);
  await withBot(
    async ({ tg, deliver }) => {
      await deliver(textUpdate(ALLOWED, "תוסיף חלב"));
      const reply = model.requests[1]!.messages.find(message => message.role === "tool");
      assert.match(String(reply?.content), /^Error: could not read the arguments/);
      assert.equal(tg.sent().at(-1), "סליחה, ננסה שוב.");
    },
    { model }
  );
});

test("a turn stops after the maximum number of model calls", async () => {
  const model = scriptedModel([toolCall("shopping_get_list", {})]);
  await withBot(
    async ({ tg, deliver }) => {
      await deliver(textUpdate(ALLOWED, "לולאה"));
      assert.equal(model.requests.length, MAX_MODEL_CALLS);
      assert.equal(tg.sent().at(-1), STEP_LIMIT_REPLY);
    },
    { model }
  );
});

test("a re-delivered update is handled once", async () => {
  const model = scriptedModel([say("פעם אחת")]);
  await withBot(
    async ({ tg, deliver }) => {
      const update = textUpdate(ALLOWED, "שלום");
      await deliver(update);
      await deliver(update);
      assert.equal(model.requests.length, 1);
      assert.equal(tg.sent().length, 1);
    },
    { model }
  );
});

// --- Model fallback, end to end --------------------------------------------------------------

/** Telegram plus a Gemini endpoint answering from a per-model script of statuses. */
function geminiRouter(
  tg: FakeTelegram,
  statuses: Record<string, number[]>,
  seen: { model: string; body: Record<string, unknown> }[]
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    if (!href.startsWith("https://generativelanguage.googleapis.com/")) return tg.fetch(input, init);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const model = String(body.model);
    seen.push({ model, body });
    const status = statuses[model]?.shift() ?? 200;
    if (status !== 200) return new Response(`{"error":{"code":${status}}}`, { status });
    const turn = seen.filter(entry => entry.model === model).length;
    const message = turn === 1 ? toolCall("shopping_get_list", {}) : say(`answered by ${model}`);
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;
}

test("when every model is busy the user gets the friendly text", async () => {
  await withBot(async ({ tg, deps, deliver }) => {
    const seen: { model: string; body: Record<string, unknown> }[] = [];
    deps.fetch = geminiRouter(tg, { "m-a": [503], "m-b": [429] }, seen);
    await deliver(textUpdate(ALLOWED, "שלום"), botEnv({ BOT_MODEL: "m-a, m-b" }));
    assert.deepEqual(seen.map(entry => entry.model), ["m-a", "m-b"]);
    assert.equal(tg.sent().at(-1), BUSY_REPLY);
  });
});

test("a busy first model falls back to the next, and the turn stays on that model", async () => {
  await withBot(async ({ tg, deps, deliver }) => {
    const seen: { model: string; body: Record<string, unknown> }[] = [];
    deps.fetch = geminiRouter(tg, { "m-a": [503] }, seen);
    await deliver(textUpdate(ALLOWED, "מה ברשימה?"), botEnv({ BOT_MODEL: "m-a,m-b" }));
    // m-a refused, m-b made the tool call, and the follow-up went to m-b rather than back to m-a.
    assert.deepEqual(seen.map(entry => entry.model), ["m-a", "m-b", "m-b"]);
    assert.equal(tg.sent().at(-1), "answered by m-b");
    // The key goes in a header, never the body or the URL.
    assert.ok(!JSON.stringify(seen).includes("test-gemini-key"));
  });
});

test("a model that goes busy mid-turn is not swapped for another", async () => {
  // Its tool calls carry thought signatures that only it can accept.
  await withBot(async ({ tg, deps, deliver }) => {
    const seen: { model: string; body: Record<string, unknown> }[] = [];
    deps.fetch = geminiRouter(tg, { "m-a": [200, 503] }, seen);
    await deliver(textUpdate(ALLOWED, "מה ברשימה?"), botEnv({ BOT_MODEL: "m-a,m-b" }));
    assert.deepEqual(seen.map(entry => entry.model), ["m-a", "m-a"]);
    assert.equal(tg.sent().at(-1), BUSY_REPLY);
  });
});

test("the Gemini request carries the key in the Authorization header", async () => {
  let headers: Record<string, string> = {};
  const client = geminiClient("secret-key", ["m"], (async (_input: unknown, init: RequestInit = {}) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ choices: [{ message: say("ok") }] }));
  }) as typeof fetch);
  await client.complete([], [], { deadline: Date.now() + 10_000 });
  assert.equal(headers.Authorization, "Bearer secret-key");
});

// --- Destructive actions need a button press -----------------------------------------------

test("clearing bought items waits for the confirmation button", async () => {
  const model = scriptedModel([
    toolCall("shopping_clear_checked", { mode: "remove", confirm: true }),
    request => {
      assert.match(String(request.messages.at(-1)?.content), /confirmation button/);
      return say("לחצו על הכפתור לאישור.");
    }
  ]);
  await withBot(
    async ({ tg, deliver, items }) => {
      await deliver(textUpdate(ALLOWED, "תנקה את מה שקנינו"));
      // Nothing deleted yet, whatever the model decided.
      assert.ok(items().some(item => item.name === "תפוח עץ"));

      const button = tg.messages().at(-1);
      const keyboard = (button?.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
      const confirm = keyboard[0]![0]!.callback_data;
      assert.match(confirm, /^ok:[a-f0-9]{32}$/);
      assert.equal(tg.sent().at(-2), "לחצו על הכפתור לאישור.");

      // A stranger pressing it achieves nothing.
      await deliver(callbackUpdate(STRANGER, confirm));
      assert.ok(items().some(item => item.name === "תפוח עץ"));

      await deliver(callbackUpdate(ALLOWED, confirm));
      assert.ok(!items().some(item => item.name === "תפוח עץ"));
      const edit = tg.calls.filter(call => call.method === "editMessageText").at(-1);
      assert.match(String(edit?.body.text), /בוצע/);

      // A second press finds nothing to run.
      await deliver(callbackUpdate(ALLOWED, confirm));
      const again = tg.calls.filter(call => call.method === "editMessageText").at(-1);
      assert.match(String(again?.body.text), /לא בתוקף/);
    },
    { model }
  );
});

test("pressing cancel leaves the list alone", async () => {
  const model = scriptedModel([toolCall("shopping_clear_checked", { mode: "remove", confirm: true }), say("לחצו לאישור.")]);
  await withBot(
    async ({ tg, deliver, items }) => {
      await deliver(textUpdate(ALLOWED, "תנקה את מה שקנינו"));
      const keyboard = (tg.messages().at(-1)?.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
      await deliver(callbackUpdate(ALLOWED, keyboard[0]![1]!.callback_data));
      assert.ok(items().some(item => item.name === "תפוח עץ"));
    },
    { model }
  );
});

test("a confirmation expires", async () => {
  let clock = 1_000_000;
  const model = scriptedModel([toolCall("shopping_clear_checked", { mode: "remove", confirm: true }), say("לחצו לאישור.")]);
  await withBot(
    async ({ tg, deliver, items }) => {
      await deliver(textUpdate(ALLOWED, "תנקה את מה שקנינו"));
      const keyboard = (tg.messages().at(-1)?.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
      clock += 11 * 60 * 1000;
      await deliver(callbackUpdate(ALLOWED, keyboard[0]![0]!.callback_data));
      assert.ok(items().some(item => item.name === "תפוח עץ"));
    },
    { model, now: () => clock }
  );
});

// --- Formatting ----------------------------------------------------------------------------

test("a reply Telegram cannot parse as HTML is resent as plain text", async () => {
  const model = scriptedModel([say("**שלום** <עולם>")]);
  const rtdb = installFakeRtdb({ data: { [LIST_PATH]: seedList() } });
  try {
    const tg = fakeTelegram({ rejectHtml: true });
    await handleTelegramWebhook(webhookRequest(textUpdate(ALLOWED, "היי")), botEnv(), undefined, {
      fetch: tg.fetch,
      store: memoryStore(),
      model
    });
    const sends = tg.calls.filter(call => call.method === "sendMessage");
    assert.equal(sends.length, 2);
    assert.equal(sends[0]?.body.text, "<b>שלום</b> &lt;עולם&gt;");
    assert.equal(sends[1]?.body.parse_mode, undefined);
    assert.equal(sends[1]?.body.text, "**שלום** <עולם>");
  } finally {
    rtdb.restore();
  }
});

test("a long reply is split into messages Telegram accepts", async () => {
  const long = Array.from({ length: 400 }, (_, index) => `שורה מספר ${index} עם קצת טקסט נוסף`).join("\n");
  const model = scriptedModel([say(long)]);
  await withBot(
    async ({ tg, deliver }) => {
      await deliver(textUpdate(ALLOWED, "היי"));
      const texts = tg.sent();
      assert.ok(texts.length > 1);
      for (const text of texts) assert.ok(text.length <= 4096);
      assert.equal(texts.join("\n"), long);
    },
    { model }
  );
});

// --- Owner routes --------------------------------------------------------------------------

const ACCESS = "owner-access-token";

test("the setup route registers the webhook with the secret and the command menu", async () => {
  const tg = fakeTelegram();
  const original = globalThis.fetch;
  globalThis.fetch = tg.fetch;
  try {
    const unauthorized = await worker.fetch(
      new Request("https://example.workers.dev/telegram/setup"),
      { ...botEnv(), SHOPPING_LIST_ACCESS_TOKEN: ACCESS }
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(tg.calls.length, 0);

    const response = await worker.fetch(
      new Request(`https://example.workers.dev/${ACCESS}/telegram/setup`),
      { ...botEnv(), SHOPPING_LIST_ACCESS_TOKEN: ACCESS }
    );
    assert.equal(response.status, 200);
    const setWebhook = tg.calls.find(call => call.method === "setWebhook");
    assert.equal(setWebhook?.body.url, "https://example.workers.dev/telegram/webhook");
    assert.equal(setWebhook?.body.secret_token, WEBHOOK_SECRET);
    assert.deepEqual(setWebhook?.body.allowed_updates, ["message", "callback_query"]);
    assert.ok(tg.calls.some(call => call.method === "setMyCommands"));
    const text = await response.text();
    assert.ok(!text.includes(BOT_TOKEN));
    assert.ok(!text.includes(WEBHOOK_SECRET));
  } finally {
    globalThis.fetch = original;
  }
});

test("the setup route refuses a secret Telegram would reject", async () => {
  const response = await worker.fetch(
    new Request(`https://example.workers.dev/${ACCESS}/telegram/setup`),
    { ...botEnv({ TELEGRAM_WEBHOOK_SECRET: "has spaces & symbols!" }), SHOPPING_LIST_ACCESS_TOKEN: ACCESS }
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /bad_webhook_secret/);
});

test("the status route reports the webhook and never the bot token", async () => {
  // Even if Telegram's answer somehow contained the token, it is scrubbed.
  const tg = fakeTelegram({ webhookInfo: { url: "https://example.workers.dev/telegram/webhook", last_error_message: `oops ${BOT_TOKEN}` } });
  const original = globalThis.fetch;
  globalThis.fetch = tg.fetch;
  try {
    const response = await worker.fetch(
      new Request(`https://example.workers.dev/${ACCESS}/telegram/status`),
      { ...botEnv(), SHOPPING_LIST_ACCESS_TOKEN: ACCESS }
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(BOT_TOKEN));
    const body = JSON.parse(text) as { bot: string; deployment: { storage: string; allowed_phones: number } };
    assert.equal(body.bot, "@family_list_bot");
    assert.equal(body.deployment.allowed_phones, 1);
    assert.match(body.deployment.storage, /^memory/);
  } finally {
    globalThis.fetch = original;
  }
});

// --- D1 ------------------------------------------------------------------------------------

test("the D1 store works against real SQLite", async t => {
  const db = await sqliteD1();
  if (!db) {
    t.skip("node:sqlite is not available in this Node version");
    return;
  }
  const store = d1Store(db);
  assert.equal(await store.markUpdateSeen(7), true);
  assert.equal(await store.markUpdateSeen(7), false);

  assert.deepEqual(await store.getHistory(1), []);
  await store.saveHistory(1, [{ role: "user", content: "שלום" }]);
  await store.saveHistory(1, [{ role: "user", content: "שלום" }, { role: "assistant", content: "היי" }]);
  assert.equal((await store.getHistory(1)).length, 2);
  await store.clearHistory(1);
  assert.deepEqual(await store.getHistory(1), []);

  await store.saveVerifiedUser(5, "972521234567");
  assert.equal(await store.getVerifiedPhone(5), "972521234567");
  await store.forgetUser(5);
  assert.equal(await store.getVerifiedPhone(5), null);

  const action = { id: "a".repeat(32), chatId: 1, userId: 1, tool: "shopping_clear_checked", args: { mode: "remove", confirm: true }, createdAt: 1 };
  await store.savePending(action);
  assert.deepEqual(await store.takePending(action.id), action);
  assert.equal(await store.takePending(action.id), null);
});

test("the whole bot runs on the D1 store", async t => {
  const db = await sqliteD1();
  if (!db) {
    t.skip("node:sqlite is not available in this Node version");
    return;
  }
  const model = scriptedModel([say("שלום!")]);
  await withBot(
    async ({ deliver, store }) => {
      await deliver(contactUpdate(PHONE_USER, "0521234567", PHONE_USER));
      const update = textUpdate(PHONE_USER, "שלום");
      await deliver(update);
      await deliver(update);
      assert.equal(model.requests.length, 1);
      assert.equal((await store.getHistory(PHONE_USER)).length, 2);
    },
    { model, store: d1Store(db) }
  );
});
