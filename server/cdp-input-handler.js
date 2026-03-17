const WebSocket = require('./node_modules/ws');

const BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right' };

function createInputHandler(displayNum) {
  let ws = null;
  let msgId = 0;
  let connected = false;
  let retries = 0;

  const CDP_BASE_PORT = 9222;
  const DISPLAY_MIN = 100;
  const cdpPort = CDP_BASE_PORT + (displayNum - DISPLAY_MIN);

  async function connect() {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page');
      if (!page) {
        if (retries < 5) { retries++; setTimeout(connect, 500); }
        return;
      }

      ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.on('open', () => { connected = true; retries = 0; });
      ws.on('close', () => {
        connected = false; ws = null;
        if (retries < 5) { retries++; setTimeout(connect, 1000); }
      });
      ws.on('error', () => {});
    } catch {
      if (retries < 5) { retries++; setTimeout(connect, 1000); }
    }
  }

  setTimeout(connect, 300);

  function send(method, params) {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({ id: ++msgId, method, params }));
  }

  return {
    sendInput(msg) {
      if (!connected) return;
      const t = msg.type;

      if (t === 'mousemove') {
        send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: msg.x, y: msg.y
        });
      }
      else if (t === 'mousedown') {
        send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: msg.x, y: msg.y,
          button: BUTTON_MAP[msg.button] || 'left', clickCount: 1
        });
      }
      else if (t === 'mouseup') {
        send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: msg.x, y: msg.y,
          button: BUTTON_MAP[msg.button] || 'left'
        });
      }
      else if (t === 'click') {
        send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: msg.x, y: msg.y,
          button: BUTTON_MAP[msg.button] || 'left', clickCount: 1
        });
        send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: msg.x, y: msg.y,
          button: BUTTON_MAP[msg.button] || 'left'
        });
      }
      else if (t === 'scroll') {
        send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: msg.x, y: msg.y,
          deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0
        });
      }
      else if (t === 'keydown') {
        const key = msg.key || '';
        const params = { type: 'keyDown', key };
        if (key.length === 1) params.text = key;
        if (msg.code) params.code = msg.code;
        send('Input.dispatchKeyEvent', params);
      }
      else if (t === 'keyup') {
        const key = msg.key || '';
        send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      }
    },

    reconnect() {
      retries = 0;
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connected = false;
      setTimeout(connect, 100);
    },

    stop() {
      retries = 99;
      connected = false;
      if (ws) { try { ws.close(); } catch {} ws = null; }
    },
  };
}

module.exports = { createInputHandler };
