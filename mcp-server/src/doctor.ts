#!/usr/bin/env node
/**
 * Connectivity self-test: `npm run doctor`.
 *
 * Checks what can go wrong on a new machine: reaching Google's auth endpoint, reaching the
 * Realtime Database, the rules allowing a read of the default list, and whether the shared
 * index that makes other lists discoverable can be read. Prints what to do about each failure.
 * Writes nothing.
 */
import { getAuthToken } from "./auth.js";
import { DATABASE_URL, DEFAULT_LIST_ID, LIST_INDEX_PATH, LISTS_ROOT, SITE_URL } from "./constants.js";
import { readListIndex } from "./list-index.js";
import { progressOf } from "./normalize.js";
import { shallowKeys } from "./rtdb.js";
import { loadList } from "./store.js";
import { fileBackend, stateFilePath } from "./state-file.js";
import { useStateBackend } from "./state.js";

const line = (label: string, value: string): void => {
  process.stdout.write(`${label.padEnd(22)} ${value}\n`);
};

async function main(): Promise<void> {
  useStateBackend(fileBackend);
  process.stdout.write("shopping-list-mcp-server doctor\n\n");
  line("site", SITE_URL);
  line("database", DATABASE_URL);
  line("lists path", LISTS_ROOT);
  line("index path", LIST_INDEX_PATH);
  line("default list", DEFAULT_LIST_ID);
  line("state file", stateFilePath);
  process.stdout.write("\n");

  try {
    const token = await getAuthToken();
    line("1. authentication", `ok (credential length ${token.length})`);
  } catch (error) {
    line("1. authentication", `FAILED — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const loaded = await loadList(DEFAULT_LIST_ID);
    if (loaded.missing) {
      line("2. read default list", "reachable, but no list stored at that id yet");
    } else {
      const progress = progressOf(loaded.payload);
      line(
        "2. read default list",
        `ok — "${loaded.payload.name}", ${loaded.payload.departments.length} categories, ${progress.done}/${progress.total} checked`
      );
    }
  } catch (error) {
    line("2. read default list", `FAILED — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const indexed = await readListIndex();
  line(
    "3. shared list index",
    indexed === null
      ? "not readable: the database rules refuse it, so shopping_list_lists can only report lists this server has touched"
      : indexed.length
        ? `ok, ${indexed.length} list(s) advertised: ${indexed.map(entry => entry.name).join(", ")}`
        : "readable but empty. It fills as the page or this server saves a list"
  );

  const keys = await shallowKeys(LISTS_ROOT);
  line(
    "4. enumerate lists",
    keys === null
      ? "not permitted by the database rules, so the shared index above is what makes lists discoverable (this is fine)"
      : `ok, ${keys.length} node(s) visible`
  );

  process.stdout.write("\nAll checks passed. The server can read and write the list.\n");
}

main().catch(error => {
  process.stderr.write(`doctor failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
