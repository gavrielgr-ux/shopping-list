/**
 * A small Telegram Bot API client.
 *
 * The Bot API puts the bot token in the URL (`/bot<TOKEN>/sendMessage`), so a request URL is
 * never logged or put in an error. Every error here names the method and Telegram's own
 * description, and any stray copy of the token is scrubbed before a message leaves this module.
 */
import { markdownToTelegramHtml, splitMessage } from "./format.js";

type FetchLike = typeof fetch;

/** Long enough for a slow Telegram, short enough to leave room inside `waitUntil`'s budget. */
const TELEGRAM_TIMEOUT_MS = 10_000;

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = "TelegramError";
  }
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | {
      keyboard: { text: string; request_contact?: boolean }[][];
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
    }
  | { remove_keyboard: true };

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  /** Remove the token from any text before it is logged or returned. */
  scrub(text: string): string {
    return this.token ? text.split(this.token).join("<token>") : text;
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    // Called unbound: the Workers runtime rejects a fetch invoked as a method of another object
    // ("Illegal invocation").
    const doFetch = this.fetchImpl;
    let response: Response;
    try {
      response = await doFetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const reason = controller.signal.aborted
        ? `timed out after ${TELEGRAM_TIMEOUT_MS}ms`
        : this.scrub(error instanceof Error ? error.message : String(error));
      throw new TelegramError(method, 0, reason);
    } finally {
      clearTimeout(timer);
    }

    let payload: { ok?: boolean; result?: T; description?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // A non-JSON answer is reported by status alone.
    }
    if (!response.ok || !payload.ok) {
      throw new TelegramError(method, response.status, this.scrub(payload.description ?? "no description"));
    }
    return payload.result as T;
  }

  /**
   * Send Markdown as one or more messages.
   *
   * Each chunk goes as HTML first. If Telegram refuses to parse it, the same chunk is resent as
   * plain text, because an unformatted answer beats none.
   */
  async sendMessage(chatId: number, markdown: string, replyMarkup?: ReplyMarkup): Promise<void> {
    const chunks = splitMessage(markdown);
    for (const [index, chunk] of chunks.entries()) {
      // Buttons belong under the last part of the reply.
      const markup = index === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {};
      try {
        await this.call("sendMessage", {
          chat_id: chatId,
          text: markdownToTelegramHtml(chunk),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...markup
        });
      } catch (error) {
        if (!(error instanceof TelegramError) || error.status !== 400) throw error;
        await this.call("sendMessage", { chat_id: chatId, text: chunk, ...markup });
      }
    }
  }

  /** Show "typing…". Failures are ignored: it is decoration. */
  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text ? { text } : {})
    }).catch(() => undefined);
  }

  /** Replace a message's text and drop its buttons, so a confirmation cannot be pressed twice. */
  async editText(chatId: number, messageId: number, markdown: string): Promise<void> {
    const [chunk = markdown] = splitMessage(markdown);
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: markdownToTelegramHtml(chunk),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true }
      });
    } catch (error) {
      if (!(error instanceof TelegramError) || error.status !== 400) throw error;
      await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: chunk });
    }
  }
}
