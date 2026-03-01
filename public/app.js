/* ═══════════════════════════════════════════════════════════════════════════
   Canvas Homework Tracker — frontend logic
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Config ─────────────────────────────────────────────────────────────────
const CONFIG_KEY = 'cht_config';

function getConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
  catch { return {}; }
}

function saveConfig(patch) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getConfig(), ...patch }));
}

function hasCredentials() {
  const c = getConfig();
  return !!(c.canvasToken && c.canvasUrl);
}

// ─── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = getConfig().theme || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  saveConfig({ theme: next });
  applyTheme(next);
}

// ─── API helpers ─────────────────────────────────────────────────────────────
function buildHeaders(token, url) {
  return {
    'Content-Type': 'application/json',
    'x-canvas-token': token,
    'x-canvas-url': `https://${url}`,
  };
}

async function apiFetch(path, token, url) {
  const res = await fetch(path, { headers: buildHeaders(token, url) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchCourses(token, url) {
  return apiFetch('/api/canvas/courses', token, url);
}

async function fetchAssignments(token, url, courseId) {
  return apiFetch(`/api/canvas/courses/${courseId}/assignments`, token, url);
}

async function fetchColors(token, url) {
  try { return await apiFetch('/api/canvas/colors', token, url); }
  catch { return {}; }
}

// ─── Due-date helpers ────────────────────────────────────────────────────────
function dueCategory(dueAt) {
  if (!dueAt) return 'none';
  const msLeft = new Date(dueAt) - Date.now();
  const days = msLeft / 86_400_000;
  if (days < 0)  return 'urgent'; // overdue (shouldn't appear with 'upcoming' bucket but just in case)
  if (days < 1)  return 'urgent'; // due today
  if (days < 2)  return 'soon';   // due tomorrow
  if (days < 7)  return 'soon';   // due this week
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

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Render: one course column ────────────────────────────────────────────────
function renderColumn(course, assignments, color) {
  const col = document.createElement('div');
  col.className = 'course-col';
  col.style.setProperty('--course-color', color || '#888888');

  // Sort: soonest due first; no-due-date items last
  const sorted = [...assignments].sort((a, b) => {
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    return new Date(a.due_at) - new Date(b.due_at);
  });

  const header = `
    <div class="course-header">
      <div class="course-name">${esc(course.name)}</div>
      ${course.course_code ? `<div class="course-code">${esc(course.course_code)}</div>` : ''}
    </div>`;

  let body;
  if (sorted.length === 0) {
    body = `<div class="no-assignments">All caught up ✓</div>`;
  } else {
    const items = sorted.map((a) => {
      const cat  = dueCategory(a.due_at);
      const due  = formatDue(a.due_at);
      const pts  = a.points_possible != null ? `${a.points_possible} pts` : '';
      return `
        <li class="assignment-item">
          <div class="due-dot ${cat}"></div>
          <div class="assignment-info">
            <a class="assignment-link"
               href="${esc(a.html_url)}"
               target="_blank"
               rel="noopener"
               title="${esc(a.name)}">${esc(a.name)}</a>
            <div class="assignment-due ${cat}">${due}</div>
          </div>
          ${pts ? `<div class="assignment-pts">${pts}</div>` : ''}
        </li>`;
    }).join('');
    body = `<ul class="assignment-list">${items}</ul>`;
  }

  col.innerHTML = header + body;
  return col;
}

// ─── Status helpers ───────────────────────────────────────────────────────────
const statusArea = () => document.getElementById('status-area');
const grid       = () => document.getElementById('grid');

function showLoading() {
  statusArea().innerHTML = `
    <div class="status-loading">
      <span class="spinner"></span> Loading your classes…
    </div>`;
  grid().innerHTML = '';
}

function showError(msg) {
  statusArea().innerHTML = `
    <div class="status-error">
      <span>⚠</span> ${esc(msg)}
    </div>`;
}

function clearStatus() {
  statusArea().innerHTML = '';
}

// ─── Main data load ───────────────────────────────────────────────────────────
async function loadData() {
  const { canvasToken, canvasUrl } = getConfig();
  if (!canvasToken || !canvasUrl) { openModal(); return; }

  // Spinning refresh button
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.classList.add('spinning');
  showLoading();

  try {
    const [courses, colors] = await Promise.all([
      fetchCourses(canvasToken, canvasUrl),
      fetchColors(canvasToken, canvasUrl),
    ]);

    if (courses.length === 0) {
      clearStatus();
      grid().innerHTML = '<div class="status-empty">No active courses found for your account.</div>';
      return;
    }

    // Fetch all courses' assignments in parallel
    const allAssignments = await Promise.all(
      courses.map((c) =>
        fetchAssignments(canvasToken, canvasUrl, c.id).catch(() => [])
      )
    );

    clearStatus();
    grid().innerHTML = '';
    courses.forEach((course, i) => {
      const color = colors[`course_${course.id}`] || null;
      grid().appendChild(renderColumn(course, allAssignments[i] || [], color));
    });

    // Timestamp
    document.getElementById('last-updated').textContent =
      `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  } catch (err) {
    showError(err.message || 'Could not load Canvas data. Check your token or connection.');
    grid().innerHTML = '';
    // If it looks like an auth error, prompt re-setup
    if (err.message?.includes('Invalid') || err.message?.includes('unauthorized')) {
      openModal();
    }
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');

  // Pre-fill saved values
  const cfg = getConfig();
  const schoolSelect = document.getElementById('school-select');
  const customGroup  = document.getElementById('custom-url-group');
  const customInput  = document.getElementById('custom-url-input');
  const tokenInput   = document.getElementById('token-input');
  const classToggle  = document.getElementById('classroom-toggle');
  const classFields  = document.getElementById('classroom-fields');
  const classKey     = document.getElementById('classroom-key-input');
  const cancelBtn    = document.getElementById('modal-cancel-btn');

  if (cfg.canvasUrl && cfg.canvasUrl !== 'dublinusd.instructure.com') {
    schoolSelect.value = 'custom';
    customGroup.style.display = 'block';
    customInput.value = cfg.canvasUrl;
  } else {
    schoolSelect.value = 'dublinusd.instructure.com';
    customGroup.style.display = 'none';
  }

  if (cfg.canvasToken) tokenInput.value = cfg.canvasToken;
  if (cfg.classroomEnabled) {
    classToggle.checked = true;
    classFields.classList.remove('hidden');
  }
  if (cfg.classroomKey) classKey.value = cfg.classroomKey;

  // Hide cancel button on first setup (no credentials yet)
  cancelBtn.style.display = hasCredentials() ? 'block' : 'none';

  clearModalError();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function clearModalError() {
  const el = document.getElementById('modal-error');
  el.textContent = '';
  el.classList.add('hidden');
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function saveModal() {
  const schoolSelect = document.getElementById('school-select');
  const customInput  = document.getElementById('custom-url-input');
  const tokenInput   = document.getElementById('token-input');
  const classToggle  = document.getElementById('classroom-toggle');
  const classKey     = document.getElementById('classroom-key-input');

  let canvasUrl =
    schoolSelect.value === 'custom'
      ? customInput.value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
      : schoolSelect.value;

  const canvasToken = tokenInput.value.trim();

  if (!canvasUrl) { showModalError('Please enter your school\'s Canvas URL.'); return; }
  if (!canvasToken) { showModalError('Please enter your Canvas access token.'); return; }

  saveConfig({
    canvasUrl,
    canvasToken,
    classroomEnabled: classToggle.checked,
    classroomKey: classKey.value.trim(),
  });

  closeModal();
  loadData();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Apply saved theme immediately
  applyTheme(getConfig().theme || 'light');

  // ── Theme toggle ──
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);

  // ── Refresh ──
  document.getElementById('refresh-btn').addEventListener('click', loadData);

  // ── Settings ──
  document.getElementById('settings-btn').addEventListener('click', openModal);

  // ── Modal: school select changes ──
  document.getElementById('school-select').addEventListener('change', (e) => {
    const customGroup = document.getElementById('custom-url-group');
    customGroup.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  // ── Modal: Google Classroom toggle ──
  document.getElementById('classroom-toggle').addEventListener('change', (e) => {
    document.getElementById('classroom-fields').classList.toggle('hidden', !e.target.checked);
  });

  // ── Modal: save ──
  document.getElementById('modal-save-btn').addEventListener('click', saveModal);

  // ── Modal: cancel ──
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);

  // ── Modal: close on overlay click ──
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay') && hasCredentials()) {
      closeModal();
    }
  });

  // ── Modal: save on Enter key ──
  document.getElementById('modal-overlay').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveModal();
    if (e.key === 'Escape' && hasCredentials()) closeModal();
  });

  // ── Initial load ──
  if (hasCredentials()) {
    loadData();
  } else {
    openModal();
  }
});
