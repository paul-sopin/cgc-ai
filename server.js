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

// ─── AI: parse raw text into a custom class ───────────────────────────────────
app.post('/api/ai/parse-class', async (req, res) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(503).json({ error: 'AI is not configured on this server. Add GEMINI_API_KEY to your Render environment variables.' });
  }

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a homework tracker assistant. Today is ${today}.
Parse the following text (could be a pasted spreadsheet, syllabus, assignment list, or schedule) and extract all assignments and their due dates.

Return ONLY valid JSON — no markdown, no code fences, no extra text — in this exact format:
{
  "className": "short clean class name like 'AP Calculus' or 'US History'",
  "assignments": [
    {"name": "assignment name", "due_at": "ISO 8601 UTC datetime string, or null if no date found"}
  ]
}

Rules:
- className should be short and clean. If unclear, use "Custom Class".
- Include all assignments, homework, projects, quizzes, tests.
- Convert dates to ISO 8601 UTC format. If only month/day given, assume year ${new Date().getFullYear()}.
- If a time is not given, use 23:59:00 local time (output as UTC equivalent).
- Ignore grades, point values, completion checkmarks.
- due_at must be null if no date is identifiable.

Text to parse:
${text.slice(0, 8000)}`;

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      }
    );

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Strip any accidental markdown fences
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed.className || !Array.isArray(parsed.assignments)) {
      throw new Error('Unexpected AI response format');
    }

    res.json({ className: parsed.className, assignments: parsed.assignments });
  } catch (err) {
    console.error('[AI parse error]', err.message);
    res.status(500).json({ error: 'AI could not parse the text. Try pasting more structured data, or use the Manual tab.' });
  }
});

// ─── Health check + SPA fallback ──────────────────────────────────────────────
app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Canvas Homework Tracker on port ${PORT}`));
