const { WebSocket } = require('ws');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class CDPScreencast {
  constructor(cdpPort) {
    this.cdpPort = cdpPort;
    this.ws = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.onFrame = null;
    this.frameCount = 0;
    this.lastLogTime = Date.now();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  start(onFrame) {
    this.onFrame = onFrame;
    this._connect();
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

    ws.on('open', () => {
      this.reconnectAttempts = 0; // Reset on successful connect
      console.log(`[CDP:${this.cdpPort}] WebSocket conectado ao Chrome`);
      enableId = idCounter++;
      ws.send(JSON.stringify({ id: enableId, method: 'Page.enable' }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Resposta do Page.enable — iniciar screencast
      if (msg.id === enableId && msg.result !== undefined) {
        console.log(`[CDP:${this.cdpPort}] Page.enable OK, iniciando screencast...`);
        ws.send(JSON.stringify({
          id: idCounter++,
          method: 'Page.startScreencast',
          params: {
            format: 'jpeg',
            quality: 80,
            everyNthFrame: 1,
          },
        }));
        return;
      }

      // Frame recebido
      if (msg.method === 'Page.screencastFrame') {
        const { data: b64, sessionId } = msg.params;
        try {
          const frame = Buffer.from(b64, 'base64');
          if (this.onFrame) this.onFrame(frame);
          this.frameCount++;
          const now = Date.now();
          if (now - this.lastLogTime >= 5000) {
            console.log(`[CDP:${this.cdpPort}] ${this.frameCount} frames enviados, ultimo ${frame.length} bytes`);
            this.lastLogTime = now;
          }
        } catch (e) {
          console.error(`[CDP:${this.cdpPort}] Erro processar frame:`, e.message);
        }

        // ACK obrigatório — Chrome para de enviar se não receber
        try {
          ws.send(JSON.stringify({
            id: idCounter++,
            method: 'Page.screencastFrameAck',
            params: { sessionId },
          }));
        } catch {}
      }
    });

    ws.on('close', () => {
      this.ws = null;
      if (!this.stopped) {
        this.reconnectAttempts++;
        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
          const delay = Math.min(1000 * this.reconnectAttempts, 5000);
          this.reconnectTimer = setTimeout(() => this._connect(), delay);
        } else {
          console.error(`[CDP:${this.cdpPort}] Max reconnect attempts reached, giving up`);
        }
      }
    });

    ws.on('error', () => {});
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
