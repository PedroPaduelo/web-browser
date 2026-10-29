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
    this.mode = 'none'; // 'ffmpeg' | 'cdp'
    // Teto de backpressure por cliente (default 1MB — 4MB enfileirava ~2s de
    // vídeo e atrasava o stream; quem passa disso recebe o próximo lastFrame).
    this.maxBuffered = Math.max(64 * 1024, +opts.maxBufferedBytes || 1024 * 1024);
    this.dropped = 0;
    this.sendErrors = 0;
  }

  // Injetar frame diretamente (CDP screencast mode). Retorna nº de clientes
  // que realmente receberam (0 = só guardado como lastFrame).
  pushFrame(frameBuffer) {
    this.lastFrame = frameBuffer;
    if (this.clients.size === 0) return 0;
    return this.broadcastFrame(frameBuffer);
  }

  addClient(ws) {
    this.clients.add(ws);
    if (ws._socket) {
      ws._socket.setNoDelay(true);
    }

    if (this.lastFrame) {
      try { ws.send(this.lastFrame, { binary: true }); } catch {}
    }

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
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
    // O produtor nasce pausado (startFfmpegCapture faz stdout.pause() para o
    // pipe não encher antes de assinar). Só 'data' NÃO retoma após pause()
    // explícito (medido: 0 bytes) — precisa do resume().
    try { ffmpegStdout.resume(); } catch {}
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
      const frame = Buffer.allocUnsafe(frameEnd - soiIdx);
      this.buf.copy(frame, 0, soiIdx, frameEnd);

      this.lastFrame = frame;
      this.broadcastFrame(frame);

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

  broadcastFrame(frame) {
    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

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
    };
  }
}

module.exports = StreamManager;
