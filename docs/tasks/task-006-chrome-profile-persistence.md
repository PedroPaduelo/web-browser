# Task 006 — Pesquisa Chrome Profile Persistence

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar mecanismos de persistencia de profile do Chrome para manter login/sessao entre sessoes do browser remoto.

## O que foi feito

- Estrutura completa do user-data-dir (SQLite, LevelDB, JSON)
- Cookies: localizacao, esquema de criptografia (Linux headless usa senha "peanuts")
- localStorage (LevelDB), IndexedDB (LevelDB por origin), Service Workers
- Headless novo vs antigo (Chrome 128+ mudou padrao)
- Puppeteer e Playwright: persistentContext vs storageState
- 5 estrategias de backup/restore (tar completo, seletivo, rsync, cookies JSON, storageState)
- 8 melhores praticas (fechar Chrome antes backup, preservar Local State, etc)
- Armadilhas: SingletonLock, LevelDB nao copiavel com processo rodando, mudanca cookies Chrome 96

## Resultado

Valida a abordagem atual do Serende: copiar profile master para sessao, merge de volta ao parar. Recomendado fechar Chrome antes do merge (ja implementado).

## Arquivos alterados

- `docs/research/06-chrome-profile-persistence.md`
