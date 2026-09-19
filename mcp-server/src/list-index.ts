import { DEFAULT_LIST_NAME, LIST_ID_PATTERN, LIST_INDEX_PATH } from "./constants.js";
import { deleteNode, readNode, RulesDenied, writeNode } from "./rtdb.js";
import { rememberList } from "./state.js";
import type { IndexEntry } from "./types.js";

/**
 * The shared index of lists, at `LIST_INDEX_PATH`.
 *
 * The database has no index of its own and the page's "recent lists" never leave the browser
 * that made them, so before this existed a list created in a browser could not be found by
 * anything that did not already hold its id: `shopping_list_lists` could only report the
 * default list plus whatever this server happened to have touched. Each entry here is
 * `{name, updatedAt}` stored under the list's id, written by whichever side last saved the
 * list, and read back by `shopping_list_lists`.
 *
 * Every write is best-effort, for the same reason the local state file is: the index is a
 * convenience for finding a list, not part of storing one. Reporting a failure to advertise a
 * list as a failure of the edit itself would invite a retry of a write that already committed.
 */

/** Names already advertised in this process, so an edit does not rewrite an unchanged entry. */
const advertised = new Map<string, string>();

let warned = false;

function warnOnce(action: string, error: unknown): void {
  if (warned) return;
  warned = true;
  const message =
    `shopping-list-mcp-server: could not ${action} the shared list index at ${LIST_INDEX_PATH} ` +
    `(${error instanceof Error ? error.message : String(error)}). Lists stay readable and ` +
    "writable; they may just not show up in shopping_list_lists for other clients.\n";
  if (typeof process !== "undefined" && process.stderr) process.stderr.write(message);
  else console.error(message.trim());
}

const entryPath = (id: string): string => `${LIST_INDEX_PATH}/${id}`;

/**
 * Advertise a list in the shared index.
 *
 * Called from the write paths only. Doing it on a read as well would turn every reading tool
 * into a writer, which is both a surprise given their `readOnlyHint` and, for
 * `shopping_list_lists` with `include_progress`, one write per list per call.
 */
export async function publishList(id: string, name: string): Promise<void> {
  if (advertised.get(id) === name) return;
  try {
    await writeNode(entryPath(id), { name, updatedAt: Date.now() }, null);
    advertised.set(id, name);
  } catch (error) {
    // Clear the memo so the next edit tries again rather than assuming this one landed.
    advertised.delete(id);
    warnOnce("write to", error);
  }
}

/** Retract a list from the shared index, after it has been deleted. */
export async function unpublishList(id: string): Promise<void> {
  advertised.delete(id);
  try {
    await deleteNode(entryPath(id));
  } catch (error) {
    warnOnce("remove an entry from", error);
  }
}

/** Record a list both locally and in the shared index. Used wherever a write has just landed. */
export async function recordList(id: string, name: string): Promise<void> {
  await rememberList(id, name);
  await publishList(id, name);
}

/**
 * Read the shared index.
 *
 * Returns null when the database's own rules forbid the read, which is reported rather than
 * hidden: it is the difference between "you have no other lists" and "this cannot see them".
 * A network block is left to propagate, so a total egress failure is never misreported as a
 * rules problem.
 */
export async function readListIndex(): Promise<IndexEntry[] | null> {
  let value: unknown;
  try {
    value = (await readNode<unknown>(LIST_INDEX_PATH)).value;
  } catch (error) {
    if (error instanceof RulesDenied) return null;
    throw error;
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    // Anything that is not a usable list id cannot be opened, so it is not a list.
    .filter(([id]) => LIST_ID_PATTERN.test(id))
    .map(([id, entry]) => {
      const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const name = typeof record.name === "string" ? record.name.trim() : "";
      return {
        id,
        name: name || DEFAULT_LIST_NAME,
        updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : null
      };
    });
}
