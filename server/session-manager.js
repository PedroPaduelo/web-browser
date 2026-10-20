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
// Use the actual chrome binary directly instead of the wrapper script to avoid SIGTRAP issues
const CHROME_BIN = path.join(PROJECT_ROOT, 'chrome-install', 'opt', 'google', 'chrome', 'chrome');
const CHROME_LIB = path.join(PROJECT_ROOT, 'chrome-install', 'opt', 'google', 'chrome');
const EXTRA_LIB = path.join(PROJECT_ROOT, 'chrome-install', 'usr', 'lib', 'x86_64-linux-gnu');

const sessions = new Map();
const usedDisplays = new Set();
const releasingDisplays = new Set();
let onSessionDiedCallback = null;
let onCaptureDiedCallback = null;

function onSessionDied(callback) {
  onSessionDiedCallback = callback;
}

// Queda do produtor de vídeo (ffmpeg): o index.js usa isso para cair no
// CDP screencast sem derrubar a sessão.
function onCaptureDied(callback) {
  onCaptureDiedCallback = callback;
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

const XVFB_BIN = process.env.XVFB_BIN || 'Xvfb';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

// Path absoluto do ffmpeg (cacheado): 'ffmpeg' puro no PATH resolve via shell,
// mas o spawn precisa de um executável real. Sem isso, o produtor de vídeo
// simplesmente não sobe e caímos no CDP screencast.
let ffmpegPathCache; // undefined = ainda não checado, null = ausente
function resolveFfmpegPath() {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;
  try {
    const out = execSync(`command -v ${FFMPEG_BIN}`, { encoding: 'utf8' }).trim();
    ffmpegPathCache = out || null;
  } catch {
    ffmpegPathCache = null;
  }
  if (!ffmpegPathCache) {
    console.warn(`[Session] ffmpeg não encontrado no PATH — vídeo usará o fallback CDP screencast`);
  }
  return ffmpegPathCache;
}

function stageError(stage, code, message, status) {
  const err = new Error(message);
  err.stage = stage;
  err.code = code;
  if (status) err.status = status;
  return err;
}

// Pré-voo (cacheado): binário ausente vira erro acionável ANTES de consumir display/porta,
// em vez de spawn opaco + 7s de CDP falhando.
let binaryCheckCache = null;
function checkBinaries() {
  if (binaryCheckCache) return binaryCheckCache;
  const problems = [];
  try {
    execSync(`command -v ${XVFB_BIN}`, { stdio: 'ignore' });
  } catch {
    problems.push(`Xvfb não encontrado no PATH (instale com: apt-get install -y xvfb)`);
  }
  if (!fs.existsSync(CHROME_BIN)) {
    problems.push(`Chrome ausente em ${CHROME_BIN} (rode o script de instalação do chrome-install)`);
  } else {
    try { fs.accessSync(CHROME_BIN, fs.constants.X_OK); }
    catch { problems.push(`Chrome sem permissão de execução (chmod +x ${CHROME_BIN})`); }
  }
  binaryCheckCache = problems;
  return problems;
}

// Espera ativa pelo Xvfb (lock/socket) em vez de sleep fixo — start mais rápido no caso comum.
async function waitForXvfb(xvfb, displayNum, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!xvfb.pid || xvfb.exitCode !== null || xvfb.killed) return false;
    if (fs.existsSync(`/tmp/.X${displayNum}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${displayNum}`)) return true;
    await sleep(100);
  }
  return xvfb.exitCode === null && !xvfb.killed;
}

// CDP com backoff exponencial + timeout por tentativa (sem sleep fixo antes da 1ª).
async function waitForCdp(cdpPort, { attempts = 10, baseDelayMs = 200, maxDelayMs = 800, timeoutMs = 2000 } = {}) {
  let lastError = new Error('CDP sem tentativa');
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
      const data = await res.json();
      if (data.webSocketDebuggerUrl) return { url: data.webSocketDebuggerUrl, attempts: i + 1 };
      lastError = new Error('CDP respondeu sem webSocketDebuggerUrl');
    } catch (e) {
      lastError = e.name === 'AbortError' ? new Error(`CDP timeout após ${timeoutMs}ms`) : e;
      if (i === 0 || i === attempts - 1) console.log(`[CDP:${cdpPort}] tentativa ${i + 1}/${attempts} falhou: ${lastError.message}`);
    } finally {
      clearTimeout(timer);
    }
    await sleep(Math.min(baseDelayMs * 2 ** i, maxDelayMs));
  }
  throw lastError;
}

function cleanupDisplayArtifacts(displayNum, sessionId = '?') {
  for (const p of [`/tmp/.X${displayNum}-lock`, `/tmp/.X11-unix/X${displayNum}`]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[Session:${sessionId}] Limpou artefato ${p}`);
      }
    } catch (e) {
      console.warn(`[Session:${sessionId}] Falha ao limpar ${p}:`, e.message);
    }
  }
}

// --- Produtor de VÍDEO: ffmpeg x11grab (30fps) ---
//
// O CDP screencast só emite frame quando a página REPINTA (0.33fps em página
// estática). O x11grab captura o display X continuamente (30fps medidos).
//
// Wrapper anti-órfão: o ffmpeg roda dentro de um `sh` que vigia dois sinais —
//   (1) EOF no stdin  => o Node pai morreu (exit/SIGTERM) => mata o ffmpeg;
//   (2) PPID mudou     => o pai morreu por SIGKILL e fomos reparentados => mata.
// MEDIDO: ffmpeg puro NÃO morre com EOF no stdin — o wrapper é obrigatório.
// O `exec 3<&0` duplica o stdin real ANTES do fork: em shell não-interativo o
// stdin de um job em background vira /dev/null e a detecção de EOF nunca
// dispara (foi exatamente o que quebrou na primeira versão).
const FFMPEG_WRAPPER_SCRIPT = `
FFBIN="$1"
shift
PARENT_PID="$PPID"
"$FFBIN" "$@" &
FF_PID=$!
cleanup() { kill -TERM "$FF_PID" 2>/dev/null || true; }
trap cleanup TERM INT EXIT
exec 3<&0
( cat <&3 > /dev/null; kill -TERM "$FF_PID" 2>/dev/null || true ) &
READER_PID=$!
while kill -0 "$FF_PID" 2>/dev/null; do
  if [ "$PPID" != "$PARENT_PID" ]; then
    cleanup
    break
  fi
  sleep 1
done
wait "$FF_PID"
STATUS=$?
kill "$READER_PID" 2>/dev/null || true
wait "$READER_PID" 2>/dev/null || true
exit "$STATUS"
`;

const FFMPEG_FRAMERATE = Math.max(1, Math.min(60, parseInt(process.env.FFMPEG_FRAMERATE || '30') || 30));
const FFMPEG_QUALITY = Math.max(1, Math.min(31, parseInt(process.env.FFMPEG_QSCALE || '5') || 5));

// Sobe o produtor de vídeo. Retorna { proc, stdout, stdin, stopping } ou null.
function startFfmpegCapture(sessionId, display, width, height) {
  const ffmpegBin = resolveFfmpegPath();
  if (!ffmpegBin) return null;

  const args = [
    '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', String(FFMPEG_FRAMERATE),
    '-video_size', `${width}x${height}`,
    '-i', display,
    '-q:v', String(FFMPEG_QUALITY),
    '-f', 'mjpeg',
    '-',
  ];

  let proc;
  try {
    proc = spawn('/bin/sh', ['-c', FFMPEG_WRAPPER_SCRIPT, 'serende-ffmpeg', ffmpegBin, ...args], {
      env: { ...process.env, DISPLAY: display },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`[Session:${sessionId}] ffmpeg spawn falhou:`, err.message);
    return null;
  }

  const capture = { proc, stdout: proc.stdout, stdin: proc.stdin, stopping: false };

  // Não deixa o pipe encher antes do StreamManager assinar o stdout.
  proc.stdout.pause();

  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-500);
  });

  proc.on('error', (err) => {
    console.error(`[Session:${sessionId}] ffmpeg erro de processo:`, err.message);
  });

  proc.on('exit', (code, signal) => {
    const s = sessions.get(sessionId);
    // 'stopping' = morte intencional (stopSession) — não é queda.
    if (capture.stopping) return;
    const reason = `code=${code} signal=${signal || '-'}${stderrTail.trim() ? ` stderr=${stderrTail.trim().slice(-200)}` : ''}`;
    console.error(`[Session:${sessionId}] ffmpeg de captura MORREU (${reason})`);
    if (!s) return; // sessão já encerrada
    // Sinaliza a queda para o index.js trocar para o fallback CDP screencast.
    if (onCaptureDiedCallback) {
      try { onCaptureDiedCallback(sessionId, reason); } catch {}
    }
  });

  console.log(`[Session:${sessionId}] ffmpeg x11grab iniciado: ${display} ${width}x${height} @${FFMPEG_FRAMERATE}fps q=${FFMPEG_QUALITY}`);
  return capture;
}

// Encerra o produtor de vídeo: fecha o stdin (o wrapper anti-órfão interpreta
// o EOF e mata o ffmpeg) e depois mata o wrapper por.signal.
function stopCapture(capture) {
  if (!capture || capture.stopping) return;
  capture.stopping = true;
  try { capture.stdin?.end(); } catch {}
  try { capture.stdin?.destroy(); } catch {}
  killProcess(capture.proc);
}

// Saúde síncrona de uma sessão (processos vivos?) — base da detecção/recuperação de mortas.
function getSessionHealth(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { alive: false, reason: 'not_found' };
  if (s.xvfb && (s.xvfb.exitCode !== null || s.xvfb.killed)) return { alive: false, reason: 'xvfb_died' };
  if (s.chrome && (s.chrome.exitCode !== null || s.chrome.killed)) return { alive: false, reason: 'chrome_died' };
  return { alive: true };
}

function getDeadSessions() {
  const dead = [];
  for (const id of sessions.keys()) {
    const h = getSessionHealth(id);
    if (!h.alive && h.reason !== 'not_found') dead.push({ sessionId: id, reason: h.reason });
  }
  return dead;
}

// Recuperação: para e limpa sessões com processo morto, devolvendo display/porta ao pool.
async function sweepDeadSessions() {
  const reclaimed = [];
  for (const { sessionId, reason } of getDeadSessions()) {
    try {
      await stopSession(sessionId, reason);
      reclaimed.push({ sessionId, reason });
    } catch (e) {
      console.warn(`[Sweep] falha ao limpar ${sessionId}:`, e.message);
    }
  }
  if (reclaimed.length) console.log(`[Sweep] ${reclaimed.length} sessão(ões) morta(s) recuperada(s)`);
  return reclaimed;
}

async function startSession(sessionId, tenantId, options = {}) {
  // Pré-voo: binário ausente gera erro acionável ANTES de consumir display/porta.
  const missing = checkBinaries();
  if (missing.length) {
    throw stageError('preflight', 'missing_binary', `Dependências ausentes: ${missing.join(' | ')}`, 503);
  }

  if (sessions.size >= MAX_SESSIONS) {
    throw stageError('limits', 'limit_reached', `Global session limit reached (${MAX_SESSIONS})`, 429);
  }

  const tenantMaxSessions = options.maxSessions || MAX_SESSIONS;
  const effectiveMax = Math.min(tenantMaxSessions, MAX_SESSIONS);
  const tenantCount = getTenantSessionCount(tenantId);
  if (tenantCount >= effectiveMax) {
    throw stageError('limits', 'limit_reached', `Tenant session limit reached (${effectiveMax})`, 429);
  }

  const {
    resolution = '1280x720',
    startUrl = 'https://www.google.com',
    extensionPath = null,
  } = options;

  const [width, height] = String(resolution).split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 200) {
    throw stageError('validate', 'bad_resolution', `Resolução inválida "${resolution}" — use LARGURAxALTURA, ex.: 1280x720`, 400);
  }

  const displayNum = allocateDisplay();
  if (displayNum === null) {
    throw stageError('limits', 'no_display', 'No display available (:100-199 todos em uso ou em quarentena)', 429);
  }

  const display = `:${displayNum}`;
  const cdpPort = CDP_BASE_PORT + (displayNum - DISPLAY_MIN);

  // Daqui em diante toda falha passa por fail(): mata processos, limpa locks/sockets,
  // apaga o profile parcial e devolve o display ao pool (sem vazar :100-199).
  let xvfb = null;
  let chrome = null;
  let capture = null;
  let displayReleased = false;
  const releaseOnce = () => { if (!displayReleased) { displayReleased = true; releaseDisplay(displayNum); } };
  const fail = async (stage, code, message, status) => {
    stopCapture(capture);
    if (chrome) killChromeGroup(chrome);
    if (xvfb) killProcess(xvfb);
    cleanupDisplayArtifacts(displayNum, sessionId);
    releaseOnce();
    try { tenantManager.cleanupSessionDir(tenantId, sessionId); } catch {}
    throw stageError(stage, code, message, status);
  };

  let userDataDir;
  try {
    // Independentes entre si → rodam juntos: setup do profile (disco) + extermínio de
    // restos do display (pkill de Xvfb e de Chrome órfão preso à porta CDP).
    const [profileDir] = await Promise.all([
      (async () => {
        tenantManager.ensureTenantDir(tenantId);
        return tenantManager.copyProfileToSession(tenantId, sessionId);
      })(),
      (async () => {
        try { execSync(`pkill -f "Xvfb ${display}"`, { stdio: 'ignore' }); } catch {}
        try { execSync(`pkill -f "remote-debugging-port=${cdpPort}"`, { stdio: 'ignore' }); } catch {}
        cleanupDisplayArtifacts(displayNum, sessionId);
        await sleep(200); // dar tempo ao processo antigo de soltar o socket
      })(),
    ]);
    userDataDir = profileDir;
  } catch (err) {
    if (err.stage) throw err;
    await fail('profile', 'profile_setup_failed', `Falha ao preparar profile da sessão: ${err.message}`);
  }

  console.log(`[Session:${sessionId}] Starting Xvfb on ${display} at ${resolution}`);
  let xvfbSpawnError = null;
  try {
    xvfb = spawn(XVFB_BIN, [
      display,
      '-screen', '0', `${width}x${height}x24`,
      '-ac',
      '+extension', 'GLX',
      '+render',
      '-noreset',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    await fail('xvfb', 'xvfb_spawn_failed', `Xvfb não iniciou no display ${display}: ${err.message}`, 502);
  }

  xvfb.stdout.on('data', (d) => console.log(`[Xvfb:${sessionId}:stdout]`, d.toString().trim()));
  xvfb.stderr.on('data', (d) => console.error(`[Xvfb:${sessionId}:stderr]`, d.toString().trim()));
  xvfb.on('error', (err) => {
    xvfbSpawnError = err;
    console.error(`[Session:${sessionId}] Xvfb spawn error:`, err.message);
  });

  // Patch de Preferences (disco) roda ENQUANTO o Xvfb sobe — independentes entre si.
  const prefsReady = (async () => {
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
  })();

  const xvfbReady = await waitForXvfb(xvfb, displayNum, 3000);
  await prefsReady;

  if (!xvfbReady) {
    const detail = xvfbSpawnError ? ` (${xvfbSpawnError.message})` : ` (exit=${xvfb.exitCode})`;
    await fail('xvfb', 'xvfb_failed', `Xvfb não subiu no display ${display} em 3s${detail} — veja o log [Xvfb:${sessionId}]`, 502);
  }
  console.log(`[Session:${sessionId}] Xvfb pronto: pid=${xvfb.pid}`);

  const chromeArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-in-process-stack-traces',
    '--disable-oopr-debug-crash-dump',
    '--no-crash-upload',
    '--disable-gpu-sandbox',
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
    '--metrics-recording-only',
    '--no-pings',
    // --- Redução de RSS (memória do sandbox = 2048MB) ---
    // MEDIDO: uma sessão consumia 2709MB no process group (Chrome 2027MB em
    // 8 processos + ffmpeg 342MB + Xvfb 158MB). O guardião de memória do
    // sandbox mata o processo com maior RSS e, como tudo herdava o PGID do
    // backend, derrubava o backend junto (SIGTERM) => HTTP 500 no frontend.
    // O Chrome abre 1 browser + 2 zygotes + 1 gpu + 1 network + 1 storage +
    // 2 renderers. Limitar renderers e o heap do V8 corta ~1GB.
    '--renderer-process-limit=1',
    '--process-per-site',
    '--js-flags=--max-old-space-size=192',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,TranslateUI',
    '--disable-sync',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--no-zygote',
    '--disable-partial-raster',
    '--disable-skia-runtime-opts',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    // Kiosk = fullscreen SEM barra de título. Medido: com --kiosk a janela fica
    // 1279x719 em (0,0) e o viewport tem EXATAMENTE o mesmo tamanho => o crop do
    // x11grab casa 1:1 com as coordenadas do input CDP (offset zero).
    // Sem --kiosk o viewport é 1279x576 (143px de barra) e a mira quebra.
    '--kiosk',
    '--autoplay-policy=no-user-gesture-required',
    '--no-session-id',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--restore-last-session=false',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--app=${startUrl}`, // App mode: sem barra de endereço/abas, viewport == screen
  ];

  if (extensionPath) {
    chromeArgs.push(`--load-extension=${extensionPath}`);
  }

  console.log(`[Session:${sessionId}] Starting Chrome on ${display} cdpPort=${cdpPort}`);
  const chromeEnv = {
    ...process.env,
    DISPLAY: display,
    LD_LIBRARY_PATH: [CHROME_LIB, EXTRA_LIB, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':'),
    CHROME_DEVEL_SANDBOX: '/dev/null',
    HOME: '/tmp',
    XDG_RUNTIME_DIR: '/tmp',
    TMPDIR: '/tmp',
  };
  let chromeSpawnError = null;
  try {
    chrome = spawn(CHROME_BIN, chromeArgs, {
      env: chromeEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      // detached: o Chrome entra em um NOVO process group (setsid).
      // SEM isso o Chrome herda o PGID do backend, e o guardião de memória do
      // sandbox (que mata por process group: process.kill(-pgid, 'SIGKILL'))
      // derruba o backend junto quando a sessão passa de ~1.6GB.
      // MEDIDO 2026-10-20: PGID 29657 (backend) = 2709MB com 1 sessão.
      detached: true,
    });
    // O grupo é novo: o Chrome não recebe o Ctrl-C/SIGINT do shell do backend.
    // Nós o gerenciamos por PID (stopSession), então isso é seguro.
    chrome.unref();
  } catch (err) {
    await fail('chrome', 'chrome_spawn_failed', `Chrome não iniciou (display ${display}): ${err.message}`, 502);
  }

  chrome.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line.includes('DevTools listening')) console.log(`[Chrome:${sessionId}] ${line}`);
    else if (line && (line.includes('ERROR:') || line.includes('WARN:'))) console.error(`[Chrome:${sessionId}]`, line.slice(0, 200));
  });
  chrome.on('error', (err) => {
    chromeSpawnError = err;
    console.error(`[Session:${sessionId}] Chrome spawn error:`, err.message);
  });

  // Sem sleep fixo: 1ª tentativa de CDP imediata, backoff exponencial em seguida.
  let cdpUrl = null;
  let cdpAttempts = 0;
  try {
    const found = await waitForCdp(cdpPort, { attempts: 10, baseDelayMs: 200, maxDelayMs: 800, timeoutMs: 2000 });
    cdpUrl = found.url;
    cdpAttempts = found.attempts;
  } catch (err) {
    const chromeDead = !chrome.pid || chrome.exitCode !== null || chrome.killed;
    const detail = chromeSpawnError ? ` (spawn: ${chromeSpawnError.message})` : '';
    console.error(`[Session:${sessionId}] CDP FAILED - Chrome pid=${chrome.pid} killed=${chrome.killed} exit=${chrome.exitCode}${detail} causa: ${err.message}`);
    if (chromeDead) {
      await fail('chrome', 'chrome_died_early', `Chrome morreu antes do CDP (exit=${chrome.exitCode})${detail} — última causa: ${err.message}`, 502);
    }
    await fail('cdp', 'cdp_unavailable', `Chrome CDP indisponível na porta ${cdpPort} após 10 tentativas: ${err.message}`, 502);
  }

  console.log(`[Session:${sessionId}] CDP pronto em ${cdpAttempts} tentativa(s): ${cdpUrl}`);

  // --- Produtor de VÍDEO ---
  // ffmpeg x11grab (30fps) é o produtor primário; o CDP screencast é o fallback.
  // Captura o DISPLAY INTEIRO: com --kiosk o Chrome ocupa 0,0 e o conteúdo do
  // vídeo casa 1:1 com as coordenadas do viewport (input via CDP).
  capture = startFfmpegCapture(sessionId, display, width, height);
  if (capture) {
    console.log(`[Session:${sessionId}] Produtor de vídeo: ffmpeg x11grab (${width}x${height} @${FFMPEG_FRAMERATE}fps)`);
  } else {
    console.log(`[Session:${sessionId}] Produtor de vídeo: fallback CDP screencast (ffmpeg indisponível)`);
  }

  // Monitor de saúde — verifica se Xvfb e Chrome estão vivos a cada 30s
  const healthCheckInterval = setInterval(() => {
    const currentSession = sessions.get(sessionId);
    if (!currentSession) {
      clearInterval(healthCheckInterval);
      return;
    }

    // exitCode !== null = processo já saiu
    const xvfbDead = xvfb.exitCode !== null || xvfb.killed;
    const chromeDead = chrome.exitCode !== null || chrome.killed;

    if (xvfbDead) {
      console.error(`[Session:${sessionId}] Health check FAILED: Xvfb dead`);
      clearInterval(healthCheckInterval);
      if (sessions.has(sessionId)) {
        killChromeGroup(chrome);
        stopSession(sessionId, 'xvfb_died').catch(() => {});
        if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
      }
      return;
    }

    if (chromeDead) {
      console.error(`[Session:${sessionId}] Health check FAILED: Chrome dead`);
      clearInterval(healthCheckInterval);
      if (sessions.has(sessionId)) {
        stopSession(sessionId, 'chrome_died').catch(() => {});
        if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
      }
      return;
    }
  }, 30000);

  chrome.on('exit', (code, signal) => {
    clearInterval(healthCheckInterval);
    if (!sessions.has(sessionId)) return; // já foi parado via stopSession
    console.log(`[Session:${sessionId}] Chrome CRASHED (code=${code}, signal=${signal})`);
    stopSession(sessionId, 'chrome_crash').catch(() => {});
    if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
  });

  // Xvfb exit handler — se Xvfb morrer, matar Chrome também
  xvfb.on('exit', (code, signal) => {
    clearInterval(healthCheckInterval);
    if (!sessions.has(sessionId)) return;
    console.log(`[Session:${sessionId}] Xvfb CRASHED (code=${code}, signal=${signal})`);
    killChromeGroup(chrome);
    stopSession(sessionId, 'xvfb_died').catch(() => {});
    if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
  });

  const sessionData = {
    sessionId,
    tenantId,
    userId: tenantId,
    xvfb,
    chrome,
    cdpUrl,
    cdpPort,
    capture,
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

  killChromeGroup(session.chrome);

  // Mata o produtor de vídeo ANTES do Xvfb: o ffmpeg captura o display, e
  // deixar ele vivo segura o socket X. O wrapper anti-órfão garante que o
  // ffmpeg neto também morra.
  stopCapture(session.capture);

  setTimeout(() => {
    killProcess(session.xvfb);

    // Limpar lock files do Xvfb para evitar conflitos em restarts futuros
    try {
      if (fs.existsSync(`/tmp/.X${session.displayNum}-lock`)) {
        fs.unlinkSync(`/tmp/.X${session.displayNum}-lock`);
        console.log(`[Session:${sessionId}] Cleaned lock file /tmp/.X${session.displayNum}-lock`);
      }
    } catch (e) {
      console.warn(`[Session:${sessionId}] Failed to clean lock file:`, e.message);
    }

    try {
      if (fs.existsSync(`/tmp/.X11-unix/X${session.displayNum}`)) {
        fs.unlinkSync(`/tmp/.X11-unix/X${session.displayNum}`);
        console.log(`[Session:${sessionId}] Cleaned socket /tmp/.X11-unix/X${session.displayNum}`);
      }
    } catch (e) {
      console.warn(`[Session:${sessionId}] Failed to clean socket:`, e.message);
    }

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

// Mata o Chrome e TODO o seu process group.
//
// NECESSÁRIO porque o Chrome é spawneado com `detached: true` (setsid) para
// sair do PGID do backend — sem isso o guardião de memória do sandbox mata o
// backend junto. Com detached, o `proc.kill()` acima mata só o processo
// browser: os renderers/gpu/zygotes ficariam órfãos segurando memória
// (medido: ~2GB por sessão). Por isso matamos o grupo inteiro (PID = PGID
// do Chrome, pois setsid faz do filho o líder do novo grupo).
function killChromeGroup(proc) {
  if (!proc || !proc.pid) return;
  const pid = proc.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {}
    }
  }, 2000);
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
  getSessionHealth,
  getDeadSessions,
  sweepDeadSessions,
  getTenantSessions,
  getUserSessions,
  getSessionCount,
  getTenantSessionCount,
  getUserSessionCount,
  getAllSessions,
  stopAllSessions,
  onSessionDied,
  onCaptureDied,
  startTimeoutTracker,
  updateActivity,
  getSessionTimeout,
};
