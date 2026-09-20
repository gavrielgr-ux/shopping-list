import assert from "node:assert/strict";
import test from "node:test";
import { LIST_ID, LIST_PATH, seedList, startHarness } from "./harness.js";

/**
 * Discovery of lists this server has never touched.
 *
 * The database stores one node per list and no index of them, and its rules refuse a read of
 * the collection root, so `shopping_list_lists` used to see only the default list plus
 * whatever was in its own local registry. A list created in a browser was therefore invisible:
 * the user had to paste its id before anything could be done with it. The fix is a shared index
 * that both the page and this server write to, exercised here.
 */

/**
 * Written out rather than imported from `constants.ts`, which resolves the state directory the
 * moment it is first imported: pulling it in at the top of this file loaded it before the
 * harness could redirect that, and these tests then wrote the developer's real state file.
 * `LIST_INDEX_PATH` is pinned against this value in `app-contract.test.ts`, which starts no
 * server and so can import it safely.
 */
const LIST_INDEX_PATH = "shared-lists/!index";

const entryPath = (id: string): string => `${LIST_INDEX_PATH}/${id}`;

/** Seeded state for a list created in a browser: the list, plus the entry the page advertises. */
const browserMade = (id: string, name: string): Record<string, unknown> => ({
  [`shared-lists/${id}`]: seedList({ name }),
  [entryPath(id)]: { name, updatedAt: 1_700_000_100_000 }
});

test("a list created in a browser is discoverable, without anyone naming its id", async () => {
  const harness = await startHarness({
    data: {
      [LIST_PATH]: seedList(),
      ...browserMade("list-al-haesh-sukkot", "על האש בסוכות")
    },
    blockEnumeration: true
  });
  try {
    const result = await harness.data<{
      index_available: boolean;
      enumeration_allowed: boolean;
      lists: { id: string; name: string; reachable: boolean | null; progress: { total: number } | null }[];
    }>("shopping_list_lists", { response_format: "json" });

    assert.equal(result.index_available, true);
    assert.equal(result.enumeration_allowed, false, "the rules still forbid enumerating the root");
    const entry = result.lists.find(item => item.id === "list-al-haesh-sukkot");
    assert.ok(entry, "a list advertised in the shared index must be reported");
    assert.equal(entry?.name, "על האש בסוכות");
    assert.equal(entry?.reachable, true);
    assert.ok((entry?.progress?.total ?? 0) > 0);
  } finally {
    await harness.close();
  }
});

test("the markdown answer names the shared index as the source", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), ...browserMade("list-markdown-note", "רשימה מהדפדפן") },
    blockEnumeration: true
  });
  try {
    const text = await harness.text("shopping_list_lists");
    assert.match(text, /רשימה מהדפדפן/);
    assert.match(text, /shared index/);
  } finally {
    await harness.close();
  }
});

test("creating a list advertises it in the shared index", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, blockEnumeration: true });
  try {
    const created = await harness.data<{ id: string; name: string }>("shopping_create_list", {
      name: "קניות לשבת",
      categories: [],
      response_format: "json"
    });
    const entry = harness.rtdb.get<{ name: string; updatedAt: number }>(entryPath(created.id));
    assert.ok(entry, "a list created here must be advertised, so other clients can find it");
    assert.equal(entry?.name, "קניות לשבת");
    assert.ok(Number.isFinite(entry?.updatedAt));
  } finally {
    await harness.close();
  }
});

test("renaming a list updates what the shared index advertises", async () => {
  const listId = "list-rename-advert";
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), ...browserMade(listId, "שם ישן") },
    blockEnumeration: true
  });
  try {
    await harness.text("shopping_rename_list", { list_id: listId, name: "שם חדש" });
    assert.equal(harness.rtdb.get<{ name: string }>(entryPath(listId))?.name, "שם חדש");
  } finally {
    await harness.close();
  }
});

test("the shared index outranks a stale local registry entry", async () => {
  // The page writes the index on every save, and this server's local registry only moves when
  // this server touches a list, so a rename done in a browser reaches one and not the other.
  const listId = "list-renamed-elsewhere";
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), ...browserMade(listId, "שם מקורי") }
  });
  try {
    await harness.text("shopping_get_list", { list_id: listId });
    harness.rtdb.set(entryPath(listId), { name: "שם שהוחלף בדפדפן", updatedAt: 1_700_000_900_000 });
    harness.rtdb.set(`shared-lists/${listId}`, seedList({ name: "שם שהוחלף בדפדפן" }));

    const result = await harness.data<{ lists: { id: string; name: string }[] }>("shopping_list_lists", {
      include_progress: false,
      response_format: "json"
    });
    assert.equal(
      result.lists.find(item => item.id === listId)?.name,
      "שם שהוחלף בדפדפן",
      "the shared index is the fresher source and must win"
    );
  } finally {
    await harness.close();
  }
});

test("deleting a list retracts its index entry, so it stops being advertised", async () => {
  const listId = "list-to-be-deleted";
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), ...browserMade(listId, "רשימה למחיקה") },
    blockEnumeration: true
  });
  try {
    await harness.text("shopping_delete_list", { list_id: listId, confirm: true });
    assert.equal(harness.rtdb.get(entryPath(listId)), null);

    const result = await harness.data<{ lists: { id: string }[] }>("shopping_list_lists", {
      include_progress: false,
      response_format: "json"
    });
    assert.ok(!result.lists.some(item => item.id === listId));
  } finally {
    await harness.close();
  }
});

test("an entry left behind for an already-deleted list is retracted", async () => {
  // The client that writes the tombstone is the one meant to retract the entry, and it may have
  // failed to, or may predate the index. Deleting again repairs it instead of only erroring.
  const listId = "list-stale-advert";
  const harness = await startHarness({
    data: {
      [LIST_PATH]: seedList(),
      [`shared-lists/${listId}`]: { deleted: true, deletedAt: 1_700_000_500_000 },
      [entryPath(listId)]: { name: "רשימה שנמחקה", updatedAt: 1_700_000_100_000 }
    },
    blockEnumeration: true
  });
  try {
    const message = await harness.error("shopping_delete_list", { list_id: listId, confirm: true });
    assert.match(message, /already deleted/);
    assert.equal(harness.rtdb.get(entryPath(listId)), null, "the stale entry must be gone");
  } finally {
    await harness.close();
  }
});

test("the index node is never reported as a list of its own", async () => {
  // Enumerating the lists root returns every child, the index node included. It is not a list,
  // and its key cannot be one: `!` is outside the id pattern the page and this server accept.
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), ...browserMade("list-alongside-index", "רשימה") }
  });
  try {
    const result = await harness.data<{ enumeration_allowed: boolean; lists: { id: string }[] }>(
      "shopping_list_lists",
      { include_progress: false, response_format: "json" }
    );
    assert.equal(result.enumeration_allowed, true);
    assert.ok(
      !result.lists.some(item => item.id.includes("!") || item.id === "!index"),
      "the index node must not be mistaken for a list"
    );
    assert.ok(result.lists.some(item => item.id === "list-alongside-index"));
  } finally {
    await harness.close();
  }
});

test("an unreadable index is reported rather than passed off as an empty answer", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList() },
    blockEnumeration: true,
    denyPath: LIST_INDEX_PATH
  });
  try {
    const result = await harness.data<{ index_available: boolean; lists: { id: string }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    assert.equal(result.index_available, false);
    assert.ok(result.lists.some(item => item.id === LIST_ID), "the default list is still reported");

    const text = await harness.text("shopping_list_lists");
    assert.match(text, /could not be read/);
  } finally {
    await harness.close();
  }
});

test("an edit still succeeds when the index cannot be written", async () => {
  // The index is how a list is found, not how it is stored. A failure to advertise must not be
  // reported as a failure to save, which would invite a retry of a write that already landed.
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList() },
    blockEnumeration: true,
    denyPath: `${LIST_INDEX_PATH}/${LIST_ID}`
  });
  try {
    const text = await harness.text("shopping_add_items", {
      items: [{ name: "קמח", category: "מזווה ורטבים" }],
      create_category: true
    });
    assert.match(text, /קמח/);
    assert.ok(
      JSON.stringify(harness.stored()).includes("קמח"),
      "the item must be stored even though it could not be advertised"
    );
  } finally {
    await harness.close();
  }
});

test("reading a list does not write to the index", async () => {
  // shopping_get_list and shopping_list_lists declare readOnlyHint, and a client may auto-approve
  // them on the strength of it.
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), ...browserMade("list-read-only-check", "רשימה") }
  });
  try {
    await harness.text("shopping_get_list");
    await harness.text("shopping_get_list", { list_id: "list-read-only-check" });
    await harness.text("shopping_list_lists");
    await harness.text("shopping_share_list");

    const writes = harness.rtdb.requests.filter(
      entry => entry.method !== "GET" && entry.url.includes(encodeURIComponent("!index"))
    );
    assert.deepEqual(writes, [], "a reading tool must not touch the index");
  } finally {
    await harness.close();
  }
});

test("a malformed index entry is tolerated rather than crashing the listing", async () => {
  const harness = await startHarness({
    data: {
      [LIST_PATH]: seedList(),
      [entryPath("list-no-name-stored")]: { updatedAt: "not a number" },
      [entryPath("list-wrong-shape")]: "just a string",
      [`shared-lists/list-no-name-stored`]: seedList({ name: "שם אמיתי" })
    },
    blockEnumeration: true
  });
  try {
    const result = await harness.data<{ lists: { id: string; name: string; reachable: boolean | null }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    // The stored list's own name is authoritative once it is read.
    assert.equal(result.lists.find(item => item.id === "list-no-name-stored")?.name, "שם אמיתי");
    assert.equal(result.lists.find(item => item.id === "list-wrong-shape")?.reachable, false);
  } finally {
    await harness.close();
  }
});

test("a registry entry for a list the database says is gone is forgotten", async () => {
  // Nothing else ever removed one: only an explicit delete through this server called
  // forgetList, so an id that entered the registry was reported as unreachable for ever. A test
  // run that wrote the real state file is exactly how that came up.
  const listId = "list-vanishes-later";
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), [`shared-lists/${listId}`]: seedList({ name: "רשימה" }) },
    blockEnumeration: true
  });
  try {
    await harness.text("shopping_get_list", { list_id: listId });
    harness.rtdb.store.delete(`shared-lists/${listId}`);

    const first = await harness.data<{ lists: { id: string; reachable: boolean | null }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    assert.equal(
      first.lists.find(item => item.id === listId)?.reachable,
      false,
      "the call that notices it is gone still reports it, so the answer explains itself"
    );

    const second = await harness.data<{ lists: { id: string }[] }>("shopping_list_lists", {
      response_format: "json"
    });
    assert.ok(!second.lists.some(item => item.id === listId), "and it is not carried for ever");
  } finally {
    await harness.close();
  }
});

test("a list that merely could not be read is kept, because it may well exist", async () => {
  // The distinction the pruning turns on. Forgetting a list because the rules blocked one read
  // would lose the only record of it this server has.
  const listId = "list-unreadable-for-now";
  const options = {
    data: { [LIST_PATH]: seedList(), [`shared-lists/${listId}`]: seedList({ name: "רשימה חסויה" }) },
    blockEnumeration: true,
    denyPath: undefined as string | undefined
  };
  const harness = await startHarness(options);
  try {
    await harness.text("shopping_get_list", { list_id: listId });

    options.denyPath = `shared-lists/${listId}`;
    const blocked = await harness.data<{ lists: { id: string; reachable: boolean | null }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    assert.equal(blocked.lists.find(item => item.id === listId)?.reachable, false);

    options.denyPath = undefined;
    const after = await harness.data<{ lists: { id: string; reachable: boolean | null }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    assert.equal(
      after.lists.find(item => item.id === listId)?.reachable,
      true,
      "it must still be known once it can be read again"
    );
  } finally {
    await harness.close();
  }
});

test("a list tombstoned by somebody else is forgotten locally", async () => {
  const listId = "list-tombstoned";
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), [`shared-lists/${listId}`]: seedList({ name: "רשימה" }) },
    blockEnumeration: true
  });
  try {
    await harness.text("shopping_get_list", { list_id: listId });
    // A tombstone written by another client, so this server never called forgetList itself.
    harness.rtdb.set(`shared-lists/${listId}`, { deleted: true, deletedAt: 1_700_000_500_000 });

    await harness.text("shopping_list_lists");
    const after = await harness.data<{ lists: { id: string }[] }>("shopping_list_lists", {
      include_progress: false,
      response_format: "json"
    });
    assert.ok(!after.lists.some(item => item.id === listId), "a tombstone counts as gone");
  } finally {
    await harness.close();
  }
});

test("a stale index entry keeps a dead list listed until a delete retracts it", async () => {
  // The boundary of the pruning above. Forgetting it locally is not enough while the shared
  // index still advertises it, and the reading tools deliberately do not write the index: that
  // belongs to the delete paths, which are writers. Reported as unreachable in the meantime.
  const listId = "list-dead-but-advertised";
  const harness = await startHarness({
    data: {
      [LIST_PATH]: seedList(),
      [`shared-lists/${listId}`]: { deleted: true, deletedAt: 1_700_000_500_000 },
      [entryPath(listId)]: { name: "רשימה שנמחקה", updatedAt: 1_700_000_100_000 }
    },
    blockEnumeration: true
  });
  try {
    const listed = await harness.data<{ lists: { id: string; reachable: boolean | null }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    assert.equal(listed.lists.find(item => item.id === listId)?.reachable, false);

    // The delete path is what retracts it, and then it is gone from the output.
    await harness.error("shopping_delete_list", { list_id: listId, confirm: true });
    assert.equal(harness.rtdb.get(entryPath(listId)), null);
    const after = await harness.data<{ lists: { id: string }[] }>("shopping_list_lists", {
      include_progress: false,
      response_format: "json"
    });
    assert.ok(!after.lists.some(item => item.id === listId));
  } finally {
    await harness.close();
  }
});

test("an index entry for a list that is simply absent is retracted on a delete attempt", async () => {
  const listId = "list-advertised-but-absent";
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), [entryPath(listId)]: { name: "רשימת רפאים", updatedAt: 1 } },
    blockEnumeration: true
  });
  try {
    const message = await harness.error("shopping_delete_list", { list_id: listId, confirm: true });
    assert.match(message, /nothing to delete/);
    assert.equal(harness.rtdb.get(entryPath(listId)), null, "stop advertising a list that is not there");
  } finally {
    await harness.close();
  }
});
