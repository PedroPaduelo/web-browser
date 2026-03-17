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
      enableId = idCounter++;
      ws.send(JSON.stringify({ id: enableId, method: 'Page.enable' }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Resposta do Page.enable — iniciar screencast
      if (msg.id === enableId && msg.result !== undefined) {
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
        } catch {}

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
        this.reconnectTimer = setTimeout(() => this._connect(), 1000);
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
