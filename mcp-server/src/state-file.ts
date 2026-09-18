import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./constants.js";
import type { StateBackend } from "./state.js";

/**
 * Filesystem state backend for the Node build.
 *
 * This is the only module that imports `node:fs`, so a bundle for a runtime without a
 * filesystem simply never imports it.
 */
export const stateFilePath = join(STATE_DIR, "state.json");

export const fileBackend: StateBackend = {
  async read() {
    try {
      return await readFile(stateFilePath, "utf8");
    } catch {
      return null;
    }
  },
  async write(text) {
    await mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 });
    // Write to a sibling then rename, so a crash mid-write cannot truncate the saved token.
    const temporary = `${stateFilePath}.${process.pid}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, stateFilePath);
  },
  describe() {
    return stateFilePath;
  }
};
