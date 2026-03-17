# Task 045 — Pesquisa Chrome Profile Persistence (Detalhada)

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar como Chrome salva dados no user-data-dir, backup/restauração programática, multi-tenant, garantir salvamento antes de fechar, CDP para cookies/storage.

## O que foi feito

- **user-data-dir**: estrutura de diretórios, caminhos por OS, persistência automática (writes incrementais, flush, shutdown behavior)
- **Arquivos importantes**: Cookies (SQLite), Local Storage (LevelDB), IndexedDB, Session Files v86+, Preferences JSON
- **Backup programático**: backup completo, restauração, backup incremental/automático
- **Problemas comuns**: SingletonLock órfãos, corrupção Preferences, SQLite corrompido, disco cheio — cada um com solução
- **Multi-tenant**: user-data-dir separado (recomendado) vs BrowserContexts (não persiste)
- **Salvamento garantido**: Browser.close() via CDP (método oficial), trap SIGTERM/SIGINT, timeout com auto-close
- **CDP para cookies/storage**: Network.getCookies, DOMStorage, IndexedDB, CacheStorage com export/import completo
- **ChromeProfileManager**: classe Node.js completa (launch, close, backup, restore, health check, repair)

## Arquivos alterados

- `docs/research/05-chrome-profile-persistence.md`
