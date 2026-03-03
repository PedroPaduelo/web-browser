const JPEG_SOI = Buffer.from([0xFF, 0xD8]);
const JPEG_EOI = Buffer.from([0xFF, 0xD9]);

class StreamManager {
  constructor() {
    this.clients = new Set();
    this.ffmpegStream = null;
    this.buffer = Buffer.alloc(0);
    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.fps = 0;
  }

  addClient(ws) {
    this.clients.add(ws);
    console.log(`[Stream] Client added (total: ${this.clients.size})`);

    ws.on('close', () => {
      this.clients.delete(ws);
      console.log(`[Stream] Client removed (total: ${this.clients.size})`);
    });
  }

  startCapture(ffmpegStdout) {
    if (!ffmpegStdout) return;

    this.ffmpegStream = ffmpegStdout;
    this.buffer = Buffer.alloc(0);

    ffmpegStdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.extractFrames();
    });

    ffmpegStdout.on('end', () => {
      console.log('[Stream] ffmpeg stream ended');
      this.ffmpegStream = null;
    });

    ffmpegStdout.on('error', (err) => {
      console.error('[Stream] ffmpeg stream error:', err.message);
    });

    console.log('[Stream] Capture started');
  }

  extractFrames() {
    while (true) {
      const soiIdx = this.buffer.indexOf(JPEG_SOI);
      if (soiIdx === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      const eoiIdx = this.buffer.indexOf(JPEG_EOI, soiIdx + 2);
      if (eoiIdx === -1) {
        if (soiIdx > 0) {
          this.buffer = this.buffer.subarray(soiIdx);
        }
        break;
      }

      const frame = this.buffer.subarray(soiIdx, eoiIdx + 2);
      this.buffer = this.buffer.subarray(eoiIdx + 2);

      this.broadcastFrame(frame);
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
      if (ws.readyState === 1) {
        try {
          ws.send(frame, { binary: true });
        } catch {}
      }
    }
  }

  stop() {
    this.ffmpegStream = null;
    this.buffer = Buffer.alloc(0);
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
