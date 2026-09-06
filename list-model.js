export const DEFAULT_LIST_ID = 'rehovot-family-4d7f8c12';
export const DEFAULT_LIST_NAME = 'רשימת קניות';

const safeListId = /^[a-z0-9_-]{6,90}$/i;

export function getListIdFromLocation(locationHref) {
  const requestedId = new URL(locationHref).searchParams.get('list');
  return requestedId && safeListId.test(requestedId) ? requestedId : null;
}

export function createListId(uuid = () => crypto.randomUUID()) {
  return `list-${uuid().toLowerCase()}`;
}

export function normalizePayload(value, fallbackName = DEFAULT_LIST_NAME) {
  if (Array.isArray(value)) return { name: fallbackName, departments: value };
  if (value && Array.isArray(value.departments)) {
    return {
      name: String(value.name || fallbackName).trim() || fallbackName,
      departments: value.departments
    };
  }
  return null;
}

export function payloadForSave(name, departments, updatedAt = Date.now()) {
  return {
    name: String(name || DEFAULT_LIST_NAME).trim() || DEFAULT_LIST_NAME,
    departments,
    updatedAt
  };
}

export function emptyListPayload(name, updatedAt = Date.now()) {
  return payloadForSave(name, [], updatedAt);
}

export function normalizeDepartmentRecords(records, defaults = []) {
  if (!Array.isArray(records)) return [];
  const itemsFor = value => (Array.isArray(value) ? value : []).map(item => (
    Array.isArray(item)
      ? { name: item[0] || '', note: item[1] || '', checked: false, blank: false }
      : item
  ));
  return records.map((record, index) => {
    if (Array.isArray(record)) {
      const fallback = defaults[index] || { title: `קטגוריה ${index + 1}`, hint: '' };
      return { ...fallback, items: itemsFor(record) };
    }
    return {
      title: String(record?.title || `קטגוריה ${index + 1}`).trim() || `קטגוריה ${index + 1}`,
      hint: String(record?.hint || '').trim(),
      items: itemsFor(record?.items)
    };
  });
}
