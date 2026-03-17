# Task 016 — Pesquisa browser-use AI Agent Framework

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar frameworks de AI agents para controle de browser (browser-use, stagehand, Playwright MCP).

## O que foi feito

- **browser-use** (Python): Playwright + LLM observe-decide-act,支持所有大模型, Cloud API $0.01/task
- **stagehand** (TypeScript): primitivas act()/extract()/observe(), Accessibility Tree, caching, self-healing v3
- **Playwright MCP**: Microsoft MCP server, snapshot mode (accessibility tree), <2s por ação mas frágil

## Comparativo

| Framework | Speed | Tokens | Resilience | Control | Language |
|-----------|-------|--------|------------|---------|----------|
| browser-use | 15-30s | Medium | High | Low | Python |
| stagehand | 5-10s | Low | High | High | TypeScript |
| Playwright MCP | <2s | High | Low | High | Any |

## Resultado

Serende-MCP já oferece ferramentas de baixo nível. Poderia evoluir para camada de alto nível inspirada no stagehand (caching, self-healing).

## Arquivos alterados

- `docs/research/16-browser-use-ai-agent.md`
