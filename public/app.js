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

// ─── Auth state ───────────────────────────────────────────────────────────────
// mode: 'auth' | 'session' | 'account'
let appState = {
  mode:          'auth',
  jwt:           null,
  email:         null,
  hiddenCourses: [],   // [{ id, name }]
};

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

// ─── Render one course column ─────────────────────────────────────────────────
function renderColumn(course, assignments, color) {
  const col = document.createElement('div');
  col.className = 'course-col';
  col.dataset.courseId = course.id;
  col.style.setProperty('--course-color', color || '#888888');

  const sorted = [...assignments].sort((a, b) => {
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    return new Date(a.due_at) - new Date(b.due_at);
  });

  const header = `
    <div class="course-header">
      <div class="course-header-text">
        <div class="course-name">${esc(course.name)}</div>
        ${course.course_code ? `<div class="course-code">${esc(course.course_code)}</div>` : ''}
      </div>
      <button class="hide-course-btn" title="Hide this class" data-course-id="${course.id}" data-course-name="${esc(course.name)}">×</button>
    </div>`;

  const body = sorted.length === 0
    ? `<div class="no-assignments">All caught up ✓</div>`
    : `<ul class="assignment-list">${sorted.map(a => {
        const cat = dueCategory(a.due_at);
        const pts = a.points_possible != null ? `<div class="assignment-pts">${a.points_possible} pts</div>` : '';
        return `<li class="assignment-item">
          <div class="due-dot ${cat}"></div>
          <div class="assignment-info">
            <a class="assignment-link" href="${esc(a.html_url)}" target="_blank" rel="noopener" title="${esc(a.name)}">${esc(a.name)}</a>
            <div class="assignment-due ${cat}">${formatDue(a.due_at)}</div>
          </div>${pts}</li>`;
      }).join('')}</ul>`;

  col.innerHTML = header + body;

  col.querySelector('.hide-course-btn').addEventListener('click', async (e) => {
    const id   = e.currentTarget.dataset.courseId;
    const name = e.currentTarget.dataset.courseName;
    await hideCourse(id, name);
    col.remove();
  });

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

// ─── Main data load ───────────────────────────────────────────────────────────
async function loadData() {
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.classList.add('spinning');
  showLoading();

  try {
    const [courses, colors] = await Promise.all([fetchCourses(), fetchColors()]);

    if (!courses.length) {
      clearStatus();
      document.getElementById('grid').innerHTML = '<div class="status-empty">No active courses found.</div>';
      return;
    }

    const allAssignments = await Promise.all(
      courses.map(c => fetchAssignments(c.id).catch(() => []))
    );

    clearStatus();
    const grid = document.getElementById('grid');
    grid.innerHTML = '';

    courses.forEach((course, i) => {
      if (isHidden(course.id)) return;
      grid.appendChild(renderColumn(course, allAssignments[i] || [], colors[`course_${course.id}`] || null));
    });

    if (!grid.children.length) {
      grid.innerHTML = '<div class="status-empty">All classes are hidden. Restore them in Settings.</div>';
    }

    document.getElementById('last-updated').textContent =
      `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  } catch (err) {
    showError(err.message || 'Could not load Canvas data.');
    document.getElementById('grid').innerHTML = '';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
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
  appState.jwt   = jwt;
  appState.mode  = 'account';
  LS.set(KEY_JWT, jwt);
  LS.remove(KEY_SESSION);

  // Load user info (hidden courses)
  try {
    const me = await apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${jwt}` } });
    appState.email         = me.email;
    appState.hiddenCourses = Array.isArray(me.hidden_courses) ? me.hidden_courses : [];
  } catch { appState.hiddenCourses = []; }

  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('save-banner').classList.add('hidden');
  loadData();
}

function onSession(canvasToken, canvasUrl) {
  appState.mode  = 'session';
  appState.jwt   = null;
  appState.hiddenCourses = LS.get(KEY_HIDDEN) || [];
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
      loadData();
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(LS.get(KEY_THEME) || 'light');

  // ── Theme ──
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);

  // ── Refresh ──
  document.getElementById('refresh-btn').addEventListener('click', loadData);

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
    // Switch auth modal to create-account page pre-filled
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
    appState = { mode: 'auth', jwt: null, email: null, hiddenCourses: [] };
    document.getElementById('settings-overlay').classList.add('hidden');
    document.getElementById('grid').innerHTML = '';
    clearStatus();
    openAuthModal();
  });

  // ── Close modals on overlay click ──
  document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-overlay'))
      document.getElementById('settings-overlay').classList.add('hidden');
  });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('settings-overlay').classList.add('hidden');
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
    // Verify JWT is still valid
    apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${savedJwt}` } })
      .then(me => {
        appState.jwt           = savedJwt;
        appState.mode          = 'account';
        appState.email         = me.email;
        appState.hiddenCourses = Array.isArray(me.hidden_courses) ? me.hidden_courses : [];
        loadData();
      })
      .catch(() => {
        LS.remove(KEY_JWT);
        openAuthModal();
      });
  } else if (savedSession?.canvasToken) {
    appState.mode          = 'session';
    appState.hiddenCourses = LS.get(KEY_HIDDEN) || [];
    document.getElementById('save-banner').classList.remove('hidden');
    loadData();
  } else {
    openAuthModal();
  }
});
