import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LIST_INDEX_PATH, LISTS_ROOT } from "../src/constants.js";
import { serializePayload } from "../src/normalize.js";
import { assertListId } from "../src/store.js";

/**
 * The page's own model helpers, loaded from the repository root.
 *
 * This server's writes are only useful if the page can read them, so that contract is pinned
 * here rather than assumed. The module is untyped plain JavaScript outside this package, so it
 * is resolved at runtime and its shape asserted, which also keeps it out of the build graph.
 */
interface AppModel {
  getListIdFromLocation: (locationHref: string) => string | null;
  normalizePayload: (
    value: unknown,
    fallbackName?: string
  ) => { name: string; departments: { title?: string; items?: { name?: string; checked?: boolean }[] }[]; updatedAt?: number } | null;
  shouldApplyRemoteUpdate: (payload: unknown, lastSavedAt: unknown) => boolean;
}

const modelPath = [
  resolve(process.cwd(), "../list-model.js"),
  resolve(process.cwd(), "list-model.js")
].find(existsSync);

if (!modelPath) throw new Error("could not locate list-model.js at the repository root");
const { getListIdFromLocation, normalizePayload, shouldApplyRemoteUpdate } = (await import(
  pathToFileURL(modelPath).href
)) as AppModel;

test("the page can read a list this server writes with no categories", () => {
  // Firebase deletes a key whose value is an empty array, so `departments: []` reaches the page
  // as a payload with no `departments` at all. The page used to treat that as unreadable, skip
  // the update while still showing "synced", and save its own stale categories back over it.
  const written = serializePayload({ name: "ריקה", departments: [], updatedAt: null }, null);
  const afterPruning = { name: written.name, updatedAt: written.updatedAt };

  const parsed = normalizePayload(afterPruning);
  assert.notEqual(parsed, null, "an empty list must be readable by the page");
  assert.deepEqual(parsed?.departments, []);
  assert.equal(parsed?.name, "ריקה");
  assert.ok(shouldApplyRemoteUpdate(afterPruning, null));
});

test("the page can read a normal list this server writes", () => {
  const written = serializePayload(
    {
      name: "רשימה",
      departments: [
        { title: "חלב וביצים", hint: "מקררים", items: [{ name: "חלב", note: "2", checked: true, blank: false }] }
      ],
      updatedAt: null
    },
    null
  );
  const parsed = normalizePayload(written);
  assert.equal(parsed?.departments.length, 1);
  assert.equal(parsed?.departments[0]?.items?.[0]?.name, "חלב");
  assert.equal(parsed?.departments[0]?.items?.[0]?.checked, true);
});

test("the page still rejects payloads that are not lists", () => {
  // Widening normalizePayload must not make it accept a deletion marker or junk, since app.js
  // and the local-copy restore both rely on null meaning "nothing usable here".
  for (const value of [null, undefined, {}, 42, "x", { deleted: true, deletedAt: 1 }]) {
    assert.equal(normalizePayload(value), null, `${JSON.stringify(value)} must not parse as a list`);
  }
});

test("the page adopts an update only when updatedAt grows", () => {
  // Why serializePayload forces the timestamp strictly upward.
  const written = serializePayload({ name: "x", departments: [], updatedAt: 5_000 }, 5_000);
  assert.ok(shouldApplyRemoteUpdate(written, 5_000));
  assert.equal(shouldApplyRemoteUpdate({ updatedAt: 5_000 }, 5_000), false);
});

test("the shared index key can never be opened or created as a list", () => {
  // The index lives at a child of the lists root because the security rules grant read and
  // write there and nowhere else. What keeps it from colliding with a real list is that its key
  // is not a usable list id: the page refuses to open it and assertListId refuses to create it.
  // If either side ever started accepting the key, a list could occupy the index path.
  // The literal is also written out in `list-index.test.ts`, which cannot import this constant
  // without loading the state directory before its harness can redirect it, so pin the whole
  // path here and not just the key.
  assert.equal(LIST_INDEX_PATH, "shared-lists/!index");
  const key = LIST_INDEX_PATH.split("/").pop();
  assert.equal(
    getListIdFromLocation(`https://example.test/?list=${encodeURIComponent(key!)}`),
    null,
    "the page must not open the index node as a list"
  );
  assert.throws(() => assertListId(key!), /not a usable list id/);
  assert.ok(LIST_INDEX_PATH.startsWith(`${LISTS_ROOT}/`), "the index must sit where the rules allow writes");
});
