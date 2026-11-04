/**
 * CaptureService — UM ffmpeg por sessão, DUAS saídas (MJPEG + rawvideo I420).
 *
 * Arquitetura (veredito do painel de design, abordagem B + grafts do A):
 *   ffmpeg x11grab -+- saída 1 (stdout, pipe:1): MJPEG q/env -> StreamManager
 *                  `- saída 2 (pipe:4):        rawvideo yuv420p -> WebRTCSession
 *
 * Por que pipe:4 e não pipe:3: o wrapper anti-órfão faz `exec 3<&0` (duplica o
 * stdin no fd 3 para detectar EOF quando o Node morre). Qualquer pipe que o
 * Node mapeasse para o fd 3 seria destruído. fds >= 4 atravessam o `sh`
 * intactos até o neto ffmpeg — stdio fica ['pipe','pipe','pipe','ignore','pipe']
 * (índice 3 OBRIGATORIAMENTE 'ignore').
 *
 * INVARIANTE CRÍTICA: todo rawFd vivo precisa de um consumidor de 'data'.
 * Um pipe:4 pausado-sem-leitor enche o buffer de 64KB do kernel em ~2ms
 * (~41MB/s a 15fps/720p) e TRAVA o ffmpeg — congelando AMBAS as saídas.
 * Por isso o spawn já anexa um drain de descarte, e attach/detach trocam o
 * listener sem nunca deixar o fd sem leitor enquanto o produtor vive.
 */

const { spawn } = require('child_process');
const { resolveFfmpegPath } = require('./ffmpeg-bin');
const { script: FFMPEG_WRAPPER_SCRIPT } = require('./ffmpeg-wrapper');

const FFMPEG_FRAMERATE = Math.max(1, Math.min(60, parseInt(process.env.FFMPEG_FRAMERATE || '15') || 15));
const FFMPEG_QUALITY = Math.max(1, Math.min(31, parseInt(process.env.FFMPEG_QSCALE || '7') || 7));

// Grace unificada: UM timer governa o produtor compartilhado (MJPEG viewers +
// RTC peers). Sem demanda total por esse tempo -> produtor cai.
const IDLE_GRACE_MS = Math.max(2000, parseInt(process.env.STREAM_IDLE_GRACE_MS || '15000') || 15000);

// Geometria canônica: as entradas já são validadas (>= 320x200), então o
// clamp nunca degenera. EW/EH pares são exigência do YUV420 (frameSize EXATO,
// sem Math.floor). Ver `unifiedDims`.
function unifiedDims(width, height) {
  const ew = Math.max(2, Number(width) & ~1);
  const eh = Math.max(2, Number(height) & ~1);
  return { ew, eh, frameSize: (ew * eh * 3) / 2 };
}

class CaptureService {
  constructor({ sessionId, display, width, height, killProcessGroup, onDeath }) {
    this.sessionId = sessionId;
    this.display = display;
    this.width = width;
    this.height = height;
    const { ew, eh, frameSize } = unifiedDims(width, height);
    this.ew = ew;
    this.eh = eh;
    this.frameSize = frameSize;
    this._killProcessGroup = killProcessGroup;
    this._onDeath = typeof onDeath === 'function' ? onDeath : null;

    this.proc = null;      // processo do wrapper sh (líder do pgroup)
    this.rawFd = null;     // proc.stdio[4]: rawvideo I420 (pipe:4)
    this.rawAttached = false; // algum WebRTCSession anexado ao rawFd atual?
    this._lastProc = null; // último proc morto (espera do grupo no re-spawn)
    this.running = false;  // produtor deveria estar vivo?
    this.stopping = false; // morte intencional (stop): exit não é queda
    this.generation = 0;   // ignora exits de gerações antigas
    this.spawning = false; // serializa spawn/stop (nunca 2 x11grab no display)
    this.viewers = 0;      // WS MJPEG conectados
    this.peers = 0;        // RTC peers conectados
    this._idleTimer = null;
    this._deaths = 0;      // mortes inesperadas consecutivas (telemetria)
    this._rawDrain = null;
    this.rawBytes = 0;     // telemetria: bytes I420 consumidos/descartados
  }

  // --- argv dual-output ---
  //
  // Seção de entrada COMPARTILHADA (um único x11grab). Cada saída tem seu
  // `-map 0:v` + `-vf` próprio: o MESMO crop+scale nas duas (a borda morta de
  // 1px do kiosk some das duas vistas; o scale devolve o tamanho cheio E cai
  // em dims pares). `-c:v rawvideo` explícito na perna I420 (o painel exigiu:
  // sem ele, o muxer default da perna poderia variar entre builds).
  _buildArgs() {
    const vf = `crop=${this.width - 1}:${this.height - 1}:0:0,scale=${this.ew}:${this.eh}:flags=neighbor`;
    return [
      '-loglevel', 'error',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'x11grab',
      '-framerate', String(FFMPEG_FRAMERATE),
      '-video_size', `${this.width}x${this.height}`,
      '-thread_queue_size', '4',
      '-i', this.display,
      '-map', '0:v',
      '-vf', vf,
      '-q:v', String(FFMPEG_QUALITY),
      '-f', 'mjpeg',
      '-',
      '-map', '0:v',
      '-vf', vf,
      '-c:v', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-f', 'rawvideo',
      '-an',
      'pipe:4',
    ];
  }

  get mjpegStdout() {
    return this.proc ? this.proc.stdout : null;
  }

  get alive() {
    return !!(this.proc && this.proc.exitCode === null && !this.stopping);
  }

  _demand() {
    return this.viewers + this.peers;
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  _scheduleIdleCheck() {
    this._clearIdleTimer();
    if (this._demand() > 0) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._demand() > 0) return;
      if (!this.running) return;
      this._stopProducer(true); // intencional: grace esgotada, sem fallback
    }, IDLE_GRACE_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _attachDiscardDrain() {
    // Dreno de descarte: garante a INVARIANTE (fd sempre com leitor) desde o
    // spawn, antes de qualquer attach real. Conta bytes para telemetria.
    if (!this.rawFd) return;
    const counting = (chunk) => { this.rawBytes += chunk ? chunk.length : 0; };
    this._rawDrain = counting;
    try { this.rawFd.on('data', counting); } catch {}
    try { this.rawFd.resume(); } catch {}
  }

  _detachDrain() {
    if (!this.rawFd || !this._rawDrain) return;
    try { this.rawFd.removeListener('data', this._rawDrain); } catch {}
    this._rawDrain = null;
  }

  async _spawnProducer() {
    if (this.spawning || this.alive) return this.alive;
    this.spawning = true;
    try {
      // Pausa-e-retomada imediata não pode spawnar sobre o grupo velho: o
      // cleanup escala para SIGKILL em 2s. Espera a morte do proc anterior OU
      // do último proc morto (o _stopProducer nulifica this.proc, mas o grupo
      // pode viver até 2s no SIGTERM-grace) — teto 3s. Nunca dois x11grab no
      // mesmo display.
      const old = (this.proc && this.proc.exitCode === null) ? this.proc : this._lastProc;
      if (old && old.exitCode === null) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3000);
          try { old.once('exit', () => { clearTimeout(t); resolve(); }); } catch { clearTimeout(t); resolve(); }
        });
      }
      this._lastProc = null;
      const ffmpegBin = resolveFfmpegPath();
      if (!ffmpegBin) return false;

      const gen = ++this.generation;
      const proc = spawn('/bin/sh', ['-c', FFMPEG_WRAPPER_SCRIPT, 'serende-ffmpeg', ffmpegBin, ...this._buildArgs()], {
        env: { ...process.env, DISPLAY: this.display },
        stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'],
        detached: true,
      });
      this.proc = proc;
      this.rawFd = proc.stdio[4] || null;
      this.rawBytes = 0;
      if (!this.rawFd) {
        console.error(`[Capture:${this.sessionId}] pipe:4 ausente — produtor dual-output inviável`);
        try { this._killProcessGroup(proc); } catch {}
        this.proc = null;
        return false;
      }

      let stderrTail = '';
      proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-500); });
      proc.on('error', (err) => {
        console.error(`[Capture:${this.sessionId}] ffmpeg erro de processo:`, err.message);
      });
      proc.on('exit', (code, signal) => {
        if (gen !== this.generation) return; // geração antiga: ignora
        this.proc = null;
        this.rawFd = null;
        this._rawDrain = null;
        if (this.stopping) return; // intencional: sem fallback, sem re-spawn
        this.running = false;
        this._deaths++;
        const reason = `code=${code} signal=${signal || '-'}${stderrTail.trim() ? ` stderr=${stderrTail.trim().slice(-200)}` : ''}`;
        console.error(`[Capture:${this.sessionId}] produtor dual MORREU (${reason})`);
        if (this._onDeath) { try { this._onDeath(reason); } catch {} }
      });

      // stdout MJPEG nasce pausado (o StreamManager assina depois); rawFd
      // nasce com dreno de descarte (INVARIANTE: sempre com leitor).
      try { proc.stdout.pause(); } catch {}
      this._attachDiscardDrain();
      this.stopping = false;
      this.running = true;
      console.log(`[Capture:${this.sessionId}] produtor dual iniciado: ${this.display} ${this.ew}x${this.eh} @${FFMPEG_FRAMERATE}fps q=${FFMPEG_QUALITY} (mjpeg→stdout, i420→pipe:4)`);
      return true;
    } finally {
      this.spawning = false;
    }
  }

  _stopProducer() {
    // Parada intencional (grace esgotada ou stop()): sem fallback, sem re-spawn.
    const proc = this.proc;
    if (!proc) {
      this.running = false;
      return;
    }
    // Guarda o proc para o próximo spawn esperar o grupo morrer (SIGKILL
    // escalation em 2s) mesmo com this.proc já nulificado abaixo.
    this._lastProc = proc;
    this.rawAttached = false;
    this.stopping = true;
    this.generation++; // exits deste proc viram "geração antiga": ignorados
    this._clearIdleTimer();
    try { proc.stdin && proc.stdin.end && proc.stdin.end(); } catch {}
    try { proc.stdin && proc.stdin.destroy && proc.stdin.destroy(); } catch {}
    try { this._killProcessGroup(proc); } catch {}
    this.proc = null;
    this.rawFd = null;
    this._rawDrain = null;
    this.running = false;
  }

  // Garante produtor vivo (spawna se preciso) — usado por demanda (viewer/peer).
  async ensureRunning() {
    if (this.alive) return true;
    this.stopping = false;
    return this._spawnProducer();
  }

  // Restart coordenado para attach-at-offset-0: quando o primeiro peer chega
  // com o produtor já rodando (só MJPEG), o reassembler I420 entraria no meio
  // do stream e rasgaria o vídeo permanentemente (markerless). Para
  // (intencional, sem onDeath) e re-spawna: o próximo attach começa no offset 0.
  async restartForRawAttach() {
    if (!this.alive) return this.ensureRunning();
    this._stopProducer();
    return this.ensureRunning();
  }

  // --- Refcount unificado (viewers MJPEG + peers RTC) ---

  addViewer(id) {
    this.viewers++;
    this._clearIdleTimer();
    void id;
  }

  removeViewer(id) {
    if (this.viewers > 0) this.viewers--;
    void id;
    this._scheduleIdleCheck();
  }

  addPeer(id) {
    this.peers++;
    this._clearIdleTimer();
    void id;
  }

  removePeer(id) {
    if (this.peers > 0) this.peers--;
    void id;
    this._scheduleIdleCheck();
  }

  peerCount() { return this.peers; }
  viewerCount() { return this.viewers; }

  markRawAttached() { this.rawAttached = true; }

  // Parada total (fim da sessão): intencional, sem onDeath, sem timer.
  stop() {
    this._clearIdleTimer();
    this.viewers = 0;
    this.peers = 0;
    this.rawAttached = false;
    this._stopProducer();
  }

  getStats() {
    return {
      running: this.running,
      alive: this.alive,
      viewers: this.viewers,
      peers: this.peers,
      deaths: this._deaths,
      rawBytes: this.rawBytes,
      dims: { w: this.ew, h: this.eh },
      frameSize: this.frameSize,
    };
  }
}

module.exports = { CaptureService, unifiedDims, FFMPEG_FRAMERATE, FFMPEG_QUALITY, IDLE_GRACE_MS };
