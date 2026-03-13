const SOI_0 = 0xFF;
const SOI_1 = 0xD8;
const EOI_0 = 0xFF;
const EOI_1 = 0xD9;

const TARGET_FPS = 30;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

class StreamManager {
  constructor() {
    this.clients = new Set();
    this.ffmpegStream = null;
    this.buf = Buffer.allocUnsafe(512 * 1024);
    this.bufLen = 0;
    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.fps = 0;
    this.lastFrameTime = 0;
    this.lastFrame = null;
  }

  addClient(ws) {
    this.clients.add(ws);
    ws._writableState && (ws._writableState.highWaterMark = 64 * 1024);

    if (this.lastFrame) {
      try { ws.send(this.lastFrame, { binary: true }); } catch {}
    }

    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }

  startCapture(ffmpegStdout) {
    if (!ffmpegStdout) return;

    this.ffmpegStream = ffmpegStdout;
    this.bufLen = 0;
    this.lastFrameTime = 0;

    ffmpegStdout.on('data', (chunk) => {
      const needed = this.bufLen + chunk.length;
      if (needed > this.buf.length) {
        const newBuf = Buffer.allocUnsafe(Math.max(needed * 2, this.buf.length * 2));
        this.buf.copy(newBuf, 0, 0, this.bufLen);
        this.buf = newBuf;
      }
      chunk.copy(this.buf, this.bufLen);
      this.bufLen += chunk.length;
      this.extractFrames();
    });

    ffmpegStdout.on('end', () => {
      this.ffmpegStream = null;
    });

    ffmpegStdout.on('error', () => {});

    console.log('[Stream] Capture started');
  }

  extractFrames() {
    let offset = 0;
    let lastFrameStart = -1;
    let lastFrameEnd = -1;

    while (offset < this.bufLen - 1) {
      if (this.buf[offset] === SOI_0 && this.buf[offset + 1] === SOI_1) {
        const soiIdx = offset;
        let eoiIdx = -1;
        for (let j = soiIdx + 2; j < this.bufLen - 1; j++) {
          if (this.buf[j] === EOI_0 && this.buf[j + 1] === EOI_1) {
            eoiIdx = j;
            break;
          }
        }
        if (eoiIdx === -1) break;
        lastFrameStart = soiIdx;
        lastFrameEnd = eoiIdx + 2;
        offset = lastFrameEnd;
      } else {
        offset++;
      }
    }

    if (lastFrameStart === -1) return;

    const now = Date.now();
    const elapsed = now - this.lastFrameTime;

    if (elapsed >= FRAME_INTERVAL - 2) {
      const frame = Buffer.allocUnsafe(lastFrameEnd - lastFrameStart);
      this.buf.copy(frame, 0, lastFrameStart, lastFrameEnd);
      this.lastFrame = frame;
      this.lastFrameTime = now;
      this.broadcastFrame(frame);
    }

    if (lastFrameEnd < this.bufLen) {
      this.buf.copy(this.buf, 0, lastFrameEnd, this.bufLen);
      this.bufLen -= lastFrameEnd;
    } else {
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

    const clients = this.clients;
    for (const ws of clients) {
      if (ws.readyState === 1) {
        if (ws.bufferedAmount > 128 * 1024) continue;
        try {
          ws.send(frame, { binary: true, fin: true });
        } catch {}
      }
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
    console.log('[Stream] Stopped');
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
