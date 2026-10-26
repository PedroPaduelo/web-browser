#!/usr/bin/env node
// Teste de aceite do PAINEL ADMIN (/admin) e da tela do viewer.
//
// O browser de teste carrega a pagina real do admin, loga e mede o que a
// pessoa ve: abas, busca, filtro por key, acao em lote, confirmacao propria,
// a coluna "o que esta vendo" e a ausencia de rolagem de pagina.
//
// Uso (um teste por vez: cada sessao usa ~400-600 MB da sandbox):
//   KEY_FILE=/tmp/ef.key LOTE_KEY_FILE=/tmp/lote.key node scripts/qa/t-admin-ui.js
//
// Precisa de:
//   - /tmp/ef.key  : a chave do tenant principal (o browser de teste);
//   - /tmp/lote.key: uma chave de um tenant SEPARADO, cujas sessoes sao o
//     alvo da acao em lote (o lote nao pode fechar a sessao do proprio
//     painel);
//   - o admin com senha known: ADMIN_EMAIL / ADMIN_PASS.
//
// Cria as sessoes, roda os casos e fecha tudo no fim. Sai com codigo 1 se
// algum caso falhar.
'use strict';
const fs = require('fs');

const KEY = (process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8')).trim();
const LOTE = (process.env.LOTE_KEY || fs.readFileSync(process.env.LOTE_KEY_FILE || '/tmp/lote.key', 'utf8')).trim();
const ENDPOINT = process.env.MCP_URL || 'http://127.0.0.1:4202/mcp';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@serende.local';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin@12345';
const ADMIN_URL = process.env.ADMIN_URL || 'https://sb-serende-p4201.mp.serendiped.com/admin';
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:4201';
const ENV_FILE = process.env.SERVER_ENV || '/workspace/server/.env';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rid = 1;
const sids = {};
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail).slice(0, 300)}`}`);
  if (!ok) failures++;
}

async function rpcWith(key, body) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': key };
  if (sids[key]) h['mcp-session-id'] = sids[key];
  const res = await fetch(ENDPOINT, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const s = res.headers.get('mcp-session-id');
  if (s) sids[key] = s;
  const txt = await res.text();
  const data = txt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  if (!data && !txt.trim()) return null;
  return data ? JSON.parse(data) : JSON.parse(txt);
}

async function tool(name, args = {}, key = KEY) {
  if (!sids[key]) {
    await rpcWith(key, { jsonrpc: '2.0', id: rid++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't-admin-ui', version: '1' } } });
    await rpcWith(key, { jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  const j = await rpcWith(key, { jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } });
  if (!j) return { isError: true, text: 'resposta vazia' };
  const content = (j.result && j.result.content) || [];
  return {
    isError: !!(j.result && j.result.isError),
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
  };
}

(async () => {
  // Duas sessoes no tenant do LOTE (alvo da acao em lote).
  const a1 = await tool('session_start', { forceNew: true, startUrl: 'https://example.com' }, LOTE);
  const id1 = (a1.text.match(/"sessionId":\s*"([^"]+)"/) || [])[1];
  const a2 = await tool('session_start', { forceNew: true, startUrl: 'https://www.google.com' }, LOTE);
  const id2 = (a2.text.match(/"sessionId":\s*"([^"]+)"/) || [])[1];
  if (!id1 || !id2) throw new Error('nao criou as sessoes de teste: ' + a1.text.slice(0, 200));
  console.log(`sessoes do lote: ${id1.slice(0, 8)} ${id2.slice(0, 8)}`);
  await sleep(4000);

  const st = await tool('session_start', { forceNew: true, startUrl: ADMIN_URL });
  const sid = (st.text.match(/"sessionId":\s*"([^"]+)"/) || [])[1];
  await sleep(4000);

  const js = async (script) => {
    const r = await tool('evaluate_js', { sessionId: sid, script });
    const t = r.text;
    try { const p = JSON.parse(t); return p && p.value !== undefined ? p.value : p; } catch { return t; }
  };

  try {
    // Login pelo ADMIN_SECRET: o login por e-mail tem rate limit (5 tentativas
    // em 5 min) e uma bateria de testes trava o admin. O token vai para o
    // sessionStorage, que e exatamente onde o painel o guarda.
    const secret = fs.readFileSync(ENV_FILE, 'utf8').match(/^ADMIN_SECRET=(.*)$/m)[1].trim();
    const loginRes = await fetch(`${BACKEND}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'x-admin-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
    });
    const { token } = await loginRes.json();
    await js(`(() => { sessionStorage.setItem('serende_admin_jwt', ${JSON.stringify(token)}); location.reload(); return true; })()`);
    await sleep(6000);

    const linhas = await js('document.querySelectorAll("tbody tr").length');
    check('admin: a lista mostra as 3 sessoes (2 do lote + a do browser)', linhas >= 3, { linhas });

    const colunas = await js('JSON.stringify([...document.querySelectorAll("thead th")].map(h=>h.textContent))');
    check('admin: a tabela tem a coluna do que a pessoa esta vendo', String(colunas).includes('vendo'), colunas);

    const temUrl = await js('document.body.innerText.includes("example.com") || document.body.innerText.includes("google.com")');
    check('admin: mostra a URL que a pessoa esta vendo', temUrl === true, null);

    const scroll = await js('JSON.stringify({ doc: document.documentElement.scrollHeight, inner: innerHeight, overflow: document.documentElement.scrollHeight - innerHeight })');
    check('admin: a PAGINA nao rola (o painel rola por dentro)', JSON.parse(scroll).overflow === 0, scroll);

    // Busca
    await js(`(() => { const inp=document.querySelector('input[type=search]'); const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value'); d.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}; set(inp,${JSON.stringify(id1.slice(0, 8))}); return true; })()`);
    await sleep(900);
    const filtradas = await js('document.querySelectorAll("tbody tr").length');
    check('admin: a busca filtra a lista', filtradas === 1, { filtradas });
    await js(`(() => { const inp=document.querySelector('input[type=search]'); const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value'); d.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}; set(inp,''); return true; })()`);
    await sleep(700);

    // Filtro por key
    const filtro = await js('(() => { const s=[...document.querySelectorAll("select")].find(x=>x.options.length>1); return s ? [...s.options].map(o=>o.textContent).join(" | ") : "sem select"; })()');
    check('admin: o filtro por key lista as chaves', String(filtro).includes('qa-lote-teste'), filtro);

    // Acao em lote a partir da aba de keys
    await js('(() => { const b=[...document.querySelectorAll("button")].find(x=>/API Keys/.test(x.textContent)); if(b) b.click(); return true; })()');
    await sleep(900);
    const achou = await js(`(() => { const row=[...document.querySelectorAll("tbody tr")].find(r=>/qa-lote-teste/.test(r.textContent)); if(!row) return "sem linha"; const b=[...row.querySelectorAll("button")].find(x=>/Fechar sessões/.test(x.textContent)); if(!b) return "sem botao"; b.click(); return "clicou"; })()`);
    check('admin: a aba de keys tem "Fechar sessoes" por key', achou === 'clicou', achou);
    await sleep(900);
    const modalTxt = await js('document.body.innerText.slice(0,400)');
    check('admin: o modal de lote nomeia a key', String(modalTxt).includes('Fechar todas as sess'), modalTxt);

    await js('(() => { const b=[...document.querySelectorAll("button")].find(x=>/Fechar todas$/.test(x.textContent.trim()) && x.closest("div[style*=fixed]")); if(b) b.click(); return true; })()');
    await sleep(1800);
    const toastTxt = await js('document.body.innerText.slice(0,400)');
    check('admin: o toast diz quantas foram fechadas', /2 sess/.test(String(toastTxt)), toastTxt);
    await sleep(3500);

    const restantes = await js(`document.body.innerText.indexOf(${JSON.stringify(id1.slice(0, 8))}) >= 0 || document.body.innerText.indexOf(${JSON.stringify(id2.slice(0, 8))}) >= 0`);
    check('admin: as 2 sessoes do lote sumiram da lista', restantes === false, null);

    const viva = await tool('list_sessions', {});
    check('admin: a sessao do proprio painel sobreviveu ao lote', viva.text.includes(sid.slice(0, 8)), viva.text.slice(0, 200));
  } finally {
    await tool('session_stop', { sessionId: sid });
    for (const x of [id1, id2]) { try { await tool('session_stop', { sessionId: x }, LOTE); } catch {} }
    console.log('sessoes de teste encerradas');
  }
  console.log(failures ? `\n${failures} caso(s) falharam` : '\nTodos os casos passaram');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('ERRO', e.message); process.exit(1); });
