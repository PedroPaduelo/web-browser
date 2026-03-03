const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let currentSession = null;
let starting = false;

const DISPLAY_NUM = 100;
const DISPLAY = `:${DISPLAY_NUM}`;
const USER_DATA_DIR = path.join(os.tmpdir(), 'serende-chrome-profile');

async function startSession(options = {}) {
  if (currentSession || starting) {
    return { error: 'Session already active' };
  }
  starting = true;

  const {
    resolution = '1280x720',
    startUrl = 'https://www.google.com',
    extensionPath = null,
  } = options;

  const [width, height] = resolution.split('x').map(Number);

  try { execSync(`pkill -f "Xvfb ${DISPLAY}"`, { stdio: 'ignore' }); } catch {}
  await sleep(500);

  console.log(`[Session] Starting Xvfb on ${DISPLAY} at ${resolution}`);
  const xvfb = spawn('Xvfb', [
    DISPLAY,
    '-screen', '0', `${resolution}x24`,
    '-ac',
    '+extension', 'GLX',
    '+render',
    '-noreset',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  xvfb.stderr.on('data', (d) => console.error('[Xvfb]', d.toString().trim()));
  xvfb.on('error', (err) => console.error('[Session] Xvfb error:', err.message));

  await sleep(1500);

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const chromeArgs = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    '--disable-background-networking',
    `--user-data-dir=${USER_DATA_DIR}`,
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    '--autoplay-policy=no-user-gesture-required',
    '--start-maximized',
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
  ];

  if (extensionPath) {
    chromeArgs.push(`--load-extension=${extensionPath}`);
  }

  chromeArgs.push(startUrl);

  console.log(`[Session] Starting Chrome on ${DISPLAY} with user-data-dir=${USER_DATA_DIR}`);
  const chrome = spawn('google-chrome-stable', chromeArgs, {
    env: { ...process.env, DISPLAY },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  chrome.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !line.includes('ERROR:') && !line.includes('WARN:')) return;
    if (line) console.error('[Chrome]', line);
  });
  chrome.on('error', (err) => console.error('[Session] Chrome error:', err.message));

  await sleep(3000);

  let cdpUrl = null;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
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
    starting = false;
    throw new Error('Chrome CDP not available after 7.5s');
  }

  console.log(`[Session] Chrome CDP ready: ${cdpUrl}`);

  const ffmpegArgs = [
    '-f', 'x11grab',
    '-framerate', '30',
    '-video_size', resolution,
    '-draw_mouse', '0',
    '-i', DISPLAY,
    '-f', 'mjpeg',
    '-q:v', '8',
    '-an',
    'pipe:1',
  ];

  console.log(`[Session] Starting ffmpeg capture on ${DISPLAY}`);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    env: { ...process.env, DISPLAY },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  ffmpeg.on('error', (err) => console.error('[Session] ffmpeg error:', err.message));

  currentSession = {
    xvfb,
    chrome,
    ffmpeg,
    cdpUrl,
    resolution: { width, height },
    display: DISPLAY,
    displayNum: DISPLAY_NUM,
    createdAt: new Date(),
    startUrl,
  };

  starting = false;
  console.log('[Session] Session started successfully');
  return {
    cdpUrl,
    resolution: { width, height },
    display: DISPLAY,
  };
}

function stopSession() {
  if (!currentSession) return false;

  console.log('[Session] Stopping session...');

  const session = currentSession;
  currentSession = null;

  killProcess(session.ffmpeg);
  killProcess(session.chrome);

  setTimeout(() => {
    killProcess(session.xvfb);
    console.log('[Session] Session stopped');
  }, 500);

  return true;
}

function getSession() {
  if (!currentSession) return null;
  return {
    status: 'running',
    resolution: currentSession.resolution,
    display: currentSession.display,
    cdpUrl: currentSession.cdpUrl,
    createdAt: currentSession.createdAt.toISOString(),
    uptime: Math.floor((Date.now() - currentSession.createdAt.getTime()) / 1000),
  };
}

function getFfmpegStdout() {
  return currentSession?.ffmpeg?.stdout || null;
}

function getCdpUrl() {
  return currentSession?.cdpUrl || null;
}

function getResolution() {
  return currentSession?.resolution || { width: 1280, height: 720 };
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

function getDisplayNum() {
  return String(DISPLAY_NUM);
}

module.exports = { startSession, stopSession, getSession, getFfmpegStdout, getCdpUrl, getResolution, getDisplayNum };
