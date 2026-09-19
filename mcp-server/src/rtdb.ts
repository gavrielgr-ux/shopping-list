import { getAuthToken, invalidateToken } from "./auth.js";
import { DATABASE_URL } from "./constants.js";
import { HttpError, request } from "./http.js";

/** Sentinel the Realtime Database returns as the ETag of a path that holds nothing. */
export const ABSENT_ETAG = "null_etag";

export interface ReadResult<T> {
  value: T | null;
  /** ETag of the node, used to make the following write conditional. */
  etag: string | null;
}

/**
 * Raised when the database itself refused, i.e. its security rules did.
 *
 * Distinct from a refusal by something in between, because the two are fixed in different
 * places and a caller that treats them alike will send the reader to the wrong console.
 */
export class RulesDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesDenied";
  }
}

/** Raised when a proxy, firewall or egress policy refused before the database was reached. */
export class NetworkBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkBlocked";
  }
}

/** Raised when a conditional write lost a race with another writer. */
export class PreconditionFailed extends Error {
  constructor(readonly currentEtag: string | null) {
    super("The list changed in the database since it was read.");
    this.name = "PreconditionFailed";
  }
}

const endpoint = (path: string, query: Record<string, string> = {}): string => {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");
  const search = new URLSearchParams(query);
  return `${DATABASE_URL}/${encoded}.json${search.size ? `?${search}` : ""}`;
};

const databaseHost = (): string => new URL(DATABASE_URL).host;

/**
 * True when a rejection came from the database itself rather than from something in between.
 *
 * The Realtime Database answers a refusal with a JSON body such as
 * `{"error":"Permission denied"}`. A proxy or egress filter standing in front of it answers
 * with its own plain-text message, and blaming the security rules for that would send the
 * reader to the wrong console entirely.
 */
function isFirebaseRefusal(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === "string";
  } catch {
    return false;
  }
}

function describe(error: HttpError): Error {
  if (error.status === 401 || error.status === 403) {
    if (!isFirebaseRefusal(error.body)) {
      // Relay the intermediary's own words: they usually name the exact remedy.
      const upstream = error.body.trim().slice(0, 300);
      return new NetworkBlocked(
        `A network policy between this machine and the database refused the request (HTTP ${error.status})` +
          `${upstream ? `: ${upstream}` : "."} ` +
          `Nothing is wrong with the list or with Firebase — the host ${databaseHost()} has to be ` +
          "reachable from wherever this server runs. In Claude Code on the web, add it to the " +
          "environment's network egress allowlist; elsewhere, allow it in the proxy or firewall."
      );
    }
    return new RulesDenied(
      `The Realtime Database refused access (HTTP ${error.status}): ${error.body.trim().slice(0, 200)}. ` +
        "The security rules most likely do not grant this identity read/write on the list path. Check " +
        "them in the Firebase console, or set SHOPPING_LIST_DB_SECRET to authenticate as an admin."
    );
  }
  if (error.status === 404) {
    return new Error(
      `The database URL ${DATABASE_URL} returned 404. Confirm SHOPPING_LIST_DATABASE_URL matches the databaseURL in the site's app.js.`
    );
  }
  return new Error(`Realtime Database request failed (HTTP ${error.status}): ${error.body.slice(0, 300)}`);
}

/**
 * Send an authenticated request, retrying once after re-authenticating.
 *
 * A cached ID token can expire between tool calls; rather than surface a 401 to the model, the
 * token is dropped and the request replayed with a fresh one.
 */
async function authorized(
  build: (token: string) => { url: string; init: Parameters<typeof request>[1] }
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const token = await getAuthToken();
    const { url, init } = build(token);
    try {
      return await request(url, init);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && attempt === 0) {
        invalidateToken();
        continue;
      }
      throw error instanceof HttpError ? describe(error) : error;
    }
  }
}

/** Read a node together with its ETag. */
export async function readNode<T>(path: string): Promise<ReadResult<T>> {
  const response = await authorized(token => ({
    url: endpoint(path, { auth: token }),
    init: { headers: { "X-Firebase-ETag": "true" } }
  }));
  const text = await response.text();
  const etag = response.headers.get("etag");
  return {
    value: text && text !== "null" ? (JSON.parse(text) as T) : null,
    etag
  };
}

/**
 * Overwrite a node, optionally only if it still matches `etag`.
 *
 * The web app saves with `set()`, replacing the whole list, so a full conditional PUT is the
 * faithful equivalent. Passing the ETag turns it into a compare-and-swap, which is what keeps
 * a concurrent edit in an open browser tab from being overwritten.
 */
export async function writeNode(path: string, value: unknown, etag: string | null): Promise<string | null> {
  const response = await authorized(token => ({
    url: endpoint(path, { auth: token }),
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(etag ? { "if-match": etag } : { "X-Firebase-ETag": "true" })
      },
      body: JSON.stringify(value),
      allowStatuses: [412]
    }
  }));
  if (response.status === 412) {
    await response.text().catch(() => "");
    throw new PreconditionFailed(response.headers.get("etag"));
  }
  await response.text().catch(() => "");
  return response.headers.get("etag");
}

/**
 * Remove a node and everything under it.
 *
 * Used to retract an index entry for a list that was deleted. Unconditional on purpose: each
 * entry is owned by one list id, so there is no race worth a compare-and-swap, and a retraction
 * that lost one would leave a dead list advertised.
 */
export async function deleteNode(path: string): Promise<void> {
  const response = await authorized(token => ({
    url: endpoint(path, { auth: token }),
    init: { method: "DELETE" }
  }));
  await response.text().catch(() => "");
}

/**
 * List the child keys of a node without downloading their contents.
 *
 * Returns null when the database's own rules forbid the read, which is an expected outcome:
 * the web app never reads the collection root, so the rules may well grant read only on an
 * individual list. Anything else is rethrown. Swallowing a network failure here would report
 * it as "the rules do not allow enumeration", which is the misdiagnosis this module exists to
 * avoid.
 */
export async function shallowKeys(path: string): Promise<string[] | null> {
  try {
    const response = await authorized(token => ({
      url: endpoint(path, { auth: token, shallow: "true" }),
      init: {}
    }));
    const text = await response.text();
    if (!text || text === "null") return [];
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>) : [];
  } catch (error) {
    if (error instanceof RulesDenied) return null;
    throw error;
  }
}
