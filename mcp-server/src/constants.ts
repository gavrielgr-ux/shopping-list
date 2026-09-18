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

/** Network timeout for a single HTTP request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = Number(env("SHOPPING_LIST_TIMEOUT_MS") ?? 15_000);
