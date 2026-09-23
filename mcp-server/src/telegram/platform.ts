/**
 * The few Cloudflare runtime types the bot touches, declared structurally.
 *
 * Declaring them here avoids a dependency on @cloudflare/workers-types, whose globals would
 * clash with the Node types the rest of the package compiles against.
 */

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface D1Result<T> {
  results?: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
