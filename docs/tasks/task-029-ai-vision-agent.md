# Task 029 — Pesquisa AI Vision Agents

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar arquiteturas de agents de IA que controlam navegadores via visão computacional (screenshots + LLM multimodal) e sua integração com MCP.

## O que foi feito

- **Vision Loop**: captura screenshot → envia para LLM multimodal (GPT-4V, Claude) → analisa → executa ação (click, type, scroll) → repete.
- **Frequência**: 1-5 FPS (trade-off latência vs custo API).
- **Latência acumulada**: screenshot 50-200ms + LLM API 500ms-3s → total >1s por ciclo.
- **Prompt engineering**: estrutura JSON com action, target description, coordinates, text (para type).
- **Precisão de coordenadas**: crítica; modelo retorna coordenadas de tela que mapeiam para elementos.
- **MCP integration**: tools como `screenshot`, `click`, `type`, `scroll` expostas via MCP para Claude/agent controlar.
- **Benchmarks projetos**: Microsoft AutoGen, BrowserUse, Stagehand — todos usam screenshot + LLM.
- **Limitações**: latência alta, custo API, imprecisão em dynamic UIs.
- **Alternativa**: CDP DOM access direto (mais rápido, menos latência) mas perde acesso a páginas sem estrutura acessível.

## Resultado

Definepath para integração de AI agents no Serende: expor tools MCP que combinam screenshot (ou CDP DOM) com LLM-driven action. Priorizar CDP para baixa latência, usar vision fallback para páginas complexas.

## Arquivos alterados

- `docs/research/24-ai-vision-agent.md`
