#!/usr/bin/env node
/**
 * Regressão do vazamento do produtor de vídeo (ffmpeg x11grab).
 *
 * Bug: no stop da sessão, o wrapper anti-órfão recebia SIGTERM, rodava o
 * cleanup (matando o ffmpeg com SIGTERM) mas NÃO saía — e o escalonamento para
 * SIGKILL do `killProcess` era código morto (`proc.killed` já é true logo após
 * o SIGTERM). Resultado: wrapper + ffmpeg capturando o display X para sempre,
 * depois da sessão encerrada.
 *
 * Uso: node scripts/test-ffmpeg-leak.js [ciclos]
 */
const fs = require('fs');
const API = process.env.SERENDE_API || 'http://127.0.0.1:4201';
const KEY = process.env.KEY;
if (!KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node scripts/test-ffmpeg-leak.js');
  process.exit(1);
}
const CICLOS = parseInt(process.argv[2] || '3', 10);

// Captura os processos de captura de vídeo (o wrapper e o ffmpeg).
function capturas() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (c.includes('x11grab') || c.includes('serende-ffmpeg')) out.push(Number(d));
    } catch { /* processo morreu no meio da leitura */ }
  }
  return out.sort((a, b) => a - b);
}

(async () => {
  const antes = capturas();
  console.log(`capturas antes: ${antes.length ? antes.join(',') : 'nenhuma'}`);

  const login = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: KEY }),
  })).json();
  if (!login.token) throw new Error('login falhou');

  for (let i = 1; i <= CICLOS; i++) {
    const start = await (await fetch(`${API}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ resolution: '1280x720', startUrl: 'https://example.com' }),
    })).json();
    if (!start.sessionId) throw new Error(`sessão ${i} não subiu: ${JSON.stringify(start)}`);

    const durante = capturas();
    const stop = await fetch(`${API}/api/session/${start.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${login.token}` },
    });
    const status = stop.status;
    await stop.text();

    // killProcess dá SIGTERM e escala para SIGKILL em 2s; o wrapper tem loop
    // de 1s. 4s é folga suficiente.
    await new Promise((r) => setTimeout(r, 4000));
    const depois = capturas();
    const vazou = depois.length > antes.length;
    console.log(
      `ciclo ${i}: stop=${status} durante=${durante.length} depois=${depois.length} ` +
      `${vazou ? '❌ VAZOU (' + depois.join(',') + ')' : '✅'}`
    );
    if (vazou) {
      console.log(`   → sobrou: ${depois.filter((p) => !antes.includes(p)).join(',')}`);
      process.exit(1);
    }
  }

  const final = capturas();
  console.log(final.length === antes.length
    ? '✅ nenhum processo de captura vazado'
    : `❌ sobraram ${final.length - antes.length} processos`);
  process.exit(final.length === antes.length ? 0 : 1);
})().catch((e) => {
  console.error('erro no teste:', e);
  process.exit(1);
});
