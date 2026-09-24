/**
 * What the bot remembers between messages: chat history, verified users, seen updates and
 * destructive actions waiting for a button press.
 *
 * Kept in D1 rather than the Firebase database, because anyone who can read a shopping list can
 * read everything under `shared-lists`, and rather than KV, because KV is eventually consistent
 * and two quick messages would read stale history.
 *
 * A memory store stands in when no D1 binding exists. It forgets on every new isolate, so the
 * bot still works but phone-verified users are asked to share their number again now and then.
 */
import type { D1Database } from "./platform.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A destructive tool call the model asked for, held until a person presses the button. */
export interface PendingAction {
  id: string;
  chatId: number;
  userId: number;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
}

export interface BotStore {
  readonly kind: "d1" | "memory";
  /** Record an update id, answering true only the first time it is seen. */
  markUpdateSeen(updateId: number): Promise<boolean>;
  getHistory(chatId: number): Promise<ChatTurn[]>;
  saveHistory(chatId: number, turns: ChatTurn[]): Promise<void>;
  clearHistory(chatId: number): Promise<void>;
  getVerifiedPhone(userId: number): Promise<string | null>;
  saveVerifiedUser(userId: number, phone: string): Promise<void>;
  forgetUser(userId: number): Promise<void>;
  savePending(action: PendingAction): Promise<void>;
  /** Remove and return a pending action, so a double tap cannot run it twice. */
  takePending(id: string): Promise<PendingAction | null>;
  clearPending(chatId: number): Promise<void>;
}

/** How long a seen update id is kept. Telegram gives up re-delivering long before this. */
const UPDATE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, history TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, phone TEXT NOT NULL, verified_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS updates (update_id INTEGER PRIMARY KEY, seen_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, created_at INTEGER NOT NULL)`
];

interface PendingRow {
  id: string;
  chat_id: number;
  user_id: number;
  tool: string;
  args: string;
  created_at: number;
}

const parseHistory = (raw: string | undefined | null): ChatTurn[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (turn): turn is ChatTurn =>
            !!turn &&
            typeof turn === "object" &&
            (turn.role === "user" || turn.role === "assistant") &&
            typeof turn.content === "string"
        )
      : [];
  } catch {
    return [];
  }
};

/** D1-backed store. Tables are created on first use, so there is no migration step. */
export function d1Store(db: D1Database, now: () => number = Date.now): BotStore {
  let ready: Promise<void> | null = null;
  const schema = (): Promise<void> => {
    ready ??= db
      .batch(SCHEMA.map(sql => db.prepare(sql)))
      .then(() => undefined)
      .catch(error => {
        // Let the next call try again rather than caching the failure for the isolate's life.
        ready = null;
        throw error;
      });
    return ready;
  };

  return {
    kind: "d1",
    async markUpdateSeen(updateId) {
      await schema();
      const inserted = await db
        .prepare(
          "INSERT INTO updates (update_id, seen_at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING update_id"
        )
        .bind(updateId, now())
        .first();
      // Pruning on a fraction of updates keeps the table small without a scheduled job.
      if (inserted && updateId % 50 === 0) {
        await db
          .prepare("DELETE FROM updates WHERE seen_at < ?")
          .bind(now() - UPDATE_RETENTION_MS)
          .run();
      }
      return inserted !== null;
    },
    async getHistory(chatId) {
      await schema();
      const row = await db
        .prepare("SELECT history FROM chats WHERE chat_id = ?")
        .bind(chatId)
        .first<{ history: string }>();
      return parseHistory(row?.history);
    },
    async saveHistory(chatId, turns) {
      await schema();
      await db
        .prepare(
          "INSERT INTO chats (chat_id, history, updated_at) VALUES (?, ?, ?) ON CONFLICT (chat_id) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at"
        )
        .bind(chatId, JSON.stringify(turns), now())
        .run();
    },
    async clearHistory(chatId) {
      await schema();
      await db.prepare("DELETE FROM chats WHERE chat_id = ?").bind(chatId).run();
    },
    async getVerifiedPhone(userId) {
      await schema();
      const row = await db
        .prepare("SELECT phone FROM users WHERE user_id = ?")
        .bind(userId)
        .first<{ phone: string }>();
      return row?.phone ?? null;
    },
    async saveVerifiedUser(userId, phone) {
      await schema();
      await db
        .prepare(
          "INSERT INTO users (user_id, phone, verified_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET phone = excluded.phone, verified_at = excluded.verified_at"
        )
        .bind(userId, phone, now())
        .run();
    },
    async forgetUser(userId) {
      await schema();
      await db.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
    },
    async savePending(action) {
      await schema();
      await db
        .prepare(
          "INSERT INTO pending (id, chat_id, user_id, tool, args, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(
          action.id,
          action.chatId,
          action.userId,
          action.tool,
          JSON.stringify(action.args),
          action.createdAt
        )
        .run();
    },
    async takePending(id) {
      await schema();
      const row = await db
        .prepare("DELETE FROM pending WHERE id = ? RETURNING *")
        .bind(id)
        .first<PendingRow>();
      if (!row) return null;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(row.args) as Record<string, unknown>;
      } catch {
        // A row that cannot be parsed runs with no arguments and fails in the tool instead.
      }
      return {
        id: row.id,
        chatId: row.chat_id,
        userId: row.user_id,
        tool: row.tool,
        args,
        createdAt: row.created_at
      };
    },
    async clearPending(chatId) {
      await schema();
      await db.prepare("DELETE FROM pending WHERE chat_id = ?").bind(chatId).run();
    }
  };
}

/** In-memory store, for tests and for a deployment that has no D1 binding yet. */
export function memoryStore(): BotStore {
  const seen = new Set<number>();
  const chats = new Map<number, ChatTurn[]>();
  const users = new Map<number, string>();
  const pending = new Map<string, PendingAction>();
  return {
    kind: "memory",
    async markUpdateSeen(updateId) {
      if (seen.has(updateId)) return false;
      seen.add(updateId);
      if (seen.size > 1000) seen.delete(seen.values().next().value as number);
      return true;
    },
    async getHistory(chatId) {
      return [...(chats.get(chatId) ?? [])];
    },
    async saveHistory(chatId, turns) {
      chats.set(chatId, [...turns]);
    },
    async clearHistory(chatId) {
      chats.delete(chatId);
    },
    async getVerifiedPhone(userId) {
      return users.get(userId) ?? null;
    },
    async saveVerifiedUser(userId, phone) {
      users.set(userId, phone);
    },
    async forgetUser(userId) {
      users.delete(userId);
    },
    async savePending(action) {
      pending.set(action.id, action);
    },
    async takePending(id) {
      const action = pending.get(id) ?? null;
      pending.delete(id);
      return action;
    },
    async clearPending(chatId) {
      for (const [id, action] of pending) if (action.chatId === chatId) pending.delete(id);
    }
  };
}
