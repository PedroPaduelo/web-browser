#!/usr/bin/env node
/**
 * Serende — watchdog (camada 2 de supervisão).
 *
 * POR QUE EXISTE
 * --------------
 * O guardião de memória do sandbox (memguard) mata o process group com maior
 * RSS: `process.kill(-pgid, 'SIGTERM')` e, 2s depois, SIGKILL. Até
 * 2026-10-20 o Chrome herdava o PGID do backend, então uma única sessão de
 * browser (2709MB medidos > limite de 2048MB) derrubava o backend INTEIRO.
 * O frontend (Vite) continuava vivo e o proxy /api devolvia HTTP 500.
 *
 * Camada 1 (já no código): o Chrome nasce com `detached: true`, então tem
 * PGID próprio e o guardião não alcança o backend.
 *
 * Esta é a camada 2: um supervisor EXTERNO que reexecuta o backend se ele
 * morrer por qualquer motivo — SIGTERM, SIGKILL (não capturável por
 * handler), OOM do cgroup, crash de código ou exit não-zero.
 *
 * O que ele faz
 * -------------
 *  - sobe o backend (`node server/index.js`) e o frontend (`npm run dev`);
 *  - se um processo morre, reinicia com backoff exponencial + jitter;
 *  - health check em /api/health: se o processo está de pé mas o health
 *    falha (travou no boot), reinicia;
 *  - para tudo de forma limpa em SIGINT/SIGTERM.
 *
 * Uso:
 *   node scripts/watchdog.js            # backend + frontend
 *   node scripts/watchdog.js --backend  # só o backend
 *   node scripts/watchdog.js --frontend # só o frontend
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const FRONTEND_DIR = path.join(ROOT, 'frontend');

const BACKEND_PORT = parseInt(process.env.SERENDE_PORT || '4201', 10);
const FRONTEND_PORT = parseInt(process.env.SERENDE_FRONTEND_PORT || '4204', 10);

const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 3000;
// Backoff do reinício: 1s, 2s, 4s, 8s... até 30s.
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
// Quantas falhas de health check seguidas caracterizam "travado" (mas vivo).
const HEALTH_FAIL_THRESHOLD = 3;

const only = process.argv.slice(2).filter((a) => a.startsWith('--'));
const wantBackend = only.length === 0 || only.includes('--backend');
const wantFrontend = only.length === 0 || only.includes('--frontend');

function log(scope, message) {
  console.log(`[watchdog:${scope}] ${new Date().toISOString()} ${message}`);
}

// --- Health check ---------------------------------------------------------

function checkHealth(port, path = '/api/health') {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        // Consome o corpo para liberar o socket.
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// --- Processo supervisionado ----------------------------------------------

class Supervised {
  constructor({ name, command, args, cwd, port, healthPath, env }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.port = port;
    this.healthPath = healthPath;
    this.env = env || {};
    this.child = null;
    this.restarts = 0;
    this.healthFails = 0;
    this.stopping = false;
    this.timer = null;
  }

  start() {
    if (this.stopping) return;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const pid = this.child.pid;
    log(this.name, `iniciado pid=${pid} (${this.command} ${this.args.join(' ')})`);

    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        log(this.name, `encerrado (parada do watchdog)`);
        return;
      }
      this.restarts += 1;
      const delay = Math.min(
        RESTART_MAX_MS,
        RESTART_BASE_MS * Math.pow(2, Math.min(this.restarts - 1, 5))
      );
      // Jitter: evita que todos os processos voltem no mesmo instante.
      const jitter = Math.floor(Math.random() * 500);
      log(
        this.name,
        `MORREU (code=${code} signal=${signal || '-'}) — reiniciando em ${delay + jitter}ms ` +
        `(restart #${this.restarts})`
      );
      this.timer = setTimeout(() => this.start(), delay + jitter);
    });

    this.child.on('error', (err) => {
      log(this.name, `erro ao spawn: ${err.message}`);
    });
  }

  async checkHealth() {
    if (!this.child) return false;
    const ok = await checkHealth(this.port, this.healthPath);
    if (ok) {
      if (this.healthFails > 0) {
        log(this.name, `health OK após ${this.healthFails} falha(s) — normalizado`);
      }
      this.healthFails = 0;
      return true;
    }
    this.healthFails += 1;
    log(this.name, `health FALHOU (${this.healthFails}/${HEALTH_FAIL_THRESHOLD}) em :${this.port}${this.healthPath}`);
    if (this.healthFails >= HEALTH_FAIL_THRESHOLD) {
      log(this.name, `processo travado (vivo mas sem health) — reiniciando`);
      this.healthFails = 0;
      this.killAndRestart();
    }
    return false;
  }

  killAndRestart() {
    const pid = this.child ? this.child.pid : null;
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    // O handler de 'exit' dispara e agenda o reinício com backoff.
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 3000);
    }
  }
}

// --- Montagem -------------------------------------------------------------

const supervised = [];

if (wantBackend) {
  supervised.push(new Supervised({
    name: 'backend',
    command: process.execPath,
    args: [path.join(SERVER_DIR, 'index.js')],
    cwd: SERVER_DIR,
    port: BACKEND_PORT,
    healthPath: '/api/health',
  }));
}

if (wantFrontend) {
  supervised.push(new Supervised({
    name: 'frontend',
    command: 'npm',
    args: ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(FRONTEND_PORT)],
    cwd: FRONTEND_DIR,
    port: FRONTEND_PORT,
    healthPath: '/',
  }));
}

for (const s of supervised) s.start();

const healthTimer = setInterval(() => {
  for (const s of supervised) {
    s.checkHealth().catch(() => {});
  }
}, HEALTH_INTERVAL_MS);

function shutdown() {
  log('watchdog', 'encerrando — parando filhos');
  clearInterval(healthTimer);
  for (const s of supervised) s.stop();
  setTimeout(() => process.exit(0), 3500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('watchdog', `supervisionando: ${supervised.map((s) => s.name).join(', ') || '(nada)'}`);
log('watchdog', `health a cada ${HEALTH_INTERVAL_MS}ms · backoff ${RESTART_BASE_MS}ms→${RESTART_MAX_MS}ms`);
