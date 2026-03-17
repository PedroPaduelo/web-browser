# Task 028 — Pesquisa Isolamento Multi-Tenant

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar estratégias de isolamento multi-tenant para remote browser, incluindo Docker-in-Docker vs user-data-dir, limites de recursos, cleanup e compliance.

## O que foi feito

- **Browserbase**: modelo serverless por sessão (cada sessão isolada completa), SOC-2/HIPAA compliant.
- **Browserless**: dois modos — container por sessão (isolamento total) e context-based (reuso de browser com contexts isolados). Trade-off: performance vs risk de contaminação.
- **Namespaces Linux**: PID, user, net, mnt, ipc, cgroup. Chrome já usa namespaces internamente para sandbox.
- **cgroups**: limitam CPU, memória, I/O, rede.
- **Docker-in-Docker**: complexo, heavy; alternativas com `unshare` para namespaces leves.
- **Profile persistence**: user-data-dir por tenant, merge no logout/timeout.
- **Zombie sessions**: cleanup imperativo (fechar contexts, matar processes, limpar dirs).
- **Limiares recursos**: maxSessions global, maxSessionDuration, maxIdleTimeout.
- **Security**: user-data-dir isolado por tenant, limpar após uso, evitar shared state.

## Resultado

Define arquitetura de isolamento para Serende: usar user-data-dir por tenant + session-specific profiles, combinado com timeouts e cleanup automático. Docker opcional para maior isolamento mas não obrigatório.

## Arquivos alterados

- `docs/research/24-multi-tenant-isolation.md`
