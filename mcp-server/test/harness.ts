import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFakeRtdb, type FakeOptions, type FakeRtdb } from "./fake-rtdb.js";

export const LIST_ID = "rehovot-family-4d7f8c12";
export const LIST_PATH = `shared-lists/${LIST_ID}`;

/** A stored list resembling what the real database holds. */
export function seedList(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "רשימת קניות",
    updatedAt: 1_700_000_000_000,
    departments: [
      {
        title: "פירות וירקות",
        hint: "תחילת הסיבוב",
        items: [
          { name: "גזר", note: "", checked: false, blank: false },
          { name: "תפוח עץ", note: "", checked: true, blank: false },
          { name: "", note: "", checked: false, blank: true }
        ]
      },
      {
        title: "חלב וביצים",
        hint: "מקררים",
        items: [
          { name: "חלב", note: "", checked: false, blank: false },
          { name: "ביצים", note: "", checked: false, blank: false },
          { name: "חמאה", note: "2 יחידות", checked: false, blank: false }
        ]
      }
    ],
    ...overrides
  };
}

export interface Harness {
  client: Client;
  rtdb: FakeRtdb;
  /** Call a tool and return its text content joined. */
  text(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Call a tool and return its structured content. */
  data<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Call a tool expecting failure, returning the error text. */
  error(name: string, args?: Record<string, unknown>): Promise<string>;
  /** The stored list payload as the database now holds it. */
  stored(path?: string): Record<string, unknown> | null;
  close(): Promise<void>;
}

interface CallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const textOf = (result: CallResult): string =>
  (result.content ?? [])
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .join("\n");

/**
 * Start the server against a fake database and connect a real MCP client to it.
 *
 * Going through the client rather than calling handlers directly means the tests also check
 * the parts the SDK owns: input coercion, default values, and validation of every
 * `structuredContent` against the tool's declared output schema.
 */
export async function startHarness(options: FakeOptions = {}): Promise<Harness> {
  // constants.ts reads the environment once at import time, so the state directory has to be
  // redirected before the server module graph is loaded.
  process.env.SHOPPING_LIST_STATE_DIR = mkdtempSync(join(tmpdir(), "shopping-list-mcp-test-"));
  const rtdb = installFakeRtdb(options);

  const { createServer } = await import("../src/server.js");
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> =>
    (await client.callTool({ name, arguments: args })) as CallResult;

  return {
    client,
    rtdb,
    async text(name, args) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed unexpectedly: ${textOf(result)}`);
      return textOf(result);
    },
    async data<T>(name: string, args?: Record<string, unknown>) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed unexpectedly: ${textOf(result)}`);
      if (!result.structuredContent) throw new Error(`${name} returned no structuredContent`);
      return result.structuredContent as T;
    },
    async error(name, args) {
      const result = await call(name, args);
      if (!result.isError) throw new Error(`${name} was expected to fail but returned: ${textOf(result)}`);
      return textOf(result);
    },
    stored(path = LIST_PATH) {
      return rtdb.get<Record<string, unknown>>(path);
    },
    async close() {
      await client.close();
      await server.close();
      rtdb.restore();
    }
  };
}

/** Categories of a stored payload, as plain objects. */
export function categoriesOf(payload: Record<string, unknown> | null): {
  title: string;
  hint: string;
  items: { name: string; note: string; checked: boolean; blank: boolean }[];
}[] {
  return (payload?.departments ?? []) as never;
}

/** Item names of one stored category, placeholders included. */
export function itemNames(payload: Record<string, unknown> | null, index: number): string[] {
  return (categoriesOf(payload)[index]?.items ?? []).map(item => item.name);
}
