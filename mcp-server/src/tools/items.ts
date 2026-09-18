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
  findItems,
  mutateList,
  requireOneItem,
  resolveCategory,
  stripTrailingBlanks,
  ToolError
} from "../store.js";
import type { Category, ListItem } from "../types.js";
import { guard, mutationResult, type Server } from "./helpers.js";

const newRow = (name: string, note: string, checked: boolean): ListItem => ({
  name,
  note,
  checked,
  blank: false
});

export function registerItemTools(server: Server): void {
  server.registerTool(
    "shopping_add_items",
    {
      title: "Add items",
      description: `Add one or more items to a shopping list, into one or several categories.

This is the main way to put things on the list, and it takes a batch — add everything in a single call rather than one call per product. Each item may name its own category; items without one fall back to the top-level "category" argument.

A row whose name already exists in the target category is not duplicated. By default its note is left alone and the item is reported as already present; pass on_duplicate='update_note' to overwrite the note instead.

Args:
  - list_id (string): list to change (default: the site's default list)
  - items (array): rows to add, each { name, note?, checked?, category? }
  - category (string): category for items that do not name one
  - create_category (boolean): create a named category that does not exist yet (default: true)
  - on_duplicate ('skip' | 'update_note'): what to do when the name is already there (default: 'skip')

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "add milk, eggs and bread" -> items=[{name:'חלב'},{name:'ביצים'},{name:'לחם'}], category='חלב וביצים'
  - Use when: "add 2kg sugar to baking" -> items=[{name:'סוכר', note:'2 ק״ג', category:'אפייה ואגוזים'}]
  - Don't use when: ticking something off — use shopping_set_checked

Error handling:
  - Returns an error naming the available categories if a category is unknown and create_category is false
  - Returns an error if no category is given and the list has none`,
      inputSchema: {
        list_id: listIdField,
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200).describe("Product name, e.g. 'חלב'."),
              note: z
                .string()
                .trim()
                .max(200)
                .optional()
                .describe(
                  "Quantity or note, e.g. '2 יחידות'. With on_duplicate='update_note', an empty string clears an existing note, while omitting it leaves the note alone."
                ),
              checked: z.boolean().default(false).describe("Whether it starts ticked off."),
              category: z
                .string()
                .trim()
                .optional()
                .describe("Category for this item, overriding the top-level category argument.")
            })
          )
          .min(1)
          .max(200)
          .describe("Items to add. Batch them into one call."),
        category: categoryNameField.optional().describe(
          "Category for items that do not name their own. Required unless every item names one."
        ),
        create_category: z
          .boolean()
          .default(true)
          .describe("Create a named category when it does not exist yet."),
        on_duplicate: z
          .enum(["skip", "update_note"])
          .default("skip")
          .describe("What to do when the category already holds a row with that name."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ list_id, items, category, create_category, on_duplicate, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const changes: string[] = [];

        /** Resolve, or create, the category an item belongs in. */
        const targetFor = (wanted: string | undefined): number => {
          const name = wanted ?? category;
          if (name === undefined || !name.trim()) {
            if (payload.departments.length === 1) return 0;
            throw new ToolError(
              payload.departments.length
                ? `Specify a category. Available: ${payload.departments
                    .map((entry, index) => `${index}: ${entry.title}`)
                    .join(", ")}.`
                : "This list has no categories yet. Pass a category name and leave create_category=true."
            );
          }
          const matches = matchAll(
            payload.departments.map(entry => entry.title),
            name
          );
          if (matches.length === 1) return matches[0]!.index;
          if (matches.length > 1) {
            throw new ToolError(
              `"${name}" matches several categories (${matches
                .map(match => `${match.index}: ${payload.departments[match.index]?.title}`)
                .join(", ")}). Use an exact category name.`
            );
          }
          if (!create_category) {
            throw new ToolError(
              `No category matches "${name}". Available: ${
                payload.departments.map((entry, index) => `${index}: ${entry.title}`).join(", ") || "(none)"
              }. Set create_category=true to add it.`
            );
          }
          const created: Category = { title: name, hint: "", items: [] };
          payload.departments.push(created);
          changes.push(`created category "${name}"`);
          return payload.departments.length - 1;
        };

        for (const item of items) {
          const index = targetFor(item.category);
          const target = payload.departments[index]!;
          const existing = matchAll(
            target.items.map(row => row.name),
            item.name
          ).filter(match => match.tier === "exact" || match.tier === "folded");

          if (existing.length) {
            const row = target.items[existing[0]!.index]!;
            // An explicit empty note clears; an omitted one leaves the existing note alone.
            if (on_duplicate === "update_note" && item.note !== undefined && item.note !== row.note) {
              changes.push(
                item.note
                  ? `"${row.name}" already in "${target.title}", note updated to "${item.note}"`
                  : `"${row.name}" already in "${target.title}", note cleared`
              );
              row.note = item.note;
              row.blank = false;
            } else {
              changes.push(`"${row.name}" already in "${target.title}", left as it was`);
            }
            continue;
          }

          stripTrailingBlanks(target);
          target.items.push(newRow(item.name, item.note ?? "", item.checked));
          changes.push(
            `added "${item.name}"${item.note ? ` (${item.note})` : ""} to "${target.title}"`
          );
        }

        payload.departments.forEach(ensureTrailingBlank);
        return changes;
      });

      const id = assertListId(list_id);
      const added = result.detail.filter(line => line.startsWith("added ")).length;
      return reply(
        response_format,
        renderSummary(
          added === result.detail.length
            ? `Added ${added} item(s).`
            : `Added ${added} item(s); see the notes below.`,
          result.after,
          id,
          result.detail
        ),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_set_checked",
    {
      title: "Tick items off, or un-tick them",
      description: `Tick items off the list, or clear their tick marks, by name.

This is the tool for shopping in the aisle: names are searched across the whole list, so the category does not have to be known. Matching ignores case and Hebrew niqqud and falls back to prefix or substring, so "חלב" finds "חלב 3%".

Args:
  - list_id (string): list to change (default: the site's default list)
  - items (array of strings): product names to tick off or un-tick
  - checked (boolean): true to tick off, false to clear (default: true)
  - category (string): restrict the search to one category
  - all (boolean): apply to every named row in scope, ignoring "items" (default: false)

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "got the milk and the eggs" -> items=['חלב','ביצים'], checked=true
  - Use when: "un-check everything" -> all=true, checked=false (same as the page's reset button)
  - Use when: "mark the whole produce section done" -> all=true, category='פירות וירקות'
  - Don't use when: removing rows outright — use shopping_remove_items

Error handling:
  - Reports each name that matched nothing, or matched several rows, and still applies the rest
  - Returns an error if neither items nor all=true is given`,
      inputSchema: {
        list_id: listIdField,
        items: z
          .array(z.string().trim().min(1))
          .default([])
          .describe("Product names to tick off or un-tick. Batch them into one call."),
        checked: z.boolean().default(true).describe("True ticks off, false clears the tick."),
        category: categoryNameField.optional().describe("Restrict the search to this category."),
        all: z
          .boolean()
          .default(false)
          .describe("Apply to every named row in scope, ignoring the items argument."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, items, checked, category, all, response_format }) => {
      if (!all && !items.length) {
        throw new ToolError("Nothing to do: pass item names in 'items', or all=true to apply to everything.");
      }
      const result = await mutateList(list_id, payload => {
        const scope = category === undefined ? undefined : resolveCategory(payload, { category });
        const changes: string[] = [];

        if (all) {
          let touched = 0;
          payload.departments.forEach((entry, index) => {
            if (scope !== undefined && index !== scope) return;
            entry.items.forEach(row => {
              if (row.name.trim() && row.checked !== checked) {
                row.checked = checked;
                touched += 1;
              }
            });
          });
          changes.push(
            `${checked ? "ticked off" : "cleared"} ${touched} row(s)${
              scope === undefined ? " across the whole list" : ` in "${payload.departments[scope]?.title}"`
            }`
          );
          return changes;
        }

        for (const name of items) {
          const matches = findItems(payload, name, { categoryIndex: scope });
          if (!matches.length) {
            changes.push(`"${name}" — no matching row, skipped`);
            continue;
          }
          if (matches.length > 1) {
            changes.push(
              `"${name}" — matches ${matches.length} rows (${matches
                .map(match => match.item.name)
                .join(", ")}), skipped; use a more specific name`
            );
            continue;
          }
          const match = matches[0]!;
          const row = payload.departments[match.categoryIndex]!.items[match.itemIndex]!;
          if (row.checked === checked) {
            changes.push(`"${row.name}" was already ${checked ? "ticked off" : "unticked"}`);
          } else {
            row.checked = checked;
            changes.push(`${checked ? "ticked off" : "unticked"} "${row.name}"`);
          }
        }
        return changes;
      });

      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary(checked ? "Ticked items off." : "Cleared tick marks.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_update_item",
    {
      title: "Edit an item",
      description: `Change one row's name, note or tick mark.

The row is found by its current name, searched across the whole list unless a category is given. Use shopping_set_checked for ticking several things off at once; this tool is for editing a single row.

Args:
  - list_id (string): list to change (default: the site's default list)
  - item (string): current product name
  - category (string): restrict the search to one category
  - new_name (string): new product name
  - new_note (string): new quantity or note; empty string clears it
  - checked (boolean): new tick state

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "make it 3 bottles of olive oil" -> item='שמן זית', new_note='3 בקבוקים'
  - Use when: "the milk should say lactose free" -> new_name
  - Don't use when: moving a row to another category — use shopping_move_item

Error handling:
  - Returns an error listing candidates if the name matches none or several rows
  - Returns an error if no new value is supplied`,
      inputSchema: {
        list_id: listIdField,
        item: z.string().trim().min(1).describe("Current product name of the row to edit."),
        category: categoryNameField.optional().describe("Restrict the search to this category."),
        new_name: z.string().trim().min(1).max(200).optional().describe("New product name."),
        new_note: z.string().trim().max(200).optional().describe("New note; empty string clears it."),
        checked: z.boolean().optional().describe("New tick state."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, item, category, new_name, new_note, checked, response_format }) => {
      if (new_name === undefined && new_note === undefined && checked === undefined) {
        throw new ToolError("Nothing to change: supply new_name, new_note or checked.");
      }
      const result = await mutateList(list_id, payload => {
        const scope = category === undefined ? undefined : resolveCategory(payload, { category });
        const match = requireOneItem(payload, item, { categoryIndex: scope });
        const row = payload.departments[match.categoryIndex]!.items[match.itemIndex]!;
        const changes: string[] = [];
        if (new_name !== undefined && new_name !== row.name) {
          changes.push(`renamed "${row.name}" to "${new_name}"`);
          row.name = new_name;
        }
        if (new_note !== undefined && new_note !== row.note) {
          changes.push(new_note ? `note set to "${new_note}"` : "note cleared");
          row.note = new_note;
        }
        if (checked !== undefined && checked !== row.checked) {
          changes.push(checked ? "ticked off" : "unticked");
          row.checked = checked;
        }
        // A row edited through this server is real content, never a typing placeholder.
        row.blank = false;
        if (!changes.length) changes.push(`"${row.name}" already matched the requested values`);
        return changes;
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary("Updated the item.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_remove_items",
    {
      title: "Remove items",
      description: `Delete rows from a shopping list by name.

The rows are removed outright, not just unticked. Names are searched across the whole list unless a category is given.

Args:
  - list_id (string): list to change (default: the site's default list)
  - items (array of strings): product names to remove
  - category (string): restrict the search to one category

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "take the sugar off the list" -> items=['סוכר לבן']
  - Don't use when: the item was bought and should stay recorded — use shopping_set_checked
  - Don't use when: clearing everything already bought — use shopping_clear_checked

Error handling:
  - Reports each name that matched nothing, or matched several rows, and still removes the rest`,
      inputSchema: {
        list_id: listIdField,
        items: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(200)
          .describe("Product names to remove. Batch them into one call."),
        category: categoryNameField.optional().describe("Restrict the search to this category."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ list_id, items, category, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const scope = category === undefined ? undefined : resolveCategory(payload, { category });
        const changes: string[] = [];
        for (const name of items) {
          const matches = findItems(payload, name, { categoryIndex: scope });
          if (!matches.length) {
            changes.push(`"${name}" — no matching row, skipped`);
            continue;
          }
          if (matches.length > 1) {
            changes.push(
              `"${name}" — matches ${matches.length} rows (${matches
                .map(match => match.item.name)
                .join(", ")}), skipped; use a more specific name`
            );
            continue;
          }
          const match = matches[0]!;
          const target = payload.departments[match.categoryIndex]!;
          const [removed] = target.items.splice(match.itemIndex, 1);
          changes.push(`removed "${removed!.name}" from "${target.title}"`);
        }
        payload.departments.forEach(ensureTrailingBlank);
        return changes;
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary("Removed items.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_move_item",
    {
      title: "Move an item",
      description: `Move a row to another category, or to a different position within its own.

Args:
  - list_id (string): list to change (default: the site's default list)
  - item (string): product name of the row to move
  - from_category (string): restrict the search for the row to this category
  - to_category (string): destination category name
  - to_category_index (number): destination category position instead of a name
  - to_index (number): zero-based position within the destination; appended when omitted

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "the horseradish belongs with the vegetables" -> item='שורש חזרת', to_category='פירות וירקות'
  - Use when: "put the milk at the top of dairy" -> to_category='חלב וביצים', to_index=0
  - Don't use when: reordering whole categories — use shopping_move_category

Error handling:
  - Returns an error if the row or the destination category cannot be resolved
  - Returns an error if neither to_category nor to_index is supplied`,
      inputSchema: {
        list_id: listIdField,
        item: z.string().trim().min(1).describe("Product name of the row to move."),
        from_category: categoryNameField.optional().describe("Restrict the search for the row to this category."),
        to_category: z.string().trim().min(1).optional().describe("Destination category name."),
        to_category_index: categoryIndexField.optional().describe("Destination category position."),
        to_index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based position within the destination category."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    guard(async ({ list_id, item, from_category, to_category, to_category_index, to_index, response_format }) => {
      if (to_category === undefined && to_category_index === undefined && to_index === undefined) {
        throw new ToolError(
          "Nothing to do: supply to_category (or to_category_index) to move between categories, or to_index to reorder within one."
        );
      }
      const result = await mutateList(list_id, payload => {
        const scope = from_category === undefined ? undefined : resolveCategory(payload, { category: from_category });
        const match = requireOneItem(payload, item, { categoryIndex: scope });
        const source = payload.departments[match.categoryIndex]!;
        const destinationIndex =
          to_category === undefined && to_category_index === undefined
            ? match.categoryIndex
            : resolveCategory(payload, { category: to_category, category_index: to_category_index });

        const [row] = source.items.splice(match.itemIndex, 1);
        const destination = payload.departments[destinationIndex]!;
        stripTrailingBlanks(destination);
        const at = to_index === undefined ? destination.items.length : Math.min(to_index, destination.items.length);
        destination.items.splice(at, 0, row!);
        payload.departments.forEach(ensureTrailingBlank);

        return [
          destinationIndex === match.categoryIndex
            ? `moved "${row!.name}" to position ${at} in "${destination.title}"`
            : `moved "${row!.name}" from "${source.title}" to "${destination.title}" at position ${at}`
        ];
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary("Moved the item.", result.after, id, result.detail),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );

  server.registerTool(
    "shopping_clear_checked",
    {
      title: "Clear bought items",
      description: `Tidy up after a shop, in one of two ways.

  - mode='untick' (default) clears every tick mark but keeps the rows, which is what the page's own reset button does. Use it for a list that is reused each week.
  - mode='remove' deletes the ticked rows outright. This discards them, so confirm must be true.

Args:
  - list_id (string): list to change (default: the site's default list)
  - mode ('untick' | 'remove'): keep the rows and clear their ticks, or delete them (default: 'untick')
  - category (string): restrict to one category
  - confirm (boolean): required for mode='remove' (default: false)

Returns JSON with schema:
  { "ok": true, "list_id": string, "list_name": string, "url": string, "changed": string[],
    "progress": { "done": number, "total": number, "percent": number }, "retries": number }

Examples:
  - Use when: "reset the list for next week" -> mode='untick'
  - Use when: "clear out everything we bought" -> mode='remove', confirm=true
  - Don't use when: deleting the whole list — use shopping_delete_list

Error handling:
  - Returns an error naming the row count if mode='remove' and confirm is not true`,
      inputSchema: {
        list_id: listIdField,
        mode: z
          .enum(["untick", "remove"])
          .default("untick")
          .describe("'untick' keeps the rows and clears their ticks; 'remove' deletes them."),
        category: categoryNameField.optional().describe("Restrict to this category."),
        confirm: z.boolean().default(false).describe("Must be true when mode='remove'."),
        response_format: responseFormatField
      },
      outputSchema: mutationShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    guard(async ({ list_id, mode, category, confirm, response_format }) => {
      const result = await mutateList(list_id, payload => {
        const scope = category === undefined ? undefined : resolveCategory(payload, { category });
        const inScope = payload.departments.filter((_, index) => scope === undefined || index === scope);
        const ticked = inScope.flatMap(entry => entry.items.filter(row => row.checked && row.name.trim()));

        if (!ticked.length) {
          return [`nothing was ticked off${scope === undefined ? "" : ` in "${payload.departments[scope]?.title}"`}`];
        }
        if (mode === "remove" && !confirm) {
          throw new ToolError(
            `mode='remove' would delete ${ticked.length} ticked row(s) (${ticked
              .slice(0, 5)
              .map(row => row.name)
              .join(", ")}${ticked.length > 5 ? ", …" : ""}). ` +
              "Confirm with the user, then call again with confirm=true — or use mode='untick' to keep the rows."
          );
        }

        if (mode === "untick") {
          ticked.forEach(row => {
            row.checked = false;
          });
          return [`cleared the tick mark on ${ticked.length} row(s)`];
        }

        payload.departments.forEach((entry, index) => {
          if (scope !== undefined && index !== scope) return;
          entry.items = entry.items.filter(row => !(row.checked && row.name.trim()));
        });
        payload.departments.forEach(ensureTrailingBlank);
        return [`removed ${ticked.length} ticked row(s)`];
      });
      const id = assertListId(list_id);
      return reply(
        response_format,
        renderSummary(
          mode === "untick" ? "Cleared the tick marks." : "Removed the bought items.",
          result.after,
          id,
          result.detail
        ),
        mutationResult(id, result.after, result.detail, result.retries)
      );
    })
  );
}
