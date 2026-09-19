/**
 * Configuration for the shared shopping list backend.
 *
 * The web app at https://gavrielgr-ux.github.io/shopping-list/ is a static page that
 * talks straight to a Firebase Realtime Database. This server speaks to the exact same
 * database over the RTDB REST API, so every write made here shows up live in any open
 * browser tab (the page subscribes with `onValue`).
 *
 * The Firebase web config below is the same one shipped in the public `app.js`. A Firebase
 * web API key is a project identifier, not a secret: access is governed by the database
 * security rules, so keeping it as a default here grants no more than loading the page does.
 * Every value can still be overridden by environment variable.
 */

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
};

/** Firebase web API key, used for anonymous sign-in. */
export const FIREBASE_API_KEY =
  env("SHOPPING_LIST_API_KEY") ?? "AIzaSyBTNbSh9PgI9cTc67YyLjEuULkg6ACB6SA";

/** Realtime Database origin, without a trailing slash. */
export const DATABASE_URL = (
  env("SHOPPING_LIST_DATABASE_URL") ?? "https://shopping-list-27ffd-default-rtdb.firebaseio.com"
).replace(/\/+$/, "");

/** RTDB path prefix holding one child per list, matching `app.js`. */
export const LISTS_ROOT = env("SHOPPING_LIST_ROOT") ?? "shared-lists";

/**
 * Path of the shared index that makes a list discoverable by something that lacks its id.
 *
 * The database stores one node per list and no index of them, and the page keeps its "recent
 * lists" in the browser's `localStorage`, so a list created in a browser used to be invisible
 * to anything that did not already know its id. Both the page and this server now write
 * `{name, updatedAt}` here under the list's own id, and `shopping_list_lists` reads it.
 *
 * It sits inside `LISTS_ROOT` on purpose. The project's security rules grant read and write on
 * a child of that root and nothing else: a sibling top-level node is refused outright, so an
 * index there would need a rules change in the Firebase console before any of this worked.
 *
 * The `!` puts the key outside `LIST_ID_PATTERN`, so no list can ever be created at that id and
 * the key can never be mistaken for one. That is also why enumeration filters by that pattern
 * rather than by this name.
 */
export const LIST_INDEX_PATH = env("SHOPPING_LIST_INDEX_PATH") ?? `${LISTS_ROOT}/!index`;

/** Public site used to build shareable links. */
export const SITE_URL = (
  env("SHOPPING_LIST_SITE_URL") ?? "https://gavrielgr-ux.github.io/shopping-list/"
).replace(/\?.*$/, "");

/** The list the web app opens by default, from `list-model.js`. */
export const DEFAULT_LIST_ID = env("SHOPPING_LIST_DEFAULT_ID") ?? "rehovot-family-4d7f8c12";

/** Fallback list name, from `list-model.js`. */
export const DEFAULT_LIST_NAME = "רשימת קניות";

/** Fallback category name, matching the label `app.js` gives new categories. */
export const DEFAULT_CATEGORY_TITLE = "קטגוריה חדשה";

/** `safeListId` from `list-model.js` — ids must satisfy this to be reachable by URL. */
export const LIST_ID_PATTERN = /^[a-z0-9_-]{6,90}$/i;

/** Directory for the local token cache and known-list registry. */
export const STATE_DIR =
  env("SHOPPING_LIST_STATE_DIR") ??
  `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.shopping-list-mcp`;

/** A pre-minted Firebase ID token, if the caller would rather supply its own identity. */
export const ID_TOKEN_OVERRIDE = env("SHOPPING_LIST_ID_TOKEN");

/**
 * Legacy RTDB database secret or service-account access token. Sent as `?auth=`, which the
 * RTDB REST API accepts in place of an ID token and which bypasses security rules.
 */
export const AUTH_SECRET = env("SHOPPING_LIST_DB_SECRET");

/** Cap on characters returned by a single tool response, to keep replies manageable. */
export const CHARACTER_LIMIT = 40_000;

/** How many times a conditional write is retried when it loses a race. */
export const WRITE_RETRIES = 4;

/**
 * Network timeout for a single HTTP request, in milliseconds.
 *
 * A bad value falls back to the default rather than becoming NaN, which would abort every
 * request immediately and report a timeout "after NaNms".
 */
export const REQUEST_TIMEOUT_MS = (() => {
  const configured = Number(env("SHOPPING_LIST_TIMEOUT_MS"));
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
})();
