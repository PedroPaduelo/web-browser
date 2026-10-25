#!/usr/bin/env node
/**
 * E2E do fluxo real: MCP público (preview) → sessão → navegação → screenshot.
 * Reproduz o caminho que quebrou com 429. Uso:
 *   MCP=https://sb-serende-p4202.mp.serendiped.com KEY=<chave-do-cliente> \
 *   node scripts/test-e2e-mcp-publico.js
 */
const MCP = process.env.MCP || 'http://127.0.0.1:4202';
const KEY = process.env.KEY;
if (!KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node scripts/test-e2e-mcp-publico.js');
  process.exit(1);
}
const ALVO = process.env.ALVO || 'https://canaltech.com.br/inteligencia-artificial/';

let falhas = 0;
function check(nome, cond, extra = '') {
  if (!cond) falhas++;
  console.log(`${cond ? 'OK  ' : 'ERRO'} ${nome}${extra ? ` — ${extra}` : ''}`);
}

(async () => {
  console.log(`=== E2E MCP público ===\nMCP: ${MCP}\n`);

  const init = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-API-Key': KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-publico', version: '1.0' },
      },
    }),
  });
  const sid = init.headers.get('mcp-session-id');
  check('handshake initialize', init.ok && Boolean(sid), `status=${init.status} sid=${sid}`);
  await init.text();

  await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-API-Key': KEY,
      'mcp-session-id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  let id = 10;
  async function call(name, args = {}) {
    const r = await fetch(`${MCP}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-API-Key': KEY,
        'mcp-session-id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
    });
    const t = await r.text();
    const d = t.split('\n').filter((l) => l.startsWith('data:'))[0];
    let p = {};
    try {
      p = d ? JSON.parse(d.slice(5)) : JSON.parse(t || '{}');
    } catch { /* payload não-SSE */ }
    const texto = String(p?.result?.content?.[0]?.text ?? p?.error?.message ?? t);
    const temImagem = Array.isArray(p?.result?.content)
      && p.result.content.some((c) => c.type === 'image' && String(c.data || '').length > 500);
    return { texto, temImagem, erro: p?.result?.isError === true };
  }

  // Sequência de tool calls bem mais longa que o fluxo original — é ela que
  // estourava o balde de rate limit antes da correção.
  const start = await call('session_start', { startUrl: 'https://example.com' });
  const sessionId = (start.texto.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
  check('session_start', Boolean(sessionId) && !start.erro, sessionId || start.texto.slice(0, 120));

  const nav = await call('navigate', { url: ALVO });
  check('navigate', /Navigated/i.test(nav.texto), nav.texto.slice(0, 100));

  const title = await call('get_page_title');
  check('get_page_title', title.texto.length > 2 && !/Too many requests|429/i.test(title.texto), title.texto.slice(0, 100));

  const text = await call('get_page_text', { maxLength: 4000 });
  check('get_page_text', text.texto.length > 200, `${text.texto.length} chars`);

  const shot = await call('screenshot');
  check('screenshot', shot.temImagem, `imagem=${shot.temImagem} · ${shot.texto.slice(0, 80).replace(/\n/g, ' ')}`);

  // 20 tool calls seguidas: o ponto exato onde o bug antigo estourava o limite
  let sem429 = true;
  for (let i = 0; i < 20; i++) {
    const r = await call('get_page_title');
    if (/Too many requests|429|No active session/i.test(r.texto)) {
      sem429 = false;
      console.log(`   falhou na call ${i + 1}: ${r.texto.slice(0, 120)}`);
      break;
    }
  }
  check('20 tool calls seguidas sem 429 e sem "No active session"', sem429);

  const stop = await call('session_stop');
  check('session_stop', /stopped|encerrad|parad/i.test(stop.texto), stop.texto.slice(0, 80));

  console.log(`\n${falhas === 0 ? 'E2E PASSOU' : `${falhas} FALHA(S)`}`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => {
  console.error('erro no E2E:', e);
  process.exit(1);
});
