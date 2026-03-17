const SOI_0 = 0xFF;
const SOI_1 = 0xD8;
const EOI_0 = 0xFF;
const EOI_1 = 0xD9;

class StreamManager {
  constructor() {
    this.clients = new Set();
    this.ffmpegStream = null;
    this.buf = Buffer.allocUnsafe(512 * 1024);
    this.bufLen = 0;
    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.fps = 0;
    this.lastFrame = null;
  }

  addClient(ws) {
    this.clients.add(ws);
    if (ws._socket) {
      ws._socket.setNoDelay(true);
      ws._socket.cork && ws._socket.cork();
    }

    if (this.lastFrame) {
      try { ws.send(this.lastFrame, { binary: true }); } catch {}
    }

    ws.on('close', () => this.clients.delete(ws));
  }

  startCapture(ffmpegStdout) {
    if (!ffmpegStdout) return;

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

    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      // skip se o buffer do socket estiver cheio (backpressure)
      if (ws.bufferedAmount > 256 * 1024) continue;
      try {
        ws.send(frame, { binary: true, fin: true, compress: false });
      } catch {}
    }
  }

  stop() {
    this.ffmpegStream = null;
    this.bufLen = 0;
    this.lastFrame = null;
    for (const ws of this.clients) {
      try { ws.close(); } catch {}
    }
    this.clients.clear();
  }

  getStats() {
    return {
      clients: this.clients.size,
      fps: this.fps,
      capturing: !!this.ffmpegStream,
    };
  }
}

module.exports = StreamManager;
