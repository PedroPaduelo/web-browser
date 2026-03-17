const path = require('path');
require('dotenv').config({ override: true, path: path.resolve(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('./node_modules/ws');
const cors = require('cors');
const crypto = require('crypto');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const keyStore = require('./key-store');
const sessionManager = require('./session-manager');
const StreamManager = require('./stream-manager');
const CDPScreencast = require('./cdp-screencast');
const { createInputHandler } = require('./cdp-input-handler');
const { generateToken, verifyToken, deriveTenantId, authMiddleware } = require('./auth');
const profileManager = require('./profile-manager');
const tenantManager = require('./tenant-manager');

// Migracao de key legada
const AUTH_API_KEY = process.env.AUTH_API_KEY;
if (AUTH_API_KEY) {
  const migrated = keyStore.migrateFromEnv(AUTH_API_KEY);
  if (migrated) {
    console.log(`[Serende] Migrated legacy AUTH_API_KEY to SQLite (tenantId: ${migrated.id})`);
  }
} else {
  console.log('[Serende] AUTH_API_KEY not set — using SQLite key store only');
}

function trackActivity(req, res, next) {
  const { sessionId } = req.params || {};
  if (sessionId) {
    try {
      sessionManager.updateActivity(sessionId);
    } catch (err) {
      console.error('[Server] Error updating activity:', err);
    }
  }
  next();
}

const PORT = parseInt(process.env.SERENDE_PORT || process.env.PORT) || 4201;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const app = express();
const server = http.createServer(app);

// --- Trust Proxy (EasyPanel reverse proxy) ---
app.set('trust proxy', 1);

// --- Security Headers ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// --- CORS Configurável ---
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['*'];
app.use(cors({
  origin: corsOrigins.includes('*') ? true : corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret', 'x-api-key'],
}));

// --- Body Parser com limite ---
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiting Global ---
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', globalLimiter);

// --- Request ID ---
app.use((req, res, next) => {
  req.requestId = uuidv4().slice(0, 8);
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

const sessionResources = new Map();

sessionManager.onSessionDied((sessionId) => {
  const resources = sessionResources.get(sessionId);
  if (resources) {
    resources.screencast.stop();
    resources.streamManager.stop();
    resources.inputHandler.stop();
    sessionResources.delete(sessionId);
    console.log(`[API] Cleaned up resources for orphaned session ${sessionId}`);
  }
  const session = sessionManager.getSession(sessionId);
  if (session) closeCdpClient(session.cdpPort);
});

const distPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(distPath));

// --- Rate Limiter (login) ---
const loginAttempts = new Map();
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 60_000;

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= LOGIN_MAX) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s` });
    }
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now >= entry.resetAt) loginAttempts.delete(ip);
  }
}, 300_000);

// --- Auth Routes (public) ---

app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey required' });
  }
  const tenant = keyStore.validateKey(apiKey);
  if (!tenant) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  if (tenant.disabled) {
    return res.status(403).json({ error: `API key "${tenant.name}" is disabled. Enable it in the admin panel.` });
  }
  const token = generateToken(tenant.id, { maxSessions: tenant.maxSessions });
  res.json({ token, tenantId: tenant.id, userId: tenant.id });
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, tenantId: req.tenant.tenantId, userId: req.tenant.tenantId });
});

// --- Profile Management Routes ---

app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const hasProfile = await profileManager.hasProfile(req.tenant.tenantId);
    const metadata = await profileManager.loadMetadata(req.tenant.tenantId);
    res.json({ exists: hasProfile, metadata });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/profile', authMiddleware, async (req, res) => {
  try {
    await profileManager.cleanProfile(req.tenant.tenantId);
    res.json({ message: 'Profile cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: {
      active: sessionManager.getSessionCount(),
      max: parseInt(process.env.MAX_SESSIONS) || 10,
    },
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
    version: '2.1.0',
  });
});

// --- Protected Routes ---

app.post('/api/session', authMiddleware, async (req, res) => {
  try {
    const { resolution, startUrl, extensionPath } = req.body || {};
    const sessionId = uuidv4();
    const result = await sessionManager.startSession(sessionId, req.tenant.tenantId, {
      resolution, startUrl, extensionPath,
      maxSessions: req.tenant.maxSessions,
    });

    // Iniciar timeout tracker
    sessionManager.startTimeoutTracker(sessionId);

    const raw = sessionManager.getSessionRaw(sessionId);

    // CDP Screencast — Chrome envia frames JPEG direto via CDP (sem ffmpeg)
    const streamMgr = new StreamManager();
    streamMgr.mode = 'cdp';

    const screencast = new CDPScreencast(raw.cdpPort);
    screencast.start((frame) => streamMgr.pushFrame(frame));

    const inputHdl = createInputHandler(raw.displayNum);

    sessionResources.set(sessionId, { streamManager: streamMgr, screencast, inputHandler: inputHdl });

    res.status(201).json({
      sessionId,
      status: 'running',
      resolution: result.resolution,
    });
  } catch (err) {
    console.error('[API] Start session error:', err.message);
    const status = err.message.includes('limit') ? 429 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.delete('/api/session/:sessionId', authMiddleware, (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.tenantId !== req.tenant.tenantId) {
    return res.status(403).json({ error: 'Not your session' });
  }

  const resources = sessionResources.get(sessionId);
  if (resources) {
    resources.screencast.stop();
    resources.streamManager.stop();
    resources.inputHandler.stop();
    sessionResources.delete(sessionId);
  }

  sessionManager.stopSession(sessionId);
  closeCdpClient(session.cdpPort);
  res.json({ message: 'Session stopped' });
});

app.get('/api/session', authMiddleware, (req, res) => {
  const sessions = sessionManager.getTenantSessions(req.tenant.tenantId);
  res.json({ sessions });
});

app.get('/api/session/:sessionId', authMiddleware, trackActivity, (req, res) => {
  const session = sessionManager.getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.tenantId !== req.tenant.tenantId) {
    return res.status(403).json({ error: 'Not your session' });
  }

  const resources = sessionResources.get(req.params.sessionId);
  if (resources) {
    session.stream = resources.streamManager.getStats();
  }

  // Adicionar info de timeout
  const timeoutInfo = sessionManager.getSessionTimeout
    ? sessionManager.getSessionTimeout(req.params.sessionId)
    : null;
  if (timeoutInfo) {
    session.timeout = timeoutInfo;
  }

  res.json(session);
});

app.post('/api/input', authMiddleware, trackActivity, (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  req.params = { ...req.params, sessionId };
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const msg = req.body;
  if (!msg.type) return res.status(400).json({ error: 'Missing type' });

  const resources = sessionResources.get(sessionId);
  if (resources) {
    resources.inputHandler.sendInput(msg);
  }
  res.json({ ok: true });
});

app.post('/api/input/batch', authMiddleware, trackActivity, (req, res) => {
  const { sessionId, actions } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!Array.isArray(actions)) return res.status(400).json({ error: 'Missing actions array' });

  req.params = { ...req.params, sessionId };
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const resources = sessionResources.get(sessionId);
  if (resources) {
    for (const msg of actions) {
      if (msg && msg.type) resources.inputHandler.sendInput(msg);
    }
  }
  res.json({ ok: true, count: actions.length });
});

const cdpPools = new Map();

async function getCdpClient(cdpPort) {
  const existing = cdpPools.get(cdpPort);
  if (existing && existing.ready) {
    clearTimeout(existing.closeTimer);
    existing.closeTimer = setTimeout(() => closeCdpClient(cdpPort), 30_000);
    return existing;
  }

  let pageUrl = null;
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    pageUrl = page?.webSocketDebuggerUrl || null;
  } catch {}

  if (!pageUrl) throw new Error('CDP not available');

  const ws = await import('./node_modules/ws/index.js');
  return new Promise((resolve, reject) => {
    const client = new ws.default(pageUrl);
    const pool = {
      client,
      ready: false,
      idCounter: 1,
      pendingRequests: new Map(),
      closeTimer: null,
    };

    client.on('open', () => {
      pool.ready = true;
      pool.closeTimer = setTimeout(() => closeCdpClient(cdpPort), 30_000);
      cdpPools.set(cdpPort, pool);
      resolve(pool);
    });

    client.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.id && pool.pendingRequests.has(msg.id)) {
          const { resolve: res, reject: rej } = pool.pendingRequests.get(msg.id);
          pool.pendingRequests.delete(msg.id);
          if (msg.result) res(msg.result);
          else rej(new Error(msg.error?.message || 'CDP error'));
        }
      } catch {}
    });

    client.on('close', () => {
      pool.ready = false;
      cdpPools.delete(cdpPort);
      for (const { reject: rej } of pool.pendingRequests.values()) {
        rej(new Error('CDP connection closed'));
      }
      pool.pendingRequests.clear();
    });

    client.on('error', (err) => {
      if (!pool.ready) reject(err);
    });

    setTimeout(() => {
      if (!pool.ready) {
        try { client.close(); } catch {}
        reject(new Error('CDP connection timeout'));
      }
    }, 10000);
  });
}

function closeCdpClient(cdpPort) {
  const pool = cdpPools.get(cdpPort);
  if (pool) {
    try { pool.client.close(); } catch {}
    cdpPools.delete(cdpPort);
  }
}

async function cdpRequest(cdpPort, method, params = {}) {
  const pool = await getCdpClient(cdpPort);
  const id = pool.idCounter++;

  return new Promise((resolve, reject) => {
    pool.pendingRequests.set(id, { resolve, reject });
    try {
      pool.client.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      pool.pendingRequests.delete(id);
      reject(err);
    }
    setTimeout(() => {
      if (pool.pendingRequests.has(id)) {
        pool.pendingRequests.delete(id);
        reject(new Error('CDP request timeout'));
      }
    }, 10000);
  });
}

async function getPageTargetWsUrl(cdpPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    return page?.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

function getSessionAndValidate(req, res) {
  const sessionId = req.params.sessionId || req.query.sessionId || req.body?.sessionId;
  if (!sessionId) { res.status(400).json({ error: 'Missing sessionId' }); return null; }

  const session = sessionManager.getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return null; }
  if (session.tenantId !== req.tenant.tenantId) { res.status(403).json({ error: 'Not your session' }); return null; }

  return session;
}

app.get('/api/screenshot/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  try {
    const pageUrl = await getPageTargetWsUrl(session.cdpPort);
    if (!pageUrl) return res.status(500).json({ error: 'CDP not available' });

    const ws = await import('./node_modules/ws/index.js');
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
          client.send(JSON.stringify({ id: screenshotId, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 80 } }));
        }
        if (screenshotId && msg.id === screenshotId && msg.result) {
          client.close();
          resolve(msg.result.data);
        }
        if (msg.error) { client.close(); reject(new Error(msg.error.message)); }
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

app.get('/api/url/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;
  try {
    const result = await cdpRequest(session.cdpPort, 'Page.getNavigationHistory');
    const idx = result.currentIndex;
    const url = result.entries[idx]?.url || '';
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/navigate/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    await cdpRequest(session.cdpPort, 'Page.navigate', { url });
    const resources = sessionResources.get(req.params.sessionId);
    if (resources?.inputHandler?.reconnect) {
      setTimeout(() => resources.inputHandler.reconnect(), 1000);
    }
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/evaluate/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;
  const { script } = req.body || {};
  if (!script) return res.status(400).json({ error: 'Missing script' });
  try {
    const result = await cdpRequest(session.cdpPort, 'Runtime.evaluate', { expression: script, returnByValue: true });
    res.json({ result: result.result?.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin Middleware ---

function adminAuth(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin not configured' });
  }
  const secret = req.headers['x-admin-secret'] || '';
  const a = Buffer.from(secret);
  const b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  next();
}

// --- Admin Routes ---

app.post('/api/admin/keys', adminAuth, (req, res) => {
  try {
    const { name, maxSessions, maxSessionDuration, maxIdleTimeout, features } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = keyStore.createKey(name, { maxSessions, maxSessionDuration, maxIdleTimeout, features });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/keys', adminAuth, (req, res) => {
  try {
    const keys = keyStore.listKeys();
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/keys/:id', adminAuth, (req, res) => {
  try {
    const result = keyStore.updateKey(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ error: 'Key not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/keys/:id/regenerate', adminAuth, (req, res) => {
  try {
    const result = keyStore.regenerateKey(req.params.id);
    if (!result) return res.status(404).json({ error: 'Key not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/keys/:id', adminAuth, (req, res) => {
  try {
    const result = keyStore.revokeKey(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sessions', adminAuth, (req, res) => {
  try {
    const allSessions = sessionManager.getAllSessions();
    const keys = keyStore.listKeys();
    const keyMap = {};
    for (const k of keys) keyMap[k.id] = k.name;

    const sessions = allSessions.map(s => ({
      ...s,
      tenantName: keyMap[s.tenantId] || 'Unknown',
      timeout: sessionManager.getSessionTimeout(s.sessionId),
    }));
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sessions/:sessionId/token', adminAuth, (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const token = generateToken(session.tenantId, { maxSessions: 10 });
    res.json({ token, sessionId, tenantId: session.tenantId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/sessions/:sessionId', adminAuth, (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const resources = sessionResources.get(sessionId);
    if (resources) {
      resources.screencast.stop();
      resources.streamManager.stop();
      resources.inputHandler.stop();
      sessionResources.delete(sessionId);
    }

    sessionManager.stopSession(sessionId);
    closeCdpClient(session.cdpPort);
    res.json({ message: 'Session stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  try {
    const keyStats = keyStore.getStats();
    res.json({
      ...keyStats,
      totalActiveSessions: sessionManager.getSessionCount(),
      maxSessionsGlobal: parseInt(process.env.MAX_SESSIONS) || 10,
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SPA Catch-all ---

app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// --- WebSocket ---

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 512 * 1024,
});

// --- WS Token Expiry Checker ---
const activeWsConnections = new Map();

setInterval(() => {
  for (const [ws, meta] of activeWsConnections) {
    if (ws.readyState !== 1) {
      activeWsConnections.delete(ws);
      continue;
    }
    const payload = verifyToken(meta.token);
    if (!payload) {
      try { ws.close(4001, 'Token expired'); } catch {}
      activeWsConnections.delete(ws);
    }
  }
}, 60_000);

server.on('upgrade', (req, socket, head) => {
  socket.setNoDelay(true);

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  const token = parsedUrl.searchParams.get('token');
  const sessionId = parsedUrl.searchParams.get('sessionId');

  if (!token || !sessionId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const session = sessionManager.getSession(sessionId);
  const payloadTenantId = payload.tenantId || payload.userId;
  if (!session || session.tenantId !== payloadTenantId) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const resources = sessionResources.get(sessionId);
  if (!resources) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname === '/ws/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._socket && ws._socket.setNoDelay(true);
      resources.streamManager.addClient(ws);
      activeWsConnections.set(ws, { token, sessionId });
      ws.on('close', () => activeWsConnections.delete(ws));
    });
  } else if (pathname === '/ws/input') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._socket && ws._socket.setNoDelay(true);
      activeWsConnections.set(ws, { token, sessionId });
      ws.on('close', () => {
        activeWsConnections.delete(ws);
      });
      ws.on('message', (data) => {
        try {
          resources.inputHandler.sendInput(JSON.parse(data));
        } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});

// --- Central Error Handler ---
app.use((err, req, res, next) => {
  const reqId = req.requestId || '???';
  console.error(`[${reqId}] ${req.method} ${req.originalUrl} — Error:`, err.message, {
    stack: err.stack,
    tenantId: req.tenant?.tenantId,
    sessionId: req.params?.sessionId,
  });

  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' && status === 500
      ? 'Internal server error'
      : err.message,
    requestId: reqId,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// --- 404 Handler ---
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    requestId: req.requestId,
  });
});

// --- Structured Logging Wrapper ---
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatLog(level, args) {
  const timestamp = new Date().toISOString();
  const req = args[0]?.req || args[0]?.reqId || null;
  const reqId = req || (args[0] && args[0].requestId);
  const message = args.find(arg => typeof arg === 'string');
  const data = args.filter(arg => typeof arg !== 'string' && arg !== null && arg !== undefined)[0];

  return { timestamp, level, requestId: reqId, message: message || '', data };
}

console.log = (...args) => originalLog(JSON.stringify(formatLog('INFO', args)));
console.error = (...args) => originalError(JSON.stringify(formatLog('ERROR', args)));
console.warn = (...args) => originalWarn(JSON.stringify(formatLog('WARN', args)));

server.listen(PORT, '0.0.0.0', () => {
  console.log({
    message: 'Serende server started',
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    corsOrigins: corsOrigins,
    maxSessions: parseInt(process.env.MAX_SESSIONS) || 10,
  });
});

function cleanup() {
  console.log('[Serende] Shutting down...');
  for (const [, resources] of sessionResources) {
    resources.screencast.stop();
    resources.streamManager.stop();
    resources.inputHandler.stop();
  }
  sessionResources.clear();
  sessionManager.stopAllSessions();
  server.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
