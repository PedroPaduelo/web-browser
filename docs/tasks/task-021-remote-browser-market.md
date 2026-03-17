# Task 021 — Pesquisa Remote Browser Market Analysis

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar o mercado de remote browser (produtos como nativebrowser, Anchor, Browserbase, Steel, etc.) para entender arquiteturas, tecnologias e benchmarks.

## O que foi feito

- Análise de 7 provedores (Anchor Browser, Browserbase, Steel.dev, Browserless, Hyperbrowser, Bright Data, Kernel)
- Tecnologias de streaming: CDP Screencast (padrão), WebRTC (nichos), noVNC/VNC (legado)
- MCP: todos os players relevantes têm servidor MCP
- Benchmarks: tabelas comparativas de latência, success rate, features
- Kernel: unikernel <325ms boot vs container 3-5s

## Resultado

Serende está alinhada com as melhores práticas do mercado (CDP + MCP). Diferencial: foco em simplicidade (MJPEG webSocket) vs complexidade WebRTC. Kernel é referência de performance extrema.

## Arquivos alterados

- `docs/research/07-remote-browser-market.md`
