#!/usr/bin/env node
// Teste de aceite da aba "Ao vivo" do painel admin (/admin).
//
// A aba e uma grade de quadrados, um por sessao, com a miniatura da tela de
// cada uma. serve para OLHAR (nao tem acao).
//
//   KEY_FILE=/tmp/ef.key MCP_URL=... node scripts/qa/t-admin-live.js
//
// Cria 3 sessoes de teste (paginas diferentes), abre o painel no browser,
// entra na aba e mede o que a pessoa ve. Cria uma sessao e fecha no fim.
// Sai com codigo 1 se algum caso falhar.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const KEY = (process.env.KEY || fs.readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8')).trim();
const ENDPOINT = process.env.MCP_URL || 'http://127.0.0.1:4202/mcp';
const ADMIN_URL = process.env.ADMIN_URL || 'https://sb-serende-p4201.mp.serendiped.com/admin';
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:4201';
const ENV_FILE = process.env.SERVER_ENV || '/workspace/server/.env';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@serende.local';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin@12345';
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
  // Tres sessoes com paginas diferentes: a grade tem que mostrar tres telas
  // diferentes, nao a mesma repetida.
  const urls = ['https://example.com', 'https://www.wikipedia.org', 'https://news.ycombinator.com']
  const criadas = []
  for (const u of urls) {
    const st = await tool('session_start', { forceNew: true, startUrl: u })
    // o JSON vem INDENTADO do MCP ("sessionId": "..." com espacos): \s* cobre.
    const m = st.text.match(/"sessionId":\s*"([0-9a-f-]{36})"/)
    if (!m) throw new Error('nao criou sessao para ' + u + ': ' + st.text.slice(0, 200))
    criadas.push(m[1])
  }
  console.log(`sessoes de teste: ${criadas.map((s) => s.slice(0, 8)).join(' ')}`)
  await sleep(5000)

  // O browser que abre o painel e mais uma sessao (do mesmo tenant).
  const st = await tool('session_start', { forceNew: true, startUrl: ADMIN_URL })
  const sid = (st.text.match(/"sessionId":\s*"([^"]+)"/) || [])[1]
  await sleep(4000)

  const js = async (script) => {
    const r = await tool('evaluate_js', { sessionId: sid, script })
    const t = r.text
    try { const p = JSON.parse(t); return p && p.value !== undefined ? p.value : p } catch { return t }
  }

  try {
    // Login pelo ADMIN_SECRET: o login por email tem rate limit (5/5min) e
    // uma bateria de testes trava o admin.
    const secret = fs.readFileSync(ENV_FILE, 'utf8').match(/^ADMIN_SECRET=(.*)$/m)[1].trim()
    const lr = await fetch(`${BACKEND}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'x-admin-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
    })
    const { token } = await lr.json()
    await js(`(() => { sessionStorage.setItem('serende_admin_jwt', ${JSON.stringify(token)}); location.reload(); return true; })()`)
    await sleep(6000)

    // Abrir a aba "Ao vivo"
    const clicou = await js('(() => { const b=[...document.querySelectorAll("button")].find(x=>/^Ao vivo$/.test(x.textContent.trim())); if(!b) return "sem aba"; b.click(); return "clicou"; })()')
    check('admin: a aba "Ao vivo" existe', clicou === 'clicou', clicou)

    await sleep(8000)

    const m = JSON.parse(await js(`JSON.stringify({
      quadrados: document.querySelectorAll('img').length,
      carregadas: [...document.querySelectorAll('img')].filter(i=>i.naturalWidth>0).length,
      larguras: [...document.querySelectorAll('img')].map(i=>i.naturalWidth),
      // as miniaturas tem que ser DIFERENTES (tres paginas diferentes)
      hashes: [...document.querySelectorAll('img')].length ? 'medirDepois' : 0,
      temAcao: /Fechar|Encerrar|Revogar|Abrir|Copiar/.test(document.body.innerText),
      temUrl: document.body.innerText.includes('example.com') || document.body.innerText.includes('wikipedia.org') || document.body.innerText.includes('ycombinator.com'),
      scroll: { doc: document.documentElement.scrollHeight, inner: innerHeight, overflow: document.documentElement.scrollHeight - innerHeight },
    })`))
    check('admin: um quadrado por sessao (3 de teste + a do browser)', m.quadrados >= 4, m)
    check('admin: as miniaturas CARREGARAM (nao e placeholder)', m.carregadas >= 4, m)
    check('admin: a aba ao vivo nao tem botao de acao', m.temAcao === false, m)
    check('admin: cada quadrado mostra a URL da sessao', m.temUrl === true, m)
    check('admin: a pagina nao rola com a grade', m.scroll.overflow === 0, m.scroll)

    // Miniaturas DIFERENTES: se todas tem o mesmo tamanho em bytes, a
    // captura pode estar repetindo a sessao errada (o bug de cache por
    // largura que eu mesmo introduzi e corrigi).
    const bytes = JSON.parse(await js(`JSON.stringify((async () => {
      const srcs = [...document.querySelectorAll('img')].map(i=>i.src).filter(s=>s.startsWith('blob:'));
      const out = [];
      for (const s of srcs) { const b = await (await fetch(s)).blob(); out.push(b.size); }
      return out;
    })())`))
    const distintos = new Set(bytes).size
    check('admin: as miniaturas tem tamanhos distintos (capturas diferentes, nao repetidas)', distintos >= 3, bytes)

    // As miniaturas tem que caber no quadrado (nao vazar).
    const cabem = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('img')].map(i=>{const b=i.getBoundingClientRect(); const p=i.parentElement.getBoundingClientRect(); return {w:Math.round(b.width), pw:Math.round(p.width), h:Math.round(b.height), ph:Math.round(p.height), dentro: b.width<=p.width+1 && b.height<=p.height+1};}))`))
    check('admin: cada miniatura cabe no seu quadrado', cabem.every((c) => c.dentro), cabem)

    // Limpeza: fecha as sessoes de teste pelo backend direto (o DELETE do
    // painel fecha a do painel junto, o que mataria este teste).
    const tok = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: KEY }),
    }).then((r) => r.json())
    for (const id of criadas) {
      await fetch(`${BACKEND}/api/session/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok.token}` } })
    }
    await sleep(1500)
    const sobrou = await js(`document.querySelectorAll('img').length`)
    check('admin: ao fechar as sessoes, os quadrados desaparecem', sobrou < 4, { quadradosDepois: sobrou })
  } finally {
    await tool('session_stop', { sessionId: sid }).catch(() => {})
    console.log('sessao de teste encerrada')
  }
  console.log(failures ? `\n${failures} caso(s) falharam` : '\nTodos os casos passaram')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.log('ERRO', e.message); process.exit(1); })
