#!/usr/bin/env node
// Aceite da rede e do screenshot (26/10/2026). Cada caso mede o que a tool
// afirma, contra o MCP em execução:
//   - rede: cada requisição tem um estado (receiving / finished), tempos vindos
//     do relógio do Chrome, e uma entrada por requisição;
//   - clear esvazia o buffer e a captura continua; stop desliga de verdade;
//   - screenshot: o texto traz dimensões, bytes e sha256, além do bloco image;
//   - type_text sem campo editável responde isError.
//
// Uso (uma sessão por vez: cada sessão usa ~400-600 MB da sandbox):
//   KEY_FILE=/tmp/ef.key MCP_URL=http://127.0.0.1:4202/mcp node scripts/qa/t-rede-estados.js
//
// Cria UMA sessão e fecha no fim, mesmo se algum caso falhar.
// Sai com código 1 se algum caso falhar.
'use strict';
const fs = require('fs');

const KEY = (process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8')).trim();
const ENDPOINT = process.env.MCP_URL || 'http://127.0.0.1:4202/mcp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SID = null; // mcp-session-id da conexão
let rid = 1;
let SESS = null; // sessionId do browser deste teste
let failures = 0;

async function rpc(body) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': KEY };
  if (SID) h['mcp-session-id'] = SID;
  const res = await fetch(ENDPOINT, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const s = res.headers.get('mcp-session-id');
  if (s) SID = s;
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 160)}`);
  if (!txt.trim()) return null;
  if ((res.headers.get('content-type') || '').includes('event-stream')) {
    const data = txt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(txt);
}

async function tool(name, args = {}) {
  const r = await rpc({ jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } });
  if (!r) throw new Error(`${name}: resposta vazia`);
  if (r.error) throw new Error(`${name}: JSON-RPC ${JSON.stringify(r.error).slice(0, 160)}`);
  const content = (r.result && r.result.content) || [];
  return {
    isError: !!(r.result && r.result.isError),
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    image: content.find((b) => b.type === 'image') || null,
  };
}

// Toda chamada leva o sessionId explícito (contrato de sessão).
const T = (name, args = {}) => tool(name, { sessionId: SESS, ...args });
const js = (script) => T('evaluate_js', { script });

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`);
  if (!ok) failures++;
}

function entriesOf(r) {
  try { return JSON.parse(r.text).entries || []; } catch { return null; }
}

(async () => {
  await rpc({ jsonrpc: '2.0', id: rid++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-rede-estados', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const start = await tool('session_start', { forceNew: true, startUrl: 'https://example.com' });
  const m = start.text.match(/\[session: ([^\]]+)\]/) || start.text.match(/"sessionId":\s*"([^"]+)"/);
  if (!m) throw new Error('session_start sem sessionId: ' + start.text.slice(0, 200));
  SESS = m[1];
  console.log(`sessao ${SESS}`);
  await sleep(2500);

  try {
    // 1. Screenshot: texto com a prova da captura + bloco image.
    const shot = await T('screenshot');
    check('screenshot: texto traz dimensoes, bytes e sha256',
      /Image: JPEG \d+x\d+.*, \d+ bytes, sha256:[0-9a-f]{16}/.test(shot.text), shot.text);
    check('screenshot: bloco image JPEG presente',
      !!shot.image && shot.image.mimeType === 'image/jpeg' && shot.image.data.length > 1000,
      shot.image ? `mime=${shot.image.mimeType} len=${shot.image.data.length}` : 'sem bloco image');

    // 2. Rede: estados. Um POST cujo corpo a página nunca lê não recebe loadingFinished.
    await T('get_network_activity', { action: 'start' });
    await js(`(async () => {
      await fetch('/nt-post-sem-ler', { method: 'POST', body: 'x' }).catch(() => {});
      const r = await fetch('/nt-post-lendo', { method: 'POST', body: 'y' }).catch(() => null);
      if (r) await r.text();
      await fetch('/nt-get').catch(() => {});
      return true;
    })()`);
    await sleep(4000);
    const net = entriesOf(await T('get_network_activity', { action: 'get', filterUrl: '/nt-' }));
    const one = (suffix) => (net || []).filter((e) => e.url.endsWith(suffix));
    const semLer = one('/nt-post-sem-ler');
    const lendo = one('/nt-post-lendo');
    const get = one('/nt-get');
    check('rede: POST sem ler o corpo fica "receiving" com headersMs e sem durationMs',
      semLer.length === 1 && semLer[0].state === 'receiving' && typeof semLer[0].headersMs === 'number' && semLer[0].durationMs === undefined,
      JSON.stringify(semLer));
    check('rede: POST com corpo lido fecha como "finished" com durationMs e size',
      lendo.length === 1 && lendo[0].state === 'finished' && typeof lendo[0].durationMs === 'number' && typeof lendo[0].size === 'number',
      JSON.stringify(lendo));
    check('rede: GET fecha como "finished"',
      get.length === 1 && get[0].state === 'finished' && typeof get[0].durationMs === 'number',
      JSON.stringify(get));

    // 3. clear esvazia o buffer e a captura continua.
    const cl = await T('get_network_activity', { action: 'clear' });
    check('clear: resposta diz que a captura continua', /still running/.test(cl.text), cl.text);
    await js(`fetch('/nt-after-clear').then(() => true).catch(() => true)`);
    await sleep(3000);
    const afterClear = entriesOf(await T('get_network_activity', { action: 'get', filterUrl: '/nt-' }));
    check('clear: buffer tem so a requisicao feita depois do clear, e a captura segue ligada',
      afterClear && afterClear.length === 1 && afterClear[0].url.endsWith('/nt-after-clear'),
      JSON.stringify(afterClear));

    // 4. stop desliga de verdade.
    const st = await T('get_network_activity', { action: 'stop' });
    check('stop: resposta diz que a captura parou', /stopped/.test(st.text), st.text);
    await js(`fetch('/nt-after-stop').then(() => true).catch(() => true)`);
    await sleep(2000);
    const afterStop = await T('get_network_activity', { action: 'get', filterUrl: '/nt-' });
    check('stop: get responde "not enabled" (captura desligada)', /not enabled/.test(afterStop.text), afterStop.text);

    // 5. type_text sem campo editável responde isError (nao "Typed" sem efeito).
    const typed = await T('type_text', { text: 'abc' });
    check('type_text sem campo editavel responde isError', typed.isError === true, typed.text);
  } finally {
    await T('session_stop').catch(() => {});
    console.log('sessao fechada');
  }
  console.log(failures ? `\n${failures} caso(s) falharam` : '\nTodos os casos passaram');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERRO', e.message); process.exit(1); });
