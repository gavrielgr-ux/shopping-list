import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { categoriesOf, LIST_PATH, seedList, startHarness } from "./harness.js";

/**
 * The state file is process-wide, so this lives in its own file: `node --test` gives each file
 * a separate process, and the broken directory has to be in place before the modules load.
 */
test("an unwritable state file does not turn a committed write into a reported failure", async () => {
  // A path whose parent is a regular file: mkdir fails with ENOTDIR.
  const parent = mkdtempSync(join(tmpdir(), "shopping-list-mcp-broken-"));
  const blocker = join(parent, "not-a-directory");
  writeFileSync(blocker, "");
  const harness = await startHarness({
    data: { [LIST_PATH]: seedList() },
    stateDir: join(blocker, "state")
  });
  try {
    // Sign-in persists a refresh token and every mutation records the list, both of which now
    // fail. Neither may surface as a tool error, because the database write did commit: a
    // reported failure invites a retry of an edit that is not idempotent.
    const result = await harness.data<{ progress: { done: number } }>("shopping_set_checked", {
      items: ["חלב"]
    });
    assert.equal(result.progress.done, 2);
    assert.equal(categoriesOf(harness.stored())[1]?.items[0]?.checked, true);

    // And it keeps working, rather than failing once the first warning is out.
    await harness.text("shopping_add_items", { items: [{ name: "לחם" }], category: "חלב וביצים" });
    assert.ok(
      categoriesOf(harness.stored())[1]
        ?.items.some(item => item.name === "לחם")
    );
  } finally {
    await harness.close();
  }
});
