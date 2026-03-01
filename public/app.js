/* ═══════════════════════════════════════════════════════════════════════════
   Canvas Homework Tracker — frontend
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Storage helpers ──────────────────────────────────────────────────────────
const LS = {
  get:    (k)    => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set:    (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  remove: (k)    => localStorage.removeItem(k),
};

const KEY_JWT       = 'cht_jwt';
const KEY_SESSION   = 'cht_session';
const KEY_HIDDEN    = 'cht_hidden';
const KEY_THEME     = 'cht_theme';
const KEY_ORDER     = 'cht_order';
const KEY_CUSTOM    = 'cht_custom';
const KEY_TIMEFRAME = 'cht_timeframe';

// ─── App state ────────────────────────────────────────────────────────────────
let appState = {
  mode:            'auth',
  jwt:             null,
  email:           null,
  hiddenCourses:   [],
  courseOrder:     [],
  customClasses:   [],
  customTimeframe: 30,   // days; 0 = all time
};

// ─── Color palette ────────────────────────────────────────────────────────────
const CLASS_COLORS = [
  '#e53935', '#f4511e', '#f6bf26', '#0b8043',
  '#039be5', '#3f51b5', '#8e24aa', '#e91e63',
];
let selectedColor   = CLASS_COLORS[4];
let selectedAiColor = CLASS_COLORS[4];

// ─── ID generator ─────────────────────────────────────────────────────────────
function genId() {
  return 'custom_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── Grid cache ───────────────────────────────────────────────────────────────
let cachedCourses     = [];
let cachedAssignments = [];
let cachedColors      = {};

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
function toggleTheme() {
  const next = (LS.get(KEY_THEME) || 'light') === 'light' ? 'dark' : 'light';
  LS.set(KEY_THEME, next); applyTheme(next);
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res  = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function authHeaders() {
  if (appState.jwt) return { Authorization: `Bearer ${appState.jwt}` };
  const s = LS.get(KEY_SESSION) || {};
  return {
    'x-canvas-token': s.canvasToken || '',
    'x-canvas-url':   `https://${s.canvasUrl || 'dublinusd.instructure.com'}`,
  };
}

async function fetchCourses()              { return apiFetch('/api/canvas/courses', { headers: authHeaders() }); }
async function fetchAssignments(courseId)  { return apiFetch(`/api/canvas/courses/${courseId}/assignments`, { headers: authHeaders() }); }
async function fetchColors()               { try { return await apiFetch('/api/canvas/colors', { headers: authHeaders() }); } catch { return {}; } }

// ─── Hidden courses ───────────────────────────────────────────────────────────
function isHidden(id) { return appState.hiddenCourses.some(h => String(h.id) === String(id)); }

async function hideCourse(id, name) {
  const updated = [...appState.hiddenCourses.filter(h => String(h.id) !== String(id)), { id, name }];
  appState.hiddenCourses = updated;
  if (appState.mode === 'account') {
    apiFetch('/api/user/hidden-courses', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ hiddenCourses: updated }) }).catch(() => {});
  } else { LS.set(KEY_HIDDEN, updated); }
}

async function restoreCourse(id) {
  const updated = appState.hiddenCourses.filter(h => String(h.id) !== String(id));
  appState.hiddenCourses = updated;
  if (appState.mode === 'account') {
    apiFetch('/api/user/hidden-courses', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ hiddenCourses: updated }) }).catch(() => {});
  } else { LS.set(KEY_HIDDEN, updated); }
  renderHiddenList();
}

// ─── Course order ─────────────────────────────────────────────────────────────
async function saveCourseOrder(order) {
  appState.courseOrder = order;
  LS.set(KEY_ORDER, order);
  if (appState.mode === 'account') {
    apiFetch('/api/user/course-order', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ courseOrder: order }) }).catch(() => {});
  }
}

// ─── Custom classes ───────────────────────────────────────────────────────────
async function saveCustomClasses(classes) {
  appState.customClasses = classes;
  LS.set(KEY_CUSTOM, classes);
  if (appState.mode === 'account') {
    apiFetch('/api/user/custom-classes', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ customClasses: classes }) }).catch(() => {});
  }
}

// ─── Custom timeframe ─────────────────────────────────────────────────────────
function saveTimeframe(days) {
  appState.customTimeframe = days;
  LS.set(KEY_TIMEFRAME, days);
}

function isVisibleByTimeframe(a) {
  if (appState.customTimeframe === 0) return true;  // all time
  if (!a.due_at) return true;                        // no date = always show
  if (a.done)    return true;                        // done = always show
  const dueMs  = new Date(a.due_at).getTime();
  const cutoff = Date.now() + appState.customTimeframe * 86_400_000;
  return dueMs <= cutoff; // overdue or within window
}

// ─── Due-date helpers ─────────────────────────────────────────────────────────
function dueCategory(dueAt) {
  if (!dueAt) return 'none';
  const days = (new Date(dueAt) - Date.now()) / 86_400_000;
  if (days < 0) return 'urgent';
  if (days < 2) return 'urgent';
  if (days < 7) return 'soon';
  return 'later';
}
function formatDue(dueAt) {
  if (!dueAt) return 'No due date';
  const due  = new Date(dueAt);
  const days = (due - Date.now()) / 86_400_000;
  const time = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days < 0)  return 'Past due';
  if (days < 1)  return `Today at ${time}`;
  if (days < 2)  return `Tomorrow at ${time}`;
  if (days < 7)  return due.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return due.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Color swatch helper ──────────────────────────────────────────────────────
function setupColorSwatches(containerId, initial, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = CLASS_COLORS.map(c =>
    `<button class="color-swatch${c === initial ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>`
  ).join('');
  container.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onChange(btn.dataset.color);
    });
  });
}

// ─── Render one Canvas course column ─────────────────────────────────────────
function renderColumn(course, assignments, color) {
  const col = document.createElement('div');
  col.className = 'course-col';
  col.dataset.courseId = String(course.id);
  col.draggable = true;
  col.style.setProperty('--course-color', color || '#888888');

  const isSubmitted = (a) => { const s = a.submission?.workflow_state; return s === 'submitted' || s === 'graded'; };

  const todo = [...assignments].filter(a => !isSubmitted(a)).sort((a, b) => {
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1; if (!b.due_at) return -1;
    return new Date(a.due_at) - new Date(b.due_at);
  });
  const done = [...assignments].filter(a => isSubmitted(a)).sort((a, b) => new Date(b.due_at || 0) - new Date(a.due_at || 0));

  const renderItem = (a, completed) => {
    const cat = completed ? 'done' : dueCategory(a.due_at);
    const pts = a.points_possible != null ? `<div class="assignment-pts">${a.points_possible} pts</div>` : '';
    return `<li class="assignment-item${completed ? ' completed' : ''}">
      <div class="due-dot ${cat}"></div>
      <div class="assignment-info">
        <a class="assignment-link" href="${esc(a.html_url)}" target="_blank" rel="noopener" draggable="false" title="${esc(a.name)}">${esc(a.name)}</a>
        <div class="assignment-due ${cat}">${completed ? '✓ Submitted' : formatDue(a.due_at)}</div>
      </div>${pts}</li>`;
  };

  let bodyHtml = '';
  if (!todo.length && !done.length) {
    bodyHtml = `<div class="no-assignments">All caught up ✓</div>`;
  } else {
    const doneHtml = done.length ? `<li class="completed-divider"></li>` + done.map(a => renderItem(a, true)).join('') : '';
    bodyHtml = `<ul class="assignment-list">${todo.map(a => renderItem(a, false)).join('')}${doneHtml}</ul>`;
  }

  col.innerHTML = `
    <div class="course-header">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="course-header-text">
        <div class="course-name">${esc(course.name)}</div>
        ${course.course_code ? `<div class="course-code">${esc(course.course_code)}</div>` : ''}
      </div>
      <button class="hide-course-btn" title="Hide" data-course-id="${course.id}" data-course-name="${esc(course.name)}">×</button>
    </div>${bodyHtml}`;

  col.querySelector('.hide-course-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await hideCourse(e.currentTarget.dataset.courseId, e.currentTarget.dataset.courseName);
    col.remove();
    checkGridEmpty();
  });

  return col;
}

// ─── Render one custom class column ──────────────────────────────────────────
function renderCustomColumn(cls) {
  const col = document.createElement('div');
  col.className = 'course-col custom-col';
  col.dataset.courseId = cls.id;
  col.draggable = true;
  col.style.setProperty('--course-color', cls.color || '#888888');

  function rebuild() {
    col.innerHTML = '';

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'course-header';

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.title = 'Drag to reorder';
    handle.textContent = '⠿';

    const headerText = document.createElement('div');
    headerText.className = 'course-header-text';
    headerText.innerHTML = `<div class="course-name">${esc(cls.name)}</div><div class="course-code">Custom class</div>`;

    // Edit button (pencil)
    const editBtn = document.createElement('button');
    editBtn.className = 'hide-course-btn';
    editBtn.title = 'Edit name/color';
    editBtn.innerHTML = '✎';
    editBtn.style.marginRight = '4px';
    editBtn.addEventListener('click', () => {
      // Replace header content with inline edit form
      header.innerHTML = '';

      const form = document.createElement('div');
      form.className = 'header-edit-form';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'inline-input';
      nameInput.value = cls.name;
      nameInput.placeholder = 'Class name';

      let editColor = cls.color;
      const swatchRow = document.createElement('div');
      swatchRow.className = 'color-swatches header-swatches';
      CLASS_COLORS.forEach(c => {
        const sw = document.createElement('button');
        sw.className = `color-swatch${c === cls.color ? ' selected' : ''}`;
        sw.style.background = c;
        sw.addEventListener('click', () => {
          swatchRow.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
          sw.classList.add('selected');
          editColor = c;
        });
        swatchRow.appendChild(sw);
      });

      const actions = document.createElement('div');
      actions.className = 'inline-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-link';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', rebuild);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'font-size:11px;padding:5px 10px;';
      saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        if (!newName) return;
        cls.name  = newName;
        cls.color = editColor;
        col.style.setProperty('--course-color', cls.color);
        await saveCustomClasses(appState.customClasses);
        rebuild();
      });
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); if (e.key === 'Escape') rebuild(); });

      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      form.appendChild(nameInput);
      form.appendChild(swatchRow);
      form.appendChild(actions);
      header.appendChild(form);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'hide-course-btn';
    delBtn.title = 'Delete class';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${cls.name}"? This cannot be undone.`)) return;
      await saveCustomClasses(appState.customClasses.filter(c => c.id !== cls.id));
      await saveCourseOrder(appState.courseOrder.filter(o => o !== cls.id));
      col.remove();
      checkGridEmpty();
    });

    header.appendChild(handle);
    header.appendChild(headerText);
    header.appendChild(editBtn);
    header.appendChild(delBtn);
    col.appendChild(header);

    // ── Assignments ── (filtered by timeframe)
    const visible = cls.assignments.filter(isVisibleByTimeframe);
    const hidden  = cls.assignments.length - visible.length;

    const todoItems = visible.filter(a => !a.done).sort((a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1; if (!b.due_at) return -1;
      return new Date(a.due_at) - new Date(b.due_at);
    });
    const doneItems = visible.filter(a => a.done);

    const makeItem = (a) => {
      const li = document.createElement('li');
      li.className = `assignment-item custom-assignment${a.done ? ' completed' : ''}`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'assignment-checkbox';
      cb.checked = a.done;
      cb.addEventListener('change', async () => {
        a.done = cb.checked;
        await saveCustomClasses(appState.customClasses);
        rebuild();
      });

      const info = document.createElement('div');
      info.className = 'assignment-info';
      const nameEl = a.url
        ? `<a class="assignment-link" href="${esc(a.url)}" target="_blank" rel="noopener" draggable="false">${esc(a.name)}</a>`
        : `<span class="assignment-link">${esc(a.name)}</span>`;
      info.innerHTML = nameEl + `<div class="assignment-due${a.done ? ' done' : ''}">${a.done ? '✓ Done' : formatDue(a.due_at)}</div>`;

      const xBtn = document.createElement('button');
      xBtn.className = 'custom-del-btn';
      xBtn.title = 'Remove';
      xBtn.textContent = '×';
      xBtn.addEventListener('click', async () => {
        cls.assignments = cls.assignments.filter(x => x.id !== a.id);
        await saveCustomClasses(appState.customClasses);
        rebuild();
      });

      li.appendChild(cb); li.appendChild(info); li.appendChild(xBtn);
      return li;
    };

    if (visible.length === 0 && cls.assignments.length === 0) {
      col.appendChild(Object.assign(document.createElement('div'), { className: 'no-assignments', textContent: 'No assignments yet.' }));
    } else if (visible.length === 0) {
      col.appendChild(Object.assign(document.createElement('div'), { className: 'no-assignments', textContent: `${hidden} assignment${hidden !== 1 ? 's' : ''} outside the current time range.` }));
    } else {
      const list = document.createElement('ul');
      list.className = 'assignment-list';
      todoItems.forEach(a => list.appendChild(makeItem(a)));
      if (doneItems.length) {
        const divLi = document.createElement('li');
        divLi.className = 'completed-divider';
        list.appendChild(divLi);
        doneItems.forEach(a => list.appendChild(makeItem(a)));
      }
      if (hidden > 0) {
        const hiddenNote = document.createElement('li');
        hiddenNote.className = 'timeframe-hidden-note';
        hiddenNote.textContent = `+${hidden} more outside time range`;
        list.appendChild(hiddenNote);
      }
      col.appendChild(list);
    }

    // ── Add assignment row ──
    const addRow = document.createElement('div');
    addRow.className = 'add-assignment-row';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-assignment-btn btn-link';
    addBtn.textContent = '＋ Add assignment';
    addBtn.addEventListener('click', () => {
      addRow.innerHTML = '';
      const form = document.createElement('div');
      form.className = 'inline-add-form';

      const nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.className = 'inline-input'; nameInput.placeholder = 'Assignment name';

      const dateInput = document.createElement('input');
      dateInput.type = 'date'; dateInput.className = 'inline-input';

      const urlInput = document.createElement('input');
      urlInput.type = 'url'; urlInput.className = 'inline-input'; urlInput.placeholder = 'Link (optional)';

      const actions = document.createElement('div');
      actions.className = 'inline-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-link'; cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', rebuild);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary'; saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        cls.assignments.push({
          id: genId(), name,
          due_at: dateInput.value ? new Date(dateInput.value + 'T23:59:00').toISOString() : null,
          url:    urlInput.value.trim() || null,
          done:   false,
        });
        await saveCustomClasses(appState.customClasses);
        rebuild();
      });
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); });

      actions.appendChild(cancelBtn); actions.appendChild(saveBtn);
      form.appendChild(nameInput); form.appendChild(dateInput); form.appendChild(urlInput); form.appendChild(actions);
      addRow.appendChild(form);
      nameInput.focus();
    });

    addRow.appendChild(addBtn);
    col.appendChild(addRow);
  }

  rebuild();
  return col;
}

// ─── Grid helpers ─────────────────────────────────────────────────────────────
function checkGridEmpty() {
  const grid = document.getElementById('grid');
  if (!grid.children.length) {
    grid.innerHTML = '<div class="status-empty">All classes are hidden. Restore them in Settings.</div>';
  }
}

function showLoading() {
  document.getElementById('status-area').innerHTML =
    `<div class="status-loading"><span class="spinner"></span>Loading your classes…</div>`;
  document.getElementById('grid').innerHTML = '';
}
function showError(msg) {
  document.getElementById('status-area').innerHTML =
    `<div class="status-error"><span>⚠</span> ${esc(msg)}</div>`;
}
function clearStatus() { document.getElementById('status-area').innerHTML = ''; }

// ─── Render grid from cache ───────────────────────────────────────────────────
function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  const colMap = new Map();
  cachedCourses.forEach((course, i) => {
    if (isHidden(course.id)) return;
    colMap.set(String(course.id), () => renderColumn(course, cachedAssignments[i] || [], cachedColors[`course_${course.id}`] || null));
  });
  appState.customClasses.forEach(cls => {
    if (isHidden(cls.id)) return;
    colMap.set(cls.id, () => renderCustomColumn(cls));
  });

  const seen = new Set();
  const ordered = [];
  for (const id of appState.courseOrder) {
    const sid = String(id);
    if (colMap.has(sid) && !seen.has(sid)) { ordered.push(sid); seen.add(sid); }
  }
  for (const id of colMap.keys()) { if (!seen.has(id)) ordered.push(id); }
  for (const id of ordered) { const f = colMap.get(id); if (f) grid.appendChild(f()); }

  checkGridEmpty();
  document.getElementById('last-updated').textContent =
    `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// ─── Main data load ───────────────────────────────────────────────────────────
async function loadData() {
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.classList.add('spinning');
  showLoading();
  try {
    const [courses, colors] = await Promise.all([fetchCourses(), fetchColors()]);
    const allAssignments = await Promise.all(courses.map(c => fetchAssignments(c.id).catch(() => [])));
    cachedCourses = courses; cachedAssignments = allAssignments; cachedColors = colors;
    clearStatus();
    renderGrid();
  } catch (err) {
    showError(err.message || 'Could not load Canvas data.');
    document.getElementById('grid').innerHTML = '';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// ─── Drag-and-drop ────────────────────────────────────────────────────────────
function initDragDrop() {
  const grid = document.getElementById('grid');
  let dragSrc = null;

  grid.addEventListener('dragstart', e => {
    const col = e.target.closest('.course-col');
    if (!col) return;
    dragSrc = col;
    col.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', col.dataset.courseId);
  });
  grid.addEventListener('dragover', e => {
    e.preventDefault();
    const col = e.target.closest('.course-col');
    if (!col || col === dragSrc) return;
    grid.querySelectorAll('.course-col.drag-over').forEach(c => c.classList.remove('drag-over'));
    col.classList.add('drag-over');
  });
  grid.addEventListener('dragleave', e => {
    const col = e.target.closest('.course-col');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
  });
  grid.addEventListener('drop', async e => {
    e.preventDefault();
    const col = e.target.closest('.course-col');
    if (!col || col === dragSrc) return;
    col.classList.remove('drag-over');
    const rect = col.getBoundingClientRect();
    grid.insertBefore(dragSrc, e.clientX < rect.left + rect.width / 2 ? col : col.nextSibling);
    await saveCourseOrder([...grid.querySelectorAll('.course-col')].map(c => c.dataset.courseId));
  });
  grid.addEventListener('dragend', () => {
    grid.querySelectorAll('.course-col').forEach(c => c.classList.remove('dragging', 'drag-over'));
    dragSrc = null;
  });
}

// ─── Auth modal ───────────────────────────────────────────────────────────────
function showAuthPage(id) {
  ['auth-page-token', 'auth-page-signin', 'auth-page-create', 'auth-page-forgot'].forEach(p => {
    document.getElementById(p).classList.toggle('hidden', p !== id);
  });
}
function setAuthError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.classList.toggle('hidden', !msg);
}
function openAuthModal() {
  showAuthPage('auth-page-token');
  document.getElementById('auth-overlay').classList.remove('hidden');
}

// ─── After auth ───────────────────────────────────────────────────────────────
async function onAuthenticated(jwt) {
  appState.jwt = jwt; appState.mode = 'account';
  LS.set(KEY_JWT, jwt); LS.remove(KEY_SESSION);
  try {
    const me = await apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${jwt}` } });
    appState.email         = me.email;
    appState.hiddenCourses = Array.isArray(me.hidden_courses) ? me.hidden_courses : [];
    appState.courseOrder   = Array.isArray(me.course_order)   ? me.course_order   : LS.get(KEY_ORDER)  || [];
    appState.customClasses = Array.isArray(me.custom_classes) ? me.custom_classes : LS.get(KEY_CUSTOM) || [];
    LS.set(KEY_ORDER, appState.courseOrder);
    LS.set(KEY_CUSTOM, appState.customClasses);
  } catch {
    appState.hiddenCourses = [];
    appState.courseOrder   = LS.get(KEY_ORDER)  || [];
    appState.customClasses = LS.get(KEY_CUSTOM) || [];
  }
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('save-banner').classList.add('hidden');
  loadData();
}

function onSession(canvasToken, canvasUrl) {
  appState.mode = 'session'; appState.jwt = null;
  appState.hiddenCourses = LS.get(KEY_HIDDEN) || [];
  appState.courseOrder   = LS.get(KEY_ORDER)  || [];
  appState.customClasses = LS.get(KEY_CUSTOM) || [];
  LS.set(KEY_SESSION, { canvasToken, canvasUrl });
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('save-banner').classList.remove('hidden');
  loadData();
}

// ─── Settings modal ───────────────────────────────────────────────────────────
function renderHiddenList() {
  const container = document.getElementById('hidden-classes-list');
  const hidden = appState.hiddenCourses;
  if (!hidden.length) {
    container.innerHTML = '<p class="text-muted" style="font-size:12px;">No hidden classes.</p>';
    return;
  }
  container.innerHTML = hidden.map(h =>
    `<div class="hidden-class-row"><span>${esc(h.name)}</span><button class="restore-btn" data-id="${esc(h.id)}">Restore</button></div>`
  ).join('');
  container.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await restoreCourse(btn.dataset.id); renderGrid(); });
  });
}

function openSettingsModal() {
  const isAccount = appState.mode === 'account';
  document.getElementById('settings-auth-section').classList.toggle('hidden', !isAccount);
  document.getElementById('settings-session-section').classList.toggle('hidden', isAccount);
  document.getElementById('signout-btn').classList.toggle('hidden', !isAccount);

  if (isAccount) {
    document.getElementById('settings-email').textContent = appState.email || '';
    document.getElementById('update-token-input').value = '';
    document.getElementById('update-token-error').classList.add('hidden');
  } else {
    const s = LS.get(KEY_SESSION) || {};
    const isCustom = s.canvasUrl && s.canvasUrl !== 'dublinusd.instructure.com';
    const sel = document.getElementById('settings-school-select');
    sel.value = isCustom ? 'custom' : 'dublinusd.instructure.com';
    document.getElementById('settings-custom-url-group').classList.toggle('hidden', !isCustom);
    if (isCustom) document.getElementById('settings-custom-url').value = s.canvasUrl;
    document.getElementById('settings-token-input').value = s.canvasToken || '';
  }

  // Timeframe select
  const tfSel = document.getElementById('custom-timeframe-select');
  if (tfSel) tfSel.value = String(appState.customTimeframe);

  renderHiddenList();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

async function saveSettings() {
  const errEl = document.getElementById('settings-error');
  errEl.classList.add('hidden');

  // Save timeframe
  const tfSel = document.getElementById('custom-timeframe-select');
  if (tfSel) {
    saveTimeframe(Number(tfSel.value));
    renderGrid(); // re-render custom class columns with new timeframe
  }

  if (appState.mode === 'account') {
    const newToken = document.getElementById('update-token-input').value.trim();
    if (newToken) {
      try {
        await apiFetch('/api/user/canvas-token', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ canvasToken: newToken }) });
      } catch (err) {
        document.getElementById('update-token-error').textContent = err.message;
        document.getElementById('update-token-error').classList.remove('hidden');
        return;
      }
    }
  } else {
    const sel   = document.getElementById('settings-school-select');
    const token = document.getElementById('settings-token-input').value.trim();
    let   url   = sel.value === 'custom'
      ? document.getElementById('settings-custom-url').value.trim().replace(/^https?:\/\//i,'').replace(/\/$/,'')
      : sel.value;
    if (!url || !token) { errEl.textContent = 'School and token are required.'; errEl.classList.remove('hidden'); return; }
    const s = LS.get(KEY_SESSION) || {};
    LS.set(KEY_SESSION, { ...s, canvasToken: token, canvasUrl: url,
      classroomEnabled: document.getElementById('classroom-toggle').checked,
      classroomKey: document.getElementById('classroom-key-input').value.trim() });
  }

  document.getElementById('settings-overlay').classList.add('hidden');
  loadData();
}

// ─── Add custom class modal ───────────────────────────────────────────────────
let addTab = 'manual';  // 'manual' | 'ai'
let aiParsedData = null;

function openAddClassModal() {
  addTab = 'manual';
  aiParsedData = null;
  selectedColor   = CLASS_COLORS[4];
  selectedAiColor = CLASS_COLORS[4];

  document.getElementById('new-class-name').value = '';
  document.getElementById('ai-paste-input').value = '';
  document.getElementById('ai-preview').classList.add('hidden');
  document.getElementById('add-ai-error').classList.add('hidden');
  document.getElementById('add-class-error').classList.add('hidden');

  setupColorSwatches('color-swatches',    selectedColor,   c => { selectedColor   = c; });
  setupColorSwatches('ai-color-swatches', selectedAiColor, c => { selectedAiColor = c; });

  switchAddTab('manual');
  document.getElementById('add-class-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-class-name').focus(), 50);
}

function switchAddTab(tab) {
  addTab = tab;
  document.getElementById('add-tab-manual-btn').classList.toggle('active', tab === 'manual');
  document.getElementById('add-tab-ai-btn').classList.toggle('active', tab === 'ai');
  document.getElementById('add-manual-form').classList.toggle('hidden', tab !== 'manual');
  document.getElementById('add-ai-form').classList.toggle('hidden', tab !== 'ai');
  document.getElementById('ai-parse-btn').classList.toggle('hidden', tab !== 'ai' || aiParsedData !== null);
  document.getElementById('add-class-save-btn').textContent = tab === 'ai' && !aiParsedData ? 'Parse first' : 'Add Class';
  // Clear shared error when switching so it doesn't bleed across tabs
  document.getElementById('add-class-error').classList.add('hidden');
}

async function handleAiParse() {
  const text = document.getElementById('ai-paste-input').value.trim();
  if (!text) { showAddError('Paste some text first'); return; }

  const parseBtn = document.getElementById('ai-parse-btn');
  parseBtn.textContent = 'Parsing…';
  parseBtn.disabled = true;
  document.getElementById('add-ai-error').classList.add('hidden');

  try {
    const result = await apiFetch('/api/ai/parse-class', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    aiParsedData = result;
    document.getElementById('ai-class-name').value = result.className || '';
    document.getElementById('ai-count').textContent = result.assignments.length;
    setupColorSwatches('ai-color-swatches', selectedAiColor, c => { selectedAiColor = c; });
    document.getElementById('ai-preview').classList.remove('hidden');
    parseBtn.classList.add('hidden');
    document.getElementById('add-class-save-btn').textContent = 'Add Class';
  } catch (err) {
    document.getElementById('add-ai-error').textContent = err.message;
    document.getElementById('add-ai-error').classList.remove('hidden');
  } finally {
    parseBtn.textContent = 'Parse with AI';
    parseBtn.disabled = false;
  }
}

function showAddError(msg) {
  const el = document.getElementById('add-class-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function saveNewClass() {
  document.getElementById('add-class-error').classList.add('hidden');

  let cls;
  if (addTab === 'ai') {
    if (!aiParsedData) { showAddError('Parse your text first'); return; }
    const name = document.getElementById('ai-class-name').value.trim();
    if (!name) { showAddError('Enter a class name'); return; }
    cls = {
      id:          genId(),
      name,
      color:       selectedAiColor,
      assignments: (aiParsedData.assignments || []).map(a => ({ ...a, id: genId(), done: false })),
    };
  } else {
    const name = document.getElementById('new-class-name').value.trim();
    if (!name) { showAddError('Enter a class name'); return; }
    cls = { id: genId(), name, color: selectedColor, assignments: [] };
  }

  await saveCustomClasses([...appState.customClasses, cls]);
  await saveCourseOrder([cls.id, ...appState.courseOrder]);

  document.getElementById('add-class-overlay').classList.add('hidden');

  const grid = document.getElementById('grid');
  const emptyMsg = grid.querySelector('.status-empty');
  if (emptyMsg) emptyMsg.remove();
  grid.insertBefore(renderCustomColumn(cls), grid.firstChild);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(LS.get(KEY_THEME) || 'light');
  appState.customTimeframe = LS.get(KEY_TIMEFRAME) ?? 30;
  initDragDrop();

  // Theme
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);
  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', loadData);

  // Add class modal
  document.getElementById('add-class-btn').addEventListener('click', openAddClassModal);
  document.getElementById('add-class-cancel-btn').addEventListener('click', () => {
    document.getElementById('add-class-overlay').classList.add('hidden');
  });
  document.getElementById('add-class-save-btn').addEventListener('click', saveNewClass);
  document.getElementById('new-class-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveNewClass(); });
  document.getElementById('add-tab-manual-btn').addEventListener('click', () => switchAddTab('manual'));
  document.getElementById('add-tab-ai-btn').addEventListener('click', () => switchAddTab('ai'));
  document.getElementById('ai-parse-btn').addEventListener('click', handleAiParse);

  // Auth nav
  document.getElementById('have-account-btn').addEventListener('click', () => { setAuthError('login-error',''); showAuthPage('auth-page-signin'); });
  document.getElementById('back-to-token-btn').addEventListener('click', () => { setAuthError('token-error',''); showAuthPage('auth-page-token'); });

  // School select
  document.getElementById('session-school-select').addEventListener('change', e => {
    document.getElementById('session-custom-url-group').classList.toggle('hidden', e.target.value !== 'custom');
  });

  // Sign in — Enter on both email and password fields
  document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-btn').click(); });
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-btn').click(); });
  document.getElementById('login-btn').addEventListener('click', async () => {
    setAuthError('login-error', '');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) { setAuthError('login-error', 'Email and password required'); return; }
    try {
      const { token } = await apiFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      await onAuthenticated(token);
    } catch (err) { setAuthError('login-error', err.message); }
  });

  // Forgot password
  document.getElementById('forgot-pw-btn').addEventListener('click', () => {
    showAuthPage('auth-page-forgot');
    document.getElementById('reset-pw-section').classList.add('hidden');
    document.getElementById('verify-reset-btn').textContent = 'Verify';
    document.getElementById('verify-reset-btn').dataset.step = 'verify';
    setAuthError('forgot-error', '');
  });
  document.getElementById('back-to-signin-btn').addEventListener('click', () => showAuthPage('auth-page-token'));

  let resetVerifiedToken = null;
  document.getElementById('verify-reset-btn').addEventListener('click', async () => {
    const step = document.getElementById('verify-reset-btn').dataset.step || 'verify';
    setAuthError('forgot-error', '');
    if (step === 'verify') {
      const token = document.getElementById('reset-token-input').value.trim();
      if (!token) { setAuthError('forgot-error', 'Paste your Canvas token'); return; }
      try {
        const { email } = await apiFetch('/api/auth/check-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvasToken: token }) });
        resetVerifiedToken = token;
        document.getElementById('reset-email-display').textContent = email;
        document.getElementById('reset-pw-section').classList.remove('hidden');
        document.getElementById('verify-reset-btn').textContent = 'Reset Password';
        document.getElementById('verify-reset-btn').dataset.step = 'reset';
      } catch (err) { setAuthError('forgot-error', err.message); }
    } else {
      const newPassword = document.getElementById('reset-new-password').value;
      if (!newPassword) { setAuthError('forgot-error', 'Enter a new password'); return; }
      try {
        const { token } = await apiFetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvasToken: resetVerifiedToken, newPassword }) });
        await onAuthenticated(token);
      } catch (err) { setAuthError('forgot-error', err.message); }
    }
  });

  // Canvas token continue (Enter key)
  document.getElementById('session-token-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('token-continue-btn').click(); });
  let pendingTokenData = null;
  document.getElementById('token-continue-btn').addEventListener('click', async () => {
    setAuthError('token-error', '');
    const rawToken = document.getElementById('session-token-input').value.trim();
    const sel = document.getElementById('session-school-select');
    let url = sel.value === 'custom'
      ? document.getElementById('session-custom-url').value.trim().replace(/^https?:\/\//i,'').replace(/\/$/,'')
      : sel.value;
    if (!rawToken) { setAuthError('token-error', 'Paste your Canvas token first'); return; }
    if (!url)      { setAuthError('token-error', 'Enter your school URL'); return; }
    try {
      const { email, name } = await apiFetch('/api/auth/check-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvasToken: rawToken, canvasUrl: url }) });
      pendingTokenData = { token: rawToken, url, email };
      document.getElementById('found-name').textContent = name || '';
      document.getElementById('found-email').textContent = email;
      document.getElementById('reg-password').value = '';
      setAuthError('reg-error', '');
      showAuthPage('auth-page-create');
    } catch (err) { setAuthError('token-error', err.message); }
  });

  // Create account
  document.getElementById('create-account-btn').addEventListener('click', async () => {
    setAuthError('reg-error', '');
    if (!pendingTokenData) return;
    const password = document.getElementById('reg-password').value;
    if (!password) { setAuthError('reg-error', 'Enter a password'); return; }
    try {
      const { token } = await apiFetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvasToken: pendingTokenData.token, canvasUrl: pendingTokenData.url, password }) });
      await onAuthenticated(token);
    } catch (err) { setAuthError('reg-error', err.message); }
  });

  // Skip → session mode
  document.getElementById('skip-account-btn').addEventListener('click', () => {
    if (!pendingTokenData) return;
    onSession(pendingTokenData.token, pendingTokenData.url);
  });

  // Save banner
  document.getElementById('banner-create-btn').addEventListener('click', () => {
    document.getElementById('save-banner').classList.add('hidden');
    if (pendingTokenData) { showAuthPage('auth-page-create'); document.getElementById('auth-overlay').classList.remove('hidden'); }
    else openAuthModal();
  });
  document.getElementById('banner-dismiss-btn').addEventListener('click', () => {
    document.getElementById('save-banner').classList.add('hidden');
  });

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
  document.getElementById('settings-cancel-btn').addEventListener('click', () => { document.getElementById('settings-overlay').classList.add('hidden'); });
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);
  document.getElementById('settings-school-select').addEventListener('change', e => {
    document.getElementById('settings-custom-url-group').classList.toggle('hidden', e.target.value !== 'custom');
  });
  document.getElementById('classroom-toggle').addEventListener('change', e => {
    document.getElementById('classroom-fields').classList.toggle('hidden', !e.target.checked);
  });

  // Sign out
  document.getElementById('signout-btn').addEventListener('click', () => {
    LS.remove(KEY_JWT); LS.remove(KEY_SESSION);
    appState = { mode: 'auth', jwt: null, email: null, hiddenCourses: [], courseOrder: [], customClasses: [], customTimeframe: LS.get(KEY_TIMEFRAME) ?? 30 };
    cachedCourses = []; cachedAssignments = []; cachedColors = {};
    document.getElementById('settings-overlay').classList.add('hidden');
    document.getElementById('grid').innerHTML = '';
    clearStatus();
    openAuthModal();
  });

  // Close modals on backdrop click + Escape
  ['settings-overlay', 'add-class-overlay'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      if (e.target === document.getElementById(id)) document.getElementById(id).classList.add('hidden');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('settings-overlay').classList.add('hidden');
      document.getElementById('add-class-overlay').classList.add('hidden');
    }
  });

  // ── Boot sequence ──────────────────────────────────────────────────────────
  const savedJwt     = LS.get(KEY_JWT);
  const savedSession = LS.get(KEY_SESSION);

  if (savedJwt) {
    apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${savedJwt}` } })
      .then(me => {
        appState.jwt           = savedJwt;
        appState.mode          = 'account';
        appState.email         = me.email;
        appState.hiddenCourses = Array.isArray(me.hidden_courses) ? me.hidden_courses : [];
        appState.courseOrder   = Array.isArray(me.course_order)   ? me.course_order   : LS.get(KEY_ORDER)  || [];
        appState.customClasses = Array.isArray(me.custom_classes) ? me.custom_classes : LS.get(KEY_CUSTOM) || [];
        LS.set(KEY_ORDER,  appState.courseOrder);
        LS.set(KEY_CUSTOM, appState.customClasses);
        loadData();
      })
      .catch(() => { LS.remove(KEY_JWT); openAuthModal(); });
  } else if (savedSession?.canvasToken) {
    appState.mode          = 'session';
    appState.hiddenCourses = LS.get(KEY_HIDDEN) || [];
    appState.courseOrder   = LS.get(KEY_ORDER)  || [];
    appState.customClasses = LS.get(KEY_CUSTOM) || [];
    document.getElementById('save-banner').classList.remove('hidden');
    loadData();
  } else {
    openAuthModal();
  }
});
