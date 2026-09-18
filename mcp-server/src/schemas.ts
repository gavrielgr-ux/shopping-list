import { z } from "zod";
import { DEFAULT_LIST_ID } from "./constants.js";

/**
 * Which list to act on.
 *
 * Defaults to the list the site itself opens, so ordinary single-list use needs no id.
 */
export const listIdField = z
  .string()
  .trim()
  .min(6)
  .max(90)
  .default(DEFAULT_LIST_ID)
  .describe(
    `Id of the list, i.e. the ?list= value in its URL. Defaults to "${DEFAULT_LIST_ID}", the list the site opens by default.`
  );

export const responseFormatField = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' for a readable list, 'json' for machine-readable output.");

export const categoryNameField = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Category name. Matched case- and niqqud-insensitively, and by prefix or substring if there is no exact hit."
  );

export const categoryIndexField = z
  .number()
  .int()
  .min(0)
  .describe("Zero-based position of the category, as shown in square brackets by shopping_get_list.");

/** Structured shape describing one row, reused by several output schemas. */
export const itemShape = {
  index: z.number().int().describe("Position of the row inside its category."),
  name: z.string().describe("Product name."),
  note: z.string().describe("Quantity or note, e.g. '2 יחידות'."),
  checked: z.boolean().describe("Whether the row is ticked off.")
};

/** Structured shape describing one category. */
export const categoryShape = {
  index: z.number().int().describe("Zero-based position of the category."),
  title: z.string().describe("Category name."),
  hint: z.string().describe("Aisle hint shown under the title."),
  items: z.array(z.object(itemShape)).describe("Rows in this category, placeholders excluded.")
};

/** Structured shape of a whole list, shared by the reading tools. */
export const listViewShape = {
  id: z.string().describe("List id."),
  name: z.string().describe("List name."),
  url: z.string().describe("Shareable link that opens this list."),
  updated_at: z.string().nullable().describe("ISO timestamp of the last write, or null."),
  progress: z
    .object({
      done: z.number().int().describe("Rows ticked off."),
      total: z.number().int().describe("Rows with a name."),
      percent: z.number().int().describe("Completion percentage.")
    })
    .describe("Completion counters, matching the bar shown on the page."),
  categories: z.array(z.object(categoryShape)).describe("Categories in display order.")
};

/** Structured shape returned by every mutating tool. */
export const mutationShape = {
  ok: z.literal(true).describe("Present when the write succeeded."),
  list_id: z.string().describe("List that was modified."),
  list_name: z.string().describe("Name of the list after the write."),
  url: z.string().describe("Shareable link that opens this list."),
  changed: z.array(z.string()).describe("Human-readable description of each change applied."),
  progress: z
    .object({
      done: z.number().int(),
      total: z.number().int(),
      percent: z.number().int()
    })
    .describe("Completion counters after the write."),
  retries: z.number().int().describe("Times the write was replayed after a concurrent edit.")
};
