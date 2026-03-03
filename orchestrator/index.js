const express = require('express');
const cors = require('cors');
const containerManager = require('./container-manager');

const PORT = parseInt(process.env.ORCHESTRATOR_PORT) || 4000;
const app = express();

app.use(cors());
app.use(express.json());

app.post('/sessions', async (req, res) => {
  try {
    const { userId, options } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await containerManager.createSession(userId, options);

    if (result.error === 'exists') {
      return res.status(409).json({
        error: 'Session already exists for this user',
        existingSessionId: result.existingSessionId,
      });
    }

    if (result.error === 'limit') {
      return res.status(503).json({
        error: 'Maximum session limit reached',
        currentSessions: result.currentSessions,
        maxSessions: result.maxSessions,
      });
    }

    res.status(201).json(result);
  } catch (err) {
    console.error('[API] POST /sessions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/sessions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const destroyed = await containerManager.destroySession(userId);

    if (!destroyed) {
      return res.status(404).json({ error: 'No active session for this user' });
    }

    res.json({ message: 'Session destroyed', userId });
  } catch (err) {
    console.error('[API] DELETE /sessions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/sessions', (req, res) => {
  const result = containerManager.listSessions();
  res.json(result);
});

app.get('/sessions/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = containerManager.getSession(userId);

  if (!session) {
    return res.status(404).json({ error: 'No active session for this user' });
  }

  const stats = await containerManager.getSessionStats(userId);
  if (stats) {
    session.resources = stats;
  }

  res.json(session);
});

app.post('/notify/disconnect', (req, res) => {
  const { userId } = req.body;
  if (userId) {
    containerManager.handleDisconnect(userId);
  }
  res.json({ ok: true });
});

app.post('/notify/reconnect', (req, res) => {
  const { userId } = req.body;
  if (userId) {
    containerManager.handleReconnect(userId);
  }
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  const list = containerManager.listSessions();
  res.json({
    status: 'ok',
    sessions: list.total,
    maxSessions: list.maxSessions,
    uptime: Math.floor(process.uptime()),
  });
});

async function start() {
  await containerManager.cleanupOrphanedContainers();
  containerManager.startHealthMonitoring();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Orchestrator] listening on 0.0.0.0:${PORT}`);
    console.log(`[Orchestrator] Max sessions: ${containerManager.MAX_SESSIONS}`);
  });
}

start().catch((err) => {
  console.error('[Orchestrator] Fatal error:', err);
  process.exit(1);
});
