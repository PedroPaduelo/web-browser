const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { WebSocket } = require('./node_modules/ws');
const profileManager = require('./profile-manager');
const tenantManager = require('./tenant-manager');

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 10;
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30') * 60 * 1000;
const TIMEOUT_WARNING_MS = 2 * 60 * 1000;

// Ranges via env (torneio): sharding estático de hosts (host A 100-149 +
// CDP 9222, host B 150-199 + CDP 9272) sem editar código. Defaults preservados.
// ATENÇÃO: cdp-input-handler.js tem seu próprio DISPLAY_MIN=100 fallback —
// ambos precisam mudar juntos (ver comentário lá).
const DISPLAY_MIN = Math.max(1, parseInt(process.env.DISPLAY_MIN || '100') || 100);
const DISPLAY_MAX = Math.max(DISPLAY_MIN, parseInt(process.env.DISPLAY_MAX || '199') || 199);
const CDP_BASE_PORT = Math.max(1024, parseInt(process.env.CDP_BASE_PORT || '9222') || 9222);
const DISPLAY_QUARANTINE_MS = Math.max(0, parseInt(process.env.DISPLAY_QUARANTINE_MS || '2000') || 2000);

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
  if (DISPLAY_QUARANTINE_MS <= 0) return;
  releasingDisplays.add(displayNum);
  setTimeout(() => releasingDisplays.delete(displayNum), DISPLAY_QUARANTINE_MS);
}

const XVFB_BIN = process.env.XVFB_BIN || 'Xvfb';
// resolveFfmpegPath vive em ffmpeg-bin.js (compartilhado com capture-service.js).

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

// --- Produtor de VÍDEO: CaptureService (ffmpeg único, dual-output) ---
//
// Torneio #3 (veredito B): ANTES havia DOIS ffmpeg x11grab por sessão dual-view
// (um MJPEG em startFfmpegCapture + um rawvideo no webrtc-manager), capturando
// o mesmo display 2x. AGORA o CaptureService (server/capture-service.js) é o
// dono único do produtor: uma saída MJPEG → StreamManager, uma rawvideo I420
// (pipe:4) → WebRTCSession. Wrapper anti-órfão, detached pgroup, group-kill e
// fallback CDP preservados byte-idênticos (o texto do wrapper e o resolve do
// binário vivem em ffmpeg-wrapper.js / ffmpeg-bin.js, movidos daqui).
//
// O CDP screencast só emite frame quando a página REPINTA (0.33fps em página
// estática). O x11grab captura o display X continuamente (15fps).
const { CaptureService, unifiedDims } = require('./capture-service');

// Compat: startSession ainda guarda `s.capture` (legado, usado pelo health e
// pelo stopSession abaixo). O objeto agora é { service } — o produtor real
// mora no CaptureService.

// Suspende o produtor de vídeo da sessão (encerra o ffmpeg com limpeza
// completa). Idempotente: sessão sem produtor ativo não faz nada.
// LEGADO (dual-producer): mantido para compat — o index.js agora dirige o
// CaptureService diretamente; estas funções delegam para ele quando há service.
function pauseCapture(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.captureService) {
    s.captureService.removeViewer('legacy');
    s.captureService.removePeer('legacy');
    console.log(`[Session:${sessionId}] Produtor de vídeo SUSPENSO (sem espectadores)`);
    return true;
  }
  return false;
}

// Retoma o produtor de vídeo da sessão.
// LEGADO (dual-producer): mantido para compat — delega ao CaptureService.
async function resumeCapture(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.captureService) return null;
  s.captureService.addViewer('legacy');
  const ok = await s.captureService.ensureRunning();
  if (ok) {
    console.log(`[Session:${sessionId}] Produtor de vídeo RETOMADO (espectador conectou)`);
    return { service: s.captureService };
  }
  return null;
}

// Saúde síncrona de uma sessão (processos vivos?) — base da detecção/recuperação de mortas.
function getSessionHealth(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { alive: false, reason: 'not_found' };
  if (s.xvfb && (s.xvfb.exitCode !== null || s.xvfb.killed)) return { alive: false, reason: 'xvfb_died' };
  if (s.chrome && (s.chrome.exitCode !== null || s.chrome.killed)) return { alive: false, reason: 'chrome_died' };
  const out = { alive: true };
  // Wedged-awareness NÃO-destrutiva (#wedged-aware, núcleo seguro): se o poller
  // de CDP marcou a sessão como travada, o health carrega o sinal — sem reapar
  // (um timeout isolado sob carga legítima não pode matar sessão ocupada).
  if (s.cdpWedged) { out.cdpWedged = true; out.wedgedSince = s.cdpWedgedSince || null; out.consecFails = s.cdpConsecFails || 0; }
  return out;
}

// Poller de CDP-wedge: 1 ping /json/version com timeout curto por ciclo do
// health-check (30s). 3 falhas CONSECUTIVAS marcam cdpWedged (histerese contra
// falso-positivo sob carga); 1 sucesso limpa. Só marca — quem decide o que
// fazer é o operador (ver /api/health e stats da sessão). Sem timer próprio:
// pega carona no intervalo existente (sem dobrar wakeups, sem reap races).
async function pollCdpWedge(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.stopping) return;
  const port = s.cdpPort;
  if (!port) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    await res.json();
    if (s.cdpConsecFails || s.cdpWedged) {
      s.cdpConsecFails = 0;
      if (s.cdpWedged) {
        s.cdpWedged = false; s.cdpWedgedSince = null;
        console.log(`[Session:${sessionId}] CDP recuperado (wedge limpo)`);
      }
    }
  } catch {
    s.cdpConsecFails = (s.cdpConsecFails || 0) + 1;
    if (s.cdpConsecFails >= 3 && !s.cdpWedged) {
      s.cdpWedged = true; s.cdpWedgedSince = new Date().toISOString();
      console.warn(`[Session:${sessionId}] CDP wedged (3 falhas consecutivas de /json/version) — sessão viva, sem reapar automático`);
    }
  } finally {
    clearTimeout(timer);
  }
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
    // 1440x900 (16:10) é o painel de 19" mais comum e barato: cabe inteiro
    // numa tela de 1920x1080 sem rolagem na página e sobra largura útil para
    // o agente ver a página inteira.
    resolution = '1440x900',
    startUrl = 'https://www.google.com',
    extensionPath = null,
  } = options;

  const [width, height] = String(resolution).split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 200) {
    throw stageError('validate', 'bad_resolution', `Resolução inválida "${resolution}" — use LARGURAxALTURA, ex.: 1920x1080`, 400);
  }

  // SSRF guard, defesa em profundidade (torneio): o index.js já valida o
  // startUrl, mas o session-manager é chamado por outros caminhos (testes,
  // scripts) — valida de novo aqui, ANTES de consumir display/porta.
  // extensionPath é confinado ao EXTENSIONS_PATH (allowlist root): fora dele,
  // a extensão é ignorada com warning (não falha a sessão — compat).
  const { validateUrl } = require('./url-guard');
  if (startUrl !== undefined && startUrl !== null && String(startUrl).trim() !== '') {
    const v = await validateUrl(String(startUrl)).catch((e) => ({ ok: false, reason: String(e.message || e) }));
    if (!v.ok) {
      throw stageError('validate', 'url_blocked', `startUrl bloqueado: ${v.reason}`, 403);
    }
  }
  let safeExtensionPath = null;
  if (extensionPath) {
    try {
      const root = path.resolve(process.env.EXTENSIONS_PATH || path.join(PROJECT_ROOT, 'extensions'));
      const resolved = path.resolve(root, String(extensionPath));
      const rel = path.relative(root, resolved);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(resolved)) {
        safeExtensionPath = resolved;
      } else {
        console.warn(`[Session:${sessionId}] extensionPath fora do allowlist (${root}): ignorado`);
      }
    } catch (e) {
      console.warn(`[Session:${sessionId}] extensionPath inválido: ignorado (${e.message})`);
    }
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
  let captureService = null;
  let displayReleased = false;
  const releaseOnce = () => { if (!displayReleased) { displayReleased = true; releaseDisplay(displayNum); } };
  const fail = async (stage, code, message, status) => {
    try { captureService && captureService.stop(); } catch {}
    if (chrome) killChromeGroup(chrome);
    if (xvfb) killProcessGroup(xvfb);
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
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: o Xvfb entra em um NOVO process group (setsid).
      //
      // Sem isso, Xvfb e ffmpeg ficam no MESMO grupo do backend. O memguard da
      // sandbox (que roda dentro do container) mata por GRUPO de processos: ele
      // escolhe o grupo com maior RSS somado e manda SIGTERM no grupo inteiro.
      // Como o grupo do backend acumulava o Xvfb + o ffmpeg de TODAS as
      // sessões, ele virava a vítima e o backend recebia SIGTERM junto —
      // morria com "Shutting down..." (encerramento gracioso, sem stack trace),
      // derrubando as sessões dos outros agentes. Medido: 1 sessão = 723 MB no
      // grupo do backend (backend 168 + Xvfb 162 + ffmpeg 381); 4 sessões
      // passam de 2 GB e o memguard mata o grupo.
      // Isolados, o memguard derruba o produtor pesado (que é o que ele deve
      // derrubar) e o backend fica de pé.
      detached: true,
    });
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

      // --- TEMA DARK POR PADRÃO (injeção no perfil) ---
      // MEDIDO no Chromium 156 deste host (/usr/lib/chromium/chromium):
      //   `browser.theme.color_scheme` = 2  => matchMedia('(prefers-color-scheme:
      //   dark)').matches === true (e 1 => light, 3 => dark).
      //   `webkit.webprefs.dark_mode` NÃO tem efeito aqui (medido: fica false).
      //
      // Por que o perfil e não `--force-dark-mode`: a flag só repinta a UI do
      // Chrome em dark e NÃO muda `prefers-color-scheme` — sites que respeitam
      // a preferência do sistema continuariam claros. O usuário quer o SITE em
      // dark, então o que importa é a media query, e ela sai do perfil.
      // O Chrome promove o valor para `<chave>2` ao gravar; manter as duas
      // casas evita que uma leitura antiga do profile reverta o tema.
      prefs.browser = prefs.browser || {};
      prefs.browser.theme = prefs.browser.theme || {};
      prefs.browser.theme.color_scheme = 2;
      prefs.browser.theme.color_scheme2 = 2;
      // Sem isso, a página nova (NTP) pode pintar em light por cima.
      prefs.ntp = prefs.ntp || {};

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
    // Chrome 157: o auto-detect de plataforma do Ozone fica inconstante e às
    // vezes tenta Wayland (morre com "The platform failed to initialize").
    // Aqui há sempre um Xvfb (DISPLAY real), então X11 é o destino certo.
    '--ozone-platform=x11',
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
    // --remote-debugging-address foi removida no Chrome 157 (escuta sempre
    // 127.0.0.1). Passar a flag destrói o parse do CDP nesse build.
    `--app=${startUrl}`, // App mode: sem barra de endereço/abas, viewport == screen
  ];

  if (safeExtensionPath) {
    chromeArgs.push(`--load-extension=${safeExtensionPath}`);
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

  // --- Produtor de VÍDEO: CaptureService (ffmpeg único, dual-output) ---
  // Um x11grab com DUAS saídas: MJPEG (stdout → StreamManager) + rawvideo I420
  // (pipe:4 → WebRTCSession). Captura o DISPLAY INTEIRO: com --kiosk o Chrome
  // ocupa 0,0 e o conteúdo do vídeo casa 1:1 com as coordenadas do viewport
  // (input via CDP). O serviço nasce PARADO (running=false): a demanda
  // (viewer MJPEG ou peer WebRTC) liga via ensureRunning no index.js.
  // Sem ffmpeg: captureService=null → index.js decide o fallback CDP.
  const { resolveFfmpegPath } = require('./ffmpeg-bin');
  if (resolveFfmpegPath()) {
    captureService = new CaptureService({
      sessionId,
      display,
      width,
      height,
      killProcessGroup,
      onDeath: (reason) => {
        // Morte INESPERADA: sinaliza a queda para o index.js trocar para o
        // fallback CDP screencast (mesmo contrato do onCaptureDied antigo).
        if (onCaptureDiedCallback) {
          try { onCaptureDiedCallback(sessionId, reason); } catch {}
        }
      },
    });
    console.log(`[Session:${sessionId}] Produtor de vídeo: CaptureService dual (ffmpeg único, MJPEG+rawvideo)`);
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

    // Núcleo do #crash-safe: delega o teardown COMPLETO ao onSessionDiedCallback
    // (stopSessionFully no index.js). O padrão antigo (stopSession + callback
    // manual) causava duplo teardown concorrente e vazava sessionResources.
    const die = (reason) => {
      const s = sessions.get(sessionId);
      if (!s || s.stopping) return;
      s.stopping = true;
      console.error(`[Session:${sessionId}] Health check FAILED: ${reason}`);
      clearInterval(healthCheckInterval);
      if (reason === 'xvfb_died') killChromeGroup(chrome);
      if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
    };

    if (xvfbDead) { die('xvfb_died'); return; }
    if (chromeDead) { die('chrome_died'); return; }
    // Wedge poll de carona (sem timer próprio): só marca, nunca reapa.
    pollCdpWedge(sessionId).catch(() => {});
  }, 30000);

  // Núcleo do #crash-safe: crash handlers também delegam ao callback unificado
  // (stopSessionFully). Guarda `stopping` contra health-check/timeout/DELETE
  // concorrentes; `sessions.has` sozinho não bastava (sessão presente mas já
  // em teardown por outro caminho).
  const crashDie = (reason, detail) => {
    clearInterval(healthCheckInterval);
    const s = sessions.get(sessionId);
    if (!s || s.stopping) return; // já parado ou em teardown via stopSession
    s.stopping = true;
    console.log(`[Session:${sessionId}] ${detail}`);
    if (reason === 'xvfb_died') killChromeGroup(chrome);
    if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
  };

  chrome.on('exit', (code, signal) => {
    crashDie('chrome_crash', `Chrome CRASHED (code=${code}, signal=${signal})`);
  });

  // Xvfb exit handler — se Xvfb morrer, matar Chrome também
  xvfb.on('exit', (code, signal) => {
    crashDie('xvfb_died', `Xvfb CRASHED (code=${code}, signal=${signal})`);
  });

  const sessionData = {
    sessionId,
    tenantId,
    userId: tenantId,
    xvfb,
    chrome,
    cdpUrl,
    cdpPort,
    capture: captureService ? { service: captureService } : null,
    captureService: captureService || null,
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

  // Para o timeout tracker se existir
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }

  // FECHA O CHROME ANTES DE MESCLAR O PROFILE.
  //
  // O Chrome segura os cookies em memória e só grava no SQLite do profile
  // (Default/Cookies) de tempos em tempos. Com o Chrome vivo, o merge copia
  // um Cookies VELHO: o cookie setado nos últimos segundos antes do stop
  // sumia na sessão seguinte do mesmo tenant.
  //
  // MEDIDO nesta rodada: o SIGTERM NÃO grava o cookie store. Com SIGTERM,
  // um cookie criado 5s antes do stop não sobrevivia; o MESMO cookie criado
  // 30s antes sobrevivia — o que gravava era o commit PERIÓDICO do cookie
  // store (~30s), não o shutdown. A ordem "esperar o exit" já estava certa;
  // o que faltava era pedir o shutdown pelo caminho oficial.
  //
  // Agora: Browser.close via CDP (o shutdown gracioso do Chrome, que roda o
  // flush do cookie store) → ESPERAR o 'exit' → mesclar o profile.
  await stopChromeAndWait(session.chrome, 8000, session.cdpUrl);

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

  // Mata o produtor de vídeo ANTES do Xvfb: o ffmpeg captura o display, e
  // deixar ele vivo segura o socket X. O wrapper anti-órfão garante que o
  // ffmpeg neto também morra.
  try { session.captureService && session.captureService.stop(); } catch {}

  setTimeout(() => {
    // Mata o grupo do Xvfb: ele foi spawneado com detached, então o sinal
    // precisa alcançar o grupo inteiro (o Xvfb tem filhos que seguram o
    // socket X do display).
    killProcessGroup(session.xvfb);

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
  // O escalonamento para SIGKILL precisa do PID, não de `proc.killed`:
  // o Node marca `killed = true` assim que o sinal é ENTREGUE (não quando o
  // processo morre), então `if (!proc.killed)` depois do SIGTERM nunca era
  // verdadeiro — o SIGKILL ficava sendo código morto. Consequência real: um
  // processo que ignora o SIGTERM (o wrapper do ffmpeg roda o cleanup mas não
  // sai) sobrevivia para sempre segurando o display X.
  const pid = proc.pid;
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }, 2000);
}

// Mata um processo spawneado com `detached: true` E todo o seu grupo.
//
// Com setsid, o filho vira líder do novo grupo, então PID = PGID e
// `process.kill(-pid, sinal)` acerta o grupo inteiro. Precisa ser o grupo: o
// Xvfb tem filhos e o wrapper do ffmpeg tem o ffmpeg como neto — sinalizar
// só o líder deixaria os netos vivos segurando memória e o socket X.
//
// Fallback para o sinal no PID se o grupo não existir (o processo já morreu).
function killProcessGroup(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 2000);
}

// Mata o Chrome e TODO o seu process group.
//
// NECESSÁRIO porque o Chrome é spawneado com `detached: true` (setsid) para
// sair do PGID do backend — sem isso o guardião de memória do sandbox mata o
// backend junto. Com detached, o `proc.kill()` acima mata só o processo
// browser: os renderers/gpu/zygotes ficariam órfãos segurando memória
// (medido: ~2GB por sessão). Por isso matamos o grupo inteiro (PID = PGID
// do Chrome, pois setsid faz do filho o líder do novo grupo).

// SIGTERM gracioso no Chrome + espera pelo 'exit', com teto de tempo.
//
// Sem isso o merge do profile (mergeProfileFromSession) copiava o
// Default/Cookies ANTES de o Chrome gravá-lo: quem setava cookie pouco antes
// do session_stop o perdia na sessão seguinte. O SIGTERM sozinho não basta —
// killChromeGroup delega o SIGKILL a um setTimeout de 2s, então é preciso
// AWAIT a morte de fato.
//
// Requisito do caso: o Chrome grava o profile durante o shutdown (a
// 'exit' só vem depois disso), e o SIGKILL seria imediato e sem flush —
// daí o teto generoso (8s) antes do kill definitivo.
// Pede ao Chrome um fechamento GRACIOSO via CDP (`Browser.close`).
//
// POR QUE: o SIGTERM não faz o Chrome gravar o store de cookies. Medido:
// um cookie criado e guardado 5s antes do stop não sobrevivia à sessão
// seguinte; o mesmo cookie, guardado 30s antes, sobrevivia — o signal
// mostra que o que gravava era o commit PERIÓDICO do cookie store (~30s),
// não o shutdown. `Browser.close` é o caminho oficial de shutdown do Chrome
// e roda o flush do cookie store.
//
// Devolve true se o pedido foi enviado (não garante que o Chrome morreu).
function requestBrowserClose(cdpUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!cdpUrl) { resolve(false); return; }
    let ws;
    try {
      ws = new WebSocket(cdpUrl, { handshakeTimeout: timeoutMs });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on('open', () => {
      try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch { finish(false); }
    });
    // O browser pode fechar a conexão antes de responder: isso também é sucesso.
    ws.on('message', () => { clearTimeout(timer); finish(true); });
    ws.on('close', () => { clearTimeout(timer); finish(true); });
    ws.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

async function stopChromeAndWait(proc, timeoutMs = 8000, cdpUrl = null) {
  if (!proc || !proc.pid) return;
  if (proc.exitCode !== null || proc.killed) return; // já morto
  const pid = proc.pid;

  const exited = new Promise((resolve) => {
    let done = false;
    // 'exit' é o sinal de que o processo morreu (e portanto já fez flush);
    // 'close' também resolve, para o caso de streams abertos.
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('exit', finish);
    proc.once('close', finish);
    setTimeout(finish, timeoutMs);
  });

  // Primeiro o shutdown gracioso via CDP (é o que grava os cookies). O SIGTERM
  // fica como plano B, para o caso de o CDP já estar fora do ar.
  const pediuCdp = await requestBrowserClose(cdpUrl, 3000);
  if (!pediuCdp) {
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { proc.kill('SIGTERM'); } catch {}
    }
  }
  await exited;

  // Ainda vivo após o teto → quem decide é o kill definitivo (o grupo primeiro,
  // para renderers/GPU/zygotes não ficarem órfãos).
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function killChromeGroup(proc) {
  if (!proc || !proc.pid) return;
  const pid = proc.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    // Mesmo cuidado do killProcess: `proc.killed` já é true após o SIGTERM,
    // então o fallback testá-lo tornava o SIGKILL inatingível. Usa o PID.
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
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
      // Núcleo seguro do #crash-safe (torneio): o caminho antigo chamava
      // stopSession + onSessionDiedCallback manual — stopSession NÃO limpa
      // sessionResources (stream/screencast/input vazavam) e o callback SEMPRE
      // disparava mesmo com sessão já morta (dupla-morte com DELETE
      // concorrente). Agora: marca `stopping` (guarda contra DELETE/timeout
      // concorrentes) e delega o teardown COMPLETO ao onSessionDiedCallback —
      // o index.js roteia para stopSessionFully (resources + manager + CDP).
      // O merge do profile acontece dentro do stopSession (Chrome fechado
      // antes — cookie store com flush correto).
      if (s.stopping) return;
      s.stopping = true;
      try { if (s.timeoutId) { clearTimeout(s.timeoutId); s.timeoutId = null; } } catch {}
      if (onSessionDiedCallback) { try { onSessionDiedCallback(sessionId); } catch {} }
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
  pauseCapture,
  resumeCapture,
  startTimeoutTracker,
  updateActivity,
  getSessionTimeout,
};
