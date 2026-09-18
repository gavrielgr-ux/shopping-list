import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DATABASE_URL, DEFAULT_LIST_ID, SITE_URL } from "./constants.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerItemTools } from "./tools/items.js";
import { registerListTools } from "./tools/lists.js";

export const SERVER_NAME = "shopping-list-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Build a fully wired server. Shared by the stdio entry point and the tests. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: `Read and edit the shared shopping list behind ${SITE_URL}.

The site is a static page backed by a Firebase Realtime Database, and these tools write to that same database (${DATABASE_URL}). Any browser tab that has the list open is subscribed to it and re-renders within moments of a write — there is nothing to refresh or deploy.

Working notes:
  - The list and its categories are in Hebrew and the page is right-to-left. Keep item names in Hebrew unless the user writes in another language, and put quantities in the item's "note" rather than in its name.
  - "Categories" are the aisle groupings the stored data calls "departments".
  - Every tool defaults to list "${DEFAULT_LIST_ID}", the list the site opens by default, so a single-list conversation never needs an id. Other lists are addressed by the ?list= value in their URL.
  - Batch work into one call: shopping_add_items, shopping_set_checked and shopping_remove_items all take arrays.
  - Item and category names are matched loosely (case, Hebrew niqqud, prefix and substring), so "חלב" finds "חלב 3%". When a name matches several rows the tool says so and skips it instead of guessing.
  - Call shopping_get_list first when you need indices, or to check what is actually there before editing.
  - shopping_delete_list, shopping_remove_category and shopping_clear_checked with mode='remove' destroy data and require confirm=true. Ask the user before calling them.`
    }
  );

  registerListTools(server);
  registerCategoryTools(server);
  registerItemTools(server);
  return server;
}
