const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { injectMouse, injectClick, injectScroll, injectKeyDown, injectKeyUp, injectType } = require('./input');

const PORT = parseInt(process.env.AGENT_PORT) || 9222;
const app = express();
const server = http.createServer(app);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.get('/info', (req, res) => {
  res.json({
    display: process.env.DISPLAY_NUM || '99',
    resolution: process.env.RESOLUTION || '1280x720',
    videoRtpPort: parseInt(process.env.VIDEO_RTP_PORT) || 5004,
    audioRtpPort: parseInt(process.env.AUDIO_RTP_PORT) || 5006,
    micRtpPort: parseInt(process.env.MIC_RTP_PORT) || 5008,
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  console.log('[Agent] WS client connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'mousemove':
          injectMouse(msg.x, msg.y);
          break;
        case 'click':
          injectClick(msg.x, msg.y, msg.button || 0);
          break;
        case 'scroll':
          injectScroll(msg.x, msg.y, msg.deltaY);
          break;
        case 'keydown':
          injectKeyDown(msg.key);
          break;
        case 'keyup':
          injectKeyUp(msg.key);
          break;
        case 'type':
          injectType(msg.text);
          break;
      }
    } catch (err) {
      console.error('[Agent] Bad message:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[Agent] WS client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[Agent] WS error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Session Agent] listening on 0.0.0.0:${PORT}`);
});
