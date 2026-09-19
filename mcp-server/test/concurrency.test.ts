import assert from "node:assert/strict";
import test from "node:test";
import { categoriesOf, itemNames, LIST_ID, LIST_PATH, seedList, startHarness } from "./harness.js";

test("a write is conditional on the version that was read", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_set_checked", { items: ["חלב"] });
    const indexSegment = encodeURIComponent("!index");
    const writes = harness.rtdb.requests.filter(
      entry => entry.method === "PUT" && entry.url.includes(LIST_ID) && !entry.url.includes(indexSegment)
    );
    assert.equal(writes.length, 1);
    // Without if-match the write would be a blind overwrite of whatever is stored.
    assert.ok(writes[0]?.headers["if-match"], "the write must carry an if-match precondition");
    // The edit also advertises the list in the shared index. That write is deliberately
    // unconditional: one list owns its entry, so there is no race worth a compare-and-swap.
    const advertisements = harness.rtdb.requests.filter(
      entry => entry.method === "PUT" && entry.url.includes(indexSegment)
    );
    assert.equal(advertisements.length, 1);
    assert.equal(advertisements[0]?.headers["if-match"], undefined);
    const reads = harness.rtdb.requests.filter(
      entry => entry.method === "GET" && entry.headers["x-firebase-etag"] === "true"
    );
    assert.ok(reads.length >= 1, "the read must ask for an ETag so the write can be conditional");
  } finally {
    await harness.close();
  }
});

test("a concurrent browser edit is re-applied rather than overwritten", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList() },
    conflictsBeforeSuccess: 1,
    // Stand in for somebody adding an item in the web page between our read and our write.
    onConflict: store => {
      const current = structuredClone(store.get(LIST_PATH)) as {
        departments: { items: unknown[] }[];
        updatedAt: number;
      };
      current.departments[0]!.items.push({ name: "לחם", note: "", checked: false, blank: false });
      current.updatedAt += 1;
      store.set(LIST_PATH, current);
    }
  });
  try {
    const result = await harness.data<{ retries: number; progress: { done: number } }>("shopping_set_checked", {
      items: ["חלב"]
    });
    assert.equal(result.retries, 1, "the lost race must be retried");

    const stored = harness.stored();
    // Our own change landed...
    assert.equal(categoriesOf(stored)[1]?.items[0]?.checked, true);
    // ...and so did the other writer's, which a blind overwrite would have discarded.
    assert.ok(itemNames(stored, 0).includes("לחם"), "the concurrent edit must survive");
  } finally {
    await harness.close();
  }
});

test("a write that keeps losing the race fails loudly instead of forcing itself through", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList() },
    conflictsBeforeSuccess: 99
  });
  try {
    const message = await harness.error("shopping_set_checked", { items: ["חלב"] });
    assert.match(message, /kept changing in the database/);
    // Nothing was written, so the other writer's state is intact.
    assert.equal(categoriesOf(harness.stored())[1]?.items[0]?.checked, false);
  } finally {
    await harness.close();
  }
});

test("updatedAt always increases, so an open page adopts the change", async () => {
  // A stored timestamp in the future (a device with a fast clock) must not stall propagation:
  // shouldApplyRemoteUpdate in list-model.js only adopts a snapshot whose updatedAt grew.
  const future = Date.now() + 10 * 60 * 1000;
  const harness = await startHarness({ data: { [LIST_PATH]: seedList({ updatedAt: future }) } });
  try {
    await harness.text("shopping_set_checked", { items: ["חלב"] });
    const first = harness.stored()?.updatedAt as number;
    assert.ok(first > future, `expected ${first} > ${future}`);

    await harness.text("shopping_set_checked", { items: ["ביצים"] });
    const second = harness.stored()?.updatedAt as number;
    assert.ok(second > first, "a second write must advance the timestamp again");
  } finally {
    await harness.close();
  }
});

test("create_list will not overwrite a list that appeared in the meantime", async () => {
  const harness = await startHarness();
  try {
    harness.rtdb.set("shared-lists/taken-id-01", { name: "קיימת", departments: [] });
    const message = await harness.error("shopping_create_list", { list_id: "taken-id-01", name: "חדשה" });
    assert.match(message, /already exists/);
    assert.equal(harness.stored("shared-lists/taken-id-01")?.name, "קיימת");
  } finally {
    await harness.close();
  }
});

test("an expired token is renewed and the request replayed", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, unauthorizedBefore: 1 });
  try {
    const text = await harness.text("shopping_get_list");
    // The call succeeds despite the rejection, which is the point.
    assert.match(text, /רשימת קניות/);

    const authCalls = harness.rtdb.requests.filter(entry => entry.url.includes("googleapis.com"));
    assert.equal(authCalls.length, 1, "the 401 must trigger exactly one re-authentication");
    const listReads = harness.rtdb.requests.filter(
      entry => entry.method === "GET" && entry.url.includes(LIST_PATH)
    );
    assert.equal(listReads.length, 2, "the rejected read must be replayed with the new token");
  } finally {
    await harness.close();
  }
});

test("an egress block is reported as a network policy problem, not a Firebase one", async () => {
  // The proxy in front of the database answers with its own plain-text message. Blaming the
  // security rules for that would send the reader to the wrong console entirely.
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, blockedByProxy: true });
  try {
    const message = await harness.error("shopping_get_list");
    assert.match(message, /network policy/);
    assert.match(message, /Host not in allowlist/);
    assert.match(message, /network egress allowlist/);
    assert.doesNotMatch(message, /security rules/);
  } finally {
    await harness.close();
  }
});

test("a rules denial is reported as a Firebase permissions problem", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, deniedByRules: true });
  try {
    const message = await harness.error("shopping_get_list");
    assert.match(message, /security rules/);
    assert.match(message, /Firebase console/);
    assert.doesNotMatch(message, /network policy/);
  } finally {
    await harness.close();
  }
});

test("a mutation that changes nothing is not written at all", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    // "חלב" is already unticked, so unticking it is a no-op. Writing anyway would bump
    // updatedAt, and every open tab replaces the list's innerHTML when it adopts an update,
    // taking focus out of whatever row someone is mid-way through typing.
    const before = harness.stored()?.updatedAt;
    const result = await harness.data<{ changed: string[] }>("shopping_set_checked", {
      items: ["חלב"],
      checked: false
    });
    assert.ok(result.changed.some(line => line.includes("already")));
    assert.equal(harness.rtdb.requests.filter(entry => entry.method === "PUT").length, 0);
    assert.equal(harness.stored()?.updatedAt, before);
  } finally {
    await harness.close();
  }
});

test("a real change is still written when bundled with a no-op", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_set_checked", { items: ["חלב", "תפוח עץ"] });
    assert.equal(harness.rtdb.requests.filter(entry => entry.method === "PUT").length, 1);
    assert.equal(categoriesOf(harness.stored())[1]?.items[0]?.checked, true);
  } finally {
    await harness.close();
  }
});

test("list_lists reports a total egress block instead of blaming the database rules", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, blockedByProxy: true });
  try {
    const message = await harness.error("shopping_list_lists");
    assert.match(message, /network policy/);
    assert.doesNotMatch(message, /did not allow enumerating/);
    assert.doesNotMatch(message, /security rules/);
  } finally {
    await harness.close();
  }
});

test("list_lists still falls back gracefully when only the rules forbid enumeration", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, blockEnumeration: true });
  try {
    const result = await harness.data<{ enumeration_allowed: boolean }>("shopping_list_lists", {
      response_format: "json"
    });
    assert.equal(result.enumeration_allowed, false);
  } finally {
    await harness.close();
  }
});
