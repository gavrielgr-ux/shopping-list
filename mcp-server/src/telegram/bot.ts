/**
 * The Telegram bot: webhook handling, access control, commands and confirmations.
 *
 * Flow: Telegram POSTs an update to /telegram/webhook. The Worker checks the secret header,
 * answers 200 at once, and does the work in `ctx.waitUntil`, because Telegram re-delivers an
 * update it thinks failed and a model turn takes seconds.
 *
 * Only family members get in: a Telegram user id on BOT_ALLOWED_USER_IDS, or a user who shared
 * their own phone number and that number is on BOT_ALLOWED_PHONES. Everyone else gets the
 * "share my phone number" button and never reaches the model.
 */
import { secretsMatch } from "../secrets.js";
import { MAX_MODEL_CALLS, runAgent } from "./agent.js";
import { normalizePhone, readConfig, WEBHOOK_SECRET_PATTERN, type BotConfig, type BotEnv } from "./config.js";
import { geminiClient, ModelsBusyError, type ModelClient } from "./gemini.js";
import type { ExecutionContext } from "./platform.js";
import { d1Store, memoryStore, type BotStore, type ChatTurn } from "./store.js";
import { TelegramApi, TelegramError } from "./telegram-api.js";
import { mcpTools, type ToolRunner } from "./tools.js";

type FetchLike = typeof fetch;

/** Everything the bot talks to, replaceable in tests. */
export interface BotDeps {
  /** Used for Telegram and Gemini. The tools reach Firebase through the global fetch. */
  fetch?: FetchLike;
  store?: BotStore;
  tools?: ToolRunner;
  model?: ModelClient;
  now?: () => number;
  /** How often "typing…" is refreshed while a turn runs. */
  typingIntervalMs?: number;
}

/** Plain-text turns kept per chat: ten exchanges. Tool calls are never stored. */
export const HISTORY_LIMIT = 20;

/** A confirmation button stops working after this long. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export const BUSY_REPLY =
  "המודל עמוס כרגע או שהגעתי למגבלת השימוש החינמית. נסו שוב בעוד דקה.";
const ERROR_REPLY = "משהו השתבש. נסו שוב בעוד רגע.";
const NO_MODEL_REPLY =
  "הבוט עוד לא מחובר למודל: חסר GEMINI_API_KEY בהגדרות ה-Worker. בינתיים /list עובד.";

const START_TEXT = `שלום! אני עוזר רשימת הקניות של המשפחה.

פשוט כתבו לי, למשל:
• "תוסיף חלב, ביצים ולחם"
• "מה חסר?"
• "קניתי את הלחם"
• "תנקה את מה שקנינו"

פקודות:
/list הצגת מה שנשאר לקנות
/reset התחלת שיחה חדשה
/forget מחיקת היסטוריית השיחה והאימות שלך

שימו לב: ההודעות עוברות למודל Gemini של Google בשכבה החינמית, ו-Google עשויה להשתמש בהן לשיפור המוצרים שלה.`;

const PHONE_REQUEST_TEXT =
  "הבוט הזה פרטי למשפחה. כדי להיכנס, שתפו את מספר הטלפון שלכם בכפתור למטה.";

export const BOT_COMMANDS = [
  { command: "start", description: "איך זה עובד" },
  { command: "list", description: "הצג את הרשימה" },
  { command: "reset", description: "שיחה חדשה" },
  { command: "forget", description: "מחק הכול" }
];

// --- Telegram update shapes, only the fields used ------------------------------------------

interface TgUser {
  id: number;
  first_name?: string;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  contact?: { phone_number: string; user_id?: number };
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// --- Per-isolate state ---------------------------------------------------------------------

const fallbackStore = memoryStore();
const d1Stores = new WeakMap<object, BotStore>();
let announced = false;

function storeFor(env: BotEnv, deps: BotDeps): BotStore {
  if (deps.store) return deps.store;
  if (!env.DB) return fallbackStore;
  let store = d1Stores.get(env.DB);
  if (!store) {
    store = d1Store(env.DB);
    d1Stores.set(env.DB, store);
  }
  return store;
}

const json = (status: number, body: unknown, scrub: (text: string) => string = text => text): Response =>
  new Response(scrub(JSON.stringify(body, null, 2)), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });

// --- The webhook ---------------------------------------------------------------------------

/**
 * Handle POST /telegram/webhook. Runs before the access-token check, because Telegram cannot
 * send that token; the secret header takes its place.
 *
 * A GET answers 405 whether or not the bot is configured. That makes it a deploy check from a
 * phone browser: 405 means this code is live, while an older build answers 401.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: BotEnv,
  ctx?: ExecutionContext,
  deps: BotDeps = {}
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "POST" } });
  }
  const config = readConfig(env);
  if (!config) return json(404, { error: "not_found" });

  const presented = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!presented || !(await secretsMatch(presented, config.webhookSecret))) {
    return json(403, { error: "forbidden" });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    // An error status would only make Telegram send the same unreadable body again.
    console.warn("telegram bot: ignored an update that was not JSON");
    return json(200, { ok: true });
  }

  const api = new TelegramApi(config.token, deps.fetch ?? fetch);
  const work = processUpdate(update, config, env, deps, api).catch(error => {
    console.error(`telegram bot: update failed: ${api.scrub(describe(error))}`);
  });
  if (ctx) ctx.waitUntil(work);
  else await work;
  return json(200, { ok: true });
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function processUpdate(
  update: TgUpdate,
  config: BotConfig,
  env: BotEnv,
  deps: BotDeps,
  api: TelegramApi
): Promise<void> {
  const store = storeFor(env, deps);
  if (!announced) {
    announced = true;
    console.log(
      `telegram bot answering with gemini (${config.models.join(",")}), storage ${store.kind}` +
        (config.geminiKey ? "" : ", GEMINI_API_KEY missing")
    );
  }
  if (typeof update.update_id === "number" && !(await store.markUpdateSeen(update.update_id))) {
    return;
  }
  const bot = new Bot(config, deps, api, store);
  if (update.callback_query) await bot.onCallback(update.callback_query);
  else if (update.message) await bot.onMessage(update.message);
}

class Bot {
  private readonly tools: ToolRunner;
  private readonly now: () => number;

  constructor(
    private readonly config: BotConfig,
    private readonly deps: BotDeps,
    private readonly api: TelegramApi,
    private readonly store: BotStore
  ) {
    this.tools = deps.tools ?? mcpTools;
    this.now = deps.now ?? Date.now;
  }

  private async isAllowed(userId: number): Promise<boolean> {
    if (this.config.allowedUserIds.has(userId)) return true;
    const phone = await this.store.getVerifiedPhone(userId);
    // Checked against the current allowlist, so removing a number revokes access.
    return phone !== null && this.config.allowedPhones.has(phone);
  }

  async onMessage(message: TgMessage): Promise<void> {
    if (message.chat.type !== "private" || !message.from) return;
    const chatId = message.chat.id;
    const userId = message.from.id;

    if (message.contact) return this.onContact(message);

    if (!(await this.isAllowed(userId))) {
      console.log(`telegram bot: refused user ${userId}`);
      await this.api.sendMessage(chatId, PHONE_REQUEST_TEXT, {
        keyboard: [[{ text: "📱 שיתוף מספר הטלפון", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      });
      return;
    }

    const text = message.text?.trim();
    if (!text) {
      await this.api.sendMessage(chatId, "כרגע אני מבין רק הודעות טקסט.");
      return;
    }

    const command = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase();
    switch (command) {
      case undefined:
        return this.converse(chatId, userId, text);
      case "start":
      case "help":
        return this.api.sendMessage(chatId, START_TEXT, { remove_keyboard: true });
      case "list":
        return this.showList(chatId);
      case "reset":
        await this.store.clearHistory(chatId);
        await this.store.clearPending(chatId);
        return this.api.sendMessage(chatId, "התחלנו שיחה חדשה.");
      case "forget":
        await this.store.clearHistory(chatId);
        await this.store.clearPending(chatId);
        await this.store.forgetUser(userId);
        return this.api.sendMessage(
          chatId,
          "מחקתי את היסטוריית השיחה ואת אימות מספר הטלפון שלך."
        );
      default:
        return this.api.sendMessage(chatId, START_TEXT);
    }
  }

  private async onContact(message: TgMessage): Promise<void> {
    const chatId = message.chat.id;
    const userId = message.from!.id;
    const contact = message.contact!;
    // A forwarded contact card carries someone else's user id, or none at all.
    if (contact.user_id !== userId) {
      console.log(`telegram bot: refused user ${userId} (shared a contact that is not their own)`);
      await this.api.sendMessage(chatId, "אפשר לשתף רק את מספר הטלפון שלך, בעזרת הכפתור.");
      return;
    }
    const phone = normalizePhone(contact.phone_number);
    if (!this.config.allowedPhones.has(phone)) {
      console.log(`telegram bot: refused user ${userId} (phone not on the allowlist)`);
      await this.api.sendMessage(
        chatId,
        "המספר הזה לא ברשימת המורשים. אם זו טעות, בקשו מבעל הבוט להוסיף אותו.",
        { remove_keyboard: true }
      );
      return;
    }
    await this.store.saveVerifiedUser(userId, phone);
    await this.api.sendMessage(chatId, `אומתת, ברוכים הבאים!\n\n${START_TEXT}`, {
      remove_keyboard: true
    });
  }

  /** /list: straight from the tool, with no model call, so it is instant and costs no quota. */
  private async showList(chatId: number): Promise<void> {
    const result = await this.tools.call("shopping_get_list", { response_format: "json" });
    if (result.isError || !result.structured) {
      await this.api.sendMessage(chatId, `לא הצלחתי לקרוא את הרשימה.\n${result.text}`);
      return;
    }
    await this.api.sendMessage(chatId, formatList(result.structured));
  }

  private async converse(chatId: number, userId: number, text: string): Promise<void> {
    if (!this.config.geminiKey && !this.deps.model) {
      await this.api.sendMessage(chatId, NO_MODEL_REPLY);
      return;
    }
    const model =
      this.deps.model ??
      geminiClient(this.config.geminiKey!, this.config.models, this.deps.fetch ?? fetch, this.now);

    await this.api.typing(chatId);
    const typing = setInterval(() => void this.api.typing(chatId), this.deps.typingIntervalMs ?? 4_000);
    const confirmations: { id: string; description: string }[] = [];
    let reply: string;
    try {
      const history = await this.store.getHistory(chatId);
      reply = await runAgent(history, text, {
        model,
        tools: this.tools,
        now: this.now,
        requestConfirmation: async (tool, args) => {
          const id = crypto.randomUUID().replace(/-/g, "");
          await this.store.savePending({ id, chatId, userId, tool, args, createdAt: this.now() });
          confirmations.push({ id, description: describeAction(tool, args) });
          return "Not done yet. The user now sees a confirmation button, and the action runs only when they press it. Tell them in one short sentence to press it. Do not call this tool again.";
        }
      });
      await this.store.saveHistory(
        chatId,
        [...history, { role: "user", content: text }, { role: "assistant", content: reply }].slice(
          -HISTORY_LIMIT
        ) as ChatTurn[]
      );
    } catch (error) {
      if (error instanceof ModelsBusyError) {
        console.warn(`telegram bot: no model available (${error.message})`);
        reply = BUSY_REPLY;
      } else {
        console.error(`telegram bot: turn failed: ${this.api.scrub(describe(error))}`);
        reply = ERROR_REPLY;
      }
    } finally {
      clearInterval(typing);
    }

    await this.api.sendMessage(chatId, reply);
    for (const confirmation of confirmations) {
      await this.api.sendMessage(chatId, `${confirmation.description}`, {
        inline_keyboard: [
          [
            { text: "✅ כן, לבצע", callback_data: `ok:${confirmation.id}` },
            { text: "❌ ביטול", callback_data: `no:${confirmation.id}` }
          ]
        ]
      });
    }
  }

  async onCallback(query: TgCallbackQuery): Promise<void> {
    const message = query.message;
    const match = query.data?.match(/^(ok|no):([a-f0-9]{32})$/);
    if (!message || message.chat.type !== "private" || !match) {
      await this.api.answerCallback(query.id);
      return;
    }
    if (!(await this.isAllowed(query.from.id))) {
      console.log(`telegram bot: refused user ${query.from.id}`);
      await this.api.answerCallback(query.id, "אין הרשאה.");
      return;
    }

    const chatId = message.chat.id;
    const action = await this.store.takePending(match[2]!);
    if (!action || action.chatId !== chatId || action.userId !== query.from.id) {
      await this.api.answerCallback(query.id, "הבקשה הזו כבר לא בתוקף.");
      await this.api.editText(chatId, message.message_id, "הבקשה הזו כבר לא בתוקף.").catch(() => undefined);
      return;
    }
    const description = describeAction(action.tool, action.args);
    if (this.now() - action.createdAt > CONFIRMATION_TTL_MS) {
      await this.api.answerCallback(query.id, "פג התוקף. בקשו שוב.");
      await this.api.editText(chatId, message.message_id, `${description}\n\nפג התוקף, לא בוצע.`);
      return;
    }
    if (match[1] === "no") {
      await this.api.answerCallback(query.id, "בוטל.");
      await this.api.editText(chatId, message.message_id, `${description}\n\nבוטל.`);
      await this.remember(chatId, `ביטלת: ${description}`);
      return;
    }

    const result = await this.tools.call(action.tool, action.args);
    await this.api.answerCallback(query.id, result.isError ? "לא הצלחתי." : "בוצע.");
    const outcome = result.isError ? `לא הצלחתי: ${result.text.replace(/^Error:\s*/, "")}` : "בוצע ✅";
    await this.api.editText(chatId, message.message_id, `${description}\n\n${outcome}`);
    await this.remember(chatId, result.isError ? `ניסיתי ולא הצלחתי: ${description}` : `בוצע: ${description}`);
  }

  /** Note a button press in the history, so the model knows what happened. */
  private async remember(chatId: number, note: string): Promise<void> {
    const history = await this.store.getHistory(chatId);
    await this.store.saveHistory(
      chatId,
      [...history, { role: "assistant" as const, content: note }].slice(-HISTORY_LIMIT)
    );
  }
}

/** A Hebrew description of a destructive action, for its confirmation button. */
export function describeAction(tool: string, args: Record<string, unknown>): string {
  const category = typeof args.category === "string" ? args.category : null;
  switch (tool) {
    case "shopping_clear_checked":
      return args.mode === "remove"
        ? `למחוק מהרשימה את כל מה שסומן כנקנה${category ? ` בקטגוריה "${category}"` : ""}?`
        : `לבטל את הסימון של כל מה שנקנה${category ? ` בקטגוריה "${category}"` : ""}?`;
    case "shopping_remove_category":
      return `למחוק את הקטגוריה ${
        category ? `"${category}"` : `מספר ${String(args.category_index ?? "?")}`
      } עם כל הפריטים שבה?`;
    default:
      return `לבצע את הפעולה ${tool}?`;
  }
}

interface ListShape {
  name?: string;
  url?: string;
  progress?: { done?: number; total?: number };
  categories?: { title?: string; items?: { name?: string; note?: string; checked?: boolean }[] }[];
}

/** What is left to buy, grouped by category, as Markdown for `sendMessage`. */
export function formatList(data: Record<string, unknown>): string {
  const list = data as ListShape;
  const done = list.progress?.done ?? 0;
  const total = list.progress?.total ?? 0;
  const lines = [`**${list.name ?? "רשימת קניות"}**`];
  const sections: string[] = [];
  for (const category of list.categories ?? []) {
    const pending = (category.items ?? []).filter(item => item.name && !item.checked);
    if (!pending.length) continue;
    sections.push(
      [
        `**${category.title ?? ""}**`,
        ...pending.map(item => `- ${item.name}${item.note ? ` (${item.note})` : ""}`)
      ].join("\n")
    );
  }
  if (sections.length) {
    lines.push(`נשארו ${total - done} מתוך ${total}`, "", sections.join("\n\n"));
  } else {
    lines.push("", total ? "הכול נקנה! 🎉" : "הרשימה ריקה.");
  }
  if (done) lines.push("", `✓ ${done} כבר נקנו`);
  if (list.url) lines.push("", `[פתיחת הרשימה](${list.url})`);
  return lines.join("\n");
}

// --- Owner routes, behind the access token -------------------------------------------------

/**
 * GET /<token>/telegram/setup registers the webhook and the command menu; GET
 * /<token>/telegram/status reports what Telegram and this deployment see. Both exist so the
 * owner can do from a phone browser what would otherwise need curl.
 */
export async function handleTelegramAdmin(
  request: Request,
  path: string,
  url: URL,
  env: BotEnv,
  deps: BotDeps = {}
): Promise<Response | null> {
  if (path !== "/telegram/setup" && path !== "/telegram/status") return null;
  if (request.method.toUpperCase() !== "GET") {
    return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "GET" } });
  }

  const config = readConfig(env);
  const missing = [
    ...(env.TELEGRAM_BOT_TOKEN?.trim() ? [] : ["TELEGRAM_BOT_TOKEN"]),
    ...(env.TELEGRAM_WEBHOOK_SECRET?.trim() ? [] : ["TELEGRAM_WEBHOOK_SECRET"]),
    ...(env.GEMINI_API_KEY?.trim() ? [] : ["GEMINI_API_KEY"])
  ];
  const deployment = {
    missing_settings: missing,
    models: config?.models ?? [],
    allowed_user_ids: config?.allowedUserIds.size ?? 0,
    allowed_phones: config?.allowedPhones.size ?? 0,
    storage: env.DB ? "d1" : "memory (no D1 binding: phone verifications are forgotten)",
    max_model_calls_per_message: MAX_MODEL_CALLS
  };
  if (!config) {
    return json(400, {
      error: "not_configured",
      message: "Add TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET as secrets on this Worker first.",
      deployment
    });
  }

  const api = new TelegramApi(config.token, deps.fetch ?? fetch);
  const scrub = (text: string): string => api.scrub(text);
  try {
    if (path === "/telegram/status") {
      const [bot, webhook] = await Promise.all([
        api.call<{ username?: string }>("getMe"),
        api.call<Record<string, unknown>>("getWebhookInfo")
      ]);
      return json(200, { bot: bot.username ? `@${bot.username}` : null, webhook, deployment }, scrub);
    }

    if (!WEBHOOK_SECRET_PATTERN.test(config.webhookSecret)) {
      return json(400, {
        error: "bad_webhook_secret",
        message:
          "Telegram accepts only letters A-Z and a-z, digits, _ and - in TELEGRAM_WEBHOOK_SECRET, up to 256 characters. Replace it with one made of those characters only."
      });
    }
    const webhookUrl = `${url.origin}/telegram/webhook`;
    const webhook = await api.call("setWebhook", {
      url: webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ["message", "callback_query"]
    });
    const commands = await api.call("setMyCommands", { commands: BOT_COMMANDS });
    return json(200, { ok: true, webhook_url: webhookUrl, set_webhook: webhook, set_commands: commands, deployment }, scrub);
  } catch (error) {
    const message = error instanceof TelegramError ? error.message : describe(error);
    return json(502, { error: "telegram_failed", message: scrub(message) }, scrub);
  }
}
