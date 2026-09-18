import { DEFAULT_CATEGORY_TITLE, DEFAULT_LIST_NAME } from "./constants.js";
import type { Category, DeletedList, ListItem, ListPayload } from "./types.js";

/**
 * Coerce an RTDB child collection into a dense array.
 *
 * The web app writes real JavaScript arrays, but the Realtime Database stores them as a map
 * of stringified indices and only returns a JSON array when those keys are contiguous and
 * start at 0. A list whose middle entry was removed elsewhere therefore comes back either as
 * an object (`{"0":…,"2":…}`) or as an array with `null` holes. Both collapse to a dense
 * array here, in ascending index order, so index arithmetic downstream is always safe.
 */
export function toDenseArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter(entry => entry !== null && entry !== undefined);
  if (typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [Number(key), entry] as const)
    .filter(([key, entry]) => Number.isFinite(key) && entry !== null && entry !== undefined)
    .sort((left, right) => left[0] - right[0])
    .map(([, entry]) => entry);
}

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

/**
 * Normalize one row.
 *
 * Accepts both the current object form and the legacy `[name, note]` tuple that
 * `normalizeDepartmentRecords` in `list-model.js` still migrates.
 */
export function normalizeItem(value: unknown): ListItem {
  if (Array.isArray(value)) {
    return { name: asText(value[0]), note: asText(value[1]), checked: false, blank: false };
  }
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    name: asText(record.name),
    note: asText(record.note),
    checked: Boolean(record.checked),
    blank: Boolean(record.blank)
  };
}

/** Normalize one category, tolerating the legacy "category is just an array of items" form. */
export function normalizeCategory(value: unknown, index: number): Category {
  const fallbackTitle = `קטגוריה ${index + 1}`;
  if (Array.isArray(value) || value === null || value === undefined || typeof value !== "object") {
    return {
      title: fallbackTitle,
      hint: "",
      items: toDenseArray(value).map(normalizeItem)
    };
  }
  const record = value as Record<string, unknown>;
  // A category whose `title`/`hint` keys are absent but which has numeric keys is a legacy
  // item map rather than a category object.
  const looksLikeItemMap =
    record.items === undefined &&
    record.title === undefined &&
    record.hint === undefined &&
    Object.keys(record).some(key => Number.isFinite(Number(key)));
  const items = toDenseArray(looksLikeItemMap ? record : record.items).map(normalizeItem);
  return {
    title: asText(record.title).trim() || fallbackTitle,
    hint: asText(record.hint).trim(),
    items
  };
}

/** True when the stored value is the tombstone written by the web app's delete button. */
export function isDeleted(value: unknown): value is DeletedList {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).deleted);
}

/**
 * Normalize a raw RTDB value into a `ListPayload`.
 *
 * Mirrors `normalizePayload` in `list-model.js`, which also accepts a bare array of
 * departments as the whole payload.
 */
export function normalizePayload(value: unknown, fallbackName = DEFAULT_LIST_NAME): ListPayload {
  const updatedAtOf = (raw: unknown): number | null =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : null;

  if (value === null || value === undefined) {
    return { name: fallbackName, departments: [], updatedAt: null };
  }
  if (Array.isArray(value)) {
    return {
      name: fallbackName,
      departments: toDenseArray(value).map(normalizeCategory),
      updatedAt: null
    };
  }
  if (typeof value !== "object") {
    return { name: fallbackName, departments: [], updatedAt: null };
  }
  const record = value as Record<string, unknown>;
  return {
    name: asText(record.name).trim() || fallbackName,
    departments: toDenseArray(record.departments).map(normalizeCategory),
    updatedAt: updatedAtOf(record.updatedAt)
  };
}

/**
 * Serialize a payload for writing.
 *
 * `updatedAt` is forced strictly above the value already stored: the web app's
 * `shouldApplyRemoteUpdate` only adopts an incoming snapshot when `updatedAt` grew, so a
 * write that reused or lowered the timestamp would be silently ignored by an open tab even
 * though the database changed.
 */
export function serializePayload(payload: ListPayload, previousUpdatedAt: number | null): Record<string, unknown> {
  const updatedAt = Math.max(Date.now(), (previousUpdatedAt ?? 0) + 1);
  return {
    name: payload.name.trim() || DEFAULT_LIST_NAME,
    departments: payload.departments.map(category => ({
      title: category.title.trim() || DEFAULT_CATEGORY_TITLE,
      hint: category.hint.trim(),
      items: category.items.map(item => ({
        name: item.name,
        note: item.note,
        checked: item.checked,
        blank: item.blank
      }))
    })),
    updatedAt
  };
}

/**
 * Fold text for comparison: strip combining marks (Hebrew niqqud, Latin accents), unify the
 * Hebrew geresh/gershayim with their ASCII lookalikes, collapse whitespace and case.
 *
 * Without this, "שמנת" typed with niqqud or "ד״ר" written with a straight quote would fail to
 * match the stored row.
 */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .normalize("NFC")
    .replace(/[׳‘’']/gu, "'")
    .replace(/[״“”"]/gu, '"')
    .replace(/[־‐-―]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Where a match was found, most precise first. */
const MATCH_TIERS = ["exact", "folded", "prefix", "substring"] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export interface Match {
  index: number;
  tier: MatchTier;
}

/**
 * Find every entry matching `query`, keeping only the most precise tier that produced a hit.
 *
 * Tiers are tried in order so that an exact name always wins over a row that merely contains
 * it — searching for "חלב" must not become ambiguous just because "חלב סויה" also exists.
 */
export function matchAll(candidates: string[], query: string): Match[] {
  const needleRaw = query.trim();
  const needle = foldText(query);
  if (!needle) return [];
  const folded = candidates.map(foldText);

  const tiers: Record<MatchTier, number[]> = {
    exact: [],
    folded: [],
    prefix: [],
    substring: []
  };
  candidates.forEach((candidate, index) => {
    const value = folded[index] ?? "";
    if (candidate.trim() === needleRaw) tiers.exact.push(index);
    else if (value === needle) tiers.folded.push(index);
    else if (value.startsWith(needle)) tiers.prefix.push(index);
    else if (value.includes(needle)) tiers.substring.push(index);
  });

  for (const tier of MATCH_TIERS) {
    const hits = tiers[tier];
    if (hits.length) return hits.map(index => ({ index, tier }));
  }
  return [];
}

/** Count of rows that carry a real name, matching the web app's progress denominator. */
export function countableItems(category: Category): ListItem[] {
  return category.items.filter(item => item.name.trim().length > 0);
}

/** Progress across the whole list, computed the way `updateProgress()` in `app.js` does. */
export function progressOf(payload: ListPayload): { done: number; total: number; percent: number } {
  const rows = payload.departments.flatMap(countableItems);
  const done = rows.filter(item => item.checked).length;
  return {
    done,
    total: rows.length,
    percent: rows.length ? Math.round((done / rows.length) * 100) : 0
  };
}
