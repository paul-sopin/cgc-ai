const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helper: forward Canvas API requests from the browser to Canvas.
// The Canvas token is passed as a custom header so it never appears in URLs.
// ---------------------------------------------------------------------------
function canvasHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function canvasBase(req) {
  // Fallback to Dublin USD if the client didn't specify a URL
  return req.headers['x-canvas-url'] || 'https://dublinusd.instructure.com';
}

function handleError(res, err) {
  const status = err.response?.status || 500;
  const message =
    err.response?.data?.errors?.[0]?.message ||
    err.response?.data?.message ||
    err.message ||
    'Unknown error';
  res.status(status).json({ error: message });
}

// ---------------------------------------------------------------------------
// GET /api/canvas/courses
// Returns active courses for the authenticated student.
// ---------------------------------------------------------------------------
app.get('/api/canvas/courses', async (req, res) => {
  const token = req.headers['x-canvas-token'];
  if (!token) return res.status(401).json({ error: 'Canvas token required' });

  try {
    const response = await axios.get(`${canvasBase(req)}/api/v1/courses`, {
      headers: canvasHeaders(token),
      params: {
        enrollment_state: 'active',
        enrollment_type: 'student',
        per_page: 100,
        include: ['term'],
      },
    });

    // Only surface courses that are fully available (not concluded/restricted)
    const courses = response.data.filter(
      (c) => c.workflow_state === 'available' && !c.access_restricted_by_date
    );

    res.json(courses);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/canvas/courses/:courseId/assignments
// Returns upcoming assignments for a single course.
// ---------------------------------------------------------------------------
app.get('/api/canvas/courses/:courseId/assignments', async (req, res) => {
  const token = req.headers['x-canvas-token'];
  if (!token) return res.status(401).json({ error: 'Canvas token required' });

  try {
    const response = await axios.get(
      `${canvasBase(req)}/api/v1/courses/${req.params.courseId}/assignments`,
      {
        headers: canvasHeaders(token),
        params: {
          per_page: 100,
          order_by: 'due_at',
          // 'upcoming' = not yet submitted AND due in the future
          bucket: 'upcoming',
        },
      }
    );
    res.json(response.data);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/canvas/colors
// Returns the user's custom course colour mapping from Canvas.
// ---------------------------------------------------------------------------
app.get('/api/canvas/colors', async (req, res) => {
  const token = req.headers['x-canvas-token'];
  if (!token) return res.status(401).json({ error: 'Canvas token required' });

  try {
    const response = await axios.get(
      `${canvasBase(req)}/api/v1/users/self/colors`,
      { headers: canvasHeaders(token) }
    );
    res.json(response.data.custom_colors || {});
  } catch (err) {
    // Colour fetch failing is non-fatal — return empty map
    res.json({});
  }
});

// ---------------------------------------------------------------------------
// Catch-all: serve index.html for any unmatched route (SPA behaviour)
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Canvas Homework Tracker running on port ${PORT}`);
});
