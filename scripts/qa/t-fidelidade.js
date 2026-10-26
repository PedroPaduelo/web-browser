#!/usr/bin/env node
// Testes de fidelidade do MCP: cada tool tem que dizer a verdade sobre o que fez.
//
// Uso (um teste por vez: cada sessao usa ~400-600 MB da sandbox):
//   KEY_FILE=/tmp/ef.key MCP_URL=http://127.0.0.1:4202/mcp node scripts/qa/t-fidelidade.js
//
// Cria UMA sessao, roda os casos e fecha a sessao (mesmo se algo falhar).
// Sai com codigo 1 se algum caso falhar.
'use strict';
const fs = require('fs');

const KEY = (process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8')).trim();
const ENDPOINT = process.env.MCP_URL || 'http://127.0.0.1:4202/mcp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SID = null;   // mcp-session-id da conexao
let rid = 1;
let SESS = null;  // sessionId do browser deste teste
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

// Tool de automacao NA sessao do teste (sessionId em toda chamada, como o protocolo manda).
const T = (name, args = {}) => tool(name, { sessionId: SESS, ...args });

// Valor de uma expressao JS na pagina (evaluate_js devolve o valor em JSON).
async function js(expr) {
  const r = await T('evaluate_js', { script: expr });
  try { return JSON.parse(r.text); } catch { return r.text; }
}

function check(name, pass, detail = '') {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

async function main() {
  await rpc({ jsonrpc: '2.0', id: rid++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fidelidade', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const st = await tool('session_start', { forceNew: true, startUrl: 'https://example.com' });
  const m = st.text.match(/"sessionId":\s*"([^"]+)"/);
  if (!m) throw new Error('session_start sem sessionId: ' + st.text.slice(0, 200));
  SESS = m[1];
  console.log(`sessao de teste: ${SESS.slice(0, 8)}`);
  await sleep(2500);

  try {
    // 1) screenshot: a imagem chega no cliente
    const shot = await T('screenshot');
    check('screenshot traz bloco image JPEG', !!(shot.image && shot.image.mimeType === 'image/jpeg'),
      shot.image ? `${shot.image.data.length} chars base64` : 'so texto');

    // 1b) clipboard sem nenhum clique: sem foco de janela, erro honesto e rápido
    const tCw0 = Date.now();
    const cwNoFocus = await T('clipboard_write', { text: 'QA-SEM-FOCO' });
    check('clipboard_write sem foco: isError honesto (ou copia real)', cwNoFocus.isError || /Copied/.test(cwNoFocus.text), `${Date.now() - tCw0} ms -- ${cwNoFocus.text.slice(0, 100)}`);

    // 2) type_text sem campo editavel: tem que falhar, nao dizer "Typed"
    await js(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    const tNo = await T('type_text', { text: 'QA-SEM-CAMPO' });
    check('type_text sem campo editavel -> isError', tNo.isError, tNo.text.slice(0, 110));

    // 3) click_and_type clicando fora de qualquer campo: tem que falhar
    const cNo = await T('click_and_type', { x: 60, y: 60, text: 'QA-CLIQUE-FORA' });
    check('click_and_type fora de campo -> isError', cNo.isError, cNo.text.slice(0, 110));

    // Campo real de controle
    await js(`(() => {
      document.body.innerHTML = '<input id="qa-in" type="text" style="position:fixed;top:20px;left:20px;width:400px;height:32px;font-size:16px">';
      document.getElementById('qa-in').focus();
      return true;
    })()`);

    // 4) type_text com texto longo (colagem) num campo real
    const tLong = await T('type_text', { text: 'QA-PASTE-123' });
    await sleep(400);
    const v1 = await js(`document.getElementById('qa-in').value`);
    check('type_text longo em campo real -> valor entra', v1 === 'QA-PASTE-123' && !tLong.isError,
      `valor=${JSON.stringify(v1)} resposta=${tLong.isError ? 'isError' : 'ok'}`);

    // 5) type_text curto (teclas) num campo real
    await js(`(() => { const el = document.getElementById('qa-in'); el.value = ''; el.focus(); return true; })()`);
    const tKeys = await T('type_text', { text: 'ab' });
    await sleep(400);
    const v2 = await js(`document.getElementById('qa-in').value`);
    check('type_text curto (teclas) em campo real -> valor entra', v2 === 'ab',
      `valor=${JSON.stringify(v2)} resposta=${tKeys.isError ? 'isError' : 'ok'}`);

    // 6) click_and_type no campo real
    const cYes = await T('click_and_type', { x: 200, y: 36, text: 'QA-CT-9', clearFirst: true });
    await sleep(400);
    const v3 = await js(`document.getElementById('qa-in').value`);
    check('click_and_type no campo real -> valor entra', v3 === 'QA-CT-9',
      `valor=${JSON.stringify(v3)} resposta=${cYes.isError ? 'isError' : 'ok'}`);

    // 7) clipboard sem foco de janela: erro honesto e a sessao segue viva
    await js(`(() => { document.body.innerHTML = ''; return true; })()`);
    const cw = await T('clipboard_write', { text: 'QA-CLIP' });
    check('clipboard_write: erro honesto ou copia de verdade', cw.isError || /Copied/.test(cw.text), cw.text.slice(0, 110));
    const alive = await js('1+1');
    check('sessao segue viva depois do clipboard', alive === 2, `evaluate devolveu ${JSON.stringify(alive)}`);

    // 8) rede: uma entrada por requisicao, com status e requestId
    await T('get_network_activity', { action: 'start' });
    await js(`(async () => { await fetch('/qa-get-404').catch(() => {}); await fetch('/qa-post-405', { method: 'POST', body: 'x' }).catch(() => {}); return true; })()`);
    await sleep(2000);
    const net = await T('get_network_activity', { action: 'get', filterUrl: 'qa-' });
    const entries = JSON.parse(net.text).entries || [];
    check('rede: uma entrada por requisicao (sem duplicata)', entries.length === 2, `entradas=${entries.length}`);
    check('rede: entrada traz status e requestId', entries.length > 0 && entries.every((e) => e.status && e.requestId),
      JSON.stringify(entries[0] || {}).slice(0, 160));

    // 9) drag: controle de clique e alvo de arraste (contadores na pagina)
    await js(`(() => {
      window.__ev = {};
      ['mousedown', 'mousemove', 'mouseup'].forEach((t) => window.addEventListener(t, () => { window.__ev[t] = (window.__ev[t] || 0) + 1; }, true));
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:100px;top:100px;width:200px;height:200px;background:#eee;user-select:none';
      document.body.appendChild(d);
      return true;
    })()`);
    await T('mouse_click', { x: 150, y: 150 });
    await sleep(300);
    const clickEv = await js('window.__ev');
    await js('window.__ev = {}');
    await T('drag', { fromX: 150, fromY: 150, toX: 350, toY: 260, steps: 20 });
    await sleep(400);
    const dragEv = await js('window.__ev');
    check('controle: clique gera mouseup', (clickEv.mouseup || 0) >= 1, JSON.stringify(clickEv));
    check('drag entrega mouseup ao alvo', (dragEv.mouseup || 0) >= 1, JSON.stringify(dragEv));
    // INFO (não conta como falha): arrasto de elemento draggable (HTML5)
    await js(`(() => { window.__ev = {}; const d = document.createElement('div'); d.draggable = true; d.style.cssText = 'position:fixed;left:400px;top:400px;width:120px;height:120px;background:#ddd'; document.body.appendChild(d); return true; })()`);
    await T('drag', { fromX: 460, fromY: 460, toX: 600, toY: 520, steps: 20 });
    await sleep(400);
    console.log(`INFO  drag sobre elemento draggable (HTML5): ${JSON.stringify(await js('window.__ev'))}`);

    // 10) list_sessions logo apos session_stop
    await tool('session_stop', { sessionId: SESS });
    const ls = JSON.parse((await tool('list_sessions')).text);
    const still = (ls.sessions || []).find((s) => s.sessionId === SESS);
    check('list_sessions logo apos session_stop nao mostra a sessao', !still, still ? `ainda aparece como ${still.status}` : '');
    SESS = null;
  } finally {
    if (SESS) { try { await tool('session_stop', { sessionId: SESS }); } catch {} }
  }
  console.log(`\n${failures === 0 ? 'TODOS PASSARAM' : failures + ' FALHA(S)'}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('ERRO', e.message); process.exit(2); });
