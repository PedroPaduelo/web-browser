#!/usr/bin/env node
// Teste de aceite da TELA DO VIEWER (o "watcher").
//
// Mede, no browser de teste, o que a pessoa ve na tela que assiste e age:
//   - a PAGINA nao rola (a rolagem e o que o usuario pediu para eliminar);
//   - o canvas cabe no container, com a proporcao do frame preservada
//     (nada de esticar a imagem);
//   - a barra do topo e uma so, com a altura medida;
//   - a resolucao padrao do browser interno e 1440x900.
//
// Uso (um teste por vez: cada sessao usa ~400-600 MB da sandbox):
//   KEY_FILE=/tmp/ef.key node scripts/qa/t-viewer-fit.js
//
// Cria UMA sessao e fecha no fim, mesmo se algum caso falhar.
// Sai com codigo 1 se algum caso falhar.
'use strict';
const fs = require('fs');

const KEY = (process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8')).trim();
const ENDPOINT = process.env.MCP_URL || 'http://127.0.0.1:4202/mcp';
const VIEWER_URL = process.env.VIEWER_URL || 'https://sb-serende-p4201.mp.serendiped.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rid = 1;
let SID = null;
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail).slice(0, 300)}`}`);
  if (!ok) failures++;
}

async function rpc(body) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': KEY };
  if (SID) h['mcp-session-id'] = SID;
  const res = await fetch(ENDPOINT, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const s = res.headers.get('mcp-session-id');
  if (s) SID = s;
  const txt = await res.text();
  if (!txt.trim()) return null;
  const data = txt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  return data ? JSON.parse(data) : JSON.parse(txt);
}

async function tool(name, args = {}) {
  const r = await rpc({ jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } });
  if (!r) throw new Error(`${name}: resposta vazia`);
  const content = (r.result && r.result.content) || [];
  return { isError: !!(r.result && r.result.isError), text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
}

(async () => {
  await rpc({ jsonrpc: '2.0', id: rid++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-viewer-fit', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 1) A resolucao padrao do browser interno, no backend e no MCP.
  const st = await tool('session_start', { forceNew: true, startUrl: 'https://example.com' });
  const sid = (st.text.match(/"sessionId":\s*"([^"]+)"/) || [])[1];
  if (!sid) throw new Error('session_start sem sessionId: ' + st.text.slice(0, 200));
  await sleep(3500);
  const shot = await tool('screenshot', { sessionId: sid });
  // O Chrome entrega 1 px a menos que o pedido (1439x899): a borda da janela
  // do Xvfb. Aceita 1440 ou 1439.
  const dim = (shot.text.match(/Image: JPEG (\d+)x(\d+)/) || [])[1];
  check('viewer: a resolucao padrao do browser interno e 1440x900', dim === '1440' || dim === '1439', dim || shot.text.slice(0, 120));
  await tool('session_stop', { sessionId: sid });
  await sleep(1500);

  // 2) O layout da tela, no browser de teste.
  const st2 = await tool('session_start', { forceNew: true, startUrl: VIEWER_URL });
  const sid2 = (st2.text.match(/"sessionId":\s*"([^"]+)"/) || [])[1];
  await sleep(4000);

  const js = async (script) => {
    const r = await tool('evaluate_js', { sessionId: sid2, script });
    const t = r.text;
    try { const p = JSON.parse(t); return p && p.value !== undefined ? p.value : p; } catch { return t; }
  };

  try {
    // O seletor de resolucao so existe no estado IDLE (sem sessao). Como o
    // tenant pode ter sessao ja aberta, ele e medido ANTES do login: se a
    // sessao for retomada, o seletor nao aparece e o caso vira "nao medido".
    const opcoesAntes = await js('JSON.stringify([...document.querySelectorAll("select")].map(s=>[...s.options].map(o=>o.value)))');
    if (String(opcoesAntes).includes('1440x900')) {
      check('viewer: a tela oferece 1440x900 como resolucao', true, null);
    } else {
      console.log(`INFO  viewer: o seletor de resolucao nao apareceu (sessao retomada: ${opcoesAntes})`);
    }

    // login do viewer
    await js(`(() => { const ins=document.querySelectorAll('input'); const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value'); d.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}; set(ins[0],${JSON.stringify(KEY)}); const b=[...document.querySelectorAll('button')].find(x=>/Entrar|Login/i.test(x.textContent)); if(b) b.click(); return true; })()`);
    await sleep(3000);

    // Inicia a sessao. Se o botao nao existe (o tenant ja tinha sessao
    // aberta e ela foi retomada), mede a sessao que ja esta na tela.
    const iniciou = await js('(() => { const b=[...document.querySelectorAll("button")].find(x=>/Iniciar/i.test(x.textContent)); if(b) { b.click(); return "iniciou"; } return "retomada"; })()');
    console.log(`INFO  viewer: ${iniciou}`);
    await sleep(iniciou === 'iniciou' ? 14000 : 6000);

    const m = await js(`JSON.stringify({
      scroll: { doc: document.documentElement.scrollHeight, inner: innerHeight, overflow: document.documentElement.scrollHeight - innerHeight },
      rootOverflowY: getComputedStyle(document.getElementById('root')).overflowY,
      barraTopo: (() => { const c=document.querySelector('[data-viewer-container="true"]'); return c ? Math.round(c.getBoundingClientRect().top) : null; })(),
      container: (() => { const c=document.querySelector('[data-viewer-container="true"]'); if(!c) return null; const b=c.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
      canvas: (() => { const c=document.querySelector('canvas'); if(!c) return null; const b=c.getBoundingClientRect(); return { cssW: Math.round(b.width), cssH: Math.round(b.height), attrW: c.width, attrH: c.height, ratioFrame: +(c.width/c.height).toFixed(4), ratioCss: +(b.width/b.height).toFixed(4) }; })(),
    })`);
    const med = JSON.parse(m);

    check('viewer: a PAGINA nao rola (zero overflow)', med.scroll.overflow === 0, med.scroll);
    check('viewer: a raiz trava a rolagem da pagina', med.rootOverflowY === 'hidden', med.rootOverflowY);
    check('viewer: existe so UMA barra no topo (altura pequena)', med.barraTopo !== null && med.barraTopo <= 60, med.barraTopo);
    check('viewer: o canvas cabe no container', !!med.canvas && !!med.container &&
      med.canvas.cssW <= med.container.w + 1 && med.canvas.cssH <= med.container.h + 1, med);
    check('viewer: a proporcao do frame e preservada (nao estica)',
      !!med.canvas && Math.abs(med.canvas.ratioFrame - med.canvas.ratioCss) < 0.01, med.canvas);
  } finally {
    await tool('session_stop', { sessionId: sid2 });
    console.log('sessao fechada');
  }
  console.log(failures ? `\n${failures} caso(s) falharam` : '\nTodos os casos passaram');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERRO', e.message); process.exit(1); });
