const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { WebSocket } = require('./node_modules/ws');
const profileManager = require('./profile-manager');
const tenantManager = require('./tenant-manager');

// Sem TETO GLOBAL de sessões (decisão do dono, 2026-10-29): só vale o limite
// da chave (options.maxSessions, que vem do max_sessions da tabela api_keys).
// KEY_SESSION_LIMIT_DEFAULT cobre tokens antigos sem limite no payload
// (ex.: chave legada migrada, cujo max_sessions é NULL) — mesmo default do
// createKey em key-store.js, para não virar "ilimitado" por acidente.
const KEY_SESSION_LIMIT_DEFAULT = 100;
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
cleanup() {
  kill -TERM "$FF_PID" 2>/dev/null || true
  # O ffmpeg trata SIGTERM como shutdown gracioso e pode ficar preso na leitura
  # do display X: por isso o cleanup escala para SIGKILL depois de 2s. Sem isso
  # o produtor sobrevive à sessão encerrada segurando o socket X do display.
  ( sleep 2; kill -KILL "$FF_PID" 2>/dev/null || true ) &
}
# No TERM/INT o shell precisa SAIR, não só rodar o cleanup: com o trap simples
# o script continuava no loop, o ffmpeg só recebia o SIGTERM e ninguém
# escalonava — o wrapper (e o ffmpeg) viviam depois da sessão encerrada.
trap 'cleanup; exit 0' TERM INT
trap cleanup EXIT
exec 3<&0
( cat <&3 > /dev/null; cleanup ) &
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

  // A janela do Chrome em --kiosk ocupa 1279x719 dentro do display 1280x720:
  // a última linha e a última coluna ficam SEM conteúdo (o último frame do
  // x11grab mostrava 1px preto em y=719 e x=1279). O usuário lia essa borda
  // como "tela cortada". O crop remove a faixa não pintada e o scale de volta
  // para a resolução da sessão entrega o quadro cheio (1280x720) ao usuário.
  const args = [
    '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', String(FFMPEG_FRAMERATE),
    '-video_size', `${width}x${height}`,
    '-i', display,
    '-vf', `crop=${width - 1}:${height - 1}:0:0,scale=${width}:${height}:flags=neighbor`,
    '-q:v', String(FFMPEG_QUALITY),
    '-f', 'mjpeg',
    '-',
  ];

  let proc;
  try {
    proc = spawn('/bin/sh', ['-c', FFMPEG_WRAPPER_SCRIPT, 'serende-ffmpeg', ffmpegBin, ...args], {
      env: { ...process.env, DISPLAY: display },
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached: o produtor de vídeo entra em um NOVO process group.
      //
      // Mesmo motivo do Xvfb: o memguard da sandbox mata por grupo de
      // processos. Com o ffmpeg no grupo do backend, o memguard derrubava o
      // backend junto quando a captura pesava demais (o ffmpeg sozinho passa
      // de 350 MB por sessão). Isolado, ele derruba o produtor — que é o alvo
      // certo — e o backend sobrevive.
      //
      // Consequência: o grupo precisa ser morto inteiro, senão o ffmpeg (neto
      // do wrapper sh) fica órfão segurando o socket X do display.
      // stopCapture() chama killProcessGroup() por causa disso.
      detached: true,
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
  // Mata o GRUPO, não só o wrapper: o ffmpeg roda como neto do sh e, com o
  // spawn detached, sobreviveria ao sinal dado só ao wrapper — segurando o
  // socket X do display e a memória do produtor.
  killProcessGroup(capture.proc);
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

// --- Presets de dispositivo (emulação de hardware) ---
//
// O hCaptcha coleta: plataforma, GPU (WebGL vendor/renderer), cores, memória,
// UA. Sinais REAIS do nosso host (Linux x86_64, 12 cores, 32GB, sem WebGL)
// denunciam servidor. Os presets espelham máquinas típicas; 'win' é o PC de
// escritório BR mais comum (Windows + Intel UHD integrada).
//
// A versão do Chrome no UA é preenchida em resolveDevice a partir da versão
// real instalada (lida uma vez via --version), para nunca mentir a versão.
const DEVICE_PRESETS = {
  win: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{V} Safari/537.36',
    platform: 'Win32',
    gpuVendor: 'Intel Inc.',
    gpuRenderer: 'Intel Iris OpenGL Engine',
    glVendor: 'WebKit',
    glRenderer: 'WebKit WebGL',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
  mac: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{V} Safari/537.36',
    platform: 'MacIntel',
    gpuVendor: 'Apple Inc.',
    gpuRenderer: 'Apple M1',
    glVendor: 'WebKit',
    glRenderer: 'WebKit WebGL',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
  linux: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{V} Safari/537.36',
    platform: 'Linux x86_64',
    gpuVendor: 'Intel Inc.',
    gpuRenderer: 'Mesa Intel(R) UHD Graphics 630',
    glVendor: 'WebKit',
    glRenderer: 'WebKit WebGL',
    hardwareConcurrency: 4,
    deviceMemory: 4,
  },
};

let chromeVersionCache = null;
function chromeVersion() {
  if (chromeVersionCache) return chromeVersionCache;
  try {
    const out = require('child_process').execFileSync(CHROME_BIN, ['--version'], { timeout: 5000 }).toString();
    const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
    chromeVersionCache = m ? m[1] : '120.0.0.0';
  } catch {
    chromeVersionCache = '120.0.0.0';
  }
  return chromeVersionCache;
}

function resolveDevice(presetName, overrides = {}) {
  const preset = DEVICE_PRESETS[presetName] || DEVICE_PRESETS.win;
  const v = chromeVersion();
  const device = {
    preset: DEVICE_PRESETS[presetName] ? presetName : 'win',
    userAgent: (overrides.userAgent || preset.userAgent).replace('{V}', v),
    platform: overrides.platform || preset.platform,
    gpuVendor: overrides.gpuVendor || preset.gpuVendor,
    gpuRenderer: overrides.gpuRenderer || preset.gpuRenderer,
    glVendor: preset.glVendor,
    glRenderer: preset.glRenderer,
    hardwareConcurrency: Number(overrides.hardwareConcurrency || preset.hardwareConcurrency) || 8,
    deviceMemory: Number(overrides.deviceMemory || preset.deviceMemory) || 8,
  };
  return device;
}

async function startSession(sessionId, tenantId, options = {}) {
  // Pré-voo: binário ausente gera erro acionável ANTES de consumir display/porta.
  const missing = checkBinaries();
  if (missing.length) {
    throw stageError('preflight', 'missing_binary', `Dependências ausentes: ${missing.join(' | ')}`, 503);
  }

  // Só o limite DA CHAVE: sem teto global. O effectiveMax vem do max_sessions
  // da api_keys (via JWT); chave sem limite no payload cai no default 100.
  const effectiveMax = Number(options.maxSessions) > 0 ? Number(options.maxSessions) : KEY_SESSION_LIMIT_DEFAULT;
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
    // Coerência ambiental (caso Serpro 429): o Chrome nascia com locale en-US
    // e timezone UTC, incoerente com sites BR. Os defaults abaixo espelham um
    // usuário brasileiro; session_start pode sobrescrever.
    locale = process.env.CHROME_LOCALE || 'pt-BR',
    timezone = process.env.CHROME_TIMEZONE || 'America/Sao_Paulo',
    // Proxy por sessão (caso Serpro 429): sem IP residencial BR na saída, o
    // WAF barra antes de avaliar qualquer captcha. Formato:
    //   http://host:porta  |  socks5://host:porta
    //   http://usuario:senha@host:porta  (auth vai na URL)
    // Quando presente, vira --proxy-server + --proxy-bypass-list=<-loopback>
    // (sem o bypass, o Chrome manda até o CDP 127.0.0.1 pelo proxy e o boot
    // trava). Ausente = saída direta, como antes.
    proxyUrl = process.env.CHROME_PROXY_URL || null,
    // --- Preset de dispositivo (emulação de hardware, caso Serpro/hCaptcha) ---
    // O hCaptcha coleta sinais de hardware: plataforma, GPU (WebGL), cores,
    // memória. O default 'win' espelha o PC de escritório BR mais comum
    // (Windows + Intel integrada); 'mac' e 'linux' disponíveis p/ coerência
    // com outros cenários. session_start pode sobrescrever via devicePreset,
    // ou passar sinais avulsos (userAgent, platform, gpuVendor, gpuRenderer,
    // hardwareConcurrency, deviceMemory).
    devicePreset = process.env.CHROME_DEVICE_PRESET || 'win',
    userAgent = null,
    platform = null,
    gpuVendor = null,
    gpuRenderer = null,
    hardwareConcurrency = null,
    deviceMemory = null,
    // WebGL real (SwiftShader): OPT-IN, default false.
    // REGRESSÃO 2026-10-29 (flagrada em produção): ligar o SwiftShader por
    // padrão fez o Chrome crashar em páginas pesadas com "Aw, Snap! Error
    // code: SIGTRAP" (medido em perplexity.ai, em produção). O SIGTRAP é
    // trap de instrução ilegal no processo GPU/renderer. Estabilidade
    // (browser funcionando) vale mais que ter WebGL, então só liga quem
    // pedir: o preset de GPU continua entregando o spoof de vendor/renderer
    // via script, independentemente de haver contexto real.
    webgl = process.env.CHROME_WEBGL === '1',
  } = options;

  const [width, height] = String(resolution).split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 200) {
    throw stageError('validate', 'bad_resolution', `Resolução inválida "${resolution}" — use LARGURAxALTURA, ex.: 1920x1080`, 400);
  }

  // Resolve o preset de dispositivo em sinais concretos. Sinais avulsos
  // vencem o preset (ex.: devicePreset=win + hardwareConcurrency=4).
  const device = resolveDevice(devicePreset, {
    userAgent, platform, gpuVendor, gpuRenderer, hardwareConcurrency, deviceMemory,
  });

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

      // --- LOCALE NO PERFIL (não só na flag --lang) ---
      // MEDIDO: a flag --lang=pt-BR sozinha NÃO muda navigator.languages — o
      // Preferences do profile copiado (intl.selected_languages="en-US,en")
      // sobrescreve a flag. O Chrome lê o idioma daqui; a flag só vale num
      // profile virgem. Então grava o locale pedido no perfil da sessão.
      prefs.intl = prefs.intl || {};
      prefs.intl.selected_languages = locale;
      prefs.intl.accept_languages = locale;

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
    // GPU: --disable-gpu (default, estável) ou SwiftShader (opt-in WebGL).
    // O --disable-gpu nunca crashou; o SwiftShader deu SIGTRAP em páginas
    // pesadas em produção (2026-10-29). Quem pede webgl=true aceita o risco.
    // Ver a nota do `webgl` nas options acima.
    ...(webgl
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--disable-gpu']),
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
    // Locale/timezone via CLI: aceito pelo Chrome sem depender de CDP.
    // O timezone real da página vem do Emulation.setTimezoneOverride (aplicado
    // no boot via cdpRequest no index.js); a flag --lang cobre navigator.language
    // e o Accept-Language.
    `--lang=${locale}`,
    // UA do preset de dispositivo (default: Windows). O platform e o resto
    // dos sinais vão via Network.setUserAgentOverride + script no boot.
    `--user-agent=${device.userAgent}`,
  ];

  if (extensionPath) {
    chromeArgs.push(`--load-extension=${extensionPath}`);
  }

  // Proxy: valida o formato antes de passar ao Chrome — URL malformada aqui
  // vira Chrome sem rede e sessão que nunca abre página, com erro opaco.
  // Auth vai NA URL (http://user:pass@host:port): o Chrome aceita direto na
  // flag --proxy-server, sem precisar de Fetch.authRequired (que conflitaria
  // com o tracking de rede do pool CDP). A senha nunca é logada.
  let proxyActive = null;
  if (proxyUrl) {
    const m = /^(https?|socks5):\/\/(?:([^:@\/]+)(?::([^@\/]*))?@)?([^:\/]+):(\d+)\/?$/.exec(String(proxyUrl).trim());
    if (!m) {
      await fail('validate', 'bad_proxy', `Proxy inválido "${proxyUrl}" — use http://host:porta, socks5://host:porta ou http://usuario:senha@host:porta`, 400);
    }
    const [, scheme, user, pass, host, port] = m;
    proxyActive = { scheme, user: user || null, hasPass: Boolean(pass), host, port };
    const authPart = user ? `${user}${pass ? `:${pass}` : ''}@` : '';
    chromeArgs.push(`--proxy-server=${scheme}://${authPart}${host}:${port}`);
    chromeArgs.push('--proxy-bypass-list=<-loopback>');
    console.log(`[Session:${sessionId}] Proxy: ${scheme}://${host}:${port}${user ? ` (auth: ${user})` : ''}`);
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
    // Stealth ambiental: o index.js aplica via CDP após o boot
    // (Emulation.setTimezoneOverride + script de webdriver).
    locale,
    timezone,
    proxy: proxyActive,
    device,
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
  stopCapture(session.capture);

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
