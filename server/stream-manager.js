const SOI_0 = 0xFF;
const SOI_1 = 0xD8;
const EOI_0 = 0xFF;
const EOI_1 = 0xD9;

class StreamManager {
  constructor(opts = {}) {
    this.clients = new Set();
    this.ffmpegStream = null;
    this.buf = Buffer.allocUnsafe(512 * 1024);
    this.bufLen = 0;
    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.fps = 0;
    this.lastFrame = null;
    // Idade do lastFrame: screenshot endpoints usam para decidir se o frame
    // serve como captura do AGORA (novo espectador/limiar de frescor).
    this.lastFrameAt = 0;
    this.staticFrames = 0; // frames idênticos ao anterior (tela parada)
    this.mode = 'none'; // 'ffmpeg' | 'cdp'
    // Teto de backpressure por cliente (default 1MB — 4MB enfileirava ~2s de
    // vídeo e atrasava o stream; quem passa disso recebe o próximo lastFrame).
    this.maxBuffered = Math.max(64 * 1024, +opts.maxBufferedBytes || 1024 * 1024);
    this.dropped = 0;
    this.sendErrors = 0;

    // --- Captura consciente de espectadores ---
    // MEDIDO 2026-11: o ffmpeg x11grab gastava ~1 núcleo + ~114MB por sessão
    // 30fps mesmo SEM ninguém assistindo e com a tela 100% parada (frames
    // byte-idênticos). Com hooks, o dono da sessão suspende o produtor quando
    // não há espectadores e o retoma no primeiro viewer. Ver index.js.
    this.viewerHooks = null; // { onIdle, onActive, idleMs }
    this._idleTimer = null;
    if (this.viewerHooks) this._scheduleIdleCheck();
  }

  // Registra callbacks de espectador: onActive() no 1º viewer; onIdle() após
  // `idleMs` sem nenhum viewer (inclui sessão nunca assistida). Idempotente.
  setViewerHooks(hooks = {}) {
    const idleMs = Math.max(2000, parseInt(process.env.STREAM_IDLE_GRACE_MS || '15000') || 15000);
    this.viewerHooks = {
      onActive: typeof hooks.onActive === 'function' ? hooks.onActive : null,
      onIdle: typeof hooks.onIdle === 'function' ? hooks.onIdle : null,
      idleMs,
    };
    // Sessão criada e ninguém conectou: agenda o primeiro idle.
    this._scheduleIdleCheck();
  }

  _scheduleIdleCheck() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (!this.viewerHooks || !this.viewerHooks.onIdle) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.clients.size > 0) return;
      try { this.viewerHooks.onIdle(); } catch {}
    }, this.viewerHooks.idleMs);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  // Injetar frame diretamente (CDP screencast mode). Retorna nº de clientes
  // que realmente receberam (0 = só guardado como lastFrame).
  pushFrame(frameBuffer) {
    this.lastFrame = frameBuffer;
    this.lastFrameAt = Date.now();
    if (this.clients.size === 0) return 0;
    return this.broadcastFrame(frameBuffer);
  }

  addClient(ws) {
    const wasEmpty = this.clients.size === 0;
    this.clients.add(ws);
    if (ws._socket) {
      ws._socket.setNoDelay(true);
    }

    // Primeiro espectador: produtor volta antes de qualquer envio, para o
    // viewer não esperar em tel preta mais tempo que o necessário.
    if (wasEmpty && this.viewerHooks && this.viewerHooks.onActive) {
      try { this.viewerHooks.onActive(); } catch {}
    }

    // lastFrame serve com produtor ATIVO mesmo se "velho": o dedup garante
    // que não houve mudança desde o frame — ele É a imagem corrente. Com o
    // produtor parado (suspended/stopped) o lastFrame pode estar ATRASADO
    // (o agente pode ter navegado sem ninguém assistindo): não enviar.
    const stale = this.mode === 'none';
    if (this.lastFrame && !stale) {
      try { ws.send(this.lastFrame, { binary: true }); } catch {}
    }

    ws.on('close', () => this.removeClient(ws));
    ws.on('error', () => this.removeClient(ws));
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this._scheduleIdleCheck();
  }

  startCapture(ffmpegStdout) {
    if (!ffmpegStdout) return;

    this.mode = 'ffmpeg';
    this.ffmpegStream = ffmpegStdout;
    this.bufLen = 0;

    ffmpegStdout.on('data', (chunk) => {
      const needed = this.bufLen + chunk.length;
      if (needed > this.buf.length) {
        const newBuf = Buffer.allocUnsafe(Math.max(needed * 2, this.buf.length * 2));
        this.buf.copy(newBuf, 0, 0, this.bufLen);
        this.buf = newBuf;
      }
      chunk.copy(this.buf, this.bufLen);
      this.bufLen += chunk.length;
      this.extractAndBroadcast();
    });

    ffmpegStdout.on('end', () => { this.ffmpegStream = null; });
    ffmpegStdout.on('error', () => {});
  }

  // Encerra a captura de vídeo: solta o stdout e limpa o buffer parcial.
  // Sem limpar, um JPEG pela metade ficaria no buffer e o próximo produtor
  // (fallback CDP) poderia emitir um frame corrompido.
  stopCapture() {
    if (this.ffmpegStream) {
      try { this.ffmpegStream.removeAllListeners('data'); } catch {}
      try { this.ffmpegStream.pause(); } catch {}
    }
    this.ffmpegStream = null;
    this.bufLen = 0;
    this.mode = 'none';
    // lastFrame vira "congelado" (modo none). Quem decide a validade dele é a
    // checagem de frescor nos endpoints/consumidores.
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  extractAndBroadcast() {
    let offset = 0;

    while (offset < this.bufLen - 1) {
      // encontrar SOI (FF D8)
      if (!(this.buf[offset] === SOI_0 && this.buf[offset + 1] === SOI_1)) {
        offset++;
        continue;
      }

      const soiIdx = offset;
      let eoiIdx = -1;

      for (let j = soiIdx + 2; j < this.bufLen - 1; j++) {
        if (this.buf[j] === EOI_0 && this.buf[j + 1] === EOI_1) {
          eoiIdx = j;
          break;
        }
      }

      if (eoiIdx === -1) break; // frame incompleto, aguardar mais dados

      const frameEnd = eoiIdx + 2;
      const frameLen = frameEnd - soiIdx;

      // --- Dedup de tela parada ---
      // MEDIDO: em sessão ociosa o frame é BYTE-IDÊNTO ao anterior (o ffmpeg
      // retorna o mesmo JPEG). Comparar ANTES de alocar: sem cópia (subarray é
      // view) e sem envio (o viewer já tem este exato frame). Elimina o
      // reenvio de ~31KB×30/s por viewer e o churn de 30 allocs/s.
      if (this.lastFrame && this.lastFrame.length === frameLen) {
        const candidate = this.buf.subarray(soiIdx, frameEnd);
        if (candidate.equals(this.lastFrame)) {
          this.staticFrames++;
          this._countFrame(); // fps conta frames CAPTURADOS (sensor vivo)
          // lastFrameAt atualiza: o frame repetido É a imagem atual —
          // consumidores (screenshots/addClient) precisam vê-lo como fresco.
          this.lastFrameAt = Date.now();
          offset = frameEnd;
          continue;
        }
      }

      const frame = Buffer.allocUnsafe(frameLen);
      this.buf.copy(frame, 0, soiIdx, frameEnd);

      this.lastFrame = frame;
      this.lastFrameAt = Date.now();
      if (this.clients.size > 0) this.broadcastFrame(frame);

      offset = frameEnd;
    }

    // manter apenas dados não processados
    if (offset > 0 && offset < this.bufLen) {
      this.buf.copy(this.buf, 0, offset, this.bufLen);
      this.bufLen -= offset;
    } else if (offset >= this.bufLen) {
      this.bufLen = 0;
    }
  }

  _countFrame() {
    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
  }

  broadcastFrame(frame) {
    this._countFrame();

    let sent = 0;
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      // Descarte sob congestão: cliente com buffer cheio pula este frame e
      // recebe o próximo lastFrame ao drenar — evita fila crescente e atraso.
      if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > this.maxBuffered) {
        this.dropped++;
        continue;
      }
      try {
        ws.send(frame, { binary: true, fin: true, compress: false });
        sent++;
      } catch {
        this.sendErrors++;
      }
    }
    return sent;
  }

  stop() {
    this.stopCapture();
    this.lastFrame = null;
    for (const ws of this.clients) {
      try { ws.close(); } catch {}
    }
    this.clients.clear();
  }

  getStats() {
    let slowClients = 0;
    for (const ws of this.clients) {
      if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > this.maxBuffered) slowClients++;
    }
    return {
      clients: this.clients.size,
      slowClients,
      fps: this.fps,
      capturing: this.mode !== 'none',
      mode: this.mode,
      dropped: this.dropped,
      sendErrors: this.sendErrors,
      maxBufferedBytes: this.maxBuffered,
      staticFrames: this.staticFrames,
      lastFrameAgeMs: this.lastFrame ? (Date.now() - this.lastFrameAt) : null,
      idleWatch: !!this.viewerHooks,
    };
  }
}

module.exports = StreamManager;
