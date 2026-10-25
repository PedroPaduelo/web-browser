#!/usr/bin/env node
/**
 * run-tests.js — runner único da suíte de regressão do web-browser.
 *
 * Uso:  node scripts/run-tests.js   (ou: npm test, na raiz do repo)
 *
 * O que faz:
 *   1. DESCOBRE os testes varrendo `scripts/` e `frontend/` por arquivos
 *      `test-*.(js|mjs|cjs)` e `*.test.(js|mjs|cjs)` — sem lista hardcoded.
 *      (Arquivos de investigação pontual como `investigate-*` não são teste
 *      de regressão e ficam fora da varredura.)
 *   2. Para cada teste, VERIFICA os pré-requisitos antes de executar:
 *      - dependências de código (ex.: playwright/puppeteer): se o módulo que
 *        o script importa não resolve, marca SKIP (não executado) com motivo;
 *      - KEY: se o script lê `process.env.KEY`, o runner injeta a chave lida
 *        de `server/.env` (AUTH_API_KEY). O valor nunca é impresso nem vai
 *        para relatório/arquivo. Sem chave disponível: SKIP, não falha;
 *      - ambiente externo: script com URL de produção hardcoded e sem
 *        override por variável de ambiente é SKIP (não bate fora daqui);
 *      - serviço local: se o script fala com a API (:4201) ou o MCP (:4202),
 *        checa o health antes; fora do ar → SKIP com mensagem clara
 *        ("MCP não está no ar em :4202"), em vez de erro confuso.
 *   3. EXECUTA em sequência (nunca em paralelo: os testes dividem o backend
 *      e o balde de rate limit — paralelizar falsearia o resultado), com
 *      timeout generoso por script (default 10 min; `RUN_TESTS_TIMEOUT_MS`),
 *      mede a duração de cada um e continua nos demais quando um falha.
 *   4. REPORTA PASS/FAIL/SKIP por script com exit code e duração, mais um
 *      resumo final. Sai com exit 1 se QUALQUER teste falhou, 0 caso contrário
 *      (SKIP não falha a suíte).
 *
 * Contratos preservados:
 *   - `node scripts/test-x.js` continua funcionando sozinho, sem mudança.
 *   - cwd dos filhos é sempre a raiz do repo (test-wrapper-fix.js lê
 *     `server/session-manager.js` por caminho relativo).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { builtinModules } = require('module');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['scripts', 'frontend'];
const ENV_FILE = path.join(ROOT, 'server', '.env');
const TIMEOUT_MS = parseInt(process.env.RUN_TESTS_TIMEOUT_MS || '600000', 10);
const CHECK_MS = parseInt(process.env.RUN_TESTS_CHECK_MS || '8000', 10);
const TAIL_LINES = 30; // últimas linhas do output exibidas quando um teste falha

const SERVICES = {
  api: { label: 'API', port: ':4201', health: 'http://127.0.0.1:4201/api/health' },
  mcp: { label: 'MCP', port: ':4202', health: 'http://127.0.0.1:4202/health' },
};

// ---------------------------------------------------------------- descoberta

function discover() {
  const found = [];
  for (const dir of SEARCH_DIRS) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const f of fs.readdirSync(absDir).sort()) {
      const abs = path.join(absDir, f);
      if (!fs.statSync(abs).isFile()) continue;
      if (!/\.(js|mjs|cjs)$/.test(f)) continue;
      if (!/^test-|[-.]test\./.test(f)) continue;
      found.push({ rel: `${dir}/${f}`, abs, dir });
    }
  }
  return found;
}

// ------------------------------------------------------------------ análise

function analyzeSource(src) {
  const needsKey = /process\.env\.KEY\b/.test(src);
  const needsApi = /4201|SERENDE_API|['"`]\/api\//.test(src);
  const needsMcp = /4202|SERENDE_MCP|process\.env\.MCP\b|['"`]\/mcp/.test(src);
  const hasProdHost = /serende\.ddw1sl\.easypanel\.host/.test(src);
  const hasEnvOverride = /process\.env\.[A-Z_]+\s*\|\|/.test(src);

  const specifiers = new Set();
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(m[1]);
  for (const m of src.matchAll(/import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) specifiers.add(m[1]);

  return { needsKey, needsApi, needsMcp, hasProdHost, hasEnvOverride, specifiers };
}

function missingModule(test, specifiers) {
  const skipPrefixes = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  for (const spec of specifiers) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) {
      if (skipPrefixes.has(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
    }
    if (skipPrefixes.has(spec)) continue;
    try {
      require.resolve(spec, {
        paths: [test.dir === 'frontend' ? path.join(ROOT, 'frontend') : path.join(ROOT, 'scripts'), ROOT],
      });
    } catch {
      return spec;
    }
  }
  return null;
}

// ------------------------------------------------------------------- segredo

// Lê só a AUTH_API_KEY de server/.env. O valor nunca é impresso nem
// serializado: fica apenas na memória deste processo e no env dos filhos.
function loadKey() {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^AUTH_API_KEY\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const v = m[1].replace(/^["']|["']$/g, '');
    if (v) return v;
  }
  return null;
}

// Redige segredos do output repassado dos testes (chave sk_* e JWTs).
function redact(line) {
  return line
    .replace(/sk_[A-Za-z0-9_-]{8,}/g, 'sk_[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, '[jwt-redacted]');
}

// ----------------------------------------------------------------- serviços

async function checkService(svc) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CHECK_MS);
  try {
    const res = await fetch(svc.health, { signal: ctl.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ----------------------------------------------------------------- execução

function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s - m * 60).toFixed(1)}s`;
}

function runScript(test, envExtra) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [test.abs], {
      cwd: ROOT,
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = [];
    const bufs = { out: '', err: '' };
    const emitLine = (tag, line) => {
      const clean = redact(line);
      tail.push(clean);
      if (tail.length > 200) tail.shift();
      process.stdout.write(`    [${test.rel}] ${clean}\n`);
    };
    const onData = (tag) => (data) => {
      bufs[tag] += data.toString();
      let i;
      while ((i = bufs[tag].indexOf('\n')) >= 0) {
        emitLine(tag, bufs[tag].slice(0, i).replace(/\r$/, ''));
        bufs[tag] = bufs[tag].slice(i + 1);
      }
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* já morreu */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já morreu */ } }, 5000);
    }, TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, ms: Date.now() - started, error: String(err), tail, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      for (const tag of ['out', 'err']) {
        if (bufs[tag].length) emitLine(tag, bufs[tag]);
      }
      resolve({ code, signal, ms: Date.now() - started, tail, timedOut });
    });
  });
}

// --------------------------------------------------------------------- main

(async () => {
  console.log('=== Suíte de regressão do web-browser ===\n');

  const tests = discover();
  if (!tests.length) {
    console.log('Nenhum teste encontrado em scripts/ ou frontend/ — nada a fazer.');
    process.exitCode = 1;
    return;
  }
  console.log(`Descobertos ${tests.length} teste(s): ${tests.map((t) => t.rel).join(', ')}`);
  console.log(`Timeout por script: ${fmtDur(TIMEOUT_MS)} (RUN_TESTS_TIMEOUT_MS)\n`);

  const key = loadKey();
  console.log(key
    ? 'KEY: carregada de server/.env (valor oculto) — injetada nos testes que leem process.env.KEY'
    : 'KEY: NÃO encontrada em server/.env — testes que precisam dela serão marcados como não executados');
  console.log('');

  const results = [];
  let n = 0;
  for (const test of tests) {
    n += 1;
    console.log(`--- [${n}/${tests.length}] ${test.rel} ---`);
    const src = fs.readFileSync(test.abs, 'utf8');
    const info = analyzeSource(src);

    // Pré-checagem 1: dependências de código.
    const missing = missingModule(test, info.specifiers);
    if (missing) {
      console.log(`SKIP — dependência ausente: "${missing}" não está instalado; teste não executado\n`);
      results.push({ test, status: 'SKIP', detail: `dependência ausente: ${missing}` });
      continue;
    }

    // Pré-checagem 2: KEY.
    const envExtra = {};
    if (info.needsKey) {
      if (!key) {
        console.log('SKIP — KEY indisponível (não há AUTH_API_KEY em server/.env); teste não executado, não é falha\n');
        results.push({ test, status: 'SKIP', detail: 'KEY indisponível' });
        continue;
      }
      envExtra.KEY = key;
    }

    // Pré-checagem 3: ambiente externo hardcoded.
    if (info.hasProdHost && !info.hasEnvOverride) {
      console.log('SKIP — aponta para ambiente externo (URL de produção hardcoded, sem override por env); teste não executado\n');
      results.push({ test, status: 'SKIP', detail: 'ambiente externo hardcoded' });
      continue;
    }

    // Pré-checagem 4: serviços locais.
    let skipService = null;
    for (const k of ['api', 'mcp']) {
      if (!info[k === 'api' ? 'needsApi' : 'needsMcp']) continue;
      // eslint-disable-next-line no-await-in-loop
      if (!(await checkService(SERVICES[k]))) skipService = SERVICES[k];
    }
    if (skipService) {
      console.log(`SKIP — ${skipService.label} não está no ar em ${skipService.port}; teste não executado\n`);
      results.push({ test, status: 'SKIP', detail: `${skipService.label} fora do ar em ${skipService.port}` });
      continue;
    }

    // Executa (exit != 0 de um não impede os demais).
    // eslint-disable-next-line no-await-in-loop
    const r = await runScript(test, envExtra);
    if (r.timedOut) {
      console.log(`FAIL — timeout após ${fmtDur(TIMEOUT_MS)} (exit —, sinal ${r.signal || '—'})\n`);
      results.push({ test, status: 'FAIL', detail: `timeout após ${fmtDur(TIMEOUT_MS)}`, ms: r.ms, code: null });
    } else if (r.code === 0) {
      console.log(`PASS — exit 0 em ${fmtDur(r.ms)}\n`);
      results.push({ test, status: 'PASS', ms: r.ms, code: 0 });
    } else {
      console.log(`FAIL — exit ${r.code == null ? `— (sinal ${r.signal})` : r.code} em ${fmtDur(r.ms)}`);
      const tail = r.tail.slice(-TAIL_LINES);
      if (tail.length) {
        console.log('  últimas linhas:');
        for (const l of tail) console.log(`    ${l}`);
      }
      console.log('');
      results.push({ test, status: 'FAIL', ms: r.ms, code: r.code, error: r.error });
    }
  }

  const pass = results.filter((r) => r.status === 'PASS');
  const fail = results.filter((r) => r.status === 'FAIL');
  const skip = results.filter((r) => r.status === 'SKIP');

  console.log('========================================');
  console.log('RESUMO DA SUÍTE');
  console.log('========================================');
  for (const r of results) {
    if (r.status === 'PASS') console.log(`  PASS  ${r.test.rel} (exit ${r.code}, ${fmtDur(r.ms)})`);
    else if (r.status === 'FAIL') console.log(`  FAIL  ${r.test.rel} (exit ${r.code == null ? '—' : r.code}${r.ms != null ? `, ${fmtDur(r.ms)}` : ''})`);
    else console.log(`  SKIP  ${r.test.rel} (não executado: ${r.detail})`);
  }
  console.log(`\n${pass.length} PASS · ${fail.length} FAIL · ${skip.length} SKIP (${results.length} no total)`);
  if (fail.length) {
    console.log('SUÍTE FALHOU');
    process.exitCode = 1;
  } else {
    console.log('SUÍTE PASSOU');
  }
})().catch((e) => {
  console.error('erro no runner:', e);
  process.exitCode = 1;
});
