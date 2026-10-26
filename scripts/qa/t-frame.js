#!/usr/bin/env node
'use strict';
// Mede o frame que o VIEWER recebe pelo stream (/ws/stream).
// Conecta no WebSocket, captura frames binarios e mede o JPEG (SOF marker).
const fs = require('fs');
const WebSocket = require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));

const API = process.env.API || 'http://127.0.0.1:4201';
const KEY = process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8').trim();

function jpegSize(buf) {
  // procura SOF0/1/2 (FF C0/C1/C2): altura e largura no header
  for (let i = 0; i < buf.length - 9; i++) {
    if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc1 || buf[i + 1] === 0xc2)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
  }
  return null;
}

(async () => {
  const resolution = process.argv[2] || '1440x900';
  const login = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: KEY }),
  })).json();
  const token = login.token;
  if (!token) { console.log('login falhou', JSON.stringify(login).slice(0, 200)); process.exit(2); }

  const created = await (await fetch(`${API}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ resolution }),
  })).json();
  const sid = created.sessionId;
  console.log(`sessao ${sid} @ ${resolution} — criando...`);
  await new Promise(r => setTimeout(r, 8000));

  const wsUrl = `${API.replace('http', 'ws')}/ws/stream?token=${encodeURIComponent(token)}&sessionId=${sid}`;
  const ws = new WebSocket(wsUrl);
  const frames = [];
  let done = false;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const s = jpegSize(buf);
    frames.push(s ? s : { erro: 'sem SOF', bytes: buf.length });
    if (frames.length >= 6) { done = true; ws.close(); }
  });
  ws.on('error', (e) => { console.log('ws erro:', e.message); done = true; });
  ws.on('open', () => console.log('ws conectado, capturando frames...'));

  const t0 = Date.now();
  while (!done && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 300));
  try { ws.close(); } catch {}

  // viewport real
  const vp = await (await fetch(`${API}/api/screenshotWithInfo/${sid}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();

  console.log(`\nviewport da sessao : ${vp.info && vp.info.viewport ? vp.info.viewport.width + 'x' + vp.info.viewport.height : '?'}`);
  console.log(`screenshot (captureScreenshot): ${vp.info && vp.info.image ? vp.info.image.width + 'x' + vp.info.image.height : '?'}`);
  console.log('frames recebidos pelo viewer (stream):');
  const uniq = {};
  frames.forEach(f => { const k = f.width ? `${f.width}x${f.height}` : JSON.stringify(f); uniq[k] = (uniq[k] || 0) + 1; });
  Object.entries(uniq).forEach(([k, v]) => console.log(`   ${k}  x${v}`));
  if (!frames.length) console.log('   NENHUM frame recebido');

  await fetch(`${API}/api/session/${sid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  console.log('sessao fechada');
})();
