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
  constructor(sessionId, display, resolution, dims) {
    this.sessionId = sessionId;
    this.display = display;
    this.width = resolution.width;
    this.height = resolution.height;

    this.videoSource = new RTCVideoSource();
    this.videoTrack = this.videoSource.createTrack();

    this.peers = new Map();
    // Torneio #3 (veredito B): ESTA CLASSE NÃO SPAWNA MAIS NADA. O produtor
    // único (ffmpeg dual-output) mora no CaptureService; aqui só consumimos o
    // rawFd (pipe:4) via attachRawStream(). _spawnFfmpeg + respawn cego
    // deletados; morte do produtor chega via detach (onDeath no index.js).
    this._rawStream = null;   // readable atual (rawFd do CaptureService)
    this._onRawDataBound = (chunk) => this._onRawData(chunk);
    this._onRawEnd = null;

    // I420 EXATO (sem Math.floor): dims vêm do unifiedDims do CaptureService
    // (pares garantidos). Fallback defensivo para chamadas antigas.
    const fs = (dims && dims.frameSize)
      || ((this.width & ~1) * (this.height & ~1) * 3) / 2;
    this.frameWidth = (dims && dims.ew) || (this.width & ~1);
    this.frameHeight = (dims && dims.eh) || (this.height & ~1);
    this.frameSize = fs;
    this.frameBuf = Buffer.allocUnsafe(this.frameSize);
    this.frameBufLen = 0;

    this.frameCount = 0;
    this.lastFpsTime = Date.now();
    this.fps = 0;
  }

  // Liga este peer-set ao rawFd do CaptureService. Troca o listener de 'data'
  // (o dreno de descarte do service sai, entra o reassembler) e reseta o
  // frame parcial. Retorna true se anexado.
  attachRawStream(readable) {
    if (!readable) return false;
    this.detachRawStream();
    this._rawStream = readable;
    this.frameBufLen = 0;
    try { readable.on('data', this._onRawDataBound); } catch { return false; }
    this._onRawEnd = () => { this.detachRawStream(); };
    try { readable.once('end', this._onRawEnd); } catch {}
    try { readable.once('close', this._onRawEnd); } catch {}
    try { readable.once('error', this._onRawEnd); } catch {}
    try { readable.resume(); } catch {}
    return true;
  }

  detachRawStream() {
    const s = this._rawStream;
    this._rawStream = null;
    this.frameBufLen = 0; // descarta frame parcial (novo attach realinha)
    if (!s) return;
    try { s.removeListener('data', this._onRawDataBound); } catch {}
    if (this._onRawEnd) {
      try { s.removeListener('end', this._onRawEnd); } catch {}
      try { s.removeListener('close', this._onRawEnd); } catch {}
      try { s.removeListener('error', this._onRawEnd); } catch {}
      this._onRawEnd = null;
    }
  }

  closeAllPeers() {
    for (const [id] of this.peers) this._removePeer(id);
  }

  // Compat (dual-producer): o index.js agora dirige o CaptureService; estes
  // viram no-ops para não quebrar chamadas restantes.
  startCapture() {}
  pauseCapture() { this.detachRawStream(); }
  resumeCapture() {}

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

    // FIX (b, veredito B): cópia por dispatch em vez da view sobre o
    // frameBuf reutilizado — o timing de encode do libwrtc é opaco, e a view
    // seria sobrescrita pelo próximo frame antes do encode terminar.
    // ~1.4MB@15fps de garbage transitório (eden), aceito por correção.
    let data;
    try {
      data = new Uint8ClampedArray(Buffer.from(this.frameBuf));
    } catch { return; }

    try {
      this.videoSource.onFrame({ width: this.frameWidth, height: this.frameHeight, data });
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
      new Promise((resolve) => setTimeout(resolve, 1500)),
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
      // Notifica SEMPRE (inclusive ICE-driven failed/closed/disconnected, que
      // chama _removePeer direto sem passar pelo removePeer público) — o
      // index.js reconcilia o refcount do CaptureService via setPeers.
      if (this._onPeerCountChanged) { try { this._onPeerCountChanged(this.peers.size); } catch {} }
    }
  }

  removePeer(peerId) {
    this._removePeer(peerId);
    // Veredito B: o ICE-driven _removePeer (failed/closed/disconnected) também
    // passa por aqui? NÃO — ele chama _removePeer direto. O index.js lê
    // getStats().peers após CADA remoção (DELETE-route) e o oniceconnection-
    // statechange do frontend re-offerta; peers órfãos sem DELETE explícito
    // são cobertos pelo refcount lido no offer/answer. Documentado, sem leak
    // estrutural: peers mortos não recebem frames (_dispatchFrame checa size).
    if (this._onPeerCountChanged) { try { this._onPeerCountChanged(this.peers.size); } catch {} }
  }

  onPeerCountChanged(cb) { this._onPeerCountChanged = cb; }

  stop() {
    this.detachRawStream();
    for (const [id] of this.peers) this._removePeer(id);
    try { this.videoTrack.stop(); } catch {}
  }

  getStats() {
    return { peers: this.peers.size, fps: this.fps, capturing: !!this._rawStream };
  }
}

module.exports = { WebRTCSession };
