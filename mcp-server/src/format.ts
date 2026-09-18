import { CHARACTER_LIMIT } from "./constants.js";
import { progressOf } from "./normalize.js";
import { urlForList } from "./store.js";
import type { ListPayload, ResponseFormat } from "./types.js";

/** Structured view of a list, used as the tool output schema and the JSON response body. */
export interface ListView {
  id: string;
  name: string;
  url: string;
  updated_at: string | null;
  progress: { done: number; total: number; percent: number };
  categories: {
    index: number;
    title: string;
    hint: string;
    items: { index: number; name: string; note: string; checked: boolean }[];
  }[];
}

const isoOf = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export interface ViewOptions {
  /** Only include unchecked rows. */
  pendingOnly?: boolean;
  /** Only include rows in categories matching these indices. */
  categoryIndices?: number[];
}

/**
 * Build the structured view.
 *
 * Placeholder rows are dropped and each surviving row keeps its real index in the stored
 * array, so an index taken from this output stays valid as a selector for the edit tools.
 */
export function buildView(id: string, payload: ListPayload, options: ViewOptions = {}): ListView {
  const categories = payload.departments
    .map((category, index) => ({ category, index }))
    .filter(({ index }) => !options.categoryIndices || options.categoryIndices.includes(index))
    .map(({ category, index }) => ({
      index,
      title: category.title,
      hint: category.hint,
      items: category.items
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(({ item }) => item.name.trim().length > 0)
        .filter(({ item }) => !options.pendingOnly || !item.checked)
        .map(({ item, itemIndex }) => ({
          index: itemIndex,
          name: item.name,
          note: item.note,
          checked: item.checked
        }))
    }));

  return {
    id,
    name: payload.name,
    url: urlForList(id),
    updated_at: isoOf(payload.updatedAt),
    progress: progressOf(payload),
    categories
  };
}

/** Render a list view as Hebrew-friendly Markdown. */
export function renderList(view: ListView, options: ViewOptions = {}): string {
  const lines: string[] = [
    `# ${view.name}`,
    "",
    `- id: \`${view.id}\``,
    `- link: ${view.url}`,
    `- progress: ${view.progress.done} / ${view.progress.total} checked (${view.progress.percent}%)`
  ];
  if (view.updated_at) lines.push(`- last updated: ${view.updated_at}`);
  lines.push("");

  if (!view.categories.length) {
    lines.push("_No categories yet. Add one with shopping_add_category._");
    return lines.join("\n");
  }

  for (const category of view.categories) {
    const heading = category.hint ? `${category.title} — _${category.hint}_` : category.title;
    lines.push(`## [${category.index}] ${heading}`);
    if (!category.items.length) {
      lines.push(options.pendingOnly ? "- _(nothing left here)_" : "- _(empty)_");
    }
    for (const item of category.items) {
      const note = item.note ? ` — ${item.note}` : "";
      lines.push(`- [${item.checked ? "x" : " "}] [${item.index}] ${item.name}${note}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** A short "what changed" line to confirm a mutation without re-dumping the list. */
export function renderSummary(headline: string, payload: ListPayload, id: string, extra: string[] = []): string {
  const progress = progressOf(payload);
  return [
    headline,
    ...extra.map(line => `- ${line}`),
    `- list: ${payload.name} (\`${id}\`)`,
    `- now ${progress.done} / ${progress.total} checked across ${payload.departments.length} categories`,
    `- link: ${urlForList(id)}`,
    "",
    "_The open web page updates on its own — it is subscribed to the same database._"
  ].join("\n");
}

/** Truncate an over-long response rather than flooding the conversation. */
export function capText(text: string, hint: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return `${text.slice(0, CHARACTER_LIMIT)}\n\n_[Output truncated at ${CHARACTER_LIMIT} characters. ${hint}]_`;
}

/** Package a tool reply, honouring the requested format. */
export function reply(
  format: ResponseFormat,
  markdown: string,
  structured: Record<string, unknown>,
  truncationHint = "Narrow the request to see the rest."
): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> } {
  const text =
    format === "json" ? JSON.stringify(structured, null, 2) : markdown;
  return {
    content: [{ type: "text" as const, text: capText(text, truncationHint) }],
    structuredContent: structured
  };
}
