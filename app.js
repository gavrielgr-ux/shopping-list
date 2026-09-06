import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getDatabase, onValue, ref, set } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';
import {
  DEFAULT_LIST_ID,
  DEFAULT_LIST_NAME,
  createListId,
  getListIdFromLocation,
  normalizeDepartmentRecords,
  normalizePayload,
  payloadForSave
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
  let cloudReady = false;
  let saveTimer;
  let lastSavedContent = '';

  listNameInput.value = rememberedName || DEFAULT_LIST_NAME;
  shareButton.hidden = false;

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
    element.querySelectorAll('input').forEach(input => input.addEventListener('input', save));
    element.querySelector('[type=checkbox]').addEventListener('change', save);
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
    section.innerHTML = '<div class="department-head"><input class="category-title" aria-label="שם קטגוריה"><input class="category-hint" aria-label="הערת קטגוריה" placeholder="מיקום בחנות"><button class="remove-category" type="button">הסרת קטגוריה</button></div><div class="rows"></div><button type="button" class="add">+ הוספת שורה</button>';
    section.querySelector('.category-title').value = categoryTitle;
    section.querySelector('.category-hint').value = data.hint || '';
    section.querySelectorAll('.category-title, .category-hint').forEach(input => input.addEventListener('input', save));
    const rows = section.querySelector('.rows');
    data.items.forEach(item => rows.append(row(item, Boolean(item.blank))));
    if (!data.items.length) rows.append(row({}, true));
    section.querySelector('.add').addEventListener('click', () => {
      const fresh = row({}, true);
      rows.append(fresh);
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
  function contentOf(payload) {
    return JSON.stringify({ name: payload.name, departments: payload.departments });
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
    renderDepartments(normalizeDepartmentRecords(data.departments, defaultDepartments));
    setListTitle(data.name);
    updateProgress();
    return true;
  }
  function save(immediately = false) {
    const payload = currentPayload();
    const serialized = JSON.stringify(payload);
    localStorage.setItem(localStorageKey, serialized);
    setListTitle(payload.name);
    updateProgress();
    if (!cloudReady) return;
    clearTimeout(saveTimer);
    setSync('שמירת שינויים…');
    const write = () => {
      lastSavedContent = contentOf(payload);
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
        if (result.exists()) {
          const incoming = normalizePayload(result.val());
          if (incoming && contentOf(incoming) !== lastSavedContent) restore(incoming);
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
  connectCloud();

  listNameInput.addEventListener('input', save);
  document.querySelector('#add-category').addEventListener('click', () => {
    list.querySelector('.empty-list')?.remove();
    const section = category();
    list.append(section);
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
  shareButton.addEventListener('click', shareCurrentList);
}
