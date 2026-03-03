const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');
const sessionManager = require('./session-manager');
const StreamManager = require('./stream-manager');
const inputHandler = require('./input-handler');

const PORT = parseInt(process.env.PORT) || 4201;
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const streamManager = new StreamManager();

const distPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(distPath));

let sessionLock = false;

// Reset lock if session exists from previous run
if (sessionManager.getSession()) {
  console.log('[API] Previous session detected, cleaning up...');
  streamManager.stop();
  inputHandler.stop();
  sessionManager.stopSession();
}

app.post('/api/session', async (req, res) => {
  if (sessionLock) {
    return res.status(409).json({ error: 'Session creation in progress' });
  }
  sessionLock = true;

  try {
    const { resolution, startUrl, extensionPath } = req.body || {};
    const result = await sessionManager.startSession({ resolution, startUrl, extensionPath });

    if (result.error) {
      sessionLock = false;
      return res.status(409).json({ error: result.error });
    }

    const ffmpegStdout = sessionManager.getFfmpegStdout();
    streamManager.startCapture(ffmpegStdout);

    inputHandler.start(sessionManager.getDisplayNum());

    sessionLock = false;
    res.status(201).json({
      status: 'running',
      resolution: sessionManager.getResolution(),
    });
  } catch (err) {
    sessionLock = false;
    console.error('[API] Start session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/session', (req, res) => {
  streamManager.stop();
  inputHandler.stop();
  const stopped = sessionManager.stopSession();
  if (!stopped) {
    return res.status(404).json({ error: 'No active session' });
  }
  res.json({ message: 'Session stopped' });
});

app.get('/api/session', (req, res) => {
  const session = sessionManager.getSession();
  if (!session) {
    return res.status(404).json({ error: 'No active session' });
  }
  session.stream = streamManager.getStats();
  res.json(session);
});

app.post('/api/input', (req, res) => {
  const session = sessionManager.getSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const msg = req.body;
  if (!msg || !msg.type) return res.status(400).json({ error: 'Missing type' });
  inputHandler.handleInput(msg);
  res.json({ ok: true });
});

app.post('/api/input/batch', (req, res) => {
  const session = sessionManager.getSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const { actions } = req.body || {};
  if (!Array.isArray(actions)) return res.status(400).json({ error: 'Missing actions array' });
  for (const msg of actions) {
    if (msg && msg.type) inputHandler.handleInput(msg);
  }
  res.json({ ok: true, count: actions.length });
});

app.get('/api/screenshot', async (req, res) => {
  const session = sessionManager.getSession();
  if (!session) return res.status(404).json({ error: 'No active session' });

  try {
    const pageUrl = await getPageTargetWsUrl();
    if (!pageUrl) return res.status(500).json({ error: 'CDP not available' });

    const ws = await import('ws');

    const result = await new Promise((resolve, reject) => {
      const client = new ws.default(pageUrl);
      let id = 1;
      let screenshotId = null;

      client.on('open', () => {
        client.send(JSON.stringify({ id: id++, method: 'Page.enable', params: {} }));
      });

      client.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id === id - 1 && msg.result && !screenshotId) {
          screenshotId = id++;
          client.send(JSON.stringify({
            id: screenshotId,
            method: 'Page.captureScreenshot',
            params: { format: 'jpeg', quality: 80 }
          }));
        }
        if (screenshotId && msg.id === screenshotId && msg.result) {
          client.close();
          resolve(msg.result.data);
        }
        if (msg.error) {
          client.close();
          reject(new Error(msg.error.message));
        }
      });

      client.on('error', reject);
      setTimeout(() => { client.close(); reject(new Error('Screenshot timeout')); }, 10000);
    });

    const buf = Buffer.from(result, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Screenshot failed: ' + err.message });
  }
});

async function getPageTargetWsUrl() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json');
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    console.log('[CDP] Page target:', page?.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl || null;
  } catch (e) {
    console.error('[CDP] Error getting page target:', e.message);
    return null;
  }
}

async function cdpRequest(method, params = {}) {
  const pageUrl = await getPageTargetWsUrl();
  if (!pageUrl) throw new Error('CDP not available');
  console.log('[CDP] Sending:', method, params);

  const ws = await import('ws');
  return new Promise((resolve, reject) => {
    const client = new ws.default(pageUrl);
    let id = 1;
    const msgId = id++;
    client.on('open', () => {
      client.send(JSON.stringify({ id: msgId, method, params }));
    });
    client.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id === msgId) {
        client.close();
        if (msg.result) resolve(msg.result);
        else reject(new Error(msg.error?.message || 'CDP error'));
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.close(); reject(new Error('CDP timeout')); }, 10000);
  });
}

app.get('/api/url', async (req, res) => {
  const session = sessionManager.getSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  try {
    const result = await cdpRequest('Page.getNavigationHistory');
    const idx = result.currentIndex;
    const url = result.entries[idx]?.url || '';
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/navigate', async (req, res) => {
  const session = sessionManager.getSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    await cdpRequest('Page.navigate', { url });
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/evaluate', async (req, res) => {
  const session = sessionManager.getSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const { script } = req.body || {};
  if (!script) return res.status(400).json({ error: 'Missing script' });
  try {
    const result = await cdpRequest('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });
    res.json({ result: result.result?.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    session: !!sessionManager.getSession(),
    stream: streamManager.getStats(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/ws/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      streamManager.addClient(ws);
    });
  } else if (pathname === '/ws/input') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[Input WS] Client connected');
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          inputHandler.handleInput(msg);
        } catch {}
      });
      ws.on('close', () => console.log('[Input WS] Client disconnected'));
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Serende] Server listening on 0.0.0.0:${PORT}`);
  console.log(`[Serende] Frontend: http://localhost:${PORT}`);
  console.log(`[Serende] API: http://localhost:${PORT}/api/`);
  console.log(`[Serende] Stream WS: ws://localhost:${PORT}/ws/stream`);
  console.log(`[Serende] Input WS: ws://localhost:${PORT}/ws/input`);
});

process.on('SIGINT', () => {
  console.log('[Serende] Shutting down...');
  streamManager.stop();
  inputHandler.stop();
  sessionManager.stopSession();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Serende] Shutting down...');
  streamManager.stop();
  inputHandler.stop();
  sessionManager.stopSession();
  server.close();
  process.exit(0);
});
