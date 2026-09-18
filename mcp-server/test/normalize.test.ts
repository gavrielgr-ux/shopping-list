import assert from "node:assert/strict";
import test from "node:test";
import {
  foldText,
  matchAll,
  normalizeCategory,
  normalizePayload,
  progressOf,
  serializePayload,
  toDenseArray
} from "../src/normalize.js";

test("toDenseArray keeps a real array but drops holes", () => {
  assert.deepEqual(toDenseArray(["a", null, "b"]), ["a", "b"]);
  assert.deepEqual(toDenseArray([]), []);
  assert.deepEqual(toDenseArray(null), []);
  assert.deepEqual(toDenseArray(undefined), []);
});

test("toDenseArray reorders the numeric-key map the database returns for a sparse array", () => {
  // Firebase returns an object instead of an array whenever the indices are not 0..n.
  assert.deepEqual(toDenseArray({ "2": "c", "0": "a", "1": "b" }), ["a", "b", "c"]);
  assert.deepEqual(toDenseArray({ "5": "f", "0": "a" }), ["a", "f"]);
  assert.deepEqual(toDenseArray({ "10": "j", "2": "c" }), ["c", "j"]);
});

test("normalizePayload fills in defaults for an absent list", () => {
  const payload = normalizePayload(null);
  assert.equal(payload.departments.length, 0);
  assert.equal(payload.updatedAt, null);
  assert.equal(payload.name, "רשימת קניות");
});

test("normalizePayload reads the current object form", () => {
  const payload = normalizePayload({
    name: "שבת",
    updatedAt: 1700000000000,
    departments: [
      { title: "חלב וביצים", hint: "מקררים", items: [{ name: "חלב", note: "2", checked: true, blank: false }] }
    ]
  });
  assert.equal(payload.name, "שבת");
  assert.equal(payload.updatedAt, 1700000000000);
  assert.equal(payload.departments[0]?.title, "חלב וביצים");
  assert.equal(payload.departments[0]?.items[0]?.checked, true);
});

test("normalizePayload accepts the legacy bare-array payload", () => {
  // list-model.js still migrates a payload that is just the departments array.
  const payload = normalizePayload([{ title: "פירות", hint: "", items: [{ name: "תפוח" }] }]);
  assert.equal(payload.departments.length, 1);
  assert.equal(payload.departments[0]?.items[0]?.name, "תפוח");
});

test("normalizeCategory accepts legacy [name, note] tuples", () => {
  const category = normalizeCategory({ title: "אפייה", items: [["סוכר", "2 ק״ג"]] }, 0);
  assert.equal(category.items[0]?.name, "סוכר");
  assert.equal(category.items[0]?.note, "2 ק״ג");
  assert.equal(category.items[0]?.checked, false);
});

test("normalizeCategory names an untitled category by position", () => {
  assert.equal(normalizeCategory({ items: [] }, 3).title, "קטגוריה 4");
});

test("normalizeCategory treats a bare numeric-key map as items, not as a category", () => {
  const category = normalizeCategory({ "0": { name: "חלב" }, "1": { name: "ביצים" } }, 0);
  assert.deepEqual(
    category.items.map(item => item.name),
    ["חלב", "ביצים"]
  );
});

test("serializePayload forces updatedAt above the stored value", () => {
  // The web app ignores an incoming snapshot unless updatedAt grew, so a write that reused
  // the timestamp would never reach an open tab.
  const future = Date.now() + 60_000;
  const body = serializePayload({ name: "x", departments: [], updatedAt: future }, future);
  assert.ok((body.updatedAt as number) > future);
});

test("serializePayload keeps every item field the web app expects", () => {
  const body = serializePayload(
    {
      name: "x",
      departments: [{ title: "t", hint: "h", items: [{ name: "n", note: "o", checked: true, blank: false }] }],
      updatedAt: null
    },
    null
  );
  const departments = body.departments as { items: Record<string, unknown>[] }[];
  assert.deepEqual(Object.keys(departments[0]!.items[0]!).sort(), ["blank", "checked", "name", "note"]);
});

test("foldText ignores case, niqqud and Hebrew punctuation variants", () => {
  assert.equal(foldText("  Milk  "), "milk");
  assert.equal(foldText("שַׁמֶּנֶת"), foldText("שמנת"));
  assert.equal(foldText("ד״ר"), foldText('ד"ר'));
  assert.equal(foldText("דוד׳ס"), foldText("דוד'ס"));
});

test("matchAll prefers an exact hit over a substring one", () => {
  // "חלב" must not become ambiguous just because "חלב סויה" also contains it.
  const matches = matchAll(["חלב", "חלב סויה", "אבקת חלב"], "חלב");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.index, 0);
  assert.equal(matches[0]?.tier, "exact");
});

test("matchAll falls back to substring only when nothing better exists", () => {
  const matches = matchAll(["אבקת חלב", "שוקו חלב"], "חלב");
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.tier, "substring");
});

test("matchAll reports every hit within the winning tier", () => {
  const matches = matchAll(["חלב סויה", "חלב שקדים", "אבקת חלב"], "חלב");
  // Both prefix hits are returned; the substring hit is outranked and excluded.
  assert.deepEqual(
    matches.map(match => match.index),
    [0, 1]
  );
  assert.equal(matches[0]?.tier, "prefix");
});

test("matchAll prefers a prefix hit over a mid-string one", () => {
  const matches = matchAll(["שמן זית", "קרם שמן"], "שמן");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.index, 0);
  assert.equal(matches[0]?.tier, "prefix");
});

test("matchAll returns nothing for an empty query", () => {
  assert.deepEqual(matchAll(["חלב"], "   "), []);
});

test("progressOf counts only rows that carry a name", () => {
  const payload = normalizePayload({
    name: "x",
    departments: [
      {
        title: "t",
        items: [
          { name: "חלב", checked: true },
          { name: "ביצים", checked: false },
          { name: "", checked: false, blank: true }
        ]
      }
    ]
  });
  assert.deepEqual(progressOf(payload), { done: 1, total: 2, percent: 50 });
});

test("progressOf reports 0% for an empty list rather than dividing by zero", () => {
  assert.deepEqual(progressOf(normalizePayload(null)), { done: 0, total: 0, percent: 0 });
});
