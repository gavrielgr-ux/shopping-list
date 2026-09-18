import { z } from "zod";
import { renderSummary, reply } from "../format.js";
import { matchAll } from "../normalize.js";
import {
  categoryIndexField,
  categoryNameField,
  listIdField,
  mutationShape,
  responseFormatField
} from "../schemas.js";
import {
  assertListId,
  ensureTrailingBlank,
  mutateList,
  resolveCategory,
  ToolError
} from "../store.js";
import type { Category } from "../types.js";
import { guard, mutationResult, type Server } from "./helpers.js";

export function registerCategoryTools(server: Server): void {
  server.registerTool(
    "shopping_add_category",
    {
      title: "Add a category",
      description: `Add a category (a "department") to a shopping list, optionally with items already in it.

Categories are the aisle groupings shown as headings on the page. A category with the same name is not created twice; that is reported instead.

Args:
  - list_id (string): list to change (default: the site's default list)
  - title (string): category name, e.g. 'פירות וירקות'
  - hint (string): aisle hint shown under the title, e.g. 'תחילת הסיבוב'
  - items (array): rows to create in it, each { name, note?, checked? }
  - position (number): zero-based insert position; appended when omitted

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "add a frozen foods section"
  - Use when: "add a bakery category with challah and pita in it"
  - Don't use when: the category exists — use shopping_add_items

Error handling:
  - Returns an error if a category with that name already exists`,
      inputSchema: {
        list_id: listIdField,
        title: z.string().trim().min(1).max(120).describe("Category name."),
        hint: z.string().trim().max(120).default("").describe("Aisle hint shown under the title."),
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).describe("Product name."),
              note: z.string().trim().default("").describe("Quantity or note."),
              checked: z.boolean().default(false).describe("Whether it starts ticked off.")
            })
          )
          .default([])
          .describe("Rows to create inside the new category."),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based insert position. Appended at the end when omitted."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ list_id, title, hint, items, position, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const clash = matchAll(
          payload.departments.map(entry => entry.title),
          title
        ).filter(match => match.tier === "exact" || match.tier === "folded");
        if (clash.length) {
          throw new ToolError(
            `A category named "${payload.departments[clash[0]!.index]?.title}" already exists at index ${clash[0]!.index}. ` +
              "Add items to it with shopping_add_items, or rename it with shopping_update_category."
          );
        }
        const category: Category = {
          title,
          hint,
          items: items.map(item => ({
            name: item.name,
            note: item.note,
            checked: item.checked,
            blank: false
          }))
        };
        ensureTrailingBlank(category);
        const at = position === undefined ? payload.departments.length : Math.min(position, payload.departments.length);
        payload.departments.splice(at, 0, category);
        return { at, count: items.length };
      });

      const changed = [
        `added category "${title}" at index ${result.detail.at}${hint ? ` (hint: ${hint})` : ""}`,
        ...(result.detail.count ? [`with ${result.detail.count} item(s)`] : [])
      ];
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary(`Added category **${title}**.`, result.after, id, changed),
        mutationResult(id, result.after, changed, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_update_category",
    {
      title: "Rename a category or change its hint",
      description: `Rename a category, change its aisle hint, or both. Items inside it are untouched.

Identify the category by name ("category") or position ("category_index"). At least one of new_title or new_hint must be given.

Args:
  - list_id (string): list to change (default: the site's default list)
  - category (string): current category name
  - category_index (number): position instead of a name
  - new_title (string): new category name
  - new_hint (string): new aisle hint; pass an empty string to clear it

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "rename Produce to פירות וירקות"
  - Use when: "note that dairy is in the back fridges" -> new_hint
  - Don't use when: renaming the whole list — use shopping_rename_list

Error handling:
  - Returns an error listing the categories if the name matches none or several
  - Returns an error if neither new_title nor new_hint is supplied`,
      inputSchema: {
        list_id: listIdField,
        category: categoryNameField.optional(),
        category_index: categoryIndexField.optional(),
        new_title: z.string().trim().min(1).max(120).optional().describe("New category name."),
        new_hint: z.string().trim().max(120).optional().describe("New aisle hint; empty string clears it."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, category, category_index, new_title, new_hint, response_format }) => {
      if (new_title === undefined && new_hint === undefined) {
        throw new ToolError("Nothing to change: supply new_title, new_hint, or both.");
      }
      const result = await mutateList(list_id, payload => {
        const index = resolveCategory(payload, { category, category_index });
        const target = payload.departments[index]!;
        const changes: string[] = [];
        if (new_title !== undefined && new_title !== target.title) {
          changes.push(`renamed "${target.title}" to "${new_title}"`);
          target.title = new_title;
        }
        if (new_hint !== undefined && new_hint !== target.hint) {
          changes.push(new_hint ? `hint set to "${new_hint}"` : "hint cleared");
          target.hint = new_hint;
        }
        if (!changes.length) changes.push(`"${target.title}" already matched the requested values`);
        return changes;
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary("Updated the category.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_remove_category",
    {
      title: "Remove a category",
      description: `Remove a category and every row inside it.

This discards the items in the category, so it is destructive. When the category still has rows, confirm must be true; an already-empty category is removed without it.

Args:
  - list_id (string): list to change (default: the site's default list)
  - category (string): category name
  - category_index (number): position instead of a name
  - confirm (boolean): required when the category still holds named rows (default: false)

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "drop the personal care section" (with confirm=true if it has items)
  - Don't use when: only some rows should go — use shopping_remove_items

Error handling:
  - Returns an error naming the row count if the category is non-empty and confirm is not true`,
      inputSchema: {
        list_id: listIdField,
        category: categoryNameField.optional(),
        category_index: categoryIndexField.optional(),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to remove a category that still holds named rows."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ list_id, category, category_index, confirm, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const index = resolveCategory(payload, { category, category_index });
        const target = payload.departments[index]!;
        const named = target.items.filter(item => item.name.trim());
        if (named.length && !confirm) {
          throw new ToolError(
            `Category "${target.title}" still holds ${named.length} item(s) (${named
              .slice(0, 5)
              .map(item => item.name)
              .join(", ")}${named.length > 5 ? ", …" : ""}). ` +
              "Removing it discards them. Confirm with the user, then call again with confirm=true."
          );
        }
        payload.departments.splice(index, 1);
        return [`removed category "${target.title}" and ${named.length} item(s)`];
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary("Removed the category.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_move_category",
    {
      title: "Reorder a category",
      description: `Move a category to a different position, changing the order of headings on the page.

The order usually mirrors the route through the shop, so this is how you make the list match the walk.

Args:
  - list_id (string): list to change (default: the site's default list)
  - category (string): category name
  - category_index (number): position instead of a name
  - to_index (number): zero-based destination position; values past the end move it last

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "put produce first" -> to_index=0
  - Use when: "move sweets to the end" -> a large to_index
  - Don't use when: moving an item between categories — use shopping_move_item`,
      inputSchema: {
        list_id: listIdField,
        category: categoryNameField.optional(),
        category_index: categoryIndexField.optional(),
        to_index: z.number().int().min(0).describe("Zero-based destination position."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, category, category_index, to_index, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const from = resolveCategory(payload, { category, category_index });
        const [moved] = payload.departments.splice(from, 1);
        const target = Math.min(to_index, payload.departments.length);
        payload.departments.splice(target, 0, moved!);
        return [`moved "${moved!.title}" from index ${from} to ${target}`];
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary("Reordered the categories.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );
}
