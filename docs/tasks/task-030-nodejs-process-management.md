# Task 030 — Pesquisa Node.js Process Management

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar gerenciamento de processos Chrome/Chromium em Node.js: spawn, lifecycle, cleanup, signal handling, memory monitoring, auto-restart.

## O que foi feito

- **child_process methods**: `spawn` recomendado vs `exec` (buffer limit) vs `fork` (IPC para Node.js).
- **Chrome spawn flags**: `--headless=new`, `--no-sandbox`, `--disable-setuid-sandbox`, `--remote-debugging-port`, `--disable-dev-shm-usage`, `--disable-gpu`, `--disable-background-timer-throttling`.
- **Cleanup graceful**: wait for Chrome to exit after SIGTERM, timeout → SIGKILL; evitar zombie processes.
- **Memory monitoring**: `process.memoryUsage()`, RSS, heap, limitar por cgroups ou custom metrics.
- **Auto-restart**: detectar crash via `exit` event, reiniciar com backoff exponential.
- **Arquitetura Chrome Manager**: classe que encapsula spawn, health check, stop, restart, metrics.
- **Puppeteer pattern**: usa `spawn` com `detached: false`, pipe stdio, monitors stderr for errors.
- **Zombie prevention**: `child.on('exit', () => { if (code !== 0) log error })`, ensure no orphan processes.

## Resultado

Fornece padrão de produção para gerenciar processos Chrome no Serende, garantindo cleanup correto, monitoramento e recovery automático.

## Arquivos alterados

- `docs/research/25-nodejs-process-management.md`
