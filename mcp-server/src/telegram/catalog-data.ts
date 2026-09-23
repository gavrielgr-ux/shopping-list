/**
 * Placeholder for the generated tool declarations.
 *
 * `npm run build` compiles this to `catalog-data.js` and then `build-catalog.js` overwrites that
 * file with the real declarations, generated from the MCP server. Nothing is committed, so the
 * declarations cannot go stale; when the build step is skipped, this stays null and `tools.ts`
 * computes them at runtime instead.
 */
import type { ToolDeclaration } from "./catalog.js";

export const BUILT_CATALOG: ToolDeclaration[] | null = null;
