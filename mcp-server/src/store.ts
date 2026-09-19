import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIST_NAME,
  LIST_ID_PATTERN,
  LISTS_ROOT,
  SITE_URL,
  WRITE_RETRIES
} from "./constants.js";
import { recordList, unpublishList } from "./list-index.js";
import { isDeleted, matchAll, normalizePayload, serializePayload } from "./normalize.js";
import { ABSENT_ETAG, PreconditionFailed, readNode, writeNode } from "./rtdb.js";
import type { Category, ListItem, ListPayload, LoadedList } from "./types.js";

/** An error whose message is meant to be read by the model and acted on. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Validate a list id against the pattern the web app uses to accept `?list=`. */
export function assertListId(id: string): string {
  const trimmed = id.trim();
  if (!LIST_ID_PATTERN.test(trimmed)) {
    throw new ToolError(
      `"${trimmed}" is not a usable list id. Ids are 6-90 characters of letters, digits, hyphens or underscores ` +
        "(for example \"rehovot-family-4d7f8c12\"). Use shopping_list_lists to see known ids."
    );
  }
  return trimmed;
}

/** Mint a new id in the same shape as `createListId` in `list-model.js`. */
export function newListId(): string {
  return `list-${randomUUID().toLowerCase()}`;
}

/** The shareable URL for a list, matching `urlFor()` in `app.js`. */
export function urlForList(id: string): string {
  const url = new URL(SITE_URL);
  url.search = "";
  url.searchParams.set("list", id);
  return url.href;
}

const pathFor = (id: string): string => `${LISTS_ROOT}/${id}`;

/** Read and normalize a list. A deleted or absent list is reported, not invented. */
export async function loadList(id: string): Promise<LoadedList> {
  const listId = assertListId(id);
  const { value, etag } = await readNode<unknown>(pathFor(listId));
  if (isDeleted(value)) {
    throw new ToolError(
      `List "${listId}" was deleted, so it can no longer be read or edited. Create a new list with shopping_create_list.`
    );
  }
  const missing = value === null;
  return {
    id: listId,
    payload: normalizePayload(value),
    etag,
    missing
  };
}

/** Read a list and fail if it does not exist yet. */
export async function requireList(id: string): Promise<LoadedList> {
  const loaded = await loadList(id);
  if (loaded.missing) {
    throw new ToolError(
      `No list exists at id "${loaded.id}". Check the id with shopping_list_lists, or create it with shopping_create_list.`
    );
  }
  return loaded;
}

export interface MutationResult<T> {
  /** State before the successful attempt. */
  before: ListPayload;
  /** State written to the database. */
  after: ListPayload;
  /** Whatever the mutator reported about what it changed. */
  detail: T;
  /** False when the mutation turned out to be a no-op and nothing was sent. */
  wrote: boolean;
  /** How many times the write had to be retried after losing a race. */
  retries: number;
}

/**
 * The part of a serialized payload that represents content, ignoring the timestamp.
 *
 * Used to recognise a mutation that changed nothing, so it can be skipped. That matters beyond
 * saving a request: the page re-renders by replacing the list's innerHTML whenever it adopts a
 * remote update, which takes focus out of whatever row someone is typing in. A write that
 * changes nothing but bumps `updatedAt` would do that for no reason.
 */
const contentOf = (body: Record<string, unknown>): string =>
  JSON.stringify({ name: body.name, departments: body.departments });

/**
 * Read a list, apply `mutate`, and write it back as a compare-and-swap.
 *
 * On a lost race the list is re-read and `mutate` runs again against the newer state, so the
 * intent ("check off milk") is re-applied rather than a stale snapshot being forced over
 * somebody else's edit. `mutate` must therefore be free of outside side effects.
 */
export async function mutateList<T>(
  id: string,
  mutate: (payload: ListPayload) => T,
  options: { allowMissing?: boolean } = {}
): Promise<MutationResult<T>> {
  const listId = assertListId(id);

  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt += 1) {
    const loaded = options.allowMissing ? await loadList(listId) : await requireList(listId);
    const before = structuredClone(loaded.payload);
    const draft = structuredClone(loaded.payload);
    const detail = mutate(draft);
    const body = serializePayload(draft, loaded.payload.updatedAt);

    if (contentOf(body) === contentOf(serializePayload(before, loaded.payload.updatedAt))) {
      await recordList(listId, before.name);
      return { before, after: before, detail, retries: attempt, wrote: false };
    }

    try {
      await writeNode(pathFor(listId), body, loaded.etag ?? ABSENT_ETAG);
    } catch (error) {
      // Lost the compare-and-swap: re-read and re-apply the intent to the newer state.
      if (error instanceof PreconditionFailed) continue;
      throw error;
    }

    const after = normalizePayload(body);
    await recordList(listId, after.name);
    return { before, after, detail, retries: attempt, wrote: true };
  }

  throw new ToolError(
    `The list kept changing in the database while this edit was being written (${WRITE_RETRIES + 1} attempts). ` +
      "Something else is writing to it right now — retry in a moment."
  );
}

/** Create a list, refusing to overwrite one that already exists at the same id. */
export async function createList(id: string, name: string, departments: Category[]): Promise<ListPayload> {
  const listId = assertListId(id);
  const existing = await readNode<unknown>(pathFor(listId));
  if (existing.value !== null && !isDeleted(existing.value)) {
    throw new ToolError(
      `A list already exists at id "${listId}". Pick a different id, or edit the existing list instead.`
    );
  }
  const payload: ListPayload = {
    name: name.trim() || DEFAULT_LIST_NAME,
    departments,
    updatedAt: null
  };
  const body = serializePayload(payload, null);
  await writeNode(pathFor(listId), body, existing.etag ?? ABSENT_ETAG);
  const created = normalizePayload(body);
  await recordList(listId, created.name);
  return created;
}

/**
 * Replace a list with the tombstone the web app writes.
 *
 * `app.js` reacts to `{deleted:true}` by clearing its local copy and navigating home, so this
 * is what actually removes the list from anybody who has it open — a bare delete of the node
 * would leave open tabs to immediately recreate it from their local copy.
 */
export async function deleteList(id: string): Promise<void> {
  const listId = assertListId(id);
  const existing = await readNode<unknown>(pathFor(listId));
  if (existing.value === null) {
    throw new ToolError(`No list exists at id "${listId}", so there is nothing to delete.`);
  }
  if (isDeleted(existing.value)) {
    // A tombstone with a live index entry is stale advertising: the client that wrote the
    // tombstone is the one meant to retract the entry, and it may have failed to, or may have
    // predated the index. Repair it here rather than from a reading tool, which would make a
    // tool clients can auto-approve into a writer.
    await unpublishList(listId);
    throw new ToolError(`List "${listId}" is already deleted.`);
  }
  await writeNode(pathFor(listId), { deleted: true, deletedAt: Date.now() }, existing.etag ?? null);
  // Stop advertising a list nobody can open. Best-effort inside `unpublishList`: the deletion
  // itself has already committed, so a failure here must not be reported as one.
  await unpublishList(listId);
}

/** How a caller points at a category: by position, or by (fuzzy) title. */
export interface CategorySelector {
  category?: string | undefined;
  category_index?: number | undefined;
}

const describeCategories = (payload: ListPayload): string =>
  payload.departments.length
    ? payload.departments.map((category, index) => `${index}: ${category.title}`).join(", ")
    : "(the list has no categories yet)";

/** Resolve a category selector to an index, with an actionable error when it is unclear. */
export function resolveCategory(payload: ListPayload, selector: CategorySelector): number {
  const { category, category_index: categoryIndex } = selector;
  if (categoryIndex !== undefined) {
    if (!Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex >= payload.departments.length) {
      throw new ToolError(
        `category_index ${categoryIndex} is out of range. The list has ${payload.departments.length} categories — ${describeCategories(payload)}.`
      );
    }
    return categoryIndex;
  }
  if (category === undefined || !category.trim()) {
    throw new ToolError(
      `Specify which category, either by name ("category") or position ("category_index"). Available: ${describeCategories(payload)}.`
    );
  }
  const matches = matchAll(
    payload.departments.map(entry => entry.title),
    category
  );
  if (!matches.length) {
    throw new ToolError(
      `No category matches "${category}". Available: ${describeCategories(payload)}. ` +
        "Use shopping_add_category to create it, or pass create_category=true when adding items."
    );
  }
  if (matches.length > 1) {
    const names = matches.map(match => `${match.index}: ${payload.departments[match.index]?.title ?? ""}`).join(", ");
    throw new ToolError(
      `"${category}" matches more than one category (${names}). Pass category_index to choose one.`
    );
  }
  return matches[0]!.index;
}

export interface ResolvedItem {
  categoryIndex: number;
  itemIndex: number;
  item: ListItem;
}

/**
 * Find rows matching `query`, either inside one category or across the whole list.
 *
 * Searching the whole list is the common case while shopping: the natural instruction is
 * "check off milk", not "check off milk in dairy".
 */
export function findItems(
  payload: ListPayload,
  query: string,
  scope: { categoryIndex?: number | undefined } = {}
): ResolvedItem[] {
  const categories =
    scope.categoryIndex === undefined
      ? payload.departments.map((category, index) => ({ category, index }))
      : [{ category: payload.departments[scope.categoryIndex]!, index: scope.categoryIndex }];

  const flat: { categoryIndex: number; itemIndex: number; item: ListItem; name: string }[] = [];
  for (const { category, index } of categories) {
    category.items.forEach((item, itemIndex) => {
      if (item.name.trim()) {
        flat.push({ categoryIndex: index, itemIndex, item, name: item.name });
      }
    });
  }
  return matchAll(
    flat.map(entry => entry.name),
    query
  ).map(match => {
    const entry = flat[match.index]!;
    return { categoryIndex: entry.categoryIndex, itemIndex: entry.itemIndex, item: entry.item };
  });
}

/** Resolve a query to exactly one row, erroring with candidates when ambiguous. */
export function requireOneItem(
  payload: ListPayload,
  query: string,
  scope: { categoryIndex?: number | undefined } = {}
): ResolvedItem {
  const matches = findItems(payload, query, scope);
  if (!matches.length) {
    throw new ToolError(
      `No item matches "${query}"${
        scope.categoryIndex === undefined
          ? " anywhere in the list"
          : ` in category "${payload.departments[scope.categoryIndex]?.title ?? ""}"`
      }. Use shopping_get_list to see what is there.`
    );
  }
  if (matches.length > 1) {
    const names = matches
      .map(match => `"${match.item.name}" in ${payload.departments[match.categoryIndex]?.title ?? ""}`)
      .join(", ");
    throw new ToolError(
      `"${query}" matches ${matches.length} items (${names}). Narrow it with a more specific name, or pass "category" to limit the search.`
    );
  }
  return matches[0]!;
}

/**
 * Drop the trailing placeholder rows the web app keeps for typing into.
 *
 * Those rows carry `blank: true` and an empty name; leaving them interleaved would put new
 * items after a run of empty rows in the rendered list.
 */
export function stripTrailingBlanks(category: Category): void {
  while (category.items.length) {
    const last = category.items[category.items.length - 1]!;
    if (last.blank && !last.name.trim() && !last.note.trim()) category.items.pop();
    else break;
  }
}

/**
 * Give a category one trailing blank row, as the web app does for an empty category.
 *
 * `category()` in `app.js` appends a blank row whenever a category has no items, so matching
 * that keeps a category created here editable in the browser without a reload.
 */
export function ensureTrailingBlank(category: Category): void {
  if (!category.items.length) {
    category.items.push({ name: "", note: "", checked: false, blank: true });
  }
}

