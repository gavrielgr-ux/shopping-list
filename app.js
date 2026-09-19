import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getDatabase, onValue, ref, remove, set } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';
import {
  DEFAULT_LIST_ID,
  DEFAULT_LIST_NAME,
  createListId,
  getListIdFromLocation,
  normalizeDepartmentRecords,
  normalizePayload,
  payloadForSave,
  removeListFromRecent,
  shouldApplyRemoteUpdate
} from './list-model.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBTNbSh9PgI9cTc67YyLjEuULkg6ACB6SA',
  authDomain: 'shopping-list-27ffd.firebaseapp.com',
  databaseURL: 'https://shopping-list-27ffd-default-rtdb.firebaseio.com',
  projectId: 'shopping-list-27ffd',
  storageBucket: 'shopping-list-27ffd.firebasestorage.app',
  messagingSenderId: '512815948415',
  appId: '1:512815948415:web:9e2b3d8d8e13d2dd44954a'
};

const defaultDepartments = [
  { title:'פירות וירקות', hint:'תחילת הסיבוב', items:[['ירוקים: כוסברה, פטרוזיליה, שמיר',''],['עלים לסלט עלים',''],['2 חבילות עלי סלק','2 חבילות'],['שורש חזרת',''],['גבעולי סלרי',''],['שומר',''],['קולורבי',''],['דלעת',''],['בצל ירוק + בצל סגול + בצל לבן',''],['כרישה',''],['תפוח אדמה',''],['תפוח עץ',''],['גזר',''],['כרוב לבן','']]},
  { title:'עשבי תיבול ותבלינים', hint:'ליד הירקות', items:[['עלי דפנה',''],['תימין',''],['מרווה','']]},
  { title:'מעדנייה ודגים', hint:'לפי הצורך', items:[['סלמון פרוס','']]},
  { title:'בשר ועוף', hint:'לפני הקופות', items:[['כרעיים','']]},
  { title:'חלב וביצים', hint:'מקררים', items:[['חלב',''],['ביצים',''],['שמנת לבישול','2 יחידות'],['שמנת אפייה להקצפה','2 יחידות'],['חמאה','2 יחידות'],['מסקרפונה','']]},
  { title:'אפייה ואגוזים', hint:'מדפים יבשים', items:[['סוכר לבן','2 ק״ג'],['שקדים פרוסים או מקולפים',''],['פקאנים מסוכרים',''],['צימוקאו','3 יחידות']]},
  { title:'מזווה ורטבים', hint:'מדפים יבשים', items:[['שמן זית',''],['חרדל',''],['שאלוט','']]},
  { title:'ממתקים', hint:'מדפים יבשים', items:[['שוקולד מריר','6 טבלאות']]},
  { title:'טיפוח אישי', hint:'פארם', items:[['שמפו ד״ר פישר לשיער בלונדיני','']]}
];

// Every editable field is a textarea so its text wraps instead of scrolling out of sight.
// Browsers that have `field-sizing: content` keep the height right on their own, which also
// survives a re-layout the script never sees, such as the one the print sheet does. Everywhere
// else the height has to be set by hand, because a textarea never grows on its own.
const nativeFieldSizing = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
// A height this script measured on screen can be a line short once the print sheet lays the
// list out in narrower columns, so those browsers print one column wide instead.
document.documentElement.classList.toggle('js-sized-fields', !nativeFieldSizing);
function autoGrow(field) {
  if (nativeFieldSizing || !field || !field.isConnected) return;
  field.style.height = 'auto';
  if (!field.scrollHeight) return;
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}
function autoGrowAll(root = document) {
  root.querySelectorAll('textarea').forEach(autoGrow);
}
// Item names stay single-line data; a pasted newline would only break the stored payload.
function keepSingleLine(field) {
  if (!field.value.includes('\n')) return;
  const caret = field.selectionStart;
  field.value = field.value.replace(/\r?\n/g, ' ');
  field.setSelectionRange(caret, caret);
}
function bindField(field, onChange) {
  field.addEventListener('input', () => { keepSingleLine(field); autoGrow(field); onChange(); });
  field.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const note = field.classList.contains('name') ? field.closest('.row')?.querySelector('.note') : null;
    if (note) note.focus(); else field.blur();
  });
}
let growFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(growFrame);
  growFrame = requestAnimationFrame(() => autoGrowAll());
});

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const listId = getListIdFromLocation(window.location.href);
const dialog = document.querySelector('#lists-dialog');
const recentStorageKey = 'shopping-list:recent-lists';

function readRecentLists() {
  try { return JSON.parse(localStorage.getItem(recentStorageKey)) || []; } catch (_) { return []; }
}
function rememberList(id, name) {
  const current = readRecentLists().filter(item => item.id !== id);
  localStorage.setItem(recentStorageKey, JSON.stringify([{ id, name: String(name || DEFAULT_LIST_NAME).trim() || DEFAULT_LIST_NAME }, ...current].slice(0, 10)));
}
function forgetList(id) {
  localStorage.setItem(recentStorageKey, JSON.stringify(removeListFromRecent(readRecentLists(), id)));
}

// The list above never leaves this browser, and the database holds one node per list and no
// index of them, so a list created here could not be found by anything that did not already
// have its id: an assistant asking "which lists are there?" saw only the default one. Every
// list that gets saved is therefore also advertised under `shared-lists/!index/<id>`, which is
// what the MCP server's shopping_list_lists reads. The key is '!index' because '!' is outside
// the safeListId pattern, so no list can ever occupy it and `?list=!index` is not a valid URL.
const indexEntry = id => ref(database, `shared-lists/!index/${id}`);
// What this tab has already advertised, so typing in the name field does not write per keystroke.
let advertised = null;
function publishToIndex(id, name) {
  const entry = `${id}\n${name}`;
  if (entry === advertised) return;
  advertised = entry;
  // Best-effort, and unable to disturb the save it rides along with: advertising a list is not
  // part of storing it, and `ref()` validates the key and would throw synchronously rather than
  // reject if the SDK ever stopped accepting this one. Clearing the memo retries on the next save.
  try {
    set(indexEntry(id), { name, updatedAt: Date.now() }).catch(() => { advertised = null; });
  } catch (_) {
    advertised = null;
  }
}
function unpublishFromIndex(id) {
  advertised = null;
  try {
    return remove(indexEntry(id)).catch(() => { /* the list is gone for everyone either way */ });
  } catch (_) {
    return Promise.resolve();
  }
}
function homeUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  return url.href;
}
function urlFor(id) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('list', id);
  return url.href;
}
function renderRecentLists() {
  const target = document.querySelector('#recent-lists');
  const recent = readRecentLists();
  target.innerHTML = '';
  if (!recent.length) {
    target.innerHTML = '<li class="empty-lists">עדיין אין רשימות שנפתחו במכשיר זה.</li>';
    return;
  }
  recent.forEach(item => {
    const row = document.createElement('li');
    const open = document.createElement('button');
    const label = document.createElement('small');
    row.className = 'recent-list';
    open.type = 'button';
    open.textContent = item.name;
    open.addEventListener('click', () => window.location.assign(urlFor(item.id)));
    label.textContent = item.id === listId ? 'הרשימה הנוכחית' : 'פתיחת רשימה';
    row.append(open, label);
    target.append(row);
  });
}
function showLists() {
  renderRecentLists();
  dialog.showModal();
}

document.querySelector('#open-lists').addEventListener('click', showLists);
document.querySelector('#close-lists').addEventListener('click', () => dialog.close());
document.querySelector('#landing-create').addEventListener('click', showLists);
document.querySelector('#new-list-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = document.querySelector('#new-list-name').value.trim() || DEFAULT_LIST_NAME;
  const id = createListId();
  rememberList(id, name);
  window.location.assign(urlFor(id));
});

if (!listId) {
  document.querySelector('#landing').hidden = false;
} else {
  document.querySelector('#landing').hidden = true;
  document.querySelector('#list-view').hidden = false;
  startList(listId);
}

function startList(id) {
  const cloudList = ref(database, `shared-lists/${id}`);
  const list = document.querySelector('#list');
  const template = document.querySelector('#row-template');
  const listNameInput = document.querySelector('#list-name');
  const sync = document.querySelector('#sync');
  const shareButton = document.querySelector('#share-list');
  const localStorageKey = `shopping-list:${id}`;
  const rememberedName = readRecentLists().find(item => item.id === id)?.name;
  const undoBar = document.querySelector('#undo-remove');
  let cloudReady = false;
  let saveTimer;
  let undoTimer;
  let pendingUndo = null;
  let lastSavedAt = null;
  let deleting = false;

  listNameInput.value = rememberedName || DEFAULT_LIST_NAME;
  shareButton.hidden = false;
  document.querySelector('#undo-remove-action').addEventListener('click', () => {
    const restoreRow = pendingUndo;
    pendingUndo = null;
    clearTimeout(undoTimer);
    undoBar.hidden = true;
    if (restoreRow) restoreRow();
  });

  function setSync(message, error = false) {
    sync.textContent = message;
    sync.classList.toggle('error', error);
  }
  function setListTitle(name) {
    document.title = `${name} · רשימות קנייה`;
    document.querySelector('#page-title').textContent = name;
    rememberList(id, name);
  }
  function bindRow(element) {
    element.querySelectorAll('textarea').forEach(field => bindField(field, save));
    element.querySelector('[type=checkbox]').addEventListener('change', save);
    element.querySelector('.remove-row').addEventListener('click', () => removeRow(element));
    bindSwipe(element);
  }
  function row(item = {}, blank = false) {
    const element = template.content.firstElementChild.cloneNode(true);
    element.classList.toggle('blank', blank);
    element.querySelector('[type=checkbox]').checked = Boolean(item.checked);
    element.querySelector('.name').value = item.name || '';
    element.querySelector('.note').value = item.note || '';
    bindRow(element);
    return element;
  }
  function itemOf(element) {
    return {
      name: element.querySelector('.name').value,
      note: element.querySelector('.note').value,
      checked: element.querySelector('[type=checkbox]').checked,
      blank: element.classList.contains('blank')
    };
  }
  function offerUndo(restoreRow) {
    pendingUndo = restoreRow;
    undoBar.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { pendingUndo = null; undoBar.hidden = true; }, 7000);
  }
  function removeRow(element) {
    const rows = element.parentElement;
    const index = [...rows.children].indexOf(element);
    const item = itemOf(element);
    element.classList.add('removing');
    setTimeout(() => { element.remove(); save(); }, 180);
    offerUndo(() => {
      if (!rows.isConnected) return;
      const restored = row(item, item.blank);
      rows.insertBefore(restored, rows.children[index] || null);
      autoGrowAll(restored);
      save();
    });
  }
  // Swipe to delete, touch and pen only: dragging with a mouse belongs to the text itself.
  // `touch-action: pan-y` on the row lets the page still scroll vertically under the finger.
  function bindSwipe(element) {
    const surface = element.querySelector('.row-surface');
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let moved = 0;
    let decided = false;
    let swiping = false;
    const reset = () => {
      element.classList.remove('swiping');
      surface.style.transform = '';
      pointerId = null;
      moved = 0;
      decided = false;
      swiping = false;
    };
    surface.addEventListener('pointerdown', event => {
      if (pointerId !== null || event.pointerType === 'mouse') return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      moved = 0;
      decided = false;
      swiping = false;
    });
    surface.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        decided = true;
        swiping = Math.abs(dx) > Math.abs(dy);
        if (!swiping) { pointerId = null; return; }
        surface.setPointerCapture(pointerId);
        element.classList.add('swiping');
      }
      moved = dx;
      surface.style.transform = `translateX(${dx}px)`;
    });
    surface.addEventListener('pointerup', event => {
      if (event.pointerId !== pointerId) return;
      const distance = swiping ? Math.abs(moved) : 0;
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      reset();
      if (distance >= Math.min(120, element.clientWidth * 0.32)) removeRow(element);
    });
    surface.addEventListener('pointercancel', event => {
      if (event.pointerId !== pointerId) return;
      reset();
    });
  }
  function removeCategory(section) {
    if (confirm('להסיר את הקטגוריה ואת הפריטים שבה?')) {
      section.remove();
      renderEmptyState();
      save();
    }
  }
  function category(data = { title: 'קטגוריה חדשה', hint: '', items: [] }) {
    const section = document.createElement('article');
    const categoryTitle = data.title || 'קטגוריה חדשה';
    section.className = 'department';
    section.innerHTML = '<div class="department-head"><textarea class="category-title" rows="1" aria-label="שם קטגוריה"></textarea><textarea class="category-hint" rows="1" aria-label="הערת קטגוריה" placeholder="מיקום בחנות"></textarea><button class="remove-category" type="button">הסרת קטגוריה</button></div><div class="rows"></div><button type="button" class="add">+ הוספת שורה</button>';
    section.querySelector('.category-title').value = categoryTitle;
    section.querySelector('.category-hint').value = data.hint || '';
    section.querySelectorAll('.category-title, .category-hint').forEach(field => bindField(field, save));
    const rows = section.querySelector('.rows');
    data.items.forEach(item => rows.append(row(item, Boolean(item.blank))));
    if (!data.items.length) rows.append(row({}, true));
    section.querySelector('.add').addEventListener('click', () => {
      const fresh = row({}, true);
      rows.append(fresh);
      autoGrowAll(fresh);
      fresh.querySelector('.name').focus();
      save();
    });
    section.querySelector('.remove-category').addEventListener('click', () => removeCategory(section));
    return section;
  }
  function renderEmptyState() {
    const existing = list.querySelector('.empty-list');
    if (list.querySelector('.department') || existing) return;
    const message = document.createElement('p');
    message.className = 'empty-list';
    message.textContent = 'הרשימה ריקה. אפשר להוסיף קטגוריה כדי להתחיל.';
    list.append(message);
  }
  function renderDepartments(records) {
    list.innerHTML = '';
    records.forEach(record => list.append(category(record)));
    renderEmptyState();
    autoGrowAll(list);
  }
  function snapshotDepartments() {
    return [...list.querySelectorAll('.department')].map(section => ({
      title: section.querySelector('.category-title').value.trim() || 'קטגוריה חדשה',
      hint: section.querySelector('.category-hint').value.trim(),
      items: [...section.querySelectorAll('.row')].map(element => ({
        name: element.querySelector('.name').value,
        note: element.querySelector('.note').value,
        checked: element.querySelector('[type=checkbox]').checked,
        blank: element.classList.contains('blank')
      }))
    }));
  }
  function currentPayload() {
    return payloadForSave(listNameInput.value, snapshotDepartments());
  }
  function updateProgress() {
    const rows = [...list.querySelectorAll('.row')].filter(element => element.querySelector('.name').value.trim());
    const done = rows.filter(element => element.querySelector('[type=checkbox]').checked).length;
    const percent = rows.length ? Math.round((done / rows.length) * 100) : 0;
    document.querySelector('#progress').textContent = `${done} / ${rows.length}`;
    document.querySelector('#progress-bar').style.width = `${percent}%`;
    document.querySelector('.track').setAttribute('aria-valuenow', String(percent));
  }
  function restore(payload) {
    const data = normalizePayload(payload);
    if (!data) return false;
    listNameInput.value = data.name;
    autoGrow(listNameInput);
    renderDepartments(normalizeDepartmentRecords(data.departments, defaultDepartments));
    setListTitle(data.name);
    updateProgress();
    return true;
  }
  function save(immediately = false) {
    const payload = currentPayload();
    const serialized = JSON.stringify(payload);
    lastSavedAt = payload.updatedAt;
    localStorage.setItem(localStorageKey, serialized);
    setListTitle(payload.name);
    updateProgress();
    if (!cloudReady) return;
    clearTimeout(saveTimer);
    setSync('שמירת שינויים…');
    const write = () => {
      // Inside the debounced write, not outside it: renaming the list calls save() on every
      // keystroke, and advertising each one would be a write per character.
      publishToIndex(id, payload.name);
      set(cloudList, payload)
        .then(() => setSync('מסונכרן עכשיו'))
        .catch(() => setSync('הסנכרון אינו זמין כרגע — נשמר במכשיר', true));
    };
    if (immediately) write(); else saveTimer = setTimeout(write, 350);
  }
  async function shareCurrentList() {
    const url = urlFor(id);
    try {
      if (navigator.share) await navigator.share({ title: listNameInput.value || DEFAULT_LIST_NAME, url });
      else { await navigator.clipboard.writeText(url); setSync('קישור הרשימה הועתק'); }
    } catch (_) {
      try { await navigator.clipboard.writeText(url); setSync('קישור הרשימה הועתק'); }
      catch (_) { setSync('אפשר להעתיק את הקישור משורת הכתובת', true); }
    }
  }
  async function connectCloud() {
    try {
      if (!auth.currentUser) await signInAnonymously(auth);
      onValue(cloudList, result => {
        cloudReady = true;
        if (result.val()?.deleted) {
          if (!deleting) leaveDeletedList();
          return;
        }
        if (result.exists()) {
          const incoming = normalizePayload(result.val());
          if (incoming && shouldApplyRemoteUpdate(incoming, lastSavedAt)) restore(incoming);
          // Opening a list is enough to advertise it, so a list last saved before the index
          // existed becomes discoverable without anyone having to edit it.
          if (incoming) publishToIndex(id, incoming.name);
          setSync('מסונכרן עם הרשימה המשותפת');
        } else {
          save(true);
          setSync('נוצרה רשימה משותפת ומסונכרנת');
        }
      }, () => setSync('הסנכרון אינו זמין כרגע — נשמר במכשיר', true));
    } catch (_) {
      setSync('יש להפעיל Anonymous ב‑Firebase כדי לסנכרן', true);
    }
  }
  function leaveDeletedList() {
    localStorage.removeItem(localStorageKey);
    forgetList(id);
    window.location.assign(homeUrl());
  }
  async function deleteCurrentList() {
    if (!confirm('המחיקה תסיר לצמיתות את הרשימה ואת כל הפריטים מהקישור המשותף. להמשיך?')) return;
    deleting = true;
    setSync('מחיקת הרשימה…');
    try {
      await set(cloudList, { deleted: true, deletedAt: Date.now() });
      // Stop advertising it before leaving. This tab is the one that deleted it, so it is the
      // one that retracts the entry; a tab that merely saw the tombstone leaves it alone rather
      // than delaying its own navigation on a write somebody else already made.
      await unpublishFromIndex(id);
      leaveDeletedList();
    } catch (_) {
      deleting = false;
      setSync('לא ניתן למחוק כרגע — אפשר לנסות שוב', true);
    }
  }

  let localCopy = null;
  try { localCopy = JSON.parse(localStorage.getItem(localStorageKey)); } catch (_) { /* local copy is optional */ }
  if (!localCopy && id === DEFAULT_LIST_ID) {
    try { localCopy = JSON.parse(localStorage.getItem('shopping-list-by-department-v1')); } catch (_) { /* legacy copy is optional */ }
  }
  if (!restore(localCopy)) {
    renderDepartments(id === DEFAULT_LIST_ID ? normalizeDepartmentRecords(defaultDepartments, defaultDepartments) : []);
  }
  setListTitle(listNameInput.value || DEFAULT_LIST_NAME);
  updateProgress();
  autoGrowAll();
  connectCloud();

  bindField(listNameInput, save);
  document.querySelector('#add-category').addEventListener('click', () => {
    list.querySelector('.empty-list')?.remove();
    const section = category();
    list.append(section);
    autoGrowAll(section);
    section.querySelector('.category-title').focus();
    save();
  });
  document.querySelector('#print').addEventListener('click', () => window.print());
  document.querySelector('#clear').addEventListener('click', () => {
    if (confirm('לאפס את כל הסימונים? שמות והערות יישארו.')) {
      list.querySelectorAll('[type=checkbox]').forEach(element => { element.checked = false; });
      save();
    }
  });
  document.querySelector('#delete-list').addEventListener('click', deleteCurrentList);
  shareButton.addEventListener('click', shareCurrentList);
}
