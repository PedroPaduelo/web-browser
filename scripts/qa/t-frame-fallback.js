#!/usr/bin/env node
'use strict';
// Mede o frame do viewer NO MODO FALLBACK CDP (sem ffmpeg).
// O maxHeight do cdp-screencast so afeta este caminho: com o ffmpeg de pe, o
// produtor primario entrega o display inteiro.
const fs = require('fs');
const { execSync } = require('child_process');
const WebSocket = require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));

const API = process.env.API || 'http://127.0.0.1:4201';
const KEY = process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8').trim();

function jpegSize(buf) {
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
  const created = await (await fetch(`${API}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ resolution }),
  })).json();
  const sid = created.sessionId;
  console.log(`sessao ${sid} @ ${resolution}`);
  await new Promise(r => setTimeout(r, 9000));

  // mata o ffmpeg DELE (grupo proprio) para forcar o fallback CDP
  const ps = execSync(`ps -eo pid,pgid,args --no-headers | grep x11grab | grep -v grep || true`).toString();
  const linhas = ps.split('\n').filter(Boolean);
  console.log(`produtores x11grab vivos: ${linhas.length}`);
  for (const l of linhas) {
    const m = l.trim().match(/^(\d+)\s+(\d+)/);
    if (m) {
      const pid = m[1], pgid = m[2];
      try { process.kill(-Number(pgid), 'SIGKILL'); console.log(`  matou grupo do ffmpeg ${pgid} (pid ${pid})`); } catch (e) { console.log(`  falhou: ${e.message}`); }
    }
  }
  await new Promise(r => setTimeout(r, 5000));

  const wsUrl = `${API.replace('http', 'ws')}/ws/stream?token=${encodeURIComponent(token)}&sessionId=${sid}`;
  const ws = new WebSocket(wsUrl);
  const frames = []; let done = false;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const s = jpegSize(buf);
    frames.push(s || { erro: 'sem SOF', bytes: buf.length });
    if (frames.length >= 8) { done = true; ws.close(); }
  });
  ws.on('error', (e) => { console.log('ws erro:', e.message); done = true; });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 300));
  try { ws.close(); } catch {}

  const vp = await (await fetch(`${API}/api/screenshotWithInfo/${sid}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  console.log(`\nviewport da sessao : ${vp.info && vp.info.viewport ? vp.info.viewport.width + 'x' + vp.info.viewport.height : '?'}`);
  console.log('frames do viewer (modo fallback CDP):');
  const uniq = {};
  frames.forEach(f => { const k = f.width ? `${f.width}x${f.height}` : JSON.stringify(f); uniq[k] = (uniq[k] || 0) + 1; });
  Object.entries(uniq).forEach(([k, v]) => console.log(`   ${k}  x${v}`));
  if (!frames.length) console.log('   NENHUM frame recebido');

  await fetch(`${API}/api/session/${sid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  console.log('sessao fechada');
})();
