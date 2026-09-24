/**
 * Configuration for the Telegram bot, read from the Worker's environment.
 *
 * Every value is set in the Cloudflare dashboard (Worker → Settings → Variables and Secrets), so
 * the owner never needs a terminal. The allowlists are best stored as secrets too: a deploy from
 * `wrangler.toml` keeps secrets, and `keep_vars = true` there keeps plain variables as well.
 */
import type { D1Database } from "./platform.js";

export interface BotEnv {
  /** From @BotFather. Also sits in every Bot API URL, so it must never be logged. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Echoed by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Google AI Studio key for the Gemini free tier. */
  GEMINI_API_KEY?: string;
  /** Comma-separated Telegram numeric user ids that may use the bot. */
  BOT_ALLOWED_USER_IDS?: string;
  /** Comma-separated phone numbers that may use the bot after sharing their contact. */
  BOT_ALLOWED_PHONES?: string;
  /** Comma-separated Gemini models, tried in order when one is busy. */
  BOT_MODEL?: string;
  /** D1 database holding chat history, verified users and seen updates. */
  DB?: D1Database;
}

/** All free on the Gemini API as of September 2026; re-check the pricing page before changing. */
export const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

/** Telegram's rule for `secret_token`: 1 to 256 of these characters and nothing else. */
export const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export interface BotConfig {
  token: string;
  webhookSecret: string;
  geminiKey: string | null;
  models: string[];
  allowedUserIds: Set<number>;
  allowedPhones: Set<string>;
}

const clean = (value: string | undefined): string => (value ?? "").trim();

const splitList = (value: string | undefined): string[] =>
  clean(value)
    .split(/[\s,;]+/)
    .map(part => part.trim())
    .filter(Boolean);

/**
 * Reduce a phone number to international digits, so any way of writing it compares equal.
 *
 * Telegram sends contacts as "972521234567" or "+972521234567", while a person typing the
 * allowlist writes "052-1234567". A leading single 0 is read as an Israeli national number, and
 * a leading 00 as an international prefix.
 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `972${digits.slice(1)}`;
  return digits;
}

/** The bot's settings, or null when the two values it cannot run without are missing. */
export function readConfig(env: BotEnv): BotConfig | null {
  const token = clean(env.TELEGRAM_BOT_TOKEN);
  const webhookSecret = clean(env.TELEGRAM_WEBHOOK_SECRET);
  if (!token || !webhookSecret) return null;

  const models = splitList(env.BOT_MODEL);
  return {
    token,
    webhookSecret,
    geminiKey: clean(env.GEMINI_API_KEY) || null,
    models: models.length ? models : DEFAULT_MODELS,
    allowedUserIds: new Set(
      splitList(env.BOT_ALLOWED_USER_IDS)
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0)
    ),
    allowedPhones: new Set(
      splitList(env.BOT_ALLOWED_PHONES)
        .map(normalizePhone)
        .filter(phone => phone.length >= 8)
    )
  };
}
