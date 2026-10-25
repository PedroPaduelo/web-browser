const { WebSocket } = require('ws');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class CDPScreencast {
  constructor(cdpPort, opts = {}) {
    this.cdpPort = cdpPort;
    this.ws = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.onFrame = null;
    this.frameCount = 0;
    this.lastLogTime = Date.now();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    // Qualidade configurável; padrão 70 equilibra nitidez x banda
    // (80 gerava ~2x bytes sem ganho visível em tela remota).
    this.quality = Number.isFinite(+opts.quality)
      ? Math.min(100, Math.max(10, Math.round(+opts.quality))) : 70;
    // Teto de resolução do frame. maxWidth GUARDE o teto de largura; maxHeight
    // passa a ter valor padrão explícito (720) quando quem não informar, para
    // o screencast nunca escalar abaixo da altura útil da sessão — antes ele
    // ficava 0 ("sem limite") e o frame saía no tamanho que o Chrome quisesse
    // dar, o que podia cortar o rodapé da página.
    this.maxWidth = Math.max(0, Math.round(+opts.maxWidth || 1280));
    this.maxHeight = Math.max(0, Math.round(+opts.maxHeight || 720));
    // Throttling na origem: 1 = todo frame; 2 = metade dos frames, etc.
    this.everyNthFrame = Math.max(1, Math.round(+opts.everyNthFrame || 1));
    // Throttling local em fps (0 = desligado).
    this.maxFps = Math.max(0, +opts.maxFps || 0);
    this.sessionId = opts.sessionId || null;
    // Hook de backpressure downstream: () => true descarta o frame (com ACK).
    this.shouldDrop = (typeof opts.shouldDrop === 'function') ? opts.shouldDrop : null;
    this.droppedFrames = 0;
    this.lastSentAt = 0;
    this.lastFrameLen = 0;
  }

  start(onFrame) {
    this.onFrame = onFrame;
    this._connect();
  }

  // Troca qualidade/resolução/throttling em voo (vale no próximo startScreencast).
  setOptions(opts = {}) {
    if (Number.isFinite(+opts.quality)) this.quality = Math.min(100, Math.max(10, Math.round(+opts.quality)));
    if (Number.isFinite(+opts.maxWidth)) this.maxWidth = Math.max(0, Math.round(+opts.maxWidth));
    if (Number.isFinite(+opts.maxHeight)) this.maxHeight = Math.max(0, Math.round(+opts.maxHeight));
    if (Number.isFinite(+opts.everyNthFrame)) this.everyNthFrame = Math.max(1, Math.round(+opts.everyNthFrame));
    if (Number.isFinite(+opts.maxFps)) this.maxFps = Math.max(0, +opts.maxFps);
    if (typeof opts.sessionId === 'string') this.sessionId = opts.sessionId;
  }

  // Hook de backpressure: () => true descarta o frame (com ACK) sem encaminhar.
  setShouldDrop(fn) { this.shouldDrop = (typeof fn === 'function') ? fn : null; }

  getStats() {
    return {
      cdpPort: this.cdpPort,
      frames: this.frameCount,
      dropped: this.droppedFrames,
      lastFrameBytes: this.lastFrameLen,
      quality: this.quality,
      everyNthFrame: this.everyNthFrame,
    };
  }

  async _getPageWsUrl() {
    const res = await fetch(`http://127.0.0.1:${this.cdpPort}/json`);
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    return page?.webSocketDebuggerUrl || null;
  }

  async _connect() {
    if (this.stopped) return;

    let wsUrl = null;
    for (let i = 0; i < 10; i++) {
      try {
        wsUrl = await this._getPageWsUrl();
        if (wsUrl) break;
      } catch {}
      await sleep(500);
    }

    if (!wsUrl) {
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this._connect(), 2000);
      }
      return;
    }

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    let idCounter = 1;
    let enableId = null;
    let startId = null;
    const stag = () => `[CDP:${this.cdpPort} session=${this.sessionId || '-'}]`;

    ws.on('open', () => {
      this.reconnectAttempts = 0; // Reset on successful connect
      console.log(`${stag()} WebSocket conectado ao Chrome`);
      enableId = idCounter++;
      ws.send(JSON.stringify({ id: enableId, method: 'Page.enable' }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Resposta do Page.enable — iniciar screencast
      if (msg.id === enableId && msg.result !== undefined) {
        if (msg.error) {
          console.error(`${stag()} Page.enable falhou:`, msg.error.message || JSON.stringify(msg.error));
          return;
        }
        const params = {
          format: 'jpeg',
          quality: this.quality,
          everyNthFrame: this.everyNthFrame,
        };
        if (this.maxWidth > 0) params.maxWidth = this.maxWidth;
        if (this.maxHeight > 0) params.maxHeight = this.maxHeight;
        console.log(`${stag()} Page.enable OK, iniciando screencast ` +
          `(quality=${params.quality} everyNthFrame=${params.everyNthFrame}` +
          `${params.maxWidth ? ` maxWidth=${params.maxWidth}` : ''}` +
          `${params.maxHeight ? ` maxHeight=${params.maxHeight}` : ''})...`);
        startId = idCounter++;
        ws.send(JSON.stringify({ id: startId, method: 'Page.startScreencast', params }));
        return;
      }

      // Resposta do startScreencast — erro de parâmetro aparece aqui, não no frame.
      if (startId !== null && msg.id === startId) {
        startId = null;
        if (msg.error) {
          console.error(`${stag()} Page.startScreencast falhou:`, msg.error.message || JSON.stringify(msg.error));
        }
        return;
      }

      // Frame recebido
      if (msg.method === 'Page.screencastFrame') {
        const { data: b64, sessionId } = msg.params;
        let frame = null;
        try {
          frame = Buffer.from(b64, 'base64');
        } catch (e) {
          console.error(`${stag()} erro ao decodificar frame:`, (e && e.message) || e);
        }

        if (frame) {
          const now = Date.now();
          let dropped = false;
          // Throttling local: limita fps sem renegociar com o Chrome.
          if (this.maxFps > 0 && now - this.lastSentAt < 1000 / this.maxFps) {
            dropped = true;
          } else if (typeof this.shouldDrop === 'function') {
            // Backpressure downstream: descarta aqui em vez de enfileirar.
            try { dropped = !!this.shouldDrop(); } catch { dropped = false; }
          }
          if (dropped) {
            this.droppedFrames++;
          } else {
            this.lastSentAt = now;
            try {
              if (this.onFrame) this.onFrame(frame);
              this.frameCount++;
              this.lastFrameLen = frame.length;
            } catch (e) {
              console.error(`${stag()} erro no consumidor do frame:`, (e && e.message) || e);
            }
          }
          if (now - this.lastLogTime >= 5000) {
            console.log(`${stag()} ${this.frameCount} frames enviados` +
              (this.droppedFrames ? `, ${this.droppedFrames} descartados` : '') +
              `, ultimo ${this.lastFrameLen} bytes`);
            this.lastLogTime = now;
          }
        }

        // ACK obrigatório em TODO frame (mesmo descartado) — Chrome trava sem ele.
        try {
          ws.send(JSON.stringify({
            id: idCounter++,
            method: 'Page.screencastFrameAck',
            params: { sessionId },
          }));
        } catch (e) {
          console.error(`${stag()} falha no screencastFrameAck:`, (e && e.message) || e);
        }
      }
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      if (!this.stopped) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
          const delay = Math.min(1000 * this.reconnectAttempts, 5000);
          this.reconnectTimer = setTimeout(() => this._connect(), delay);
        } else {
          console.error(`[CDP:${this.cdpPort} session=${this.sessionId || '-'}] Max reconnect attempts reached, giving up (code=${code || '?'}${reason ? ` reason=${reason}` : ''})`);
        }
      }
    });

    ws.on('error', (e) => {
      console.error(`[CDP:${this.cdpPort} session=${this.sessionId || '-'}] erro no WS:`, (e && e.message) || e);
    });
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = CDPScreencast;
