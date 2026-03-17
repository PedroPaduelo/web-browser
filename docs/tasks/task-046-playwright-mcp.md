# Task 046 — Pesquisa @playwright/mcp Integration

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar @playwright/mcp: tools expostas, conexão a Chrome remoto via CDP, benefícios para Serende.

## O que foi feito

- **@playwright/mcp**: 70+ tools organizados por capabilities (core, vision, pdf, testing, storage, network, tracing)
- **Conectar Chrome remoto**: CDP endpoint com CLI, JSON config, env vars
- **Local vs CDP Connect**: tabela comparativa com tradeoffs
- **Usa accessibility tree**: não screenshots → 4x menos tokens
- **Ref system**: IDs determinísticos para elementos (sem ambiguidade)
- **Capabilities flags**: ativa/desativa grupos de tools
- **Snapshot modes**: incremental/full/none
- **Benefícios para Serende**: standardization, accessibility-first, multi-session, observability
- **Código exemplo**: MCP server TypeScript com CDP gateway (150+ linhas)
- **Lições**: 14 recomendações priorizadas (Fases 1-3)

### Ação Principal
Adotar accessibility snapshots + ref system para:
- Funcionar com qualquer LLM (não apenas multimodais caros)
- Reduzir custo em 20-60x vs screenshots
- Tornar automações determinísticas

## Arquivos alterados

- `docs/research/03-playwright-mcp.md`
