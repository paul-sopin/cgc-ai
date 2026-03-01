'use strict';

const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const crypto     = require('crypto');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── AES-256-GCM — encrypt Canvas tokens at rest ─────────────────────────────
const ENC_KEY = Buffer.from(
  process.env.ENCRYPTION_KEY || '0'.repeat(64),
  'hex'
);

function encrypt(plaintext) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':');
  const dec = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
  dec.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([dec.update(Buffer.from(encHex, 'hex')), dec.final()]).toString('utf8');
}

// ─── JWT ──────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-in-prod';

function signJWT(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}
function verifyJWT(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sign in required' });
  }
  try {
    req.userId = verifyJWT(header.slice(7)).sub;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────
function canvasHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// Resolve which Canvas token/URL to use: JWT (stored) or session header
async function resolveCanvas(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const payload = verifyJWT(authHeader.slice(7));
    const { data, error } = await supabase
      .from('users')
      .select('canvas_token_enc, canvas_url')
      .eq('id', payload.sub)
      .single();
    if (error || !data) throw new Error('User not found');
    return { token: decrypt(data.canvas_token_enc), baseUrl: `https://${data.canvas_url}` };
  }
  const token = req.headers['x-canvas-token'];
  if (!token) throw new Error('Canvas token required');
  return {
    token,
    baseUrl: req.headers['x-canvas-url'] || 'https://dublinusd.instructure.com',
  };
}

function handleCanvasError(res, err) {
  const status     = err.response?.status || 500;
  const canvasErr  = err.response?.data?.errors?.[0];
  let message =
    canvasErr?.message ||
    err.response?.data?.error ||
    err.response?.data?.message ||
    err.message ||
    'Unknown error';

  if (canvasErr?.expired_at || message.toLowerCase().includes('expired')) {
    message =
      'Your Canvas token is expired. Go to Canvas → Settings → Approved Integrations, ' +
      'delete the old token, generate a new one with no expiry date, and update it here.';
  }
  console.error('[Canvas error]', status, err.response?.data || err.message);
  res.status(status).json({ error: message });
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

// Verify a Canvas token and return the user's Canvas email + name
app.post('/api/auth/check-token', async (req, res) => {
  const { canvasToken, canvasUrl = 'dublinusd.instructure.com' } = req.body;
  if (!canvasToken) return res.status(400).json({ error: 'Canvas token required' });
  try {
    const { data } = await axios.get(
      `https://${canvasUrl}/api/v1/users/self/profile`,
      { headers: canvasHeader(canvasToken) }
    );
    const email = data.primary_email || data.login_id;
    if (!email) throw new Error('Canvas did not return an email for this account');
    res.json({ email, name: data.name });
  } catch (err) {
    handleCanvasError(res, err);
  }
});

// Register — verify Canvas token, get email, store hashed password + encrypted token
app.post('/api/auth/register', async (req, res) => {
  const { canvasToken, canvasUrl = 'dublinusd.instructure.com', password } = req.body;
  if (!canvasToken || !password)
    return res.status(400).json({ error: 'Canvas token and password required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const { data: profile } = await axios.get(
      `https://${canvasUrl}/api/v1/users/self/profile`,
      { headers: canvasHeader(canvasToken) }
    );
    const email = profile.primary_email || profile.login_id;
    if (!email) throw new Error('Canvas did not return an email for this account');

    const passwordHash   = await bcrypt.hash(password, 12);
    const canvasTokenEnc = encrypt(canvasToken);

    const { data, error } = await supabase
      .from('users')
      .insert({
        email:            email.toLowerCase(),
        password_hash:    passwordHash,
        canvas_token_enc: canvasTokenEnc,
        canvas_url:       canvasUrl,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505')
        return res.status(409).json({ error: 'An account already exists for this email. Please sign in instead.' });
      throw error;
    }
    res.json({ token: signJWT(data.id), email });
  } catch (err) {
    if (err.response) return handleCanvasError(res, err);
    console.error('[register error]', err.message);
    res.status(500).json({ error: err.message || 'Registration failed' });
  }
});

// Login — email + password → JWT
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { data: user } = await supabase
    .from('users')
    .select('id, password_hash')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!user) return res.status(401).json({ error: 'No account found for that email' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  res.json({ token: signJWT(user.id) });
});

// Reset password via Canvas token — proves identity, sets new password + updates stored token
app.post('/api/auth/reset-password', async (req, res) => {
  const { canvasToken, canvasUrl = 'dublinusd.instructure.com', newPassword } = req.body;
  if (!canvasToken || !newPassword)
    return res.status(400).json({ error: 'Canvas token and new password required' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const { data: profile } = await axios.get(
      `https://${canvasUrl}/api/v1/users/self/profile`,
      { headers: canvasHeader(canvasToken) }
    );
    const email = profile.primary_email || profile.login_id;
    if (!email) throw new Error('Canvas did not return an email');

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (!user) return res.status(404).json({ error: 'No account found for this Canvas email' });

    const passwordHash   = await bcrypt.hash(newPassword, 12);
    const canvasTokenEnc = encrypt(canvasToken);

    await supabase
      .from('users')
      .update({ password_hash: passwordHash, canvas_token_enc: canvasTokenEnc, canvas_url: canvasUrl, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    res.json({ token: signJWT(user.id), email });
  } catch (err) {
    if (err.response) return handleCanvasError(res, err);
    res.status(500).json({ error: err.message || 'Reset failed' });
  }
});

// Current user info — now includes course_order and custom_classes
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('email, canvas_url, hidden_courses, course_order, custom_classes')
    .eq('id', req.userId)
    .single();
  if (!data) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// Update stored Canvas token (e.g. after expiry)
app.patch('/api/user/canvas-token', requireAuth, async (req, res) => {
  const { canvasToken, canvasUrl } = req.body;
  if (!canvasToken) return res.status(400).json({ error: 'Canvas token required' });
  try {
    await axios.get(
      `https://${canvasUrl || 'dublinusd.instructure.com'}/api/v1/users/self/profile`,
      { headers: canvasHeader(canvasToken) }
    );
    await supabase
      .from('users')
      .update({ canvas_token_enc: encrypt(canvasToken), canvas_url: canvasUrl || 'dublinusd.instructure.com', updated_at: new Date().toISOString() })
      .eq('id', req.userId);
    res.json({ ok: true });
  } catch (err) {
    if (err.response) return handleCanvasError(res, err);
    res.status(500).json({ error: err.message });
  }
});

// Update hidden courses list
app.patch('/api/user/hidden-courses', requireAuth, async (req, res) => {
  const { hiddenCourses } = req.body;
  if (!Array.isArray(hiddenCourses))
    return res.status(400).json({ error: 'hiddenCourses must be an array' });
  const { error } = await supabase
    .from('users')
    .update({ hidden_courses: hiddenCourses, updated_at: new Date().toISOString() })
    .eq('id', req.userId);
  if (error) return res.status(500).json({ error: 'Could not update hidden courses' });
  res.json({ ok: true });
});

// Update course order
app.patch('/api/user/course-order', requireAuth, async (req, res) => {
  const { courseOrder } = req.body;
  if (!Array.isArray(courseOrder))
    return res.status(400).json({ error: 'courseOrder must be an array' });
  const { error } = await supabase
    .from('users')
    .update({ course_order: courseOrder, updated_at: new Date().toISOString() })
    .eq('id', req.userId);
  if (error) return res.status(500).json({ error: 'Could not update course order' });
  res.json({ ok: true });
});

// Update custom classes
app.patch('/api/user/custom-classes', requireAuth, async (req, res) => {
  const { customClasses } = req.body;
  if (!Array.isArray(customClasses))
    return res.status(400).json({ error: 'customClasses must be an array' });
  const { error } = await supabase
    .from('users')
    .update({ custom_classes: customClasses, updated_at: new Date().toISOString() })
    .eq('id', req.userId);
  if (error) return res.status(500).json({ error: 'Could not update custom classes' });
  res.json({ ok: true });
});

// ─── Canvas API proxy ─────────────────────────────────────────────────────────

app.get('/api/canvas/courses', async (req, res) => {
  try {
    const { token, baseUrl } = await resolveCanvas(req);
    const { data } = await axios.get(`${baseUrl}/api/v1/courses`, {
      headers: canvasHeader(token),
      params: { enrollment_state: 'active', enrollment_type: 'student', per_page: 100, include: ['term'] },
    });
    res.json(data.filter(c => c.workflow_state === 'available' && !c.access_restricted_by_date));
  } catch (err) {
    if (err.response) return handleCanvasError(res, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/canvas/courses/:courseId/assignments', async (req, res) => {
  try {
    const { token, baseUrl } = await resolveCanvas(req);
    const { data: rawData } = await axios.get(
      `${baseUrl}/api/v1/courses/${req.params.courseId}/assignments`,
      {
        headers: canvasHeader(token),
        // No bucket filter — fetch all and filter below to include submission state
        params: { per_page: 100, order_by: 'due_at', include: ['submission'] },
      }
    );

    // Keep unsubmitted assignments + submitted ones from the last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    const data = rawData.filter(a => {
      const state = a.submission?.workflow_state;
      const submitted = state === 'submitted' || state === 'graded';
      if (!submitted) return true; // always show incomplete work
      const dueMs = a.due_at ? new Date(a.due_at).getTime() : 0;
      return dueMs > thirtyDaysAgo; // only keep recently-completed
    });

    res.json(data);
  } catch (err) {
    if (err.response) return handleCanvasError(res, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/canvas/colors', async (req, res) => {
  try {
    const { token, baseUrl } = await resolveCanvas(req);
    const { data } = await axios.get(`${baseUrl}/api/v1/users/self/colors`, { headers: canvasHeader(token) });
    res.json(data.custom_colors || {});
  } catch {
    res.json({});
  }
});

// ─── AI helpers ───────────────────────────────────────────────────────────────

// Maps day abbreviations to JS getUTCDay() values (0=Sun … 6=Sat)
const DAY_TO_JS = { M: 1, T: 2, W: 3, Th: 4, F: 5 };

// Given an ISO due date and an array of meeting day abbreviations,
// advances the date to the NEXT meeting day (skips the base date itself).
// Tests/quizzes/exams are NOT advanced — caller decides what to skip.
function nextMeetingDay(isoDate, days) {
  const meetNums = (days || []).map(d => DAY_TO_JS[d]).filter(n => n !== undefined);
  if (!meetNums.length) return isoDate;
  const base = new Date(isoDate);
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = new Date(base);
    candidate.setUTCDate(base.getUTCDate() + offset);
    if (meetNums.includes(candidate.getUTCDay())) {
      candidate.setUTCHours(23, 59, 0, 0);
      return candidate.toISOString();
    }
  }
  return isoDate; // fallback — should never happen with valid days
}

// Returns true if the assignment name looks like a test / quiz / exam.
function isTestQuizOrExam(name) {
  return /\b(test|quiz|exam|midterm|final|checkpoint)\b/i.test(name || '');
}

// ─── AI: parse raw text into a custom class (Groq / Llama) ──────────────────
app.post('/api/ai/parse-class', async (req, res) => {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'AI is not configured. Add GROQ_API_KEY to Render environment variables.' });
  }

  const { text, context, meetsDays } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1–12
  const today = now.toISOString().slice(0, 10);

  // Academic year split: if we're currently in fall (Aug–Dec), spring dates are year+1.
  // If we're in spring/summer (Jan–Jul), fall dates were year−1.
  const inFall     = month >= 8;
  const fallYear   = inFall ? year     : year - 1;
  const springYear = inFall ? year + 1 : year;

  const systemPrompt = `You are a homework tracker assistant. Extract assignments from pasted text and return ONLY a valid JSON object — no markdown, no explanation, nothing else.

Required output format (strict):
{"className":"class name","assignments":[{"name":"assignment description","due_at":"YYYY-MM-DDTHH:mm:ssZ or null"}]}`;

  const contextBlock = context?.trim()
    ? `\n═══ SPECIAL INSTRUCTIONS FROM THE USER (highest priority — override defaults where relevant) ═══\n${context.trim()}\n`
    : '';

  const meetsDaysBlock = meetsDays?.length
    ? `\n═══ MEETING DAYS ═══\nThis class meets on: ${meetsDays.join(', ')}. Extract each date EXACTLY as listed in the schedule — do NOT advance homework dates to the next class yourself. The system will apply that shift automatically after parsing. Also note: some dates may follow an adjusted or modified schedule (e.g. Grady Day, Modified Monday); accept dates as given even if they do not match the usual meeting pattern.\n`
    : '';

  const userPrompt = `Today is ${today}. Extract every homework assignment from the text below.
${contextBlock}${meetsDaysBlock}
═══ INPUT FORMATS ═══
The text could be any of:
• Tab-separated (TSV) copied from Google Sheets — columns like Date, Day, Topic, Homework/HW
• A course syllabus with inline due dates
• A plain numbered or bulleted assignment list
• Unstructured mixed text

═══ WHAT TO INCLUDE ═══
• Homework problems (e.g. "p.400 #1-10", "6.10 + 6.14 topic questions", "WS 3.4")
• Problem sets, worksheets, readings with specific page/question numbers
• Quizzes and tests — use the date they occur as due_at
• Projects or essays with explicit due dates

═══ WHAT TO SKIP ═══
• Rows where the homework cell is blank, "--", "N/A", "none", or "No School"
• Pure lecture topics or class notes (e.g. "Introduction to derivatives") with no associated task
• Administrative entries like "Start of semester", "Holiday", "Review day", "Return quiz" unless a graded item is also listed
• Column headers (the first row of a TSV table)

═══ CLASS NAME (className field) ═══
• Infer from content, headers, or document title — e.g. "AP Calculus AB", "AP Biology", "English 11 Honors"
• If multiple subjects appear, use the dominant one
• Fall back to "Custom Class" only if the subject is completely unidentifiable

═══ PARSING TSV / GOOGLE SHEETS DATA ═══
• Row 1 is the header — identify column positions from it, do not output it as an assignment
• Date column: named "Date", "Day", or similar — values like "M 1/5" mean "Monday, January 5" — strip any leading day-of-week letter/abbreviation and use only the M/D numeric part
• Homework column: named "Homework", "HW", "Assignment", "Due", or similar — this is the assignment name
• Each non-header row is one class day; pair that row's homework value with that row's date
• If a homework cell spans multiple tasks (semicolons, commas, line breaks), output each as a separate assignment entry with the same date

═══ DATE → YEAR CONVERSION (apply to every date, no exceptions) ═══
Today is ${today}. The active school year is Fall ${fallYear} → Spring ${springYear}.
Use this exact lookup — month number determines the year, full stop:
  Jan (1)  → ${springYear}    Feb (2)  → ${springYear}    Mar (3)  → ${springYear}
  Apr (4)  → ${springYear}    May (5)  → ${springYear}    Jun (6)  → ${springYear}
  Jul (7)  → ${springYear}    Aug (8)  → ${fallYear}      Sep (9)  → ${fallYear}
  Oct (10) → ${fallYear}      Nov (11) → ${fallYear}      Dec (12) → ${fallYear}
Do NOT deviate from this table based on surrounding context, guessing, or proximity to today.
All times default to end-of-day: use the suffix "T23:59:00Z".
If no date is present for an assignment, set due_at to null.

CHRONOLOGICAL CONSISTENCY — apply after the lookup above:
Schedules are always written in forward chronological order. After assigning years with the table, walk through all assignments in document order and check that each date is >= the previous date. If a date would come BEFORE the previous date (i.e. the sequence goes backward in time), that date has crossed into the next calendar year — add 1 year to it and to every subsequent date until the sequence is non-decreasing again. Example: if 7/3→2026 is followed by 11/3→2025, that 11/3 goes backward, so correct it to 11/3→2026; if then 2/1→2026 goes backward vs 11/3→2026, correct it to 2/1→2027.

Text:
${text.slice(0, 24000)}`;

  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:           'llama-3.3-70b-versatile',
        messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature:     0.1,
        max_tokens:      8192,
        response_format: { type: 'json_object' },  // guarantees valid JSON output
      },
      { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
    );

    const raw = data.choices?.[0]?.message?.content || '';
    console.log('[AI raw response]', raw.slice(0, 300));

    const parsed = JSON.parse(raw);
    if (!parsed.className || !Array.isArray(parsed.assignments)) {
      throw new Error('Unexpected AI response format');
    }

    // Post-process: advance homework dates to next meeting day (skip tests/quizzes/exams)
    if (meetsDays?.length && Array.isArray(parsed.assignments)) {
      parsed.assignments = parsed.assignments.map(a => {
        if (!a.due_at || isTestQuizOrExam(a.name)) return a;
        return { ...a, due_at: nextMeetingDay(a.due_at, meetsDays) };
      });
    }

    res.json({ className: parsed.className, assignments: parsed.assignments });
  } catch (err) {
    console.error('[AI parse error]', err.response?.data ?? err.message);
    res.status(500).json({ error: `AI parse failed: ${err.response?.data?.error?.message ?? err.message}` });
  }
});

// ─── Health check + SPA fallback ──────────────────────────────────────────────
app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Canvas Homework Tracker on port ${PORT}`));
