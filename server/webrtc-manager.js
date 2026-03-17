/**
 * WebRTC Manager — usa @roamhq/wrtc RTCVideoSource
 *
 * Arquitetura:
 *   ffmpeg x11grab → rawvideo YUV I420 → stdout → Node.js stream
 *   → RTCVideoSource.onFrame() → RTCPeerConnection → browser
 *
 * Latência alvo: ~50ms (vs ~500ms MJPEG)
 */

const { spawn } = require('child_process');
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('@roamhq/wrtc');
const { nonstandard: { RTCVideoSource } } = require('@roamhq/wrtc');

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class WebRTCSession {
  constructor(sessionId, display, resolution) {
    this.sessionId = sessionId;
    this.display = display;
    this.width = resolution.width;
    this.height = resolution.height;

    this.videoSource = new RTCVideoSource();
    this.videoTrack = this.videoSource.createTrack();

    this.peers = new Map();
    this.ffmpeg = null;
    this.running = false;

    // I420: Y=w*h + U=(w/2)*(h/2) + V=(w/2)*(h/2) = w*h*3/2
    this.frameSize = Math.floor(this.width * this.height * 3 / 2);
    this.frameBuf = Buffer.allocUnsafe(this.frameSize);
    this.frameBufLen = 0;

    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.fps = 0;
  }

  startCapture() {
    if (this.running) return;
    this.running = true;
    this._spawnFfmpeg();
  }

  _spawnFfmpeg() {
    if (!this.running) return;

    const args = [
      '-probesize', '32',
      '-analyzeduration', '0',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'x11grab',
      '-framerate', '30',
      '-video_size', `${this.width}x${this.height}`,
      '-draw_mouse', '0',
      '-thread_queue_size', '4',
      '-i', this.display,
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-an',
      'pipe:1',
    ];

    this.ffmpeg = spawn('ffmpeg', args, {
      env: { ...process.env, DISPLAY: this.display },
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this.ffmpeg.stdout.on('data', (chunk) => this._onRawData(chunk));

    this.ffmpeg.on('exit', () => {
      this.ffmpeg = null;
      if (this.running) setTimeout(() => this._spawnFfmpeg(), 1000);
    });

    this.ffmpeg.on('error', () => {
      this.ffmpeg = null;
      if (this.running) setTimeout(() => this._spawnFfmpeg(), 1000);
    });
  }

  _onRawData(chunk) {
    let srcOffset = 0;
    while (srcOffset < chunk.length) {
      const needed = this.frameSize - this.frameBufLen;
      const available = chunk.length - srcOffset;
      const toCopy = Math.min(needed, available);

      chunk.copy(this.frameBuf, this.frameBufLen, srcOffset, srcOffset + toCopy);
      this.frameBufLen += toCopy;
      srcOffset += toCopy;

      if (this.frameBufLen === this.frameSize) {
        this._dispatchFrame();
        this.frameBufLen = 0;
      }
    }
  }

  _dispatchFrame() {
    if (this.peers.size === 0) return;

    const data = new Uint8ClampedArray(
      this.frameBuf.buffer,
      this.frameBuf.byteOffset,
      this.frameSize,
    );

    try {
      this.videoSource.onFrame({ width: this.width, height: this.height, data });
    } catch {}

    this.frameCount++;
    const now = Date.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
  }

  async createOffer(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.addTrack(this.videoTrack);

    const iceCandidates = [];
    let iceGatheringDone;
    const iceGatheringPromise = new Promise((resolve) => { iceGatheringDone = resolve; });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        iceCandidates.push(e.candidate.toJSON());
      } else {
        iceGatheringDone(iceCandidates);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this._removePeer(peerId);
      }
    };

    const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);

    await Promise.race([
      iceGatheringPromise,
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);

    this.peers.set(peerId, pc);

    return {
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
      candidates: iceCandidates,
    };
  }

  async setAnswer(peerId, answerSdp) {
    const pc = this.peers.get(peerId);
    if (!pc) throw new Error('Peer not found');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));
  }

  async addIceCandidate(peerId, candidate) {
    const pc = this.peers.get(peerId);
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  _removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) {
      try { pc.close(); } catch {}
      this.peers.delete(peerId);
    }
  }

  removePeer(peerId) { this._removePeer(peerId); }

  stop() {
    this.running = false;
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGTERM'); } catch {}
      this.ffmpeg = null;
    }
    for (const [id] of this.peers) this._removePeer(id);
    try { this.videoTrack.stop(); } catch {}
  }

  getStats() {
    return { peers: this.peers.size, fps: this.fps, capturing: !!this.ffmpeg };
  }
}

module.exports = { WebRTCSession };
