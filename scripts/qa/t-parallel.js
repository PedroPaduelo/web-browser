#!/usr/bin/env node
'use strict';
// Aceitação do sessionId explícito com o CLIENTE REAL (HTTP, sem LLM).
//
// Reproduz o pior caso do QA: vários clientes simultâneos, MESMA chave e
// MESMO mcp-session-id (é assim que o motor entrega as chamadas de subagentes
// do mesmo setup). Se o MCP deixar a sessão escapar, dá para ver na URL.

const URL_MCP = process.env.MCP_URL || 'http://127.0.0.1:4202/mcp';
const KEY = (process.env.KEY || require('fs').readFileSync(process.env.KEY_FILE || '/tmp/ef.key', 'utf8')).trim();

const ACC = 'application/json, text/event-stream';
let rpcId = 1;

async function rpc(body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: ACC,
    'X-API-Key': KEY,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(URL_MCP, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  const ct = res.headers.get('content-type') || '';
  let text = await res.text();
  if (ct.includes('text/event-stream')) {
    const lines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    text = lines.length ? lines[lines.length - 1] : text;
  }
  let obj = null;
  try { obj = JSON.parse(text); } catch {}
  return { sid, obj };
}

// Chamada de tool: devolve { isError, data|text, sessionIdEcoado }
async function tool(name, args, mcpSessionId) {
  const { obj } = await rpc({
    jsonrpc: '2.0', id: rpcId++, method: 'tools/call',
    params: { name, arguments: args },
  }, mcpSessionId);
  const r = obj && obj.result;
  const txt = (r && r.content && r.content[0] && r.content[0].text) || '';
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch { parsed = null; }
  const eco = parsed && typeof parsed === 'object' ? parsed.sessionId
    : (/\[session: ([0-9a-f-]+)\]/.exec(txt) || [])[1] || null;
  return { isError: !!(r && r.isError), raw: txt, parsed, eco, obj };
}

(async () => {
  // 1) initialize: pega o mcp-session-id que os 4 clientes vão compartilhar
  const init = await rpc({
    jsonrpc: '2.0', id: rpcId++, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  });
  const SHARED = init.sid;
  console.log(`initialize ok — mcp-session-id compartilhado: ${SHARED}`);
  if (!SHARED) { console.log('SEM mcp-session-id no header — abortando'); process.exit(2); }

  const N = Number(process.env.PROBES || 4);
  const OPS = Number(process.env.OPS || 12);

  // 2) 4 clientes em paralelo, MESMA chave e MESMO mcp-session-id
  const clients = Array.from({ length: N }, (_, i) => {
    const nome = `PROBE-${i + 1}`;
    let meuId = null;
    let ecosOk = 0, ecosDeOutro = 0, semEco = 0, erros = 0;
    const foreign = [];
    return (async () => {
      // session_start
      const st = await tool('session_start', { forceNew: true, resolution: '1280x720' }, SHARED);
      if (st.isError || !st.parsed || !st.parsed.sessionId) {
        return { nome, erro: 'session_start falhou: ' + st.raw.slice(0, 200) };
      }
      meuId = st.parsed.sessionId;
      if (st.parsed.status === 'already_active') {
        return { nome, erro: 'session_start devolveu already_active (sessão de outro agente): ' + st.raw.slice(0, 200) };
      }

      await tool('navigate', { url: `https://example.com/?probe=${nome}`, sessionId: meuId }, SHARED);

      for (let n = 1; n <= OPS; n++) {
        const ops = [
          ['get_url', { sessionId: meuId }],
          ['evaluate_js', { script: "document.title + '|' + location.search", sessionId: meuId }],
          ['navigate', { url: `https://example.com/?probe=${nome}-${n}`, sessionId: meuId }],
          ['evaluate_js', { script: 'location.search', sessionId: meuId }],
        ];
        for (const [nome2, args] of ops) {
          const r = await tool(nome2, args, SHARED);
          if (r.isError) { erros++; continue; }
          if (r.eco === meuId) ecosOk++;
          else if (r.eco) { ecosDeOutro++; foreign.push(r.eco); }
          else semEco++;
        }
      }

      const url = await tool('get_url', { sessionId: meuId }, SHARED);
      const search = await tool('evaluate_js', { script: 'location.search', sessionId: meuId }, SHARED);
      const urlTxt = (url.parsed && url.parsed.url) || url.raw;
      const srchTxt = (search.parsed && (search.parsed.result !== undefined ? search.parsed.result : search.parsed.value)) || search.raw;

      const stop = await tool('session_stop', { sessionId: meuId }, SHARED);
      return {
        nome, meuId, opsFeitas: OPS * 4, ecosOk, ecosDeOutro, semEco, erros,
        foreign: [...new Set(foreign)],
        urlFinal: String(urlTxt).slice(0, 160),
        searchFinal: String(srchTxt).slice(0, 160),
        fechou: !stop.isError,
        invasor: /probe=PROBE-(\d+)/i.exec(String(srchTxt)) && RegExp.$1 !== String(i + 1),
      };
    })();
  });

  const res = await Promise.all(clients);
  console.log('\n================ RESULTADO ================');
  let falhas = 0;
  res.forEach(r => {
    if (r.erro) { console.log(`  FAIL  ${r.nome}: ${r.erro}`); falhas++; return; }
    const contaminado = r.invasor || r.ecosDeOutro > 0;
    if (contaminado) falhas++;
    console.log(`  ${contaminado ? 'FAIL ' : 'PASS '} ${r.nome}  sessao=${String(r.meuId).slice(0, 8)}`);
    console.log(`        ops=${r.opsFeitas} eco-ok=${r.ecosOk} eco-de-outro=${r.ecosDeOutro} sem-eco=${r.semEco} erros=${r.erros}`);
    console.log(`        url   = ${r.urlFinal}`);
    console.log(`        search= ${r.searchFinal}`);
    if (r.foreign.length) console.log(`        SESSOES ESTRANGEAS VISTAS: ${r.foreign.join(', ')}`);
    if (!r.fechou) console.log('        (sessão não fechada)');
  });
  console.log(`\n================ ${res.length - falhas} PASS / ${falhas} FAIL ================`);
  process.exit(falhas ? 1 : 0);
})();
