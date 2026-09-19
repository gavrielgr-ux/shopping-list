/** Shapes stored under `shared-lists/{listId}` in the Realtime Database. */

/** One row inside a category, as `snapshotDepartments()` in `app.js` writes it. */
export interface ListItem {
  name: string;
  note: string;
  checked: boolean;
  /**
   * True for the placeholder row the web app appends so there is always somewhere to type.
   * Blank rows are excluded from the progress counter, so items added here are never blank.
   */
  blank: boolean;
}

/** A category, called a "department" in the stored payload. */
export interface Category {
  title: string;
  /** Free-text aisle hint shown under the title, e.g. "מקררים". */
  hint: string;
  items: ListItem[];
}

/** A whole list, normalized. */
export interface ListPayload {
  name: string;
  departments: Category[];
  /** Epoch milliseconds. The web app only adopts remote state when this increases. */
  updatedAt: number | null;
}

/** The tombstone `app.js` writes in place of a list when it is deleted. */
export interface DeletedList {
  deleted: true;
  deletedAt: number | null;
}

/** A list read from the database, plus the ETag needed for a conditional write. */
export interface LoadedList {
  id: string;
  payload: ListPayload;
  /** Present when the database supplied one; enables optimistic concurrency. */
  etag: string | null;
  /** True when nothing exists at this path yet. */
  missing: boolean;
}

/** An entry in the local registry of lists this server has seen. */
export interface RegistryEntry {
  id: string;
  name: string;
  /** ISO timestamp of the last time this server read or wrote the list. */
  lastSeen: string;
}

/** An entry in the shared index at `LIST_INDEX_PATH`, written by the page and by this server. */
export interface IndexEntry {
  id: string;
  name: string;
  /** Epoch milliseconds the entry was last advertised, or null when it was stored malformed. */
  updatedAt: number | null;
}

/** Persisted state: the reused anonymous identity plus the known-list registry. */
export interface PersistedState {
  refreshToken?: string;
  localId?: string;
  lists?: RegistryEntry[];
}

/** Output format shared by every reading tool. */
export type ResponseFormat = "markdown" | "json";
