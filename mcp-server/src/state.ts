import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./constants.js";
import type { PersistedState, RegistryEntry } from "./types.js";

const STATE_FILE = join(STATE_DIR, "state.json");

let cache: PersistedState | null = null;
/** Serializes writes so two concurrent tool calls cannot clobber each other's state. */
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<PersistedState> {
  if (cache) return cache;
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A missing or corrupt state file is not an error: the identity is simply re-minted.
    cache = {};
  }
  return cache;
}

async function persist(next: PersistedState): Promise<void> {
  cache = next;
  await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  // Write to a sibling then rename, so a crash mid-write cannot truncate the saved token.
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_FILE);
}

/**
 * Apply a change to the persisted state, one writer at a time.
 *
 * This never rejects. The state file is a local convenience holding a reusable anonymous
 * identity and a list of ids already seen; nothing here is required for a database operation
 * to have succeeded. An unwritable directory must therefore not turn a committed write into a
 * reported failure, which would invite a retry of a non-idempotent edit. The problem is
 * reported once on stderr instead, where it shows up as an MCP server log.
 */
let warnedAboutState = false;

function update(change: (state: PersistedState) => PersistedState): Promise<void> {
  const run = queue.then(async () => {
    try {
      const current = await load();
      await persist(change({ ...current }));
    } catch (error) {
      // Keep the in-memory copy, so the session still behaves as though it persisted.
      if (!warnedAboutState) {
        warnedAboutState = true;
        process.stderr.write(
          `shopping-list-mcp-server: cannot write ${STATE_FILE} ` +
            `(${error instanceof Error ? error.message : String(error)}). Continuing without it: ` +
            "a new anonymous identity will be created each run and shopping_list_lists will not " +
            "remember lists between runs. Set SHOPPING_LIST_STATE_DIR to a writable directory to fix it.\n"
        );
      }
    }
  });
  queue = run;
  return run;
}

export async function readState(): Promise<PersistedState> {
  return { ...(await load()) };
}

/** Remember the anonymous identity so restarts reuse it instead of creating a new user. */
export async function saveIdentity(refreshToken: string, localId: string): Promise<void> {
  await update(state => ({ ...state, refreshToken, localId }));
}

/** Forget a rejected identity so the next call signs in fresh. */
export async function clearIdentity(): Promise<void> {
  await update(({ refreshToken: _refreshToken, localId: _localId, ...rest }) => rest);
}

/**
 * Record a list this server has touched.
 *
 * The web app keeps its "recent lists" only in `localStorage`, and the database has no index
 * of lists, so without a local registry a freshly started server would have no way to name
 * any list but the default one.
 */
export async function rememberList(id: string, name: string): Promise<void> {
  const entry: RegistryEntry = { id, name, lastSeen: new Date().toISOString() };
  await update(state => ({
    ...state,
    lists: [entry, ...(state.lists ?? []).filter(item => item.id !== id)].slice(0, 200)
  }));
}

/** Drop a list from the registry, used after it is deleted. */
export async function forgetList(id: string): Promise<void> {
  await update(state => ({
    ...state,
    lists: (state.lists ?? []).filter(item => item.id !== id)
  }));
}

export async function knownLists(): Promise<RegistryEntry[]> {
  return [...((await load()).lists ?? [])];
}

export const stateFilePath = STATE_FILE;
