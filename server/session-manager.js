const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const profileManager = require('./profile-manager');
const tenantManager = require('./tenant-manager');

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 10;
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30') * 60 * 1000;
const TIMEOUT_WARNING_MS = 2 * 60 * 1000;

const DISPLAY_MIN = 100;
const DISPLAY_MAX = 199;
const CDP_BASE_PORT = 9222;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CHROME_BIN = path.join(PROJECT_ROOT, 'chrome-install', 'opt', 'google', 'chrome', 'google-chrome');
const CHROME_LIB = path.join(PROJECT_ROOT, 'chrome-install', 'opt', 'google', 'chrome');
const EXTRA_LIB = path.join(PROJECT_ROOT, 'chrome-install', 'usr', 'lib', 'x86_64-linux-gnu');

const sessions = new Map();
const usedDisplays = new Set();
const releasingDisplays = new Set();
let onSessionDiedCallback = null;

function onSessionDied(callback) {
  onSessionDiedCallback = callback;
}

function allocateDisplay() {
  for (let d = DISPLAY_MIN; d <= DISPLAY_MAX; d++) {
    if (!usedDisplays.has(d) && !releasingDisplays.has(d)) {
      usedDisplays.add(d);
      return d;
    }
  }
  return null;
}

function releaseDisplay(displayNum) {
  usedDisplays.delete(displayNum);
  releasingDisplays.add(displayNum);
  setTimeout(() => releasingDisplays.delete(displayNum), 2000);
}

async function startSession(sessionId, tenantId, options = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Global session limit reached (${MAX_SESSIONS})`);
  }

  const tenantMaxSessions = options.maxSessions || MAX_SESSIONS;
  const effectiveMax = Math.min(tenantMaxSessions, MAX_SESSIONS);
  const tenantCount = getTenantSessionCount(tenantId);
  if (tenantCount >= effectiveMax) {
    throw new Error(`Tenant session limit reached (${effectiveMax})`);
  }

  const displayNum = allocateDisplay();
  if (displayNum === null) {
    throw new Error('No display available');
  }

  const display = `:${displayNum}`;
  const cdpPort = CDP_BASE_PORT + (displayNum - DISPLAY_MIN);

  tenantManager.ensureTenantDir(tenantId);
  const userDataDir = tenantManager.copyProfileToSession(tenantId, sessionId);

  const {
    resolution = '1280x720',
    startUrl = 'https://www.google.com',
    extensionPath = null,
  } = options;

  const [width, height] = resolution.split('x').map(Number);

  try { execSync(`pkill -f "Xvfb ${display}"`, { stdio: 'ignore' }); } catch {}
  await sleep(300);

  console.log(`[Session:${sessionId}] Starting Xvfb on ${display} at ${resolution}`);
  const xvfb = spawn('Xvfb', [
    display,
    '-screen', '0', `${resolution}x24`,
    '-ac',
    '+extension', 'GLX',
    '+render',
    '-noreset',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  xvfb.stderr.on('data', (d) => console.error(`[Xvfb:${sessionId}]`, d.toString().trim()));
  xvfb.on('error', (err) => console.error(`[Session:${sessionId}] Xvfb error:`, err.message));

  await sleep(800);

  fs.mkdirSync(userDataDir, { recursive: true });

  // Forçar Chrome a NÃO restaurar sessão anterior — abrir startUrl limpo
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  try {
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    }
    prefs.session = prefs.session || {};
    prefs.session.restore_on_startup = 4; // 4 = open specific URLs (not restore)
    prefs.session.startup_urls = [startUrl];
    delete prefs.sessions;
    if (prefs.profile) prefs.profile.exit_type = 'Normal';
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    console.warn(`[Session:${sessionId}] Failed to patch Preferences:`, e.message);
  }

  const chromeArgs = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-hang-monitor',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=TranslateUI',
    '--metrics-recording-only',
    '--no-pings',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    '--autoplay-policy=no-user-gesture-required',
    '--start-maximized',
    '--no-session-id',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--restore-last-session=false',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
  ];

  if (extensionPath) {
    chromeArgs.push(`--load-extension=${extensionPath}`);
  }

  chromeArgs.push(startUrl);

  console.log(`[Session:${sessionId}] Starting Chrome on ${display} cdpPort=${cdpPort}`);
  const chromeEnv = {
    ...process.env,
    DISPLAY: display,
    LD_LIBRARY_PATH: [CHROME_LIB, EXTRA_LIB, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':'),
  };
  const chrome = spawn(CHROME_BIN, chromeArgs, {
    env: chromeEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  chrome.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !line.includes('ERROR:') && !line.includes('WARN:')) return;
    if (line) console.error(`[Chrome:${sessionId}]`, line);
  });
  chrome.on('error', (err) => console.error(`[Session:${sessionId}] Chrome error:`, err.message));

  await sleep(1500);

  let cdpUrl = null;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      const data = await res.json();
      cdpUrl = data.webSocketDebuggerUrl;
      break;
    } catch {
      await sleep(500);
    }
  }

  if (!cdpUrl) {
    killProcess(chrome);
    killProcess(xvfb);
    releaseDisplay(displayNum);
    throw new Error('Chrome CDP not available after 7.5s');
  }

  console.log(`[Session:${sessionId}] Chrome CDP ready: ${cdpUrl}`);

  console.log(`[Session:${sessionId}] CDP screencast ready (no ffmpeg)`);

  chrome.on('exit', (code, signal) => {
    console.log(`[Session:${sessionId}] Chrome exited unexpectedly (code=${code}, signal=${signal})`);
    if (sessions.has(sessionId)) {
      stopSession(sessionId);
      if (onSessionDiedCallback) onSessionDiedCallback(sessionId);
    }
  });

  const sessionData = {
    sessionId,
    tenantId,
    userId: tenantId,
    xvfb,
    chrome,
    cdpUrl,
    cdpPort,
    resolution: { width, height },
    display,
    displayNum,
    userDataDir,
    createdAt: new Date(),
    startUrl,
  };

  sessions.set(sessionId, sessionData);

  console.log(`[Session:${sessionId}] Session started successfully (total: ${sessions.size})`);
  return {
    sessionId,
    cdpUrl,
    cdpPort,
    resolution: { width, height },
    display,
  };
}

async function stopSession(sessionId, reason = 'manual') {
  const session = sessions.get(sessionId);
  if (!session) return false;

  console.log(`[Session:${sessionId}] Stopping session (reason: ${reason})...`);
  sessions.delete(sessionId);

  if (session.tenantId && reason !== 'timeout') {
    try {
      tenantManager.mergeProfileFromSession(session.tenantId, sessionId);
      await profileManager.saveSessionState(session.tenantId, session.displayNum);
    } catch (err) {
      console.error(`[Profile] Failed to save for tenant ${session.tenantId}:`, err.message);
    }
    try {
      tenantManager.cleanupSessionDir(session.tenantId, sessionId);
    } catch {}
  }

  // Parar timeout tracker se existir
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }

  killProcess(session.chrome);

  setTimeout(() => {
    killProcess(session.xvfb);
    releaseDisplay(session.displayNum);
    // NÃO remover userDataDir — é persistente!
    console.log(`[Session:${sessionId}] Session stopped (total: ${sessions.size})`);
  }, 500);

  return true;
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return {
    sessionId: s.sessionId,
    tenantId: s.tenantId,
    userId: s.tenantId,
    status: 'running',
    resolution: s.resolution,
    display: s.display,
    cdpUrl: s.cdpUrl,
    cdpPort: s.cdpPort,
    createdAt: s.createdAt.toISOString(),
    uptime: Math.floor((Date.now() - s.createdAt.getTime()) / 1000),
  };
}

function getSessionRaw(sessionId) {
  return sessions.get(sessionId) || null;
}

function getTenantSessions(tenantId) {
  const result = [];
  for (const s of sessions.values()) {
    if (s.tenantId === tenantId) {
      result.push({
        sessionId: s.sessionId,
        status: 'running',
        resolution: s.resolution,
        display: s.display,
        createdAt: s.createdAt.toISOString(),
        uptime: Math.floor((Date.now() - s.createdAt.getTime()) / 1000),
      });
    }
  }
  return result;
}

const getUserSessions = getTenantSessions;

function getSessionCount() {
  return sessions.size;
}

function getTenantSessionCount(tenantId) {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.tenantId === tenantId) count++;
  }
  return count;
}

const getUserSessionCount = getTenantSessionCount;

function getAllSessions() {
  const result = [];
  for (const s of sessions.values()) {
    result.push({
      sessionId: s.sessionId,
      tenantId: s.tenantId,
      status: 'running',
      resolution: s.resolution,
      display: s.display,
      createdAt: s.createdAt.toISOString(),
      uptime: Math.floor((Date.now() - s.createdAt.getTime()) / 1000),
    });
  }
  return result;
}

function stopAllSessions() {
  for (const sessionId of [...sessions.keys()]) {
    stopSession(sessionId);
  }
}

function killProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
    }, 2000);
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Timeout de Inatividade ---

function startTimeoutTracker(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.lastActivity = Date.now();
  session.timeoutId = null;

  const checkTimeout = () => {
    const s = sessions.get(sessionId);
    if (!s) return;

    const now = Date.now();
    const inactive = now - s.lastActivity;

    if (inactive >= SESSION_TIMEOUT_MS) {
      console.log(`[Session:${sessionId}] Timeout after ${Math.round(inactive / 60000)}min inactivity`);
      if (s.tenantId) {
        try { tenantManager.mergeProfileFromSession(s.tenantId, sessionId); } catch {}
      }
      profileManager.saveSessionState(s.tenantId, s.displayNum).catch(() => {});
      stopSession(sessionId, 'timeout');
      if (onSessionDiedCallback) onSessionDiedCallback(sessionId);
      return;
    }

    if (inactive >= SESSION_TIMEOUT_MS - TIMEOUT_WARNING_MS) {
      // Enviar warning via WebSocket (precisa do callback)
      console.log(`[Session:${sessionId}] Timeout warning: ${Math.round((SESSION_TIMEOUT_MS - inactive) / 1000)}s remaining`);
      if (s.onTimeoutWarning) {
        s.onTimeoutWarning(SESSION_TIMEOUT_MS - inactive);
      }
    }

    s.timeoutId = setTimeout(checkTimeout, 60000); // Check a cada min
  };

  session.timeoutId = setTimeout(checkTimeout, 60000);
}

function updateActivity(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.lastActivity = Date.now();

  // Reiniciar timeout tracker
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  startTimeoutTracker(sessionId);
}

function getSessionTimeout(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const inactive = Date.now() - session.lastActivity;
  const remaining = Math.max(0, SESSION_TIMEOUT_MS - inactive);
  return {
    inactive,
    remaining,
    timeoutMs: SESSION_TIMEOUT_MS,
    warningSoon: remaining < TIMEOUT_WARNING_MS,
  };
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  getSessionRaw,
  getTenantSessions,
  getUserSessions,
  getSessionCount,
  getTenantSessionCount,
  getUserSessionCount,
  getAllSessions,
  stopAllSessions,
  onSessionDied,
  startTimeoutTracker,
  updateActivity,
  getSessionTimeout,
};
