/**
 * Fakes for the Telegram bot tests: the Bot API, the model, and D1.
 *
 * The tools themselves are real and run against the fake Realtime Database, so a tool call made
 * by the scripted model genuinely changes the stored list.
 */
import type { ChatMessage, CompletionOptions, ModelClient, OpenAiTool } from "../src/telegram/gemini.js";
import type { D1Database, D1PreparedStatement } from "../src/telegram/platform.js";

export const BOT_TOKEN = "123456:TEST-bot-token";
export const WEBHOOK_SECRET = "hook_Secret-123";

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

export interface FakeTelegram {
  fetch: typeof fetch;
  calls: TelegramCall[];
  /** The text of every sendMessage, in order. */
  sent(): string[];
  /** sendMessage calls only. */
  messages(): Record<string, unknown>[];
}

/**
 * The Bot API as a fetch that records calls. With `rejectHtml`, any HTML message gets the 400
 * Telegram sends for markup it cannot parse.
 */
export function fakeTelegram(options: { rejectHtml?: boolean; webhookInfo?: unknown } = {}): FakeTelegram {
  const calls: TelegramCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const url = new URL(href);
    if (url.host !== "api.telegram.org") throw new Error(`unexpected host ${url.host}`);
    const method = url.pathname.split("/").pop()!;
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const reply = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    if (options.rejectHtml && body.parse_mode === "HTML") {
      return reply(400, { ok: false, description: "Bad Request: can't parse entities" });
    }
    if (method === "getWebhookInfo") {
      return reply(200, { ok: true, result: options.webhookInfo ?? { url: "https://example.workers.dev/telegram/webhook", pending_update_count: 0 } });
    }
    if (method === "getMe") return reply(200, { ok: true, result: { username: "family_list_bot" } });
    return reply(200, { ok: true, result: method === "sendMessage" ? { message_id: calls.length } : true });
  }) as typeof fetch;
  const messages = () => calls.filter(call => call.method === "sendMessage").map(call => call.body);
  return {
    fetch: fetchImpl,
    calls,
    messages,
    sent: () => messages().map(body => String(body.text))
  };
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: OpenAiTool[];
  options: CompletionOptions;
}

export interface ScriptedModel extends ModelClient {
  requests: ModelRequest[];
}

/**
 * A model that answers from a script, one entry per call. An entry may be a function of the
 * request, for replies that depend on what the tools returned.
 */
export function scriptedModel(
  script: (ChatMessage | ((request: ModelRequest) => ChatMessage))[],
  name = "scripted-model"
): ScriptedModel {
  const requests: ModelRequest[] = [];
  return {
    models: [name],
    requests,
    async complete(messages, tools, options) {
      // A deep copy, so later pushes to the conversation do not rewrite what was sent.
      const request = { messages: structuredClone(messages), tools, options };
      requests.push(request);
      const entry = script[Math.min(requests.length - 1, script.length - 1)];
      if (!entry) throw new Error("the script is empty");
      const message = typeof entry === "function" ? entry(request) : entry;
      // Hand out a fresh object each time, as a real client would.
      return { model: name, message: structuredClone(message) };
    }
  };
}

export const toolCall = (
  name: string,
  args: unknown,
  extra: Record<string, unknown> = {}
): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: `call_${name}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      ...extra
    }
  ]
});

export const say = (text: string): ChatMessage => ({ role: "assistant", content: text });

// --- Updates -------------------------------------------------------------------------------

let nextUpdateId = 1000;

export function textUpdate(userId: number, text: string, chatType = "private"): Record<string, unknown> {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      chat: { id: userId, type: chatType },
      from: { id: userId, first_name: "Test" },
      text
    }
  };
}

export function contactUpdate(userId: number, phone: string, contactUserId?: number): Record<string, unknown> {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      chat: { id: userId, type: "private" },
      from: { id: userId },
      contact: { phone_number: phone, ...(contactUserId === undefined ? {} : { user_id: contactUserId }) }
    }
  };
}

export function callbackUpdate(userId: number, data: string, messageId = 77): Record<string, unknown> {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { id: userId },
      data,
      message: { message_id: messageId, chat: { id: userId, type: "private" } }
    }
  };
}

export const webhookRequest = (update: unknown, secret: string | null = WEBHOOK_SECRET): Request =>
  new Request("https://example.workers.dev/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret })
    },
    body: JSON.stringify(update)
  });

// --- D1 over node:sqlite -------------------------------------------------------------------

/**
 * D1's statement API over Node's built-in SQLite, so the real SQL is exercised. Returns null
 * where node:sqlite is unavailable (Node before 22.5).
 */
export async function sqliteD1(): Promise<D1Database | null> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  const db = new sqlite.DatabaseSync(":memory:");
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>() {
      return ((db.prepare(sql).get(...(values as never[])) as T | undefined) ?? null) as T | null;
    },
    async run() {
      return db.prepare(sql).run(...(values as never[]));
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...(values as never[])) as T[] };
    }
  });
  return {
    prepare: sql => statement(sql),
    async batch(statements) {
      const results = [];
      for (const each of statements) results.push(await each.run());
      return results;
    }
  };
}
