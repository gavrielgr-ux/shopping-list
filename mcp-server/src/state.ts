import type { PersistedState, RegistryEntry } from "./types.js";

/**
 * Where the persisted state is kept.
 *
 * Abstracted because the two deployments differ: the Node build writes a file, while the
 * Cloudflare Worker has no filesystem. Keeping the storage behind this interface means only the
 * entry point differs, and nothing that imports this module has to care. The filesystem
 * implementation lives in `state-file.ts`, which is the one module importing `node:fs`, so a
 * bundle that never pulls in that entry point never pulls in `node:fs` either.
 */
export interface StateBackend {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** Human-readable location, for diagnostics. */
  describe(): string;
}

/**
 * Default backend: remembers state for the life of the process and no longer.
 *
 * Safe everywhere, and the right behaviour for a serverless deployment that authenticates with
 * a stored credential and so has no anonymous identity worth caching.
 */
const memoryBackend = (): StateBackend => {
  let held: string | null = null;
  return {
    async read() {
      return held;
    },
    async write(text) {
      held = text;
    },
    describe() {
      return "(in memory only, nothing written to disk)";
    }
  };
};

let backend: StateBackend = memoryBackend();

/** Install a storage backend. Called by an entry point before any tool runs. */
export function useStateBackend(next: StateBackend): void {
  backend = next;
  cache = null;
}

/** Where state is being kept, for diagnostics. */
export function stateLocation(): string {
  return backend.describe();
}

let cache: PersistedState | null = null;
/** Serializes writes so two concurrent tool calls cannot clobber each other's state. */
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<PersistedState> {
  if (cache) return cache;
  try {
    const raw = await backend.read();
    const parsed = raw ? (JSON.parse(raw) as PersistedState) : null;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or corrupt state is not an error: the identity is simply re-minted.
    cache = {};
  }
  return cache;
}

/**
 * Apply a change to the persisted state, one writer at a time.
 *
 * This never rejects. The state is a local convenience holding a reusable anonymous identity
 * and a list of ids already seen; nothing here is required for a database operation to have
 * succeeded. An unwritable location must therefore not turn a committed write into a reported
 * failure, which would invite a retry of a non-idempotent edit. The problem is reported once on
 * stderr instead, where it shows up as an MCP server log.
 */
let warnedAboutState = false;

function update(change: (state: PersistedState) => PersistedState): Promise<void> {
  const run = queue.then(async () => {
    const current = await load();
    const next = change({ ...current });
    cache = next;
    try {
      await backend.write(`${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      if (!warnedAboutState) {
        warnedAboutState = true;
        const message =
          `shopping-list-mcp-server: cannot persist state to ${backend.describe()} ` +
          `(${error instanceof Error ? error.message : String(error)}). Continuing without it: ` +
          "a new anonymous identity will be created each run and shopping_list_lists will not " +
          "remember lists between runs. Set SHOPPING_LIST_STATE_DIR to a writable directory to fix it.\n";
        if (typeof process !== "undefined" && process.stderr) process.stderr.write(message);
        else console.error(message.trim());
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
 * The web app keeps its "recent lists" only in `localStorage`, and the database has no index of
 * lists, so without this a freshly started server could not name any list but the default one.
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
