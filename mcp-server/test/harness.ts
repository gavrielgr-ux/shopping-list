import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
 * Refuse to run if redirecting the state directory did not take effect.
 *
 * `constants.ts` resolves `STATE_DIR` once, when it is first imported. A test file that pulls in
 * anything from `src/` at the top of the file therefore loads it before `startHarness` runs, and
 * the tests then write the developer's real state file: their reusable Firebase identity and
 * their registry of known lists, which `shopping_list_lists` reports. Nothing about that is
 * visible while the tests pass, and it has already happened once, so it is checked here rather
 * than left to import order.
 */
function assertRedirected(stateDir: string, requested: string | undefined): void {
  const temporary = resolve(tmpdir());
  if (!resolve(stateDir).startsWith(temporary)) {
    throw new Error(
      `the test state directory is ${stateDir}, outside ${temporary}: something under src/ was ` +
        "imported before startHarness could redirect it, so these tests would write real state. " +
        "Import what the test needs from this harness, or load it dynamically after the first " +
        "startHarness call."
    );
  }
  if (requested !== undefined && resolve(stateDir) !== resolve(requested)) {
    // A later call cannot move it, so a test asking for a specific directory and quietly getting
    // another one would assert against state it is not actually using.
    throw new Error(
      `this harness asked for the state directory ${requested} but ${stateDir} was already ` +
        "resolved. Only the first startHarness call in a process can choose it, so a test that " +
        "needs its own must be in its own file."
    );
  }
}

/**
 * Start the server against a fake database and connect a real MCP client to it.
 *
 * Going through the client rather than calling handlers directly means the tests also check
 * the parts the SDK owns: input coercion, default values, and validation of every
 * `structuredContent` against the tool's declared output schema.
 */
export async function startHarness(
  options: FakeOptions & { stateDir?: string } = {}
): Promise<Harness> {
  // constants.ts reads the environment once at import time, so the state directory has to be
  // redirected before the server module graph is loaded.
  process.env.SHOPPING_LIST_STATE_DIR =
    options.stateDir ?? mkdtempSync(join(tmpdir(), "shopping-list-mcp-test-"));
  const rtdb = installFakeRtdb(options);

  const { STATE_DIR } = await import("../src/constants.js");
  assertRedirected(STATE_DIR, options.stateDir);

  const { useStateBackend } = await import("../src/state.js");
  const { fileBackend } = await import("../src/state-file.js");
  useStateBackend(fileBackend);
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
