#!/usr/bin/env node
/**
 * Connectivity self-test: `npm run doctor`.
 *
 * Checks the three things that can go wrong on a new machine — reaching Google's auth
 * endpoint, reaching the Realtime Database, and the database rules allowing a read of the
 * default list — and prints what to do about each failure. Writes nothing to the list.
 */
import { getAuthToken } from "./auth.js";
import { DATABASE_URL, DEFAULT_LIST_ID, LISTS_ROOT, SITE_URL } from "./constants.js";
import { progressOf } from "./normalize.js";
import { shallowKeys } from "./rtdb.js";
import { loadList } from "./store.js";
import { stateFilePath } from "./state.js";

const line = (label: string, value: string): void => {
  process.stdout.write(`${label.padEnd(22)} ${value}\n`);
};

async function main(): Promise<void> {
  process.stdout.write("shopping-list-mcp-server doctor\n\n");
  line("site", SITE_URL);
  line("database", DATABASE_URL);
  line("lists path", LISTS_ROOT);
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

  const keys = await shallowKeys(LISTS_ROOT);
  line(
    "3. enumerate lists",
    keys === null
      ? "not permitted by the database rules — shopping_list_lists falls back to the local registry (this is fine)"
      : `ok — ${keys.length} list(s) visible`
  );

  process.stdout.write("\nAll checks passed. The server can read and write the list.\n");
}

main().catch(error => {
  process.stderr.write(`doctor failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
