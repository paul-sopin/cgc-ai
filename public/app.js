/* ═══════════════════════════════════════════════════════════════════════════
   Canvas Homework Tracker — frontend
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Storage helpers ──────────────────────────────────────────────────────────
const LS = {
  get:    (k)    => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set:    (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  remove: (k)    => localStorage.removeItem(k),
};

// Keys
const KEY_JWT     = 'cht_jwt';
const KEY_SESSION = 'cht_session';   // { canvasToken, canvasUrl }
const KEY_HIDDEN  = 'cht_hidden';    // [{ id, name }]  — session mode only
const KEY_THEME   = 'cht_theme';
const KEY_ORDER   = 'cht_order';     // [string] — ordered course IDs
const KEY_CUSTOM  = 'cht_custom';    // [{id,name,color,assignments:[]}]

// ─── Auth state ───────────────────────────────────────────────────────────────
// mode: 'auth' | 'session' | 'account'
let appState = {
  mode:          'auth',
  jwt:           null,
  email:         null,
  hiddenCourses: [],
  courseOrder:   [],   // [courseId strings — canvas IDs as strings + custom IDs]
  customClasses: [],   // [{id,name,color,assignments:[{id,name,due_at,url,done}]}]
};

// ─── Color palette for custom classes ─────────────────────────────────────────
const CLASS_COLORS = [
  '#e53935', '#f4511e', '#f6bf26', '#0b8043',
  '#039be5', '#3f51b5', '#8e24aa', '#e91e63',
];
let selectedColor = CLASS_COLORS[4]; // default blue

// ─── Simple ID generator ──────────────────────────────────────────────────────
function genId() {
  return 'custom_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── Grid cache (Canvas data) ─────────────────────────────────────────────────
let cachedCourses      = [];
let cachedAssignments  = [];  // parallel array to cachedCourses
let cachedColors       = {};

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
function toggleTheme() {
  const next = (LS.get(KEY_THEME) || 'light') === 'light' ? 'dark' : 'light';
  LS.set(KEY_THEME, next); applyTheme(next);
}

// ─── API fetch helpers ────────────────────────────────────────────────────────
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

async function fetchCourses() {
  return apiFetch('/api/canvas/courses', { headers: authHeaders() });
}
async function fetchAssignments(courseId) {
  return apiFetch(`/api/canvas/courses/${courseId}/assignments`, { headers: authHeaders() });
}
async function fetchColors() {
  try { return await apiFetch('/api/canvas/colors', { headers: authHeaders() }); }
  catch { return {}; }
}

// ─── Hidden courses ───────────────────────────────────────────────────────────
function getHidden() { return appState.hiddenCourses; }

function isHidden(courseId) {
  return getHidden().some(h => String(h.id) === String(courseId));
}

async function hideCourse(id, name) {
  const updated = [...getHidden().filter(h => String(h.id) !== String(id)), { id, name }];
  appState.hiddenCourses = updated;
  if (appState.mode === 'account') {
    await apiFetch('/api/user/hidden-courses', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ hiddenCourses: updated }),
    }).catch(() => {});
  } else {
    LS.set(KEY_HIDDEN, updated);
  }
}

async function restoreCourse(id) {
  const updated = getHidden().filter(h => String(h.id) !== String(id));
  appState.hiddenCourses = updated;
  if (appState.mode === 'account') {
    await apiFetch('/api/user/hidden-courses', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ hiddenCourses: updated }),
    }).catch(() => {});
  } else {
    LS.set(KEY_HIDDEN, updated);
  }
  renderHiddenList();
}

// ─── Course order ─────────────────────────────────────────────────────────────
async function saveCourseOrder(order) {
  appState.courseOrder = order;
  LS.set(KEY_ORDER, order);
  if (appState.mode === 'account') {
    apiFetch('/api/user/course-order', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ courseOrder: order }),
    }).catch(() => {});
  }
}

// ─── Custom classes ───────────────────────────────────────────────────────────
async function saveCustomClasses(classes) {
  appState.customClasses = classes;
  LS.set(KEY_CUSTOM, classes);
  if (appState.mode === 'account') {
    apiFetch('/api/user/custom-classes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ customClasses: classes }),
    }).catch(() => {});
  }
}

// ─── Due-date helpers ─────────────────────────────────────────────────────────
function dueCategory(dueAt) {
  if (!dueAt) return 'none';
  const days = (new Date(dueAt) - Date.now()) / 86_400_000;
  if (days < 0) return 'urgent';
  if (days < 1) return 'urgent';
  if (days < 2) return 'soon';
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

// ─── HTML escaping ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Render one Canvas course column ─────────────────────────────────────────
function renderColumn(course, assignments, color) {
  const col = document.createElement('div');
  col.className = 'course-col';
  col.dataset.courseId = String(course.id);
  col.draggable = true;
  col.style.setProperty('--course-color', color || '#888888');

  const isSubmitted = (a) => {
    const s = a.submission?.workflow_state;
    return s === 'submitted' || s === 'graded';
  };

  const todo = [...assignments]
    .filter(a => !isSubmitted(a))
    .sort((a, b) => {
      if (!a.due_at && !b.due_at) return 0;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at) - new Date(b.due_at);
    });

  const done = [...assignments]
    .filter(a => isSubmitted(a))
    .sort((a, b) => new Date(b.due_at || 0) - new Date(a.due_at || 0));

  const header = `
    <div class="course-header">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="course-header-text">
        <div class="course-name">${esc(course.name)}</div>
        ${course.course_code ? `<div class="course-code">${esc(course.course_code)}</div>` : ''}
      </div>
      <button class="hide-course-btn" title="Hide this class" data-course-id="${course.id}" data-course-name="${esc(course.name)}">×</button>
    </div>`;

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
  if (todo.length === 0 && done.length === 0) {
    bodyHtml = `<div class="no-assignments">All caught up ✓</div>`;
  } else {
    const todoHtml = todo.map(a => renderItem(a, false)).join('');
    const doneHtml = done.length
      ? `<li class="completed-divider"></li>` + done.map(a => renderItem(a, true)).join('')
      : '';
    bodyHtml = `<ul class="assignment-list">${todoHtml}${doneHtml}</ul>`;
  }

  col.innerHTML = header + bodyHtml;

  col.querySelector('.hide-course-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const id   = e.currentTarget.dataset.courseId;
    const name = e.currentTarget.dataset.courseName;
    await hideCourse(id, name);
    col.remove();
    if (!document.getElementById('grid').children.length) {
      document.getElementById('grid').innerHTML =
        '<div class="status-empty">All classes are hidden. Restore them in Settings.</div>';
    }
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

    const delBtn = document.createElement('button');
    delBtn.className = 'hide-course-btn';
    delBtn.title = 'Delete this class';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${cls.name}"? This cannot be undone.`)) return;
      const updated = appState.customClasses.filter(c => c.id !== cls.id);
      await saveCustomClasses(updated);
      const newOrder = appState.courseOrder.filter(o => o !== cls.id);
      await saveCourseOrder(newOrder);
      col.remove();
      if (!document.getElementById('grid').children.length) {
        document.getElementById('grid').innerHTML =
          '<div class="status-empty">All classes are hidden. Restore them in Settings.</div>';
      }
    });

    header.appendChild(handle);
    header.appendChild(headerText);
    header.appendChild(delBtn);
    col.appendChild(header);

    // ── Assignments ──
    const todoItems = cls.assignments
      .filter(a => !a.done)
      .sort((a, b) => {
        if (!a.due_at && !b.due_at) return 0;
        if (!a.due_at) return 1;
        if (!b.due_at) return -1;
        return new Date(a.due_at) - new Date(b.due_at);
      });
    const doneItems = cls.assignments.filter(a => a.done);

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
      const dueEl = `<div class="assignment-due${a.done ? ' done' : ''}">${a.done ? '✓ Done' : formatDue(a.due_at)}</div>`;
      info.innerHTML = nameEl + dueEl;

      const xBtn = document.createElement('button');
      xBtn.className = 'custom-del-btn';
      xBtn.title = 'Remove assignment';
      xBtn.textContent = '×';
      xBtn.addEventListener('click', async () => {
        cls.assignments = cls.assignments.filter(x => x.id !== a.id);
        await saveCustomClasses(appState.customClasses);
        rebuild();
      });

      li.appendChild(cb);
      li.appendChild(info);
      li.appendChild(xBtn);
      return li;
    };

    if (cls.assignments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-assignments';
      empty.textContent = 'No assignments yet.';
      col.appendChild(empty);
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
      col.appendChild(list);
    }

    // ── Add assignment row ──
    const addRow = document.createElement('div');
    addRow.className = 'add-assignment-row';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-assignment-btn btn-link';
    addBtn.textContent = '＋ Add assignment';
    addBtn.addEventListener('click', () => {
      // Replace button with inline form
      addRow.innerHTML = '';
      const form = document.createElement('div');
      form.className = 'inline-add-form';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'inline-input';
      nameInput.placeholder = 'Assignment name';

      const dateInput = document.createElement('input');
      dateInput.type = 'datetime-local';
      dateInput.className = 'inline-input';

      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'inline-input';
      urlInput.placeholder = 'Link (optional)';

      const actions = document.createElement('div');
      actions.className = 'inline-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-link';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', rebuild);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        const dateVal = dateInput.value;
        const url = urlInput.value.trim();
        cls.assignments.push({
          id:     genId(),
          name,
          due_at: dateVal ? new Date(dateVal).toISOString() : null,
          url:    url || null,
          done:   false,
        });
        await saveCustomClasses(appState.customClasses);
        rebuild();
      });

      // Enter key on name saves
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); });

      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      form.appendChild(nameInput);
      form.appendChild(dateInput);
      form.appendChild(urlInput);
      form.appendChild(actions);
      addRow.appendChild(form);
      nameInput.focus();
    });

    addRow.appendChild(addBtn);
    col.appendChild(addRow);
  }

  rebuild();
  return col;
}

// ─── Status helpers ───────────────────────────────────────────────────────────
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

// ─── Render grid from cache + custom classes ──────────────────────────────────
function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  // Build factory map: courseId → element
  const colMap = new Map();

  cachedCourses.forEach((course, i) => {
    if (isHidden(course.id)) return;
    colMap.set(String(course.id), () =>
      renderColumn(course, cachedAssignments[i] || [], cachedColors[`course_${course.id}`] || null)
    );
  });

  appState.customClasses.forEach(cls => {
    if (isHidden(cls.id)) return;
    colMap.set(cls.id, () => renderCustomColumn(cls));
  });

  // Order: saved order first (skip hidden), then remaining
  const seen = new Set();
  const orderedIds = [];

  for (const id of appState.courseOrder) {
    const sid = String(id);
    if (colMap.has(sid) && !seen.has(sid)) {
      orderedIds.push(sid);
      seen.add(sid);
    }
  }
  for (const id of colMap.keys()) {
    if (!seen.has(id)) orderedIds.push(id);
  }

  for (const id of orderedIds) {
    const factory = colMap.get(id);
    if (factory) grid.appendChild(factory());
  }

  if (!grid.children.length) {
    grid.innerHTML = '<div class="status-empty">All classes are hidden. Restore them in Settings.</div>';
  }

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
    const allAssignments = await Promise.all(
      courses.map(c => fetchAssignments(c.id).catch(() => []))
    );

    cachedCourses     = courses;
    cachedAssignments = allAssignments;
    cachedColors      = colors;

    clearStatus();
    renderGrid();
  } catch (err) {
    showError(err.message || 'Could not load Canvas data.');
    document.getElementById('grid').innerHTML = '';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// ─── Drag-and-drop reordering ─────────────────────────────────────────────────
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
    e.dataTransfer.dropEffect = 'move';
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
    if (e.clientX < rect.left + rect.width / 2) {
      grid.insertBefore(dragSrc, col);
    } else {
      grid.insertBefore(dragSrc, col.nextSibling);
    }
    const order = [...grid.querySelectorAll('.course-col')].map(c => c.dataset.courseId);
    await saveCourseOrder(order);
  });

  grid.addEventListener('dragend', () => {
    grid.querySelectorAll('.course-col').forEach(c => c.classList.remove('dragging', 'drag-over'));
    dragSrc = null;
  });
}

// ─── Auth modal helpers ───────────────────────────────────────────────────────
function showAuthPage(pageId) {
  ['auth-page-token', 'auth-page-signin', 'auth-page-create', 'auth-page-forgot'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', id !== pageId);
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

// ─── After successful auth ────────────────────────────────────────────────────
async function onAuthenticated(jwt) {
  appState.jwt  = jwt;
  appState.mode = 'account';
  LS.set(KEY_JWT, jwt);
  LS.remove(KEY_SESSION);

  try {
    const me = await apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${jwt}` } });
    appState.email         = me.email;
    appState.hiddenCourses = Array.isArray(me.hidden_courses)  ? me.hidden_courses  : [];
    appState.courseOrder   = Array.isArray(me.course_order)    ? me.course_order    : LS.get(KEY_ORDER)  || [];
    appState.customClasses = Array.isArray(me.custom_classes)  ? me.custom_classes  : LS.get(KEY_CUSTOM) || [];
    LS.set(KEY_ORDER,  appState.courseOrder);
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
  appState.mode          = 'session';
  appState.jwt           = null;
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
  const hidden    = getHidden();
  if (!hidden.length) {
    container.innerHTML = '<p class="text-muted" style="font-size:12px;">No hidden classes.</p>';
    return;
  }
  container.innerHTML = hidden.map(h => `
    <div class="hidden-class-row">
      <span>${esc(h.name)}</span>
      <button class="restore-btn" data-id="${esc(h.id)}">Restore</button>
    </div>`).join('');

  container.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await restoreCourse(btn.dataset.id);
      renderGrid();
    });
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

  renderHiddenList();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

async function saveSettings() {
  const errEl = document.getElementById('settings-error');
  errEl.classList.add('hidden');

  if (appState.mode === 'account') {
    const newToken = document.getElementById('update-token-input').value.trim();
    if (newToken) {
      try {
        await apiFetch('/api/user/canvas-token', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ canvasToken: newToken }),
        });
      } catch (err) {
        document.getElementById('update-token-error').textContent = err.message;
        document.getElementById('update-token-error').classList.remove('hidden');
        return;
      }
    }
  } else {
    const sel    = document.getElementById('settings-school-select');
    const token  = document.getElementById('settings-token-input').value.trim();
    let   url    = sel.value === 'custom'
      ? document.getElementById('settings-custom-url').value.trim().replace(/^https?:\/\//i,'').replace(/\/$/,'')
      : sel.value;

    if (!url || !token) { errEl.textContent = 'School and token are required.'; errEl.classList.remove('hidden'); return; }

    const classToggle = document.getElementById('classroom-toggle');
    const classKey    = document.getElementById('classroom-key-input').value.trim();
    const s           = LS.get(KEY_SESSION) || {};
    LS.set(KEY_SESSION, { ...s, canvasToken: token, canvasUrl: url, classroomEnabled: classToggle.checked, classroomKey: classKey });
  }

  document.getElementById('settings-overlay').classList.add('hidden');
  loadData();
}

// ─── Add custom class modal ───────────────────────────────────────────────────
function openAddClassModal() {
  selectedColor = CLASS_COLORS[4];
  document.getElementById('new-class-name').value = '';
  document.getElementById('add-class-error').classList.add('hidden');

  const container = document.getElementById('color-swatches');
  container.innerHTML = CLASS_COLORS.map(c =>
    `<button class="color-swatch${c === selectedColor ? ' selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join('');
  container.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedColor = btn.dataset.color;
    });
  });

  document.getElementById('add-class-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-class-name').focus(), 50);
}

async function saveNewClass() {
  const name = document.getElementById('new-class-name').value.trim();
  if (!name) {
    document.getElementById('add-class-error').textContent = 'Enter a class name';
    document.getElementById('add-class-error').classList.remove('hidden');
    return;
  }

  const cls = { id: genId(), name, color: selectedColor, assignments: [] };
  const updated = [...appState.customClasses, cls];
  await saveCustomClasses(updated);

  // Prepend to order
  const newOrder = [cls.id, ...appState.courseOrder];
  await saveCourseOrder(newOrder);

  document.getElementById('add-class-overlay').classList.add('hidden');

  // Add column at front of grid
  const grid = document.getElementById('grid');
  const emptyMsg = grid.querySelector('.status-empty');
  if (emptyMsg) emptyMsg.remove();
  grid.insertBefore(renderCustomColumn(cls), grid.firstChild);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(LS.get(KEY_THEME) || 'light');

  // Initialise drag-and-drop
  initDragDrop();

  // ── Theme ──
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);

  // ── Refresh ──
  document.getElementById('refresh-btn').addEventListener('click', loadData);

  // ── Add class ──
  document.getElementById('add-class-btn').addEventListener('click', openAddClassModal);
  document.getElementById('add-class-cancel-btn').addEventListener('click', () => {
    document.getElementById('add-class-overlay').classList.add('hidden');
  });
  document.getElementById('add-class-save-btn').addEventListener('click', saveNewClass);
  document.getElementById('new-class-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveNewClass();
  });

  // ── Auth nav links ──
  document.getElementById('have-account-btn').addEventListener('click', () => {
    setAuthError('login-error', '');
    showAuthPage('auth-page-signin');
  });
  document.getElementById('back-to-token-btn').addEventListener('click', () => {
    setAuthError('token-error', '');
    showAuthPage('auth-page-token');
  });

  // ── School select (token page) ──
  document.getElementById('session-school-select').addEventListener('change', e => {
    document.getElementById('session-custom-url-group').classList.toggle('hidden', e.target.value !== 'custom');
  });

  // ── Sign in ──
  document.getElementById('login-btn').addEventListener('click', async () => {
    setAuthError('login-error', '');
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) { setAuthError('login-error', 'Email and password required'); return; }
    try {
      const { token } = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      await onAuthenticated(token);
    } catch (err) { setAuthError('login-error', err.message); }
  });

  // ── Forgot password ──
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
        const { email } = await apiFetch('/api/auth/check-token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvasToken: token }),
        });
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
        const { token } = await apiFetch('/api/auth/reset-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvasToken: resetVerifiedToken, newPassword }),
        });
        await onAuthenticated(token);
      } catch (err) { setAuthError('forgot-error', err.message); }
    }
  });

  // ── Canvas token continue ──
  let pendingTokenData = null;
  document.getElementById('token-continue-btn').addEventListener('click', async () => {
    setAuthError('token-error', '');
    const rawToken = document.getElementById('session-token-input').value.trim();
    const sel      = document.getElementById('session-school-select');
    let   url      = sel.value === 'custom'
      ? document.getElementById('session-custom-url').value.trim().replace(/^https?:\/\//i,'').replace(/\/$/,'')
      : sel.value;
    if (!rawToken) { setAuthError('token-error', 'Paste your Canvas token first'); return; }
    if (!url)      { setAuthError('token-error', 'Enter your school URL'); return; }
    try {
      const { email, name } = await apiFetch('/api/auth/check-token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasToken: rawToken, canvasUrl: url }),
      });
      pendingTokenData = { token: rawToken, url, email };
      document.getElementById('found-name').textContent = name || '';
      document.getElementById('found-email').textContent = email;
      document.getElementById('reg-password').value = '';
      setAuthError('reg-error', '');
      showAuthPage('auth-page-create');
    } catch (err) { setAuthError('token-error', err.message); }
  });

  // ── Create account ──
  document.getElementById('create-account-btn').addEventListener('click', async () => {
    setAuthError('reg-error', '');
    if (!pendingTokenData) return;
    const password = document.getElementById('reg-password').value;
    if (!password) { setAuthError('reg-error', 'Enter a password'); return; }
    try {
      const { token } = await apiFetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasToken: pendingTokenData.token, canvasUrl: pendingTokenData.url, password }),
      });
      await onAuthenticated(token);
    } catch (err) { setAuthError('reg-error', err.message); }
  });

  // ── Skip — session mode ──
  document.getElementById('skip-account-btn').addEventListener('click', () => {
    if (!pendingTokenData) return;
    onSession(pendingTokenData.token, pendingTokenData.url);
  });

  // ── Save banner ──
  document.getElementById('banner-create-btn').addEventListener('click', () => {
    document.getElementById('save-banner').classList.add('hidden');
    if (pendingTokenData) {
      showAuthPage('auth-page-create');
      document.getElementById('auth-overlay').classList.remove('hidden');
    } else {
      openAuthModal();
    }
  });
  document.getElementById('banner-dismiss-btn').addEventListener('click', () => {
    document.getElementById('save-banner').classList.add('hidden');
  });

  // ── Settings ──
  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
  document.getElementById('settings-cancel-btn').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
  });
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);

  document.getElementById('settings-school-select').addEventListener('change', e => {
    document.getElementById('settings-custom-url-group').classList.toggle('hidden', e.target.value !== 'custom');
  });
  document.getElementById('classroom-toggle').addEventListener('change', e => {
    document.getElementById('classroom-fields').classList.toggle('hidden', !e.target.checked);
  });

  // ── Sign out ──
  document.getElementById('signout-btn').addEventListener('click', () => {
    LS.remove(KEY_JWT); LS.remove(KEY_SESSION);
    appState = { mode: 'auth', jwt: null, email: null, hiddenCourses: [], courseOrder: [], customClasses: [] };
    cachedCourses = []; cachedAssignments = []; cachedColors = {};
    document.getElementById('settings-overlay').classList.add('hidden');
    document.getElementById('grid').innerHTML = '';
    clearStatus();
    openAuthModal();
  });

  // ── Close modals on overlay click ──
  ['settings-overlay', 'add-class-overlay'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      if (e.target === document.getElementById(id))
        document.getElementById(id).classList.add('hidden');
    });
  });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('settings-overlay').classList.add('hidden');
      document.getElementById('add-class-overlay').classList.add('hidden');
    }
  });
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
  });
  document.getElementById('session-token-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('token-continue-btn').click();
  });

  // ─── Initial boot ─────────────────────────────────────────────────────────
  const savedJwt     = LS.get(KEY_JWT);
  const savedSession = LS.get(KEY_SESSION);

  if (savedJwt) {
    apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${savedJwt}` } })
      .then(me => {
        appState.jwt           = savedJwt;
        appState.mode          = 'account';
        appState.email         = me.email;
        appState.hiddenCourses = Array.isArray(me.hidden_courses)  ? me.hidden_courses  : [];
        appState.courseOrder   = Array.isArray(me.course_order)    ? me.course_order    : LS.get(KEY_ORDER)  || [];
        appState.customClasses = Array.isArray(me.custom_classes)  ? me.custom_classes  : LS.get(KEY_CUSTOM) || [];
        LS.set(KEY_ORDER,  appState.courseOrder);
        LS.set(KEY_CUSTOM, appState.customClasses);
        loadData();
      })
      .catch(() => {
        LS.remove(KEY_JWT);
        openAuthModal();
      });
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
