import assert from "node:assert/strict";
import test from "node:test";
import { categoriesOf, itemNames, LIST_ID, LIST_PATH, seedList, startHarness } from "./harness.js";

test("every tool is advertised with a description and annotations", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const { tools } = await harness.client.listTools();
    const names = tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      "shopping_add_category",
      "shopping_add_items",
      "shopping_clear_checked",
      "shopping_create_list",
      "shopping_delete_list",
      "shopping_get_list",
      "shopping_list_lists",
      "shopping_move_category",
      "shopping_move_item",
      "shopping_remove_category",
      "shopping_remove_items",
      "shopping_rename_list",
      "shopping_set_checked",
      "shopping_share_list",
      "shopping_update_category",
      "shopping_update_item"
    ]);
    for (const tool of tools) {
      assert.ok((tool.description ?? "").length > 80, `${tool.name} needs a real description`);
      assert.ok(tool.annotations, `${tool.name} needs annotations`);
    }
    // The tools that destroy data must declare it.
    const destructive = tools.filter(tool => tool.annotations?.destructiveHint).map(tool => tool.name);
    assert.deepEqual(destructive.sort(), [
      "shopping_clear_checked",
      "shopping_delete_list",
      "shopping_remove_category",
      "shopping_remove_items"
    ]);
    // Reading tools must not be marked as writers.
    for (const name of ["shopping_get_list", "shopping_list_lists"]) {
      assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
    }
  } finally {
    await harness.close();
  }
});

test("get_list renders categories, notes and tick marks with usable indices", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const text = await harness.text("shopping_get_list");
    assert.match(text, /רשימת קניות/);
    assert.match(text, /\[0\] פירות וירקות — _תחילת הסיבוב_/);
    assert.match(text, /- \[x\] \[1\] תפוח עץ/);
    assert.match(text, /- \[ \] \[2\] חמאה — 2 יחידות/);
    // The placeholder row the page keeps for typing must not be shown.
    assert.doesNotMatch(text, /\[ \] \[2\] $/m);
    assert.match(text, /progress: 1 \/ 5 checked \(20%\)/);
    assert.match(text, new RegExp(`\\?list=${LIST_ID}`));
  } finally {
    await harness.close();
  }
});

test("get_list json output matches the declared output schema", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    // The client validates structuredContent against the tool's outputSchema, so a mismatch
    // would make this call throw rather than return.
    const view = await harness.data<{
      id: string;
      progress: { done: number; total: number; percent: number };
      categories: { index: number; title: string; items: { index: number; name: string }[] }[];
    }>("shopping_get_list", { response_format: "json" });
    assert.equal(view.id, LIST_ID);
    assert.deepEqual(view.progress, { done: 1, total: 5, percent: 20 });
    assert.equal(view.categories.length, 2);
    // Indices survive the removal of the placeholder row.
    assert.deepEqual(
      view.categories[0]?.items.map(item => item.index),
      [0, 1]
    );
  } finally {
    await harness.close();
  }
});

test("get_list pending_only hides what is already bought", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const text = await harness.text("shopping_get_list", { pending_only: true });
    assert.doesNotMatch(text, /תפוח עץ/);
    assert.match(text, /גזר/);
  } finally {
    await harness.close();
  }
});

test("get_list can be limited to one category by name", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const text = await harness.text("shopping_get_list", { category: "חלב" });
    assert.match(text, /חלב וביצים/);
    assert.doesNotMatch(text, /גזר/);
  } finally {
    await harness.close();
  }
});

test("get_list on a missing list points at create_list", async () => {
  const harness = await startHarness();
  try {
    const message = await harness.error("shopping_get_list");
    assert.match(message, /No list exists/);
    assert.match(message, /shopping_create_list/);
  } finally {
    await harness.close();
  }
});

test("get_list on a deleted list explains it is gone", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: { deleted: true, deletedAt: 1_700_000_000_000 } }
  });
  try {
    const message = await harness.error("shopping_get_list");
    assert.match(message, /was deleted/);
  } finally {
    await harness.close();
  }
});

test("get_list normalizes the numeric-key map the database returns for sparse arrays", async () => {
  const harness = await startHarness({
    data: {
      [LIST_PATH]: {
        name: "רשימה",
        updatedAt: 1,
        // A middle category removed elsewhere leaves non-contiguous keys, which Firebase
        // serves as an object rather than an array.
        departments: {
          "2": { title: "ב", hint: "", items: { "1": { name: "שני" }, "0": { name: "ראשון" } } },
          "0": { title: "א", hint: "", items: [{ name: "פריט" }] }
        }
      }
    }
  });
  try {
    const view = await harness.data<{ categories: { title: string; items: { name: string }[] }[] }>(
      "shopping_get_list",
      { response_format: "json" }
    );
    assert.deepEqual(
      view.categories.map(category => category.title),
      ["א", "ב"]
    );
    assert.deepEqual(
      view.categories[1]?.items.map(item => item.name),
      ["ראשון", "שני"]
    );
  } finally {
    await harness.close();
  }
});

test("add_items batches across categories and creates a missing one", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ changed: string[]; progress: { total: number } }>("shopping_add_items", {
      items: [
        { name: "לחם", note: "פרוס" },
        { name: "עוף", category: "בשר ועוף" }
      ],
      category: "מזווה ורטבים"
    });
    assert.ok(result.changed.some(line => line.includes('created category "מזווה ורטבים"')));
    assert.ok(result.changed.some(line => line.includes('created category "בשר ועוף"')));
    assert.equal(result.progress.total, 7);

    const stored = harness.stored();
    const titles = categoriesOf(stored).map(category => category.title);
    assert.deepEqual(titles, ["פירות וירקות", "חלב וביצים", "מזווה ורטבים", "בשר ועוף"]);
    assert.deepEqual(itemNames(stored, 2), ["לחם"]);
    const bread = categoriesOf(stored)[2]?.items[0];
    assert.equal(bread?.note, "פרוס");
    // Rows written here are real content, not the page's typing placeholder.
    assert.equal(bread?.blank, false);
  } finally {
    await harness.close();
  }
});

test("add_items appends before the placeholder row rather than after it", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_add_items", { items: [{ name: "בננה" }], category: "פירות וירקות" });
    // The seeded produce category ends with a blank placeholder; the new row must precede it.
    assert.deepEqual(itemNames(harness.stored(), 0), ["גזר", "תפוח עץ", "בננה"]);
  } finally {
    await harness.close();
  }
});

test("add_items refuses an unknown category when create_category is false", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_add_items", {
      items: [{ name: "קרח" }],
      category: "קפואים",
      create_category: false
    });
    assert.match(message, /No category matches/);
    assert.match(message, /פירות וירקות/);
  } finally {
    await harness.close();
  }
});

test("add_items does not duplicate an existing row, and can update its note instead", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const skipped = await harness.data<{ changed: string[] }>("shopping_add_items", {
      items: [{ name: "חלב", note: "3 בקבוקים" }],
      category: "חלב וביצים"
    });
    assert.ok(skipped.changed.some(line => line.includes("left as it was")));
    assert.equal(categoriesOf(harness.stored())[1]?.items[0]?.note, "");
    assert.deepEqual(itemNames(harness.stored(), 1), ["חלב", "ביצים", "חמאה"]);

    const updated = await harness.data<{ changed: string[] }>("shopping_add_items", {
      items: [{ name: "חלב", note: "3 בקבוקים" }],
      category: "חלב וביצים",
      on_duplicate: "update_note"
    });
    assert.ok(updated.changed.some(line => line.includes("note updated")));
    assert.equal(categoriesOf(harness.stored())[1]?.items[0]?.note, "3 בקבוקים");
  } finally {
    await harness.close();
  }
});

test("set_checked ticks items off by loose name match across the whole list", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ changed: string[]; progress: { done: number } }>("shopping_set_checked", {
      // Niqqud and a partial name still resolve, and no category is supplied.
      items: ["חָלָב", "גזר"]
    });
    assert.equal(result.progress.done, 3);
    assert.ok(result.changed.every(line => !line.includes("no matching row")));
    assert.equal(categoriesOf(harness.stored())[1]?.items[0]?.checked, true);
    assert.equal(categoriesOf(harness.stored())[0]?.items[0]?.checked, true);
  } finally {
    await harness.close();
  }
});

test("set_checked skips an ambiguous name and says why, without touching the rest", async () => {
  const harness = await startHarness({
    data: {
      [LIST_PATH]: {
        name: "רשימה",
        updatedAt: 1,
        departments: [
          {
            title: "מזווה",
            hint: "",
            items: [
              { name: "שמן קנולה", note: "", checked: false, blank: false },
              { name: "שמן זית", note: "", checked: false, blank: false },
              { name: "אורז", note: "", checked: false, blank: false }
            ]
          }
        ]
      }
    }
  });
  try {
    const result = await harness.data<{ changed: string[]; progress: { done: number } }>("shopping_set_checked", {
      items: ["שמן", "אורז"]
    });
    assert.ok(result.changed.some(line => line.includes("matches 2 rows")));
    // The unambiguous name is still applied.
    assert.equal(result.progress.done, 1);
    assert.equal(categoriesOf(harness.stored())[0]?.items[2]?.checked, true);
    assert.equal(categoriesOf(harness.stored())[0]?.items[0]?.checked, false);
  } finally {
    await harness.close();
  }
});

test("set_checked reports a name that matches nothing", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ changed: string[] }>("shopping_set_checked", { items: ["קוויאר"] });
    assert.ok(result.changed.some(line => line.includes("no matching row")));
  } finally {
    await harness.close();
  }
});

test("set_checked all=false resets the whole list, like the page's reset button", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ progress: { done: number } }>("shopping_set_checked", {
      all: true,
      checked: false
    });
    assert.equal(result.progress.done, 0);
  } finally {
    await harness.close();
  }
});

test("set_checked all can be scoped to one category", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ progress: { done: number } }>("shopping_set_checked", {
      all: true,
      category: "חלב וביצים"
    });
    // The three dairy rows plus the apple that was already ticked.
    assert.equal(result.progress.done, 4);
    assert.equal(categoriesOf(harness.stored())[0]?.items[0]?.checked, false);
  } finally {
    await harness.close();
  }
});

test("set_checked needs either names or all=true", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_set_checked", {});
    assert.match(message, /Nothing to do/);
  } finally {
    await harness.close();
  }
});

test("update_item changes a name, a note and a tick in one call", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_update_item", {
      item: "חמאה",
      new_name: "חמאה ללא לקטוז",
      new_note: "1 יחידה",
      checked: true
    });
    const row = categoriesOf(harness.stored())[1]?.items[2];
    assert.equal(row?.name, "חמאה ללא לקטוז");
    assert.equal(row?.note, "1 יחידה");
    assert.equal(row?.checked, true);
  } finally {
    await harness.close();
  }
});

test("update_item requires at least one new value", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_update_item", { item: "חלב" });
    assert.match(message, /Nothing to change/);
  } finally {
    await harness.close();
  }
});

test("update_item refuses to guess between several matches", async () => {
  const harness = await startHarness({
    data: {
      [LIST_PATH]: {
        name: "רשימה",
        updatedAt: 1,
        departments: [
          {
            title: "מזווה",
            hint: "",
            items: [
              { name: "שמן קנולה", note: "", checked: false, blank: false },
              { name: "שמן זית", note: "", checked: false, blank: false }
            ]
          }
        ]
      }
    }
  });
  try {
    const message = await harness.error("shopping_update_item", { item: "שמן", new_note: "1" });
    assert.match(message, /matches 2 items/);
    assert.match(message, /שמן זית/);
  } finally {
    await harness.close();
  }
});

test("remove_items deletes rows and keeps a placeholder behind", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ changed: string[] }>("shopping_remove_items", {
      items: ["ביצים", "לא קיים"]
    });
    assert.ok(result.changed.some(line => line.includes('removed "ביצים"')));
    assert.ok(result.changed.some(line => line.includes("no matching row")));
    assert.deepEqual(itemNames(harness.stored(), 1), ["חלב", "חמאה"]);
  } finally {
    await harness.close();
  }
});

test("move_item moves a row between categories", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_move_item", { item: "חמאה", to_category: "פירות וירקות", to_index: 0 });
    assert.deepEqual(itemNames(harness.stored(), 0), ["חמאה", "גזר", "תפוח עץ"]);
    assert.deepEqual(itemNames(harness.stored(), 1), ["חלב", "ביצים"]);
  } finally {
    await harness.close();
  }
});

test("move_item reorders within a category when only to_index is given", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_move_item", { item: "חמאה", to_index: 0 });
    assert.deepEqual(itemNames(harness.stored(), 1), ["חמאה", "חלב", "ביצים"]);
  } finally {
    await harness.close();
  }
});

test("move_item needs a destination", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_move_item", { item: "חלב" });
    assert.match(message, /Nothing to do/);
  } finally {
    await harness.close();
  }
});

test("add_category inserts at a position and will not duplicate a name", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_add_category", {
      title: "קפואים",
      hint: "בסוף",
      position: 0,
      items: [{ name: "אפונה קפואה" }]
    });
    assert.deepEqual(
      categoriesOf(harness.stored()).map(category => category.title),
      ["קפואים", "פירות וירקות", "חלב וביצים"]
    );
    assert.deepEqual(itemNames(harness.stored(), 0), ["אפונה קפואה"]);

    const message = await harness.error("shopping_add_category", { title: "קפואים" });
    assert.match(message, /already exists/);
  } finally {
    await harness.close();
  }
});

test("add_category to an empty list leaves a row the page can type into", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: { name: "ריקה", updatedAt: 1, departments: [] } }
  });
  try {
    await harness.text("shopping_add_category", { title: "חדש" });
    // app.js gives an item-less category one blank row; matching that keeps it editable.
    assert.deepEqual(categoriesOf(harness.stored())[0]?.items, [
      { name: "", note: "", checked: false, blank: true }
    ]);
  } finally {
    await harness.close();
  }
});

test("update_category renames and re-hints", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_update_category", {
      category_index: 1,
      new_title: "מחלבה",
      new_hint: "מקרר אחורי"
    });
    const category = categoriesOf(harness.stored())[1];
    assert.equal(category?.title, "מחלבה");
    assert.equal(category?.hint, "מקרר אחורי");
    // Items are untouched by a rename.
    assert.deepEqual(itemNames(harness.stored(), 1), ["חלב", "ביצים", "חמאה"]);
  } finally {
    await harness.close();
  }
});

test("update_category reports an unknown name with the available ones", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_update_category", { category: "קפואים", new_title: "x" });
    assert.match(message, /No category matches/);
    assert.match(message, /1: חלב וביצים/);
  } finally {
    await harness.close();
  }
});

test("remove_category guards a non-empty category behind confirm", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_remove_category", { category: "חלב וביצים" });
    assert.match(message, /still holds 3 item\(s\)/);
    assert.match(message, /confirm=true/);
    assert.equal(categoriesOf(harness.stored()).length, 2);

    await harness.text("shopping_remove_category", { category: "חלב וביצים", confirm: true });
    assert.deepEqual(
      categoriesOf(harness.stored()).map(category => category.title),
      ["פירות וירקות"]
    );
  } finally {
    await harness.close();
  }
});

test("remove_category drops an empty category without confirm", async () => {
  const harness = await startHarness({
    data: {
      [LIST_PATH]: {
        name: "רשימה",
        updatedAt: 1,
        departments: [{ title: "ריק", hint: "", items: [{ name: "", note: "", checked: false, blank: true }] }]
      }
    }
  });
  try {
    await harness.text("shopping_remove_category", { category: "ריק" });
    assert.equal(categoriesOf(harness.stored()).length, 0);
  } finally {
    await harness.close();
  }
});

test("move_category reorders and clamps a too-large destination", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_move_category", { category: "חלב וביצים", to_index: 0 });
    assert.deepEqual(
      categoriesOf(harness.stored()).map(category => category.title),
      ["חלב וביצים", "פירות וירקות"]
    );
    await harness.text("shopping_move_category", { category_index: 0, to_index: 99 });
    assert.deepEqual(
      categoriesOf(harness.stored()).map(category => category.title),
      ["פירות וירקות", "חלב וביצים"]
    );
  } finally {
    await harness.close();
  }
});

test("clear_checked unticks by default and keeps the rows", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ changed: string[]; progress: { done: number; total: number } }>(
      "shopping_clear_checked",
      {}
    );
    assert.ok(result.changed[0]?.includes("cleared the tick mark on 1 row"));
    assert.deepEqual(result.progress, { done: 0, total: 5, percent: 0 });
    // Unticking keeps every row, including the page's trailing typing placeholder.
    assert.deepEqual(itemNames(harness.stored(), 0), ["גזר", "תפוח עץ", ""]);
  } finally {
    await harness.close();
  }
});

test("clear_checked mode=remove needs confirm, then deletes the bought rows", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_clear_checked", { mode: "remove" });
    assert.match(message, /would delete 1 ticked row/);
    assert.match(message, /mode='untick'/);

    await harness.text("shopping_clear_checked", { mode: "remove", confirm: true });
    // The ticked row is gone; the typing placeholder is left in place.
    assert.deepEqual(itemNames(harness.stored(), 0), ["גזר", ""]);
  } finally {
    await harness.close();
  }
});

test("clear_checked says so when nothing was ticked", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_set_checked", { all: true, checked: false });
    const result = await harness.data<{ changed: string[] }>("shopping_clear_checked", {});
    assert.ok(result.changed[0]?.includes("nothing was ticked off"));
  } finally {
    await harness.close();
  }
});

test("create_list generates a list-<uuid> id and a working link", async () => {
  const harness = await startHarness();
  try {
    const view = await harness.data<{ id: string; url: string; categories: { title: string }[] }>(
      "shopping_create_list",
      { name: "קניות לשבת", response_format: "json" }
    );
    assert.match(view.id, /^list-[0-9a-f-]{36}$/);
    assert.equal(view.url, `https://gavrielgr-ux.github.io/shopping-list/?list=${view.id}`);
    assert.ok(view.categories.length > 0, "a starter set of categories is created by default");
    const stored = harness.stored(`shared-lists/${view.id}`);
    assert.equal(stored?.name, "קניות לשבת");
  } finally {
    await harness.close();
  }
});

test("create_list honours an explicit id, an empty category set, and refuses a clash", async () => {
  const harness = await startHarness();
  try {
    const view = await harness.data<{ id: string; categories: unknown[] }>("shopping_create_list", {
      list_id: "pesach-2026",
      name: "פסח",
      categories: [],
      response_format: "json"
    });
    assert.equal(view.id, "pesach-2026");
    assert.deepEqual(view.categories, []);

    const message = await harness.error("shopping_create_list", { list_id: "pesach-2026", name: "שוב" });
    assert.match(message, /already exists/);
  } finally {
    await harness.close();
  }
});

test("create_list rejects an id the web app could not open", async () => {
  const harness = await startHarness();
  try {
    const message = await harness.error("shopping_create_list", { list_id: "bad id!!" });
    assert.match(message, /not a usable list id/);
  } finally {
    await harness.close();
  }
});

test("rename_list changes the name the page shows", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ list_name: string }>("shopping_rename_list", { name: "קניות לפסח" });
    assert.equal(result.list_name, "קניות לפסח");
    assert.equal(harness.stored()?.name, "קניות לפסח");
  } finally {
    await harness.close();
  }
});

test("delete_list refuses without confirm and then writes the app's deletion marker", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const message = await harness.error("shopping_delete_list", { list_id: LIST_ID, confirm: false });
    assert.match(message, /refusing to delete/);
    assert.equal(harness.stored()?.name, "רשימת קניות");

    const text = await harness.text("shopping_delete_list", { list_id: LIST_ID, confirm: true });
    assert.match(text, /Deleted/);
    // app.js reacts to {deleted:true} by clearing its local copy; a bare removal would let an
    // open tab write the list straight back.
    assert.equal(harness.stored()?.deleted, true);
    assert.equal(typeof harness.stored()?.deletedAt, "number");
  } finally {
    await harness.close();
  }
});

test("delete_list reports an already-deleted list", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: { deleted: true, deletedAt: 1 } } });
  try {
    const message = await harness.error("shopping_delete_list", { list_id: LIST_ID, confirm: true });
    assert.match(message, /already deleted/);
  } finally {
    await harness.close();
  }
});

test("list_lists falls back to the registry when the rules forbid enumeration", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, blockEnumeration: true });
  try {
    const result = await harness.data<{
      enumeration_allowed: boolean;
      lists: { id: string; name: string; is_default: boolean; reachable: boolean }[];
    }>("shopping_list_lists", { response_format: "json" });
    assert.equal(result.enumeration_allowed, false);
    const entry = result.lists.find(item => item.id === LIST_ID);
    assert.equal(entry?.is_default, true);
    assert.equal(entry?.reachable, true);
    assert.equal(entry?.name, "רשימת קניות");
  } finally {
    await harness.close();
  }
});

test("list_lists includes a list created earlier in the session", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() }, blockEnumeration: true });
  try {
    const created = await harness.data<{ id: string }>("shopping_create_list", {
      name: "רשימה שנייה",
      categories: [],
      response_format: "json"
    });
    const result = await harness.data<{ lists: { id: string; name: string }[] }>("shopping_list_lists", {
      response_format: "json"
    });
    assert.ok(
      result.lists.some(entry => entry.id === created.id && entry.name === "רשימה שנייה"),
      "a list created through this server must be remembered locally"
    );
  } finally {
    await harness.close();
  }
});

test("list_lists enumerates the database when the rules allow it", async () => {
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList(), "shared-lists/other-list-1": { name: "אחרת", departments: [] } }
  });
  try {
    const result = await harness.data<{ enumeration_allowed: boolean; lists: { id: string }[] }>(
      "shopping_list_lists",
      { response_format: "json" }
    );
    assert.equal(result.enumeration_allowed, true);
    assert.ok(result.lists.some(entry => entry.id === "other-list-1"));
  } finally {
    await harness.close();
  }
});

test("list_lists marks a list that cannot be read as unreachable instead of failing", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: { deleted: true, deletedAt: 1 } } });
  try {
    const result = await harness.data<{ lists: { id: string; reachable: boolean }[] }>("shopping_list_lists", {
      response_format: "json"
    });
    assert.equal(result.lists.find(entry => entry.id === LIST_ID)?.reachable, false);
  } finally {
    await harness.close();
  }
});

test("a list with no categories survives the database pruning empty values away", async () => {
  // Firebase deletes a key whose value is an empty array, so `departments: []` is written and
  // then read back as absent. The round trip must still produce a usable, editable list.
  const harness = await startHarness();
  try {
    const created = await harness.data<{ id: string }>("shopping_create_list", {
      name: "ריקה",
      categories: [],
      response_format: "json"
    });
    assert.equal(harness.stored(`shared-lists/${created.id}`)?.departments, undefined);

    const text = await harness.text("shopping_get_list", { list_id: created.id });
    assert.match(text, /No categories yet/);

    // And it can be filled in afterwards.
    await harness.text("shopping_add_items", {
      list_id: created.id,
      items: [{ name: "חלב" }],
      category: "חלב וביצים"
    });
    const view = await harness.data<{ categories: { title: string; items: { name: string }[] }[] }>(
      "shopping_get_list",
      { list_id: created.id, response_format: "json" }
    );
    assert.equal(view.categories[0]?.title, "חלב וביצים");
    assert.deepEqual(
      view.categories[0]?.items.map(item => item.name),
      ["חלב"]
    );
  } finally {
    await harness.close();
  }
});

test("share_list builds a pasteable message and confirms the link works", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{
      list_id: string;
      name: string;
      url: string;
      message: string;
      verified: boolean;
    }>("shopping_share_list", { response_format: "json" });

    assert.equal(result.verified, true);
    assert.equal(result.name, "רשימת קניות");
    assert.equal(result.url, `https://gavrielgr-ux.github.io/shopping-list/?list=${LIST_ID}`);
    // The default message is just the name and the link, which is what a DM wants.
    assert.equal(result.message, `רשימת קניות\nhttps://gavrielgr-ux.github.io/shopping-list/?list=${LIST_ID}`);
  } finally {
    await harness.close();
  }
});

test("share_list can append progress and what is left to buy", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ message: string }>("shopping_share_list", {
      include_progress: true,
      include_items: true,
      response_format: "json"
    });
    assert.match(result.message, /1 \/ 5 נקנו/);
    assert.match(result.message, /^פירות וירקות:$/m);
    assert.match(result.message, /^• גזר$/m);
    assert.match(result.message, /^• חמאה \(2 יחידות\)$/m);
    // Already-bought rows are left out, and so are placeholder rows.
    assert.doesNotMatch(result.message, /תפוח עץ/);
    assert.doesNotMatch(result.message, /^• $/m);
  } finally {
    await harness.close();
  }
});

test("share_list says so when nothing is left to buy", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_set_checked", { all: true });
    const result = await harness.data<{ message: string }>("shopping_share_list", {
      include_items: true,
      response_format: "json"
    });
    assert.match(result.message, /הרשימה הושלמה/);
  } finally {
    await harness.close();
  }
});

test("share_list refuses to hand out a link to a list that does not exist", async () => {
  const harness = await startHarness();
  try {
    // A link nobody can open is worse than no link, so this is an error rather than a URL.
    const message = await harness.error("shopping_share_list");
    assert.match(message, /No list exists/);
  } finally {
    await harness.close();
  }
});

test("share_list refuses to hand out a link to a deleted list", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: { deleted: true, deletedAt: 1 } } });
  try {
    const message = await harness.error("shopping_share_list");
    assert.match(message, /was deleted/);
  } finally {
    await harness.close();
  }
});

test("share_list with verify=false builds the URL without reading anything", async () => {
  const harness = await startHarness();
  try {
    const result = await harness.data<{ url: string; verified: boolean; name: string | null }>(
      "shopping_share_list",
      { list_id: "never-seen-list", verify: false, response_format: "json" }
    );
    assert.equal(result.verified, false);
    assert.equal(result.name, null);
    assert.equal(result.url, "https://gavrielgr-ux.github.io/shopping-list/?list=never-seen-list");
    // No database read was needed to produce it.
    assert.equal(
      harness.rtdb.requests.filter(entry => entry.url.includes("never-seen-list")).length,
      0
    );
  } finally {
    await harness.close();
  }
});

test("every reading tool's output validates in each of its modes", async () => {
  // Output schemas are only checked when a tool actually runs, so a mode nothing exercises can
  // ship with a schema that contradicts the code. That is exactly how shopping_list_lists came
  // to declare `reachable` non-nullable while returning null for an unread list.
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const calls: [string, Record<string, unknown>][] = [
      ["shopping_list_lists", { include_progress: true }],
      ["shopping_list_lists", { include_progress: false }],
      ["shopping_get_list", {}],
      ["shopping_get_list", { pending_only: true }],
      ["shopping_get_list", { category: "חלב" }],
      ["shopping_share_list", {}],
      ["shopping_share_list", { include_items: true, include_progress: true }],
      ["shopping_share_list", { list_id: "never-seen-list", verify: false }]
    ];
    for (const [name, args] of calls) {
      // data() throws if the call errored, which an output-validation failure does.
      await harness.data(name, { ...args, response_format: "json" });
    }
  } finally {
    await harness.close();
  }
});

test("list_lists reports reachable as null when it did not read the lists", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    const result = await harness.data<{ lists: { reachable: boolean | null }[] }>(
      "shopping_list_lists",
      { include_progress: false, response_format: "json" }
    );
    assert.ok(result.lists.length > 0);
    for (const entry of result.lists) {
      assert.equal(entry.reachable, null, "nothing was read, so it is unknown, not true");
    }
    // And the markdown must not call it unreachable, which would be a different claim.
    const text = await harness.text("shopping_list_lists", { include_progress: false });
    assert.match(text, /not checked/);
    assert.doesNotMatch(text, /\(unreachable\)/);
  } finally {
    await harness.close();
  }
});
