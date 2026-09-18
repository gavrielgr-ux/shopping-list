import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LIST_PATH, seedList, startHarness } from "./harness.js";

/**
 * Authentication is process-wide state, so these assertions live in their own file:
 * `node --test` runs each test file in a separate process, giving this one a clean module
 * registry and therefore an empty token cache.
 */
test("the anonymous identity is minted once, cached, and reused after a restart", async () => {
  const harness = await startHarness({ data: { [LIST_PATH]: seedList() } });
  try {
    await harness.text("shopping_get_list");
    const signUps = () => harness.rtdb.requests.filter(entry => entry.url.includes("identitytoolkit"));
    const refreshes = () => harness.rtdb.requests.filter(entry => entry.url.includes("securetoken"));

    assert.equal(signUps().length, 1, "the first call signs in anonymously, as the web page does");

    // Further calls must reuse the cached token rather than creating another anonymous user.
    await harness.text("shopping_get_list");
    await harness.text("shopping_set_checked", { items: ["חלב"] });
    assert.equal(signUps().length, 1, "the token must be cached across tool calls");
    assert.equal(refreshes().length, 0);

    // The refresh token is persisted so a restart resumes the same identity.
    const state = JSON.parse(
      await readFile(`${process.env.SHOPPING_LIST_STATE_DIR}/state.json`, "utf8")
    ) as { refreshToken?: string; lists?: { id: string }[] };
    assert.ok(state.refreshToken, "the refresh token must be saved for the next run");
    assert.ok(state.lists?.length, "lists touched by the server must be registered locally");

    // Simulate a restart: the in-memory cache is gone but the saved token is not, so the next
    // call must refresh rather than mint a second anonymous user.
    const { invalidateToken } = await import("../src/auth.js");
    invalidateToken();
    await harness.text("shopping_get_list");
    assert.equal(signUps().length, 1, "a restart must not create another anonymous user");
    assert.equal(refreshes().length, 1, "the saved refresh token must be used");
  } finally {
    await harness.close();
  }
});
