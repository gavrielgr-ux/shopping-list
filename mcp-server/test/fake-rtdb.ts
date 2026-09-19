/**
 * An in-memory stand-in for the Firebase Realtime Database REST API and Google's auth
 * endpoints, installed over `globalThis.fetch`.
 *
 * It reproduces the two behaviours the server depends on and that a plain mock would gloss
 * over: the ETag compare-and-swap used for conditional writes, and the database's habit of
 * returning a map of numeric keys instead of a JSON array.
 */

export interface FakeOptions {
  /** Initial contents, keyed by database path, e.g. { "shared-lists/abc": {...} }. */
  data?: Record<string, unknown>;
  /** Reject the shallow read of the lists root, as restrictive rules would. */
  blockEnumeration?: boolean;
  /** Reject any read or write of this exact path, as rules that do not cover it would. */
  denyPath?: string;
  /** Fail the next N conditional writes with 412, simulating a concurrent editor. */
  conflictsBeforeSuccess?: number;
  /** Mutate stored state just before a conflict is reported, as a racing writer would. */
  onConflict?: (store: Map<string, unknown>) => void;
  /** Reject the first N database requests with 401, as an expired token would. */
  unauthorizedBefore?: number;
  /** Reject every database request the way an egress proxy does: 403, plain text. */
  blockedByProxy?: boolean;
  /** Reject every database request the way Firebase's own security rules do. */
  deniedByRules?: boolean;
}

export interface FakeRtdb {
  store: Map<string, unknown>;
  /** Every request the code under test made, for asserting on protocol details. */
  requests: { method: string; url: string; headers: Record<string, string>; body?: string }[];
  get<T = unknown>(path: string): T | null;
  set(path: string, value: unknown): void;
  restore(): void;
}

let counter = 0;
const etagOf = (value: unknown): string =>
  value === null || value === undefined ? "null_etag" : `"etag-${hash(JSON.stringify(value))}"`;

function hash(text: string): string {
  let result = 0;
  for (let index = 0; index < text.length; index += 1) {
    result = (result * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(36);
}

/**
 * Drop what the Realtime Database refuses to store.
 *
 * Writing null, an empty object or an empty array deletes the key rather than storing it, and
 * the pruning is recursive. Reproducing that here means the tests exercise the same
 * "the key simply is not there" reads that the real database produces.
 */
function prune(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const kept = value.map(prune).filter(entry => entry !== undefined);
    return kept.length ? kept : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, prune(entry)] as const)
      .filter(([, entry]) => entry !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

const pathOf = (url: URL): string =>
  url.pathname
    .replace(/^\/+/, "")
    .replace(/\.json$/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent)
    .join("/");

/**
 * Assemble a node from the descendants stored beneath it.
 *
 * The database is a tree: writing `a/b/c` and then reading `a/b` returns `{c: ...}`. The store
 * here is a flat map of paths, so a read of a node nobody wrote directly has to be reassembled.
 * Without this, the shared list index would look empty to every reader, because it is only ever
 * written one child at a time.
 */
function assembleFrom(store: Map<string, unknown>, path: string): unknown {
  const prefix = `${path}/`;
  const children: Record<string, unknown> = {};
  for (const [key, value] of store) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    if (!head) continue;
    if (tail.length) children[head] = assembleFrom(store, `${path}/${head}`);
    else children[head] = value;
  }
  return Object.keys(children).length ? children : null;
}

/** Install the fake. Call `restore()` afterwards to put the real `fetch` back. */
export function installFakeRtdb(options: FakeOptions = {}): FakeRtdb {
  const original = globalThis.fetch;
  const store = new Map<string, unknown>(Object.entries(options.data ?? {}));
  const requests: FakeRtdb["requests"] = [];
  let conflictsLeft = options.conflictsBeforeSuccess ?? 0;
  let unauthorizedLeft = options.unauthorizedBefore ?? 0;
  const subtree = (path: string): unknown => assembleFrom(store, path);

  const json = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init
    });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const url = new URL(href);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value
      ])
    );
    requests.push({ method, url: href, headers, body: init.body as string | undefined });

    // --- Google Identity Toolkit: anonymous sign-in ---
    if (url.host === "identitytoolkit.googleapis.com") {
      counter += 1;
      return json({
        kind: "identitytoolkit#SignupNewUserResponse",
        idToken: `fake-id-token-${counter}`,
        refreshToken: `fake-refresh-${counter}`,
        localId: `fake-user-${counter}`,
        expiresIn: "3600"
      });
    }

    // --- Secure token service: refresh ---
    if (url.host === "securetoken.googleapis.com") {
      counter += 1;
      return json({
        id_token: `fake-id-token-${counter}`,
        refresh_token: `fake-refresh-${counter}`,
        expires_in: "3600"
      });
    }

    // --- Realtime Database REST ---
    const path = pathOf(url);
    if (!url.searchParams.get("auth")) {
      return new Response("Permission denied", { status: 401 });
    }
    if (options.blockedByProxy) {
      return new Response(
        `Host not in allowlist: ${url.host}. Add this host to your network egress settings to allow access.`,
        { status: 403, headers: { "Content-Type": "text/plain" } }
      );
    }
    if (options.deniedByRules) {
      return new Response('{"error":"Permission denied"}', {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (options.denyPath !== undefined && path === options.denyPath) {
      return new Response('{"error":"Permission denied"}', {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (unauthorizedLeft > 0) {
      unauthorizedLeft -= 1;
      return new Response('{"error":"Auth token is expired"}', { status: 401 });
    }

    if (method === "GET") {
      if (url.searchParams.get("shallow") === "true") {
        if (options.blockEnumeration) {
          return new Response('{"error":"Permission denied"}', { status: 401 });
        }
        const prefix = `${path}/`;
        const keys = [...store.keys()]
          .filter(key => key.startsWith(prefix))
          .map(key => key.slice(prefix.length).split("/")[0]!);
        const unique = [...new Set(keys)];
        return json(unique.length ? Object.fromEntries(unique.map(key => [key, true])) : null);
      }
      const value = store.has(path) ? store.get(path) : subtree(path);
      return new Response(JSON.stringify(value ?? null), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...(headers["x-firebase-etag"] ? { ETag: etagOf(value ?? null) } : {})
        }
      });
    }

    if (method === "PUT") {
      const current = store.has(path) ? store.get(path) : null;
      const ifMatch = headers["if-match"];
      if (ifMatch !== undefined) {
        if (conflictsLeft > 0) {
          conflictsLeft -= 1;
          options.onConflict?.(store);
          const afterRace = store.has(path) ? store.get(path) : null;
          return new Response('{"error":"mismatch"}', {
            status: 412,
            headers: { ETag: etagOf(afterRace ?? null) }
          });
        }
        if (ifMatch !== etagOf(current ?? null)) {
          return new Response('{"error":"mismatch"}', {
            status: 412,
            headers: { ETag: etagOf(current ?? null) }
          });
        }
      }
      const parsed = prune(init.body ? (JSON.parse(init.body as string) as unknown) : null) ?? null;
      store.set(path, parsed);
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: etagOf(parsed) }
      });
    }

    if (method === "DELETE") {
      // Removing a node removes everything under it, so drop descendant paths too.
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key);
      }
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(`Unexpected ${method} ${href}`, { status: 500 });
  }) as typeof fetch;

  return {
    store,
    requests,
    get: <T,>(path: string) => (store.has(path) ? (store.get(path) as T) : null),
    set: (path: string, value: unknown) => store.set(path, value),
    restore: () => {
      globalThis.fetch = original;
    }
  };
}
