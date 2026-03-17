# Task 037 — Pesquisa Session Timeout e Resource Management

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar best practices de timeout, idle detection, graceful shutdown, memory leaks em sessões longas, heartbeat, e limites de recursos.

## O que foi feito

- **Timeout best practices**: 5-10 min idle, 15-30 min absolute para remote browser
- **Idle session detection**: event listeners, Idle Detection API, visibility change, server-side tracking
- **Chrome graceful shutdown**: SIGTERM handling, ordered page closure, metric saving
- **SIGTERM vs SIGKILL**: Chrome SALVA estado em SIGTERM; NÃO salva em SIGKILL
- **Memory leaks**: 5 causas raiz (request accumulation = 1GB+ em <1h), 5 mitigações (context recycling, resource blocking, auto-restart)
- **Heartbeat**: WebSocket ping/pong + HTTP long-polling fallback
- **Limites recomendados**: ~200-400MB headless por sessão, 2GB=3 sessões, 4GB=8, 8GB=15
- **Browserbase lifecycle**: auto-timeout, resource recycling, rate limiting

## Arquivos alterados

- `docs/research/20-session-management.md`
