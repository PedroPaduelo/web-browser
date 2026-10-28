const path = require('path');
require('dotenv').config({ override: true, path: path.resolve(__dirname, '.env') });

// Identidade desta instância do backend. Viaja no ambiente de todos os
// filhos que o backend spawna (Xvfb, Chrome, ffmpeg), e é o que permite
// limpiar órfãos SEM tocar nas outras instâncias do host (ver
// cleanupOrphanedProcesses). Precisa ser definido ANTES de qualquer require
// que possa spawnar processo.
const INSTANCE_ID = process.env.SERENDE_INSTANCE_ID || 'default';
process.env.SERENDE_INSTANCE_ID = INSTANCE_ID;

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('./node_modules/ws');
const cors = require('cors');
const crypto = require('crypto');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const keyStore = require('./key-store');
const sessionManager = require('./session-manager');
const StreamManager = require('./stream-manager');
const CDPScreencast = require('./cdp-screencast');
const { createInputHandler } = require('./cdp-input-handler');
const { generateToken, verifyToken, deriveTenantId, authMiddleware } = require('./auth');
const { login: adminJwtLogin, adminJwtAuth, adminAnyAuth } = require('./admin-auth');
const adminUsers = require('./admin-users');
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

// --- Rate Limiting Global (tenant-aware) ---
// Chavear por IP não funciona neste deploy: o MCP é um proxy local
// (SERENDE_API=http://localhost:4201), então TODO o tráfego vindo do MCP
// chega como 127.0.0.1 — todos os tenants disputavam UM único balde e um
// tenant só estourava o limite dos outros (virava 429 em cascata).
// A chave passa a ser a IDENTIDADE do tenant: o tenantId do JWT (verificado
// localmente, sem esperar o authMiddleware que roda depois do limiter) ou o
// hash da x-api-key. Tráfego sem identidade continua no balde por IP.
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
const RATE_LIMIT_MAX_REQUESTS_TENANT = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS_TENANT) || 600;

function tenantKeyFromRequest(req) {
  // Memoizado por request: keyGenerator e limit são avaliados separadamente,
  // e verifyToken faz uma verificação de assinatura (custo real) a cada chamada.
  if (req._rateLimitTenantKey !== undefined) return req._rateLimitTenantKey;

  let key = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const payload = verifyToken(authHeader.slice(7));
    const tenantId = payload && (payload.tenantId || payload.userId);
    if (tenantId) key = `tenant:${tenantId}`;
  }
  if (!key && req.headers['x-api-key']) {
    key = `tenant:${deriveTenantId(String(req.headers['x-api-key']))}`;
  }
  req._rateLimitTenantKey = key;
  return key;
}

const globalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: (req) => (tenantKeyFromRequest(req) ? RATE_LIMIT_MAX_REQUESTS_TENANT : RATE_LIMIT_MAX_REQUESTS),
  keyGenerator: (req) => tenantKeyFromRequest(req) || ipKeyGenerator(req.ip),
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

// O processo é líder do seu próprio process group? (PGID == PID).
// /proc/<pid>/stat: depois do ')' vem state, ppid, pgrp.
function isGroupLeader(pid) {
  try {
    const stat = require('fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[2]) === pid;
  } catch {
    return false;
  }
}

// Opções do screencast CDP, ancoradas na resolução REAL da sessão.
//
// O `maxHeight` tinha o default 720 (cdp-screencast.js) e NINGUÉM passava a
// altura da sessão. Com o teto de largura em 1280, o Chrome escala
// proporcionalmente: uma janela 1440x900 saía num frame 1280x720 — 180px de
// rodapé fora de quadro. Era a complaint do usuário ("a tela abre parecendo
// que tá cortando lá embaixo a tela útil de navegação").
//
// Agora o limite de ALTURA é a altura da própria sessão: o frame nunca corta a
// área útil. O limite de LARGURA (1280) continua, porque ele existe para
// segurar banda — e como a escala é proporcional, a altura resultante cabe
// dentro do limite de altura (o Chrome só reduz, nunca amplia).
function screencastOptions(sessionId, raw = {}) {
  const sess = sessionManager.getSession(sessionId);
  const res = (sess && sess.resolution) || (raw && raw.resolution);
  return {
    quality: 60,
    maxWidth: 1280,
    maxHeight: res && Number(res.height) ? Number(res.height) : 0,
    everyNthFrame: 1,
    sessionId,
  };
}

// --- Limpar processos órfãos DESTA instância ---
// Se o backend crashou antes, Xvfb, Chrome e ffmpeg podem ter ficado
// rodando e segurando display/porta.
//
// ESCOPO: só processos desta instância (SERENDE_INSTANCE_ID no ambiente).
// Antes o boot fazia `pkill -f "Xvfb :[1-9][0-9][0-9]"` (e `pkill -f x11grab`,
// `pkill -f serende-ffmpeg`), que matava TUDO no host — inclusive os
// browsers das OUTRAS instâncias (um backend de teste isolado derrubava o
// Xvfb da produção). Os lock files também eram apagados sem olhar quem era
// o dono do display.
(function cleanupOrphanedProcesses() {
  const fs = require('fs');
  const liveDisplays = new Set(); // displays com Xvfb vivo (qualquer instância)
  const orphans = []; // { pid, cmd, kind }

  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { entries = []; }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;

    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
    if (!cmd) continue;

    const xvfbMatch = cmd.match(/Xvfb\s+:(\d+)/);
    if (xvfbMatch) liveDisplays.add(Number(xvfbMatch[1]));

    let env = '';
    try { env = fs.readFileSync(`/proc/${name}/environ`, 'utf8'); } catch { env = ''; }
    if (!env.includes(`SERENDE_INSTANCE_ID=${INSTANCE_ID}`)) continue; // outra instância

    const isXvfb = !!xvfbMatch;
    const isFfmpeg = /x11grab/.test(cmd) || /serende-ffmpeg/.test(cmd);
    const isChrome = /remote-debugging-port=\d+/.test(cmd);
    if (!isXvfb && !isFfmpeg && !isChrome) continue;

    orphans.push({ pid, cmd, kind: isXvfb ? 'xvfb' : isFfmpeg ? 'ffmpeg' : 'chrome' });
  }

  const killed = [];
  for (const o of orphans) {
    try {
      if (o.kind === 'chrome') {
        // Só mata o PROCESS GROUP se o Chrome for o líder dele (spawn
        // detached => setsid => PGID == PID). Se não for, matar -pid
        // atingiria o grupo do próprio backend.
        if (isGroupLeader(o.pid)) {
          try { process.kill(-o.pid, 'SIGTERM'); } catch { process.kill(o.pid, 'SIGTERM'); }
        } else {
          process.kill(o.pid, 'SIGTERM');
        }
      } else {
        // Xvfb e ffmpeg também são spawneados com `detached: true`, então
        // matam-se por GRUPO: sinalizar só o líder deixaria o ffmpeg (neto do
        // wrapper sh) e os filhos do Xvfb vivos, segurando o socket X e a
        // memória. Só mata o grupo se o processo for o LÍDER dele — senão
        // `kill(-pid)` acertaria o grupo do próprio backend.
        if (isGroupLeader(o.pid)) {
          try { process.kill(-o.pid, 'SIGTERM'); } catch { process.kill(o.pid, 'SIGTERM'); }
        } else {
          process.kill(o.pid, 'SIGTERM');
        }
      }
      killed.push(o);
    } catch {}
  }

  // Escalona para SIGKILL o que não morreu (rechecando o cmdline para não
  // matar um PID reaproveitado).
  if (killed.length) {
    setTimeout(() => {
      for (const o of killed) {
        try {
          const cmd = fs.readFileSync(`/proc/${o.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
          if (!cmd) continue;
          if (o.kind === 'chrome') {
            if (isGroupLeader(o.pid)) {
              try { process.kill(-o.pid, 'SIGKILL'); } catch { try { process.kill(o.pid, 'SIGKILL'); } catch {} }
            } else {
              try { process.kill(o.pid, 'SIGKILL'); } catch {}
            }
          } else {
            if (isGroupLeader(o.pid)) {
              try { process.kill(-o.pid, 'SIGKILL'); } catch { try { process.kill(o.pid, 'SIGKILL'); } catch {} }
            } else {
              try { process.kill(o.pid, 'SIGKILL'); } catch {}
            }
          }
        } catch {}
      }
    }, 2000).unref?.();
  }

  // Lock/socket de display: só remove se NÃO houver Xvfb vivo naquele
  // display (lock órfão de um crash). Antes apagava tudo, inclusive o lock
  // de displays de outras instências vivas.
  for (let d = 100; d <= 199; d++) {
    if (liveDisplays.has(d)) continue;
    try { if (fs.existsSync(`/tmp/.X${d}-lock`)) fs.unlinkSync(`/tmp/.X${d}-lock`); } catch {}
    try { if (fs.existsSync(`/tmp/.X11-unix/X${d}`)) fs.unlinkSync(`/tmp/.X11-unix/X${d}`); } catch {}
  }

  console.log(`[Startup] Cleanup de órfãos da instância "${INSTANCE_ID}": ${killed.length} processo(s) (${killed.map((k) => `${k.kind}:${k.pid}`).join(', ') || 'nenhum'})`);
})();

const sessionResources = new Map();

// Queda do produtor de vídeo (ffmpeg): troca para o CDP screencast SEM
// derrubar a sessão — vídeo degrada de 30fps para ~0.3-20fps, mas continua.
sessionManager.onCaptureDied((sessionId, reason) => {
  const resources = sessionResources.get(sessionId);
  if (!resources) return;
  if (resources.captureMode !== 'ffmpeg') return; // já está no fallback
  resources.captureMode = 'cdp';
  try { resources.streamManager.stopCapture(); } catch {}
  try { resources.streamManager.mode = 'cdp'; } catch {}
  try {
    if (!resources.screencast) {
      resources.screencast = new CDPScreencast(sessionManager.getSession(sessionId)?.cdpPort,
        screencastOptions(sessionId));
    }
    resources.screencast.start((frame) => resources.streamManager.pushFrame(frame));
  } catch (e) {
    console.error(`[API] Fallback CDP screencast falhou para ${sessionId}:`, e.message);
    return;
  }
  console.warn(`[API] Session ${sessionId}: ffmpeg caiu (${reason}) — usando CDP screencast`);
});

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

// Limiter do login do ADMIN: mais restritivo que o de usuário (10/min) porque
// o alvo aqui é brute force de senha — e cada tentativa custa um scrypt.
const adminLoginAttempts = new Map();
const ADMIN_LOGIN_MAX = 5;
const ADMIN_LOGIN_WINDOW_MS = 5 * 60_000;

function adminLoginLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = adminLoginAttempts.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= ADMIN_LOGIN_MAX) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return res.status(429).json({ error: `Muitas tentativas. Tente em ${retryAfter}s` });
    }
    entry.count++;
  } else {
    adminLoginAttempts.set(ip, { count: 1, resetAt: now + ADMIN_LOGIN_WINDOW_MS });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of adminLoginAttempts) {
    if (now >= entry.resetAt) adminLoginAttempts.delete(ip);
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
  // Sessões com processo morto entram em recuperação assíncrona (sem bloquear o health).
  let deadCount = 0;
  try {
    const dead = sessionManager.getDeadSessions ? sessionManager.getDeadSessions() : [];
    deadCount = dead.length;
    if (deadCount && sessionManager.sweepDeadSessions) {
      sessionManager.sweepDeadSessions().catch((e) => console.warn('[Health] sweep falhou:', e.message));
    }
  } catch {}
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: {
      active: sessionManager.getSessionCount(),
      max: parseInt(process.env.MAX_SESSIONS) || 10,
      dead: deadCount,
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
    const { resolution, startUrl, extensionPath, locale, timezone } = req.body || {};
    const sessionId = uuidv4();
    const result = await sessionManager.startSession(sessionId, req.tenant.tenantId, {
      resolution, startUrl, extensionPath, locale, timezone,
      maxSessions: req.tenant.maxSessions,
    });

    // Iniciar timeout tracker
    sessionManager.startTimeoutTracker(sessionId);

    const raw = sessionManager.getSessionRaw(sessionId);
    if (!raw) {
      const vanished = new Error('Sessão sumiu logo após o start (limpeza concorrente?)');
      vanished.stage = 'resources';
      vanished.code = 'session_vanished';
      vanished.status = 500;
      throw vanished;
    }

    // Se ligar stream/input falhar, a sessão (Xvfb+Chrome) NÃO pode vazar: para tudo.
    try {
      // --- Produtor de VÍDEO ---
      // Primário: ffmpeg x11grab (30fps). Fallback: CDP screencast (~0.3-20fps,
      // só emite frame quando a página repinta).
      const streamMgr = new StreamManager();
      const screencast = new CDPScreencast(raw.cdpPort, screencastOptions(sessionId, raw));

      let captureMode = 'cdp';
      if (raw.capture && raw.capture.stdout) {
        try {
          raw.capture.stdout.resume();
          streamMgr.startCapture(raw.capture.stdout);
          captureMode = 'ffmpeg';
          console.log(`[API] Session ${sessionId}: video via ffmpeg x11grab`);
        } catch (e) {
          console.error(`[API] Session ${sessionId}: ffmpeg startCapture falhou, usando CDP:`, e.message);
        }
      }
      if (captureMode === 'cdp') {
        streamMgr.mode = 'cdp';
        screencast.start((frame) => streamMgr.pushFrame(frame));
        console.log(`[API] Session ${sessionId}: video via CDP screencast (fallback)`);
      }

      const inputHdl = createInputHandler(raw.displayNum);

      // --- Stealth ambiental (caso Serpro 429) ---
      // Aplicado UMA vez no boot, antes de devolver a sessão: timezone da página
      // + remoção de navigator.webdriver em todo documento futuro. Best-effort:
      // se o CDP ainda não responde, a sessão segue sem stealth (não falha).
      try {
        if (raw.timezone) {
          await cdpRequest(raw.cdpPort, 'Emulation.setTimezoneOverride', {
            timezoneId: raw.timezone,
          });
        }
        await cdpRequest(raw.cdpPort, 'Page.addScriptToEvaluateOnNewDocument', {
          source: [
            // navigator.webdriver: false não basta esconder — o Chrome define
            // como true sob automação; redefine como getter falso e não
            // configurável, como num browser manual.
            'Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });',
            // Chrome runtime falso-positivo: alguns detectores checam
            // window.chrome.runtime ausente como sinal de headless.
            'if (window.chrome && !window.chrome.runtime) { window.chrome.runtime = {}; }',
          ].join('\n'),
        });
        console.log(`[API] Session ${sessionId}: stealth aplicado (tz=${raw.timezone || 'default'}, lang=${raw.locale || 'default'})`);
      } catch (e) {
        console.warn(`[API] Session ${sessionId}: stealth falhou (segue sem):`, e.message);
      }

      sessionResources.set(sessionId, { streamManager: streamMgr, screencast, inputHandler: inputHdl, captureMode });
    } catch (setupErr) {
      try { await sessionManager.stopSession(sessionId, 'resource_setup_failed'); } catch {}
      const wrapped = new Error(`Falha ao ligar stream/input da sessão: ${setupErr.message}`);
      wrapped.stage = 'resources';
      wrapped.code = 'resource_setup_failed';
      wrapped.status = 502;
      throw wrapped;
    }

    res.status(201).json({
      sessionId,
      status: 'running',
      resolution: result.resolution,
    });
  } catch (err) {
    console.error('[API] Start session error:', `stage=${err.stage || 'unknown'}`, `code=${err.code || 'start_failed'}`, err.message);
    const msg = String(err.message || '');
    const status = err.status
      || (err.code === 'limit_reached' || err.code === 'no_display' || msg.includes('limit') ? 429
      : err.code === 'bad_resolution' ? 400
      : err.code === 'missing_binary' ? 503
      : err.stage === 'cdp' || err.stage === 'chrome' || err.stage === 'xvfb' || err.stage === 'resources' ? 502
      : 500);
    res.status(status).json({ error: err.message, stage: err.stage || 'unknown', code: err.code || 'start_failed', requestId: req.requestId });
  }
});

app.delete('/api/session/:sessionId', authMiddleware, async (req, res) => {
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

  // Espera o Chrome fechar antes de responder: "Session stopped" passa a
  // significar que RAM, display e porta já voltaram.
  try {
    await sessionManager.stopSession(sessionId);
  } catch (e) {
    return res.status(500).json({ error: 'Stop failed: ' + e.message });
  }
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

  // Sessão registrada mas com processo morto → 410 + recuperação, em vez de "running" fantasma.
  try {
    const health = sessionManager.getSessionHealth ? sessionManager.getSessionHealth(req.params.sessionId) : { alive: true };
    if (health && !health.alive) {
      if (sessionManager.sweepDeadSessions) sessionManager.sweepDeadSessions().catch(() => {});
      return res.status(410).json({
        error: `Session dead (${health.reason}). Crie uma nova sessão.`,
        stage: 'health',
        code: health.reason || 'dead',
        requestId: req.requestId,
      });
    }
  } catch {}

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

app.post('/api/input', authMiddleware, trackActivity, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  req.params = { ...req.params, sessionId };
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const msg = req.body;
  if (!msg.type) return res.status(400).json({ error: 'Missing type' });

  const resources = sessionResources.get(sessionId);
  if (resources) {
    // O handler abre a conexão CDP ~300ms depois de criado; antes disso a
    // ação seria descartada. Espera ficar pronto (bounded).
    if (resources.inputHandler.waitReady) await resources.inputHandler.waitReady(3000);
    resources.inputHandler.sendInput(msg);
  }
  res.json({ ok: true });
});

// Um mousemove por frame do navegador. O Chrome COALESCING os moves
// pendentes (no máximo um `mousemove` no DOM por frame): despachar N moves
// seguidos no mesmo tick chega ao DOM como ~N/2 eventos (medido: 10 moves
// -> 5 eventos no DOM), e o arrasto "anda" aos trancos. 16ms = 1 frame a
// 60Hz: cada move vira um evento próprio, na ordem.
const MOUSE_MOVE_FRAME_MS = 16;

app.post('/api/input/batch', authMiddleware, trackActivity, async (req, res) => {
  const { sessionId, actions } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!Array.isArray(actions)) return res.status(400).json({ error: 'Missing actions array' });

  req.params = { ...req.params, sessionId };
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const resources = sessionResources.get(sessionId);
  if (resources) {
    const input = resources.inputHandler;
    // Espera o handler estar conectado no CDP: até lá a ação seria
    // descartada e o gesto começaria pela metade (o primeiro arrasto da
    // sessão perdia o mousedown).
    if (input.waitReady) await input.waitReady(3000);
    for (const msg of actions) {
      if (!msg || !msg.type) continue;
      input.sendInput(msg);
      // Cada ação precisa sair ANTES da próxima:
      //  - `flush()` descarrega o mousemove pendente (o coalescing do handler
      //    colapsaria N movimentos em 1 e o Chrome receberia o movimento só
      //    no fim do lote);
      //  - o `await` dá a volta do event loop para o setImmediate do flush
      //    rodar, garantindo a ORDEM dos eventos no DOM
      //    (pointerdown → mousedown → mousemove(s) → mouseup).
      // Sem isso o `drag` com steps:10 entregava 1 mousemove, e ele chegava
      // DEPOIS do mouseup (medido no DOM pelo QA).
      if (input.flush) input.flush();
      await new Promise((resolve) => setImmediate(resolve));
      // Um move por frame: o Chrome coalesce os mousemove pendentes e o
      // DOM receberia ~metade dos eventos (o arrasto anda aos trancos).
      if (msg.type === 'mousemove') {
        await new Promise((resolve) => setTimeout(resolve, MOUSE_MOVE_FRAME_MS));
      }
    }
  }
  res.json({ ok: true, count: actions.length });
});

const cdpPools = new Map();

// Uma conexão CDP por porta. Chamadas concorrentes (o GET de rede, o evaluate
// de uma tool e o input) esperavam o mesmo WebSocket: sem isso cada uma abria
// o seu, a última sobrescrevia a primeira no mapa e a primeira seguia viva,
// recebendo cada evento de rede de novo.
const cdpConnecting = new Map();
function getCdpClient(cdpPort) {
  const existing = cdpPools.get(cdpPort);
  if (existing && existing.ready) {
    clearTimeout(existing.closeTimer);
    existing.closeTimer = setTimeout(() => closeCdpClient(cdpPort), 30_000);
    return Promise.resolve(existing);
  }
  if (cdpConnecting.has(cdpPort)) return cdpConnecting.get(cdpPort);
  const p = openCdpClient(cdpPort).finally(() => cdpConnecting.delete(cdpPort));
  cdpConnecting.set(cdpPort, p);
  return p;
}

async function openCdpClient(cdpPort) {
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
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg) return;
      // Eventos do CDP (não têm `id`): é por eles que a rede é capturada
      // (Network.requestWillBeSent / responseReceived / loadingFinished).
      if (msg.method) { dispatchCdpEvent(cdpPort, msg); return; }
      if (msg.id && pool.pendingRequests.has(msg.id)) {
        const { resolve: res, reject: rej } = pool.pendingRequests.get(msg.id);
        pool.pendingRequests.delete(msg.id);
        if (msg.result) res(msg.result);
        else rej(new Error(msg.error?.message || 'CDP error'));
      }
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

async function getCurrentPageUrl(cdpPort) {
  try {
    const result = await cdpRequest(cdpPort, 'Page.getNavigationHistory', {});
    const entries = result?.entries || [];
    const idx = result?.currentIndex || 0;
    return entries[idx]?.url || null;
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

// Dimensões de um JPEG (marcador SOF). Usado para reportar o tamanho real
// da imagem capturada — é o que permite checar "a coordenada lida na imagem
// é a mesma que o find_element devolve".
function jpegSize(buf) {
  if (!buf || buf.length < 4) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // marcadores sem payload (SOI, RSTn, TEM)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xff) { i++; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// Screenshot com info (URL, title, timestamp) - para exibir no viewer com overlay
//
// A captura respeita a RESOLUÇÃO DA SESSÃO (o viewport real do Chrome).
// Antes, antes de capturar, o handler aplicava
// `Emulation.setDeviceMetricsOverride {width: 1920, height: max(scrollHeight,2000)}`:
// a imagem saía 1920-wide enquanto a sessão era 1280x720, e o conteúdo ficava
// deslocado ~320px em X — a coordenada lida na imagem NÃO era a que
// `find_element` devolve, e o agente clicava no lugar errado (a descrição de
// `mouse_click` manda "always take a screenshot first").
//
// Regra agora: imagem 1:1 com o viewport => coordenada da imagem ==
// coordenada do DOM. E o override é LIMPO antes da captura, para consertar
// sessões que já ficaram presas no 1920-wide de uma captura anterior.
app.get('/api/screenshotWithInfo/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  try {
    const pageUrl = await getPageTargetWsUrl(session.cdpPort);
    if (!pageUrl) return res.status(500).json({ error: 'CDP not available' });

    const ws = await import('./node_modules/ws/index.js');
    const result = await new Promise((resolve, reject) => {
      const client = new ws.default(pageUrl);
      let infoData = null;
      let viewport = null;
      let done = false;

      const MEASURE = '({ url: location.href, title: document.title, scrollHeight: Math.max(document.body && document.body.scrollHeight || 0, document.documentElement.scrollHeight), width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })';

      client.on('open', () => {
        client.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
      });

      client.on('message', (data) => {
        if (done) return;
        const msg = JSON.parse(data);
        if (msg.error) {
          // clearDeviceMetricsOverride é tolerante: se o Chrome não souber
          // o comando, segue medindo e capturando (a captura não depende dele).
          if (msg.id === 3) {
            client.send(JSON.stringify({ id: 4, method: 'Runtime.evaluate', params: { expression: MEASURE, returnByValue: true } }));
            return;
          }
          done = true; client.close(); reject(new Error(msg.error.message)); return;
        }

        // 1 -> 2: mede a página (url/title/viewport).
        if (msg.id === 1 && msg.result) {
          client.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: MEASURE, returnByValue: true } }));
          return;
        }

        // 2 -> 3: o CDP aninha o valor em result.result.value (mesmo path do
        // cdp-input-handler). Ler msg.result?.value nunca achava nada.
        if (msg.id === 2 && msg.result) {
          const value = msg.result?.result?.value;
          if (value) infoData = value;
          if (value && value.width > 0 && value.height > 0) viewport = { width: value.width, height: value.height };
          // Limpa qualquer override de device metrics (sessão envenenada por
          // uma captura 1920-wide anterior) e volta a medir o viewport real.
          client.send(JSON.stringify({ id: 3, method: 'Emulation.clearDeviceMetricsOverride', params: {} }));
          return;
        }

        // 3 -> 4: depois do clear o renderer pode levar um tick para
          // re-layoutar; mede de novo (é esta a medida que vale).
        if (msg.id === 3 && msg.result) {
          setTimeout(() => {
            if (done) return;
            client.send(JSON.stringify({ id: 4, method: 'Runtime.evaluate', params: { expression: MEASURE, returnByValue: true } }));
          }, 150);
          return;
        }

        // 4 -> 5: viewport final + captura do viewport (sem override).
        if (msg.id === 4 && msg.result) {
          const value = msg.result?.result?.value;
          if (value) {
            infoData = value;
            if (value.width > 0 && value.height > 0) viewport = { width: value.width, height: value.height };
          }
          client.send(JSON.stringify({
            id: 5,
            method: 'Page.captureScreenshot',
            params: { format: 'jpeg', quality: 80, captureBeyondViewport: false, fromSurface: true },
          }));
          return;
        }

        // 5: imagem capturada.
        if (msg.id === 5 && msg.result && msg.result.data) {
          done = true;
          client.close();
          resolve({ screenshot: msg.result.data, info: infoData || {}, viewport });
        }
      });
      client.on('error', reject);
      setTimeout(() => { if (!done) { done = true; client.close(); reject(new Error('Screenshot timeout')); } }, 15000);
    });

    const image = jpegSize(Buffer.from(result.screenshot, 'base64'));
    res.json({
      screenshot: result.screenshot,
      info: {
        ...(result.info || {}),
        timestamp: Date.now(),
        // Viewport real da sessão e o tamanho da imagem capturada: é o que
        // permite conferir "a coordenada lida na imagem = a do find_element".
        viewport: result.viewport || null,
        image: image || null,
      },
    });
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
    const result = await cdpRequest(session.cdpPort, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      // Sem awaitPromise, um script que devolve uma Promise voltava como
      // "sem valor" ({} no corpo) — indistinguível de erro.
      awaitPromise: true,
    });

    // O CDP NÃO sinaliza exceção como erro de protocolo: vem em
    // `exceptionDetails`, com `result` vazio. Descartar esse campo (o
    // código antigo fazia `res.json({ result: result.result?.value })`)
    // transformava QUALQUER exceção em HTTP 200 + corpo vazio — o agente
    // recebia "sucesso" sem valor e não tinha como distinguir erro de
    // resultado vazio. Agora a exceção é erro de verdade (4xx, mensagem
    // real) e o MCP vira isError:true.
    const exception = result.exceptionDetails;
    if (exception) {
      const message = exception.exception?.description
        || (exception.exception?.value !== undefined ? String(exception.exception.value) : null)
        || exception.text
        || 'Script execution failed';
      return res.status(400).json({
        error: String(message),
        code: 'script_exception',
        stage: 'evaluate',
        errorType: exception.exception?.className || exception.text || 'Error',
        lineNumber: exception.lineNumber ?? null,
        columnNumber: exception.columnNumber ?? null,
        stack: (exception.stackTrace?.callFrames || []).slice(0, 5).map((f) => ({
          functionName: f.functionName || '<anonymous>',
          url: f.url || '',
          lineNumber: f.lineNumber ?? null,
          columnNumber: f.columnNumber ?? null,
        })),
        requestId: req.requestId,
      });
    }

    // Sem exceção: resultado legítimo. Distingue "valor vazio" (undefined /
    // não serializável) de "erro" — o valor continua em `result` para não
    // quebrar os consumidores (find_element, get_text, ...).
    const remote = result.result || {};
    const hasValue = Object.prototype.hasOwnProperty.call(remote, 'value');
    res.json({
      result: hasValue ? remote.value : null,
      hasValue,
      type: remote.type || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, requestId: req.requestId });
  }
});

// ========== NETWORK TRACKING ==========
//
// A rede é capturada PELOS EVENTOS do CDP (Network.requestWillBeSent,
// Network.responseReceived, Network.loadingFinished/loadingFailed), que é a
// única forma de o CDP expor o histórico.
//
// Antes, o handler chamava `Network.getRequests` e `Network.getResponses`:
// ESSES MÉTODOS NÃO EXISTEM no CDP (o comando responde "wasn't found"), e o
// fallback preenchia `responses` com `Network.getAllCookies` — ou seja, as
// "respostas HTTP" eram COOKIES (sem url, método, status ou tamanho), e o
// filtro por URL nunca casava.
//
// Buffer por sessão: { cdpPort, enabled, requests[], responses[], byRequestId }
const networkEvents = new Map();

// Handler de eventos CDP por porta: o pool de WebSocket do backend recebe os
// eventos (eles não têm `id`) e os despacha por porta.
const cdpEventHandlers = new Map();

function dispatchCdpEvent(cdpPort, msg) {
  const handler = cdpEventHandlers.get(cdpPort);
  if (!handler) return;
  try { handler(msg); } catch (e) { console.error('[Network] handler de evento falhou:', e.message); }
}

// Limite do buffer (evita crescimento infinito em navegação longa).
const NETWORK_BUFFER_MAX = 500;

function pushCapped(arr, entry) {
  arr.push(entry);
  if (arr.length > NETWORK_BUFFER_MAX) arr.splice(0, arr.length - NETWORK_BUFFER_MAX);
}

// Monta o handler de eventos de rede de uma sessão.
//
// `state` diz em que ponto cada requisição está, porque nem toda requisição
// termina: o Chrome NÃO emite Network.loadingFinished para um fetch POST cujo
// corpo a página nunca lê (medido no CDP cru: chegam responseReceived e
// dataReceived, o fim nunca, nem após GC). Aí a entrada fica `receiving`,
// com o que já se sabe (status, headersMs, bytesReceived), em vez de
// durationMs/size vazios sem explicação.
//   sent → receiving → finished | failed;  redirected = salto de um redirect.
function networkEventHandler(sid) {
  // Tempo desde o envio da requisição, pelos relógios do PRÓPRIO Chrome
  // (timestamps monotônicos do CDP, em segundos). Date.now() media a chegada
  // dos eventos no backend, não a requisição.
  const elapsedMs = (entry, cdpTs, now) => {
    const start = typeof entry.cdpTimestamp === 'number' ? entry.cdpTimestamp : entry.responseCdpTimestamp;
    if (typeof start === 'number' && typeof cdpTs === 'number') return Math.max(0, Math.round((cdpTs - start) * 1000));
    return now - entry.timestamp;
  };

  return (msg) => {
    const ev = networkEvents.get(sid);
    if (!ev || !ev.enabled) return;
    const p = msg.params || {};
    const now = Date.now();

    // Dedup: o mesmo evento CDP (método + requestId + timestamp) só entra uma
    // vez. Duas conexões à mesma página entregavam cada evento duas vezes.
    if (p.requestId) {
      if (!ev.seen) ev.seen = new Set();
      const k = `${msg.method}|${p.requestId}|${p.timestamp}|${p.dataLength ?? ''}`;
      if (ev.seen.has(k)) return;
      ev.seen.add(k);
      if (ev.seen.size > 5000) ev.seen = new Set();
    }

    if (msg.method === 'Network.requestWillBeSent') {
      const req = p.request || {};
      // Redirect: o Chrome reusa o requestId. A entrada anterior é o salto que
      // redirecionou: fecha ela com o status do redirect, senão ficaria "sem
      // resposta" para sempre.
      const prev = p.redirectResponse ? ev.byRequestId.get(p.requestId) : null;
      if (prev) {
        prev.status = p.redirectResponse.status || 0;
        prev.statusText = p.redirectResponse.statusText || '';
        prev.redirectedTo = req.url || '';
        prev.state = 'redirected';
        prev.durationMs = elapsedMs(prev, p.timestamp, now);
      }
      const entry = {
        requestId: p.requestId,
        url: req.url || '',
        method: req.method || 'GET',
        type: p.type || '',
        timestamp: now,
        cdpTimestamp: p.timestamp,
        state: 'sent',
        postData: typeof req.postData === 'string' ? req.postData.slice(0, 2000) : undefined,
      };
      ev.byRequestId.set(p.requestId, entry);
      pushCapped(ev.requests, entry);
      return;
    }

    if (msg.method === 'Network.responseReceived') {
      const resp = p.response || {};
      let entry = ev.byRequestId.get(p.requestId);
      if (!entry) {
        entry = {
          requestId: p.requestId,
          url: resp.url || '',
          method: '',
          type: p.type || '',
          timestamp: now,
        };
        ev.byRequestId.set(p.requestId, entry);
        pushCapped(ev.requests, entry);
      }
      entry.url = resp.url || entry.url;
      entry.status = resp.status || 0;
      entry.statusText = resp.statusText || '';
      entry.mimeType = resp.mimeType || '';
      entry.fromCache = !!resp.fromDiskCache;
      entry.responseTimestamp = now;
      entry.responseCdpTimestamp = p.timestamp;
      if (typeof entry.cdpTimestamp === 'number') entry.headersMs = elapsedMs(entry, p.timestamp, now);
      if (entry.state !== 'finished' && entry.state !== 'failed') entry.state = 'receiving';
      const contentLength = resp.headers && (resp.headers['content-length'] || resp.headers['Content-Length']);
      if (contentLength !== undefined) entry.contentLength = Number(contentLength) || 0;
      pushCapped(ev.responses, entry);
      return;
    }

    if (msg.method === 'Network.dataReceived') {
      const entry = ev.byRequestId.get(p.requestId);
      if (!entry) return;
      entry.bytesReceived = (entry.bytesReceived || 0) + (Number(p.dataLength) || 0);
      return;
    }

    if (msg.method === 'Network.loadingFinished') {
      const entry = ev.byRequestId.get(p.requestId);
      if (!entry) return;
      entry.size = Number(p.encodedDataLength) || 0;
      entry.durationMs = elapsedMs(entry, p.timestamp, now);
      entry.finished = true;
      entry.state = 'finished';
      return;
    }

    if (msg.method === 'Network.loadingFailed') {
      const entry = ev.byRequestId.get(p.requestId);
      if (!entry) return;
      entry.failed = true;
      entry.state = 'failed';
      entry.errorText = p.errorText || 'request failed';
      entry.durationMs = elapsedMs(entry, p.timestamp, now);
    }
  };
}

async function enableNetworkTracking(sessionId, cdpPort) {
  try {
    // Só `Network.enable`. O `Network.setRequestInterception` (que o código
    // antigo usava) PAUSA toda requisição e não continua nunca — a navegação
    // ficava pendurada. Para captura passiva não é preciso.
    await cdpRequest(cdpPort, 'Network.enable', {});
    cdpEventHandlers.set(cdpPort, networkEventHandler(sessionId));
    return true;
  } catch (err) {
    console.error('[Network] Failed to enable:', err.message);
    return false;
  }
}

async function disableNetworkTracking(cdpPort) {
  try {
    await cdpRequest(cdpPort, 'Network.disable', {});
  } catch (err) {
    // ignore
  }
  cdpEventHandlers.delete(cdpPort);
}

app.post('/api/network/:sessionId/start', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const sid = session.sessionId;
  let events = networkEvents.get(sid);
  if (!events) {
    events = { cdpPort: session.cdpPort, enabled: false, requests: [], responses: [], byRequestId: new Map() };
    networkEvents.set(sid, events);
  }
  events.cdpPort = session.cdpPort;

  const ok = await enableNetworkTracking(sid, session.cdpPort);
  events.enabled = ok;
  events.requests = [];
  events.responses = [];
  events.byRequestId = new Map();
  res.json({ status: ok ? 'enabled' : 'failed', enabled: ok, message: ok ? 'Network tracking started' : 'Failed to enable Network domain' });
});

app.post('/api/network/:sessionId/stop', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const sid = session.sessionId;
  const events = networkEvents.get(sid);

  try {
    await disableNetworkTracking(session.cdpPort);
    if (events) events.enabled = false;
    res.json({ status: 'disabled', message: 'Network tracking stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Esvazia o buffer e CONTINUA capturando. Antes, o "clear" do MCP chamava o
// /stop: desligava a captura, não esvaziava nada e respondia "buffer cleared".
app.post('/api/network/:sessionId/clear', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const events = networkEvents.get(session.sessionId);
  if (events) {
    events.requests = [];
    events.responses = [];
    events.byRequestId = new Map();
    events.seen = new Set();
  }
  const capturing = !!(events && events.enabled);
  res.json({
    status: 'cleared',
    enabled: capturing,
    message: capturing
      ? 'Network buffer cleared; capture is still running'
      : 'Network buffer cleared; capture is NOT running (use action="start")',
  });
});

app.get('/api/network/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const sid = session.sessionId;
  const events = networkEvents.get(sid);

  if (!events) {
    return res.json({ enabled: false, requests: [], responses: [] });
  }

  // Garante o domínio Network ligado na conexão atual (o pool CDP é
  // descartado após 30s ocioso e recriado — sem isso os eventos param de
  // chegar depois do idle).
  if (events.enabled) {
    try { await cdpRequest(session.cdpPort, 'Network.enable', {}); } catch {}
    if (!cdpEventHandlers.has(session.cdpPort)) {
      cdpEventHandlers.set(session.cdpPort, networkEventHandler(sid));
    }
  }

  // Lista vazia é honesta; cookie disfarçado de resposta HTTP não é.
  res.json({
    enabled: events.enabled,
    requests: events.requests,
    responses: events.responses
  });
});

// ========== COOKIES ==========

app.get('/api/cookies/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  try {
    const result = await cdpRequest(session.cdpPort, 'Network.getAllCookies', {});
    res.json({ cookies: result.cookies || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cookies/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const { name, value, domain, path, secure, httpOnly, expires, sameSite } = req.body || {};
  if (!name || !value) {
    return res.status(400).json({ error: 'name and value required' });
  }

  try {
    // First navigate to the domain to set cookies
    const urlResult = await cdpRequest(session.cdpPort, 'Page.getNavigationHistory');
    const currentUrl = urlResult?.entries?.[urlResult.currentIndex]?.url || 'https://example.com';
    const url = new URL(currentUrl);

    const result = await cdpRequest(session.cdpPort, 'Network.setCookie', {
      name,
      value,
      domain: domain || url.hostname,
      path: path || '/',
      secure: secure ?? true,
      httpOnly: httpOnly ?? false,
      sameSite: sameSite || 'None',
      expires: expires || undefined
    });

    res.json({ success: result.success === true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cookies/:sessionId', authMiddleware, trackActivity, async (req, res) => {
  const session = getSessionAndValidate(req, res);
  if (!session) return;

  const { name, domain, url } = req.query || {};
  if (!name) {
    return res.status(400).json({ error: 'name query param required' });
  }

  try {
    // O CDP exige URL OU domínio para apagar um cookie. Sem os dois ele
    // responde "At least one of the url and domain needs to be specified" —
    // é o que fazia delete_cookie falhar 100% das vezes. O domínio padrão é
    // o host da página atual: o Chrome aceita um delete com domain exato
    // para um cookie com host-only (domain ""), então é a derivação mais
    // segura sem consultar o cookie antes.
    let cookieDomain = domain || undefined;
    let cookieUrl = url || undefined;
    if (!cookieDomain && !cookieUrl) {
      const currentUrl = await getCurrentPageUrl(session.cdpPort);
      if (currentUrl) cookieDomain = new URL(currentUrl).hostname;
    }

    const result = await cdpRequest(session.cdpPort, 'Network.deleteCookies', {
      name,
      domain: cookieDomain,
      url: cookieUrl,
    });
    res.json({ success: result?.success !== false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin Middleware ---

// Aceita JWT de login (novo) OU X-Admin-Secret (legado). O JWT é o caminho
// que a tela nova usa; o secret fica para scripts e para o painel antigo
// durante a transição. Sem ADMIN_SECRET no ambiente, só o JWT autentica.
function verifyLegacyAdminSecret(candidate) {
  if (!ADMIN_SECRET) return false;
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

const adminAuth = adminAnyAuth(verifyLegacyAdminSecret);

// --- Admin Auth (email + senha → JWT) ---

app.post('/api/admin/auth/login', adminLoginLimiter, (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password must be strings' });
  }
  if (password.length > 512) {
    return res.status(400).json({ error: 'Password too long' });
  }

  let result;
  try {
    result = adminJwtLogin(email, password);
  } catch (err) {
    // Sem JWT_SECRET o login não pode funcionar — 503, não 401 (o usuário
    // erraria a senha para sempre sem consertar nada).
    console.error('[AdminAuth] login falhou:', err.message);
    return res.status(503).json({ error: 'Admin auth not configured' });
  }

  if (!result.ok) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  res.json({
    token: result.token,
    admin: result.user,
    expiresIn: process.env.ADMIN_JWT_EXPIRY || process.env.JWT_EXPIRY || '24h',
  });
});

// Confirma o token e devolve o dono. Usado pelo painel ao recarregar a página
// para decidir entre a tela de login e o dashboard.
app.get('/api/admin/auth/me', adminJwtAuth, (req, res) => {
  res.json({ admin: req.admin });
});

app.post('/api/admin/auth/logout', adminJwtAuth, (req, res) => {
  // JWT é stateless: não há sessão no servidor para invalidar. O "logout" é o
  // frontend descartar o token; esta rota existe para o cliente ter um alvo
  // simétrico e para sabermos que o token ainda era válido.
  res.json({ ok: true });
});

// Troca a própria senha (o painel usa para forçar a troca no primeiro acesso).
app.post('/api/admin/auth/password', adminJwtAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'A nova senha precisa de pelo menos 8 caracteres' });
  }
  if (newPassword.length > 512) {
    return res.status(400).json({ error: 'Nova senha muito longa' });
  }

  // getCredentialsById (não getUserById): só este caminho precisa do hash.
  const creds = adminUsers.getCredentialsById(req.admin.id);
  if (!creds || !adminUsers.verifyPassword(currentPassword, creds.password_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'A nova senha deve ser diferente da atual' });
  }

  try {
    adminUsers.updatePassword(req.admin.id, newPassword);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ok: true });
});

// --- Admin Routes ---

// Bootstrap do PRIMEIRO admin. Sem esta rota, um deploy novo nasce com a
// tabela admin_users vazia (o servidor cria a tabela, mas nunca chama
// createUser) e ninguém consegue entrar no painel — o login existe, mas não
// há contra quem verificar a senha.
//
// Regras de segurança:
//   • só cria se a tabela estiver VAZIA (countUsers() === 0). Com um usuário
//     no banco, devolve 409 — não é brecha para criar admin arbitrariamente;
//   • exige o ADMIN_SECRET do ambiente pelo header X-Admin-Secret. Sem o
//     secret configurado, a rota é 503 (não "aberta": deploy sem secret não
//     deveria estar criando admin por HTTP);
//   • valida email e senha com as MESMAS regras do cadastro normal;
//   • não faz login automático: devolve 201 e quem chamou usa /auth/login.
//     Assim o primeiro acesso passa pelo limite de tentativas igual ao resto.
app.post('/api/admin/bootstrap', adminLoginLimiter, (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'ADMIN_SECRET not configured' });
  }
  if (!verifyLegacyAdminSecret(req.headers['x-admin-secret'])) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }

  let existing;
  try {
    existing = adminUsers.countUsers();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (existing > 0) {
    return res.status(409).json({ error: 'Admin already exists' });
  }

  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password must be strings' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'A senha precisa de pelo menos 8 caracteres' });
  }
  if (password.length > 512) {
    return res.status(400).json({ error: 'Password too long' });
  }

  let user;
  try {
    user = adminUsers.createUser(email, password, name || '');
  } catch (err) {
    // email inválido ou duplicado (duplicado não deveria acontecer: a tabela
    // estava vazia, mas entre o countUsers e o INSERT outra corrida pode
    // ter criado — daí a mensagem vem do próprio createUser).
    return res.status(400).json({ error: err.message });
  }

  console.log('[AdminAuth] primeiro admin criado via bootstrap:', user.email);
  res.status(201).json({ admin: user });
});

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

app.get('/api/admin/sessions', adminAuth, async (req, res) => {
  try {
    const allSessions = sessionManager.getAllSessions();
    const keys = keyStore.listKeys();
    const keyMap = {};
    for (const k of keys) keyMap[k.id] = k.name;

    // URL e titulo de cada sessao: o painel precisa mostrar O QUE a pessoa
    // esta vendo, nao so que existe uma sessao. A leitura vai ao CDP, que
    // pode estar ocupado: uma sessao morta nao pode derrubar a lista toda,
    // entao a falha fica em null e a sessao continua na lista.
    const sessions = await Promise.all(allSessions.map(async (s) => {
      const sess = sessionManager.getSession(s.sessionId);
      let url = null;
      let title = null;
      try {
        if (sess) {
          url = await getCurrentPageUrl(sess.cdpPort);
          const t = await cdpRequest(sess.cdpPort, 'Runtime.evaluate', {
            expression: 'document.title', returnByValue: true,
          });
          title = t?.result?.value || null;
        }
      } catch {
        // Sessao sem CDP vivo: segue sem url/titulo.
      }
      return {
        ...s,
        tenantName: keyMap[s.tenantId] || 'Unknown',
        url,
        title,
        timeout: sessionManager.getSessionTimeout(s.sessionId),
      };
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

// Miniatura de uma sessao, para o painel mostrar varias telas ao mesmo tempo.
//
// A captura e ESCALADA no proprio Chrome (Page.captureScreenshot com clip
// scale), entao o servidor nao decodifica JPEG nenhum: o Chrome entrega a
// imagem pequena. O cache e curtinho (1,5 s) porque a grade atualiza a cada
// poucos segundos e varias sessoes batem no mesmo instante.
//
// A chave inclui a largura: pedir 160 e 640 da MESMA sessao sao miniaturas
// diferentes, e servir uma no lugar da outra mostra a imagem errada.
//
// Declarado ANTES de stopSessionFully: o cache e limpo quando a sessao
// morre, e um `const` usado antes da declaracao cai em TDZ.
const thumbCache = new Map(); // `${sessionId}@${width}` → { data, mime, at }
const THUMB_TTL_MS = 1500;

// Derruba uma sessao: para o stream, o input, o gerenciador e o cliente CDP.
// Extraido para ser reusado pelo DELETE individual e pelo DELETE em lote.
function stopSessionFully(sessionId) {
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;

  // A miniatura em cache e da sessao que esta morrendo: sai junto. A chave
  // tem a largura, entao apaga todas as larguras daquela sessao.
  for (const k of [...thumbCache.keys()]) {
    if (k.startsWith(`${sessionId}@`)) thumbCache.delete(k);
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
  return true;
}

app.delete('/api/admin/sessions/:sessionId', adminAuth, (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!stopSessionFully(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ message: 'Session stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Miniatura de uma sessao, para o painel mostrar varias telas ao mesmo tempo.
// (o cache e as constantes ficam acima de stopSessionFully)

async function captureThumbnail(session, maxWidth) {
  const target = Math.max(64, Math.min(640, Number(maxWidth) || 320));
  const sw = session.resolution?.width || 1440;
  const sh = session.resolution?.height || 900;
  const scale = target / sw;
  const result = await cdpRequest(session.cdpPort, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 45,
    clip: { x: 0, y: 0, width: sw, height: sh, scale },
  });
  if (!result?.data) throw new Error('captura sem dados');
  return Buffer.from(result.data, 'base64');
}

app.get('/api/admin/sessions/:sessionId/thumbnail', adminAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const width = Math.max(64, Math.min(640, Number(req.query.w) || 320));
  const cacheKey = `${sessionId}@${width}`;

  const cached = thumbCache.get(cacheKey);
  if (cached && Date.now() - cached.at < THUMB_TTL_MS) {
    res.set('Content-Type', cached.mime);
    res.set('Cache-Control', 'no-store');
    return res.send(cached.data);
  }

  try {
    const buf = await captureThumbnail(session, width);
    thumbCache.set(cacheKey, { data: buf, mime: 'image/jpeg', at: Date.now() });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Thumbnail failed: ' + err.message });
  }
});

// DELETE em lote: fecha todas as sessoes de uma key (ou todas, sem tenantId).
// O painel precisa disso para limpar o servidor sem abrir sessao por sessao.
app.delete('/api/admin/sessions', adminAuth, (req, res) => {
  try {
    const tenantId = req.query.tenantId ? String(req.query.tenantId) : null;
    const all = sessionManager.getAllSessions();
    const targets = tenantId ? all.filter((s) => s.tenantId === tenantId) : all;
    const closed = [];
    const failed = [];
    for (const s of targets) {
      try {
        if (stopSessionFully(s.sessionId)) closed.push(s.sessionId);
        else failed.push(s.sessionId);
      } catch (e) {
        failed.push(s.sessionId);
      }
    }
    res.json({
      message: `${closed.length} session(s) closed`,
      closed: closed.length,
      failed: failed.length,
      sessionIds: closed,
    });
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

// --- Blindagem contra o guardião de memória do sandbox ---
//
// O guardião de memória (memguard) do sandbox mata o process group com maior
// RSS via `process.kill(-pgid, 'SIGTERM')` seguido de SIGKILL 2s depois.
// ANTES da correção, o Chrome herdava o PGID do backend: uma sessão de
// browser (2709MB medidos) ultrapassava o limite de 2048MB e o guardião
// derrubava o backend INTEIRO -> o proxy do Vite devolvia HTTP 500 e o
// frontend mostrava "Erro do servidor (HTTP 500)".
//
// CORREÇÃO: o Chrome nasce com `detached: true` (session-manager.js) => PGID
// novo, o guardião não alcança o backend.
//
// A segunda camada é o watchdog (scripts/watchdog.js): reexecuta o backend
// se ele morrer por QUALQUER motivo (SIGTERM, SIGKILL, OOM, crash).
// SIGKILL não é capturável por handler — só um supervisor externo resolve.
console.error('[Serende] Boot: camada 1 = Chrome detached (protege o PGID), camada 2 = watchdog externo');

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException — NÃO reiniciando:', err.message, err.stack);
  // Não matar o processo — PM2 não precisa reiniciar por erro de sessão
});

process.on('unhandledRejection', (reason) => {
  console.error('[WARN] unhandledRejection:', reason instanceof Error ? reason.message : reason);
  // Não matar o processo
});
