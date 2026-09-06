export const DEFAULT_LIST_ID = 'rehovot-family-4d7f8c12';
export const DEFAULT_LIST_NAME = 'רשימת קניות';

const safeListId = /^[a-z0-9_-]{6,90}$/i;

export function getListIdFromLocation(locationHref) {
  const requestedId = new URL(locationHref).searchParams.get('list');
  return requestedId && safeListId.test(requestedId) ? requestedId : DEFAULT_LIST_ID;
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
