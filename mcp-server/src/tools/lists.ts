import { z } from "zod";
import { DEFAULT_LIST_ID, DEFAULT_LIST_NAME, LISTS_ROOT } from "../constants.js";
import { buildView, renderList, renderSummary, reply } from "../format.js";
import { normalizePayload, progressOf } from "../normalize.js";
import { NetworkBlocked, readNode, shallowKeys } from "../rtdb.js";
import { listIdField, listViewShape, mutationShape, responseFormatField } from "../schemas.js";
import { forgetList, knownLists, rememberList } from "../state.js";
import {
  assertListId,
  createList,
  deleteList,
  ensureTrailingBlank,
  loadList,
  mutateList,
  newListId,
  requireList,
  resolveCategory,
  urlForList
} from "../store.js";
import type { Category } from "../types.js";
import { guard, mutationResult, type Server } from "./helpers.js";

/** Categories given to a brand-new list when the caller supplies none. */
const starterCategories = (): Category[] =>
  [
    { title: "פירות וירקות", hint: "תחילת הסיבוב" },
    { title: "חלב וביצים", hint: "מקררים" },
    { title: "בשר ועוף", hint: "לפני הקופות" },
    { title: "מזווה ורטבים", hint: "מדפים יבשים" }
  ].map(entry => {
    const category: Category = { ...entry, items: [] };
    ensureTrailingBlank(category);
    return category;
  });

export function registerListTools(server: Server): void {
  server.registerTool(
    "shopping_list_lists",
    {
      title: "List shopping lists",
      description: `Show the shopping lists this server can reach, with their ids and links.

Sources, merged and de-duplicated:
  - the local registry of every list this server has previously read or written
  - the site's default list, always included
  - a direct enumeration of the database, which only works if the security rules allow reading the "${LISTS_ROOT}" root; when they do not, it is skipped silently

A list created in a browser and never touched through this server will not appear, because the web app keeps its "recent lists" only in the browser's localStorage and the database holds no index. Pass its id (the ?list= value from its URL) to any tool directly.

Args:
  - include_progress (boolean): also read each list to report its name and progress. Costs one read per list (default: true)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns JSON with schema:
  {
    "count": number,
    "lists": [ { "id": string, "name": string, "url": string, "progress": { "done": number, "total": number, "percent": number } | null, "reachable": boolean, "is_default": boolean } ],
    "enumeration_allowed": boolean
  }

Examples:
  - Use when: "which shopping lists do I have?"
  - Use when: you need a list id before calling another tool
  - Don't use when: you already know the id — call shopping_get_list directly`,
      inputSchema: {
        include_progress: z
          .boolean()
          .default(true)
          .describe("Read each list to report its current name and progress."),
        response_format: responseFormatField
      },
      outputSchema: {
        count: z.number().int().describe("Number of lists reported."),
        lists: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              url: z.string(),
              progress: z
                .object({
                  done: z.number().int(),
                  total: z.number().int(),
                  percent: z.number().int()
                })
                .nullable(),
              reachable: z.boolean().describe("False when the list is missing, deleted or unreadable."),
              is_default: z.boolean().describe("True for the list the site opens by default.")
            })
          )
          .describe("Known lists, default first."),
        enumeration_allowed: z
          .boolean()
          .describe("Whether the database allowed listing the lists root directly.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ include_progress, response_format }) => {
      const registry = await knownLists();
      // A NetworkBlocked here is deliberately not caught: reporting a total egress block as
      // "the rules do not allow enumeration" would send the reader to the wrong place.
      const discovered = await shallowKeys(LISTS_ROOT);
      const ids = new Set<string>([DEFAULT_LIST_ID, ...registry.map(entry => entry.id), ...(discovered ?? [])]);

      const lists = await Promise.all(
        [...ids].map(async id => {
          const fallbackName = registry.find(entry => entry.id === id)?.name ?? DEFAULT_LIST_NAME;
          const base = {
            id,
            url: urlForList(id),
            is_default: id === DEFAULT_LIST_ID
          };
          if (!include_progress) {
            // Nothing was read, so whether the list exists is genuinely unknown.
            return { ...base, name: fallbackName, progress: null, reachable: null };
          }
          try {
            const loaded = await loadList(id);
            if (loaded.missing) return { ...base, name: fallbackName, progress: null, reachable: false };
            return {
              ...base,
              name: loaded.payload.name,
              progress: progressOf(loaded.payload),
              reachable: true
            };
          } catch (error) {
            // A network block affects every list and is not something to report per row: let it
            // escape so the tool reports the real cause once.
            if (error instanceof NetworkBlocked) throw error;
            // A deleted or rule-blocked list is reported as unreachable rather than failing the call.
            return { ...base, name: fallbackName, progress: null, reachable: false };
          }
        })
      );

      lists.sort((left, right) => {
        if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
        return left.name.localeCompare(right.name, "he");
      });

      const output = { count: lists.length, lists, enumeration_allowed: discovered !== null };
      const lines = ["# Shopping lists", ""];
      for (const entry of lists) {
        const flags = [entry.is_default ? "default" : null, entry.reachable ? null : "unreachable"]
          .filter(Boolean)
          .join(", ");
        lines.push(`## ${entry.name}${flags ? ` (${flags})` : ""}`);
        lines.push(`- id: \`${entry.id}\``);
        lines.push(`- link: ${entry.url}`);
        if (entry.progress) lines.push(`- progress: ${entry.progress.done} / ${entry.progress.total}`);
        lines.push("");
      }
      if (discovered === null) {
        lines.push(
          "_The database did not allow enumerating all lists, so this shows the default list plus any list this server has touched. Lists created in a browser and never edited here must be named by id._"
        );
      }
      return reply(response_format, lines.join("\n").trimEnd(), output);
    })
  );

  server.registerTool(
    "shopping_get_list",
    {
      title: "Read a shopping list",
      description: `Read a shopping list: its categories, rows, notes, tick marks and progress.

The "[2]" shown before a category is its category_index, accepted by the category tools. The "[5]" shown before a row is its position within that category, for reference only: the item tools select rows by name, not by index. Placeholder rows the web page keeps for typing into are omitted.

Args:
  - list_id (string): list to read (default: the site's default list)
  - pending_only (boolean): omit rows already ticked off (default: false)
  - category (string): only this category, matched by name
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns JSON with schema:
  {
    "id": string, "name": string, "url": string, "updated_at": string | null,
    "progress": { "done": number, "total": number, "percent": number },
    "categories": [ { "index": number, "title": string, "hint": string,
                      "items": [ { "index": number, "name": string, "note": string, "checked": boolean } ] } ]
  }

Examples:
  - Use when: "what's on the shopping list?"
  - Use when: "what's left to buy?" -> pending_only=true
  - Use when: you need an index before editing a specific row

Error handling:
  - Returns an error naming shopping_create_list if the list does not exist
  - Returns an error if the list was deleted`,
      inputSchema: {
        list_id: listIdField,
        pending_only: z.boolean().default(false).describe("Omit rows that are already ticked off."),
        category: z
          .string()
          .trim()
          .optional()
          .describe("Limit output to the category matching this name."),
        response_format: responseFormatField
      },
      outputSchema: listViewShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, pending_only, category, response_format }) => {
      const loaded = await requireList(list_id);
      await rememberList(loaded.id, loaded.payload.name);
      const categoryIndices = category
        ? [resolveCategory(loaded.payload, { category })]
        : undefined;
      const view = buildView(loaded.id, loaded.payload, { pendingOnly: pending_only, categoryIndices });
      return reply(
        response_format,
        renderList(view, { pendingOnly: pending_only }),
        view as unknown as Record<string, unknown>,
        "Use pending_only=true or the category argument to narrow the output."
      );
    })
  );

  server.registerTool(
    "shopping_share_list",
    {
      title: "Get a shareable link to a list",
      description: `Produce the link that opens a list, plus a ready-to-send message for a DM.

This is the equivalent of the share button on the page: the link carries the list's ?list= id, so
whoever opens it sees the same live list and their edits sync back. Anyone with the link can
edit, so treat it as an invitation rather than a read-only view.

The link is confirmed to open something before it is handed back, so a dead or deleted id is
reported rather than sent. Pass verify=false to skip that read and just build the URL.

Args:
  - list_id (string): list to link to (default: the site's default list)
  - include_items (boolean): append what is still left to buy, grouped by category (default: false)
  - include_progress (boolean): append a "33 / 47 bought" line (default: false)
  - verify (boolean): read the list first to confirm the link works (default: true)

Returns JSON with schema:
  {
    "list_id": string,       // the id in the link
    "name": string,          // list name, or null when unverified
    "url": string,           // the shareable link
    "message": string,       // the whole thing, ready to paste into a DM
    "verified": boolean      // whether the list was confirmed to exist
  }

Examples:
  - Use when: "send me a link to the shopping list" -> the message is what you paste
  - Use when: "share the list with what's left on it" -> include_items=true
  - Don't use when: you want to read the list yourself — use shopping_get_list

Error handling:
  - Returns an error if the list does not exist or was deleted, so a dead link is never sent`,
      inputSchema: {
        list_id: listIdField,
        include_items: z
          .boolean()
          .default(false)
          .describe("Append the items still to buy, grouped by category."),
        include_progress: z.boolean().default(false).describe("Append a progress line."),
        verify: z
          .boolean()
          .default(true)
          .describe("Read the list first to confirm the link opens something."),
        response_format: responseFormatField
      },
      outputSchema: {
        list_id: z.string().describe("The id carried in the link."),
        name: z.string().nullable().describe("List name, or null when verify=false."),
        url: z.string().describe("The shareable link."),
        message: z.string().describe("The link with its context, ready to paste into a DM."),
        verified: z.boolean().describe("Whether the list was confirmed to exist.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, include_items, include_progress, verify, response_format }) => {
      const id = assertListId(list_id);
      const url = urlForList(id);

      if (!verify) {
        const output = { list_id: id, name: null, url, message: url, verified: false };
        return reply(
          response_format,
          [`Link to \`${id}\` (not verified, so it may not open anything):`, "", url].join("\n"),
          output
        );
      }

      // requireList throws a described error for a missing or deleted list, which is the point:
      // a link nobody can open is worse than no link.
      const loaded = await requireList(id);
      await rememberList(id, loaded.payload.name);
      const progress = progressOf(loaded.payload);

      const lines = [loaded.payload.name, url];
      if (include_progress) {
        lines.push("", `${progress.done} / ${progress.total} נקנו`);
      }
      if (include_items) {
        const pending = loaded.payload.departments
          .map(category => ({
            title: category.title,
            items: category.items.filter(item => item.name.trim() && !item.checked)
          }))
          .filter(entry => entry.items.length);
        lines.push("");
        if (!pending.length) {
          lines.push("הרשימה הושלמה, לא נשאר מה לקנות.");
        } else {
          for (const entry of pending) {
            lines.push(`${entry.title}:`);
            for (const item of entry.items) {
              lines.push(`• ${item.name}${item.note ? ` (${item.note})` : ""}`);
            }
          }
        }
      }
      const message = lines.join("\n").trim();

      const output = { list_id: id, name: loaded.payload.name, url, message, verified: true };
      return reply(
        response_format,
        [
          `Shareable link to **${loaded.payload.name}**, ready to send:`,
          "",
          "```",
          message,
          "```",
          "",
          "_Anyone who opens it can edit the list, and their changes sync back._"
        ].join("\n"),
        output
      );
    })
  );

  server.registerTool(
    "shopping_create_list",
    {
      title: "Create a shopping list",
      description: `Create a new shopping list and return the link that opens it.

The id is generated in the same "list-<uuid>" form the web app uses unless one is supplied. Opening the returned link in a browser shows the list immediately.

Args:
  - name (string): list name, e.g. 'קניות לשבת' (default: 'רשימת קניות')
  - categories (array): category names to start with, optionally with an aisle hint. Omit for a small Hebrew starter set; pass [] for an empty list
  - list_id (string): use this exact id instead of a generated one

Returns the created list, same schema as shopping_get_list.

Examples:
  - Use when: "start a new list for the weekend shop"
  - Use when: "make a list with categories for produce and dairy"
  - Don't use when: adding to an existing list — use shopping_add_items

Error handling:
  - Returns an error if a list already exists at the given list_id`,
      inputSchema: {
        name: z.string().trim().max(200).default(DEFAULT_LIST_NAME).describe("Name for the new list."),
        categories: z
          .array(
            z.object({
              title: z.string().trim().min(1).describe("Category name."),
              hint: z.string().trim().default("").describe("Optional aisle hint, e.g. 'מקררים'.")
            })
          )
          .optional()
          .describe("Categories to create. Omit for a Hebrew starter set; pass [] for none."),
        list_id: z
          .string()
          .trim()
          .min(6)
          .max(90)
          .optional()
          .describe("Use this exact id instead of generating one."),
        response_format: responseFormatField
      },
      outputSchema: listViewShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ name, categories, list_id, response_format }) => {
      const id = list_id ? assertListId(list_id) : newListId();
      const prepared: Category[] = categories
        ? categories.map(entry => {
            const category: Category = { title: entry.title, hint: entry.hint, items: [] };
            ensureTrailingBlank(category);
            return category;
          })
        : starterCategories();
      const payload = await createList(id, name, prepared);
      const view = buildView(id, payload);
      return reply(
        response_format,
        [`Created **${payload.name}**.`, "", renderList(view)].join("\n"),
        view as unknown as Record<string, unknown>
      );
    })
  );

  server.registerTool(
    "shopping_rename_list",
    {
      title: "Rename a shopping list",
      description: `Rename an existing shopping list. The page title and any open tab update immediately.

Args:
  - list_id (string): list to rename (default: the site's default list)
  - name (string): new name

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "rename the list to קניות לפסח"
  - Don't use when: renaming a category — use shopping_update_category`,
      inputSchema: {
        list_id: listIdField,
        name: z.string().trim().min(1).max(200).describe("New name for the list."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, name, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const previous = payload.name;
        payload.name = name;
        return previous;
      });
      const changed = [`renamed "${result.detail}" to "${name}"`];
      const output = mutationResult(assertListId(list_id), result.after, changed, result.retries);
      return reply(
        response_format,
        renderSummary("Renamed the list.", result.after, assertListId(list_id), changed),
        output
      );
    })
  );

  server.registerTool(
    "shopping_delete_list",
    {
      title: "Delete a shopping list",
      description: `Permanently delete a shopping list for everyone who has its link.

This writes the same deletion marker the web app's delete button writes, so any open tab clears its local copy and navigates away. It cannot be undone and the contents are not recoverable. Confirm with the user before calling it.

Args:
  - list_id (string): list to delete — required explicitly, no default
  - confirm (boolean): must be true; a safeguard against deleting by accident

Returns JSON with schema:
  { "ok": true, "list_id": string, "deleted": true }

Examples:
  - Use when: the user has explicitly asked to delete a specific list
  - Don't use when: clearing tick marks (shopping_clear_checked) or removing rows (shopping_remove_items)

Error handling:
  - Returns an error if confirm is not true
  - Returns an error if the list does not exist or is already deleted`,
      inputSchema: {
        list_id: z
          .string()
          .trim()
          .min(6)
          .max(90)
          .describe("Id of the list to delete. Required — there is deliberately no default."),
        confirm: z
          .boolean()
          .describe("Must be true. Guards against deleting a list without the user having asked.")
      },
      outputSchema: {
        ok: z.literal(true),
        list_id: z.string(),
        deleted: z.literal(true)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ list_id, confirm }) => {
      const id = assertListId(list_id);
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: refusing to delete "${id}" without confirm=true. Deleting is permanent and affects everyone with the link — confirm with the user, then call again with confirm=true.`
            }
          ]
        };
      }
      const before = await readNode<unknown>(`${LISTS_ROOT}/${id}`);
      const name = normalizePayload(before.value).name;
      await deleteList(id);
      await forgetList(id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted **${name}** (\`${id}\`). Anyone with the link now sees it as removed. This cannot be undone.`
          }
        ],
        structuredContent: { ok: true as const, list_id: id, deleted: true as const }
      };
    })
  );
}
