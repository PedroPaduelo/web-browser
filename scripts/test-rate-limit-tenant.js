#!/usr/bin/env node
/**
 * Regressão do rate limit tenant-aware e do mascaramento de erro no MCP.
 *
 * Reproduz a falha original (429 → "No active session" → cascata) e prova
 * que ela não volta a acontecer. Uso: node scripts/test-rate-limit-tenant.js
 */
const path = require('path');

const API = process.env.SERENDE_API || 'http://127.0.0.1:4201';
const MCP = process.env.SERENDE_MCP || 'http://127.0.0.1:4202';
const keyStore = require(path.resolve(__dirname, '..', 'server', 'key-store'));

let falhas = 0;
function check(nome, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FALHA';
  if (!cond) falhas++;
  console.log(`${cond ? 'OK  ' : 'ERRO'} ${nome}${extra ? ` — ${extra}` : ''}`);
}

async function login(apiKey) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`login falhou: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// Dispara N requisições e devolve { status, limit } da última
async function burst(token, n, rota = '/api/health') {
  let last;
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${API}${rota}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    last = { status: res.status, limit: res.headers.get('ratelimit-limit') };
    if (res.status === 429) break;
  }
  return last;
}

async function mcpInit(apiKey) {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'regression-test', version: '1.0' },
      },
    }),
  });
  const sid = res.headers.get('mcp-session-id');
  await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-API-Key': apiKey,
      'mcp-session-id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

async function mcpCall(sid, apiKey, name, args = {}, id = 99) {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-API-Key': apiKey,
      'mcp-session-id': sid,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  const linhas = raw.split('\n').filter((l) => l.startsWith('data:'));
  let payload;
  try {
    payload = linhas.length ? JSON.parse(linhas[0].slice(5)) : JSON.parse(raw || '{}');
  } catch {
    payload = {};
  }
  const texto = payload?.result?.content?.[0]?.text ?? payload?.error?.message ?? raw;
  return { texto: String(texto || ''), bruto: raw };
}

(async () => {
  console.log('=== Regressão: rate limit tenant-aware + mascaramento de erro MCP ===\n');

  // --- Setup: dois tenants independentes -------------------------------
  const keyA = keyStore.createKey('regression-tenant-a', { maxSessions: 2 });
  const keyB = keyStore.createKey('regression-tenant-b', { maxSessions: 2 });
  const rawA = keyA.key;
  const rawB = keyB.key;
  const a = await login(rawA);
  const b = await login(rawB);
  console.log(`tenant A = ${a.tenantId}\ntenant B = ${b.tenantId}\n`);

  const sid = await mcpInit(rawA);

  // --- TESTE 1: o limite é o do tenant, não o do IP -------------------
  const comToken = await burst(a.token, 1);
  const semToken = await burst(null, 1);
  check(
    'trafego autenticado usa o balde do tenant',
    Number(comToken.limit) > Number(semToken.limit),
    `autenticado=${comToken.limit} anonimo=${semToken.limit}`
  );

  // --- TESTE 2: a sessao do MCP sobrevive a um 429 transitorio -------
  const start = await mcpCall(sid, rawA, 'session_start', { startUrl: 'https://example.com' }, 20);
  const sessionId = (start.texto.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
  check('sessao iniciada pelo MCP', Boolean(sessionId), sessionId || start.texto.slice(0, 120));

  // --- TESTE 3: um tenant nao bloqueia o outro ------------------------
  console.log('\nesgotando o balde do tenant A...');
  const esgotado = await burst(a.token, 700);
  check('tenant A chega a 429', esgotado.status === 429, `status=${esgotado.status} limit=${esgotado.limit}`);

  const bDepois = await burst(b.token, 5);
  check('tenant B NAO e afetado pelo esgotamento do A', bDepois.status === 200, `status B=${bDepois.status}`);

  // --- TESTE 4: 429 no MCP reporta rate limit, nao "no session" -------
  console.log('\nchamando o MCP com o balde do tenant A esgotado...');
  const chamada = await mcpCall(sid, rawA, 'session_status', {}, 21);
  const texto = chamada.texto;
  check('MCP reporta o rate limit real', /429|Too many requests/i.test(texto), texto.slice(0, 140).replace(/\n/g, ' '));
  check('MCP NAO mascara como "No active session"', !/No active session/i.test(texto));

  // --- TESTE 5: a sessao sobrevive ao rate limit ----------------------
  // O bug original apagava o cache da sessao no 429. Depois da janela a
  // sessao tem de continuar viva, com o MESMO id, sem novo session_start.
  console.log('\naguardando a janela do rate limit resetar (65s)...');
  await new Promise((r) => setTimeout(r, 65000));
  const depois = await mcpCall(sid, rawA, 'session_status', {}, 22);
  const textoDepois = depois.texto;
  const mesmoId = textoDepois.includes(sessionId);
  check(
    'sessao sobrevive ao rate limit (cache nao foi purgado)',
    mesmoId && !/No active session/i.test(textoDepois),
    textoDepois.slice(0, 140).replace(/\n/g, ' ')
  );

  // --- limpeza --------------------------------------------------------
  await mcpCall(sid, rawA, 'session_stop', {}, 23);
  keyStore.revokeKey(keyA.id);
  keyStore.revokeKey(keyB.id);

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} FALHA(S)`}`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => {
  console.error('erro no teste:', e);
  process.exit(1);
});
