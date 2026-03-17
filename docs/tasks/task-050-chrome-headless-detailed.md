# Task 050 — Pesquisa Chrome Headless New Mode (Detalhada)

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar diferenças Chrome headless old vs new, CDP screencast no headless, limitações rendering, headless vs Xvfb, performance.

## O que foi feito

- **Headless old vs new**: evolução Chrome 59 a 132, arquitetura, recursos
- **CDP screencast no headless**: funciona no `--headless=new`, parâmetros, ACK, ~30fps
- **Limitações rendering**: GPU/WebGL requer flags especiais, Canvas 2D OK, UI popups sem display, extensões parciais
- **Headless vs Xvfb**: tabela comparativa (RAM, CPU, rendering fidelity, extensões, WebGL, debugging, bot detection)
- **Performance**: headless 15% mais rápido que Xvfb em Release mode
- **Problemas CDP**: screencast limitado 30fps, frames só em mudanças, memory leaks sem ACK
- **Playwright e headless**: usa `--headless=new` automaticamente
- **Recomendação**: `--headless=new` + CDP screencast (não Xvfb) como default, com flags completas e troubleshooting

## Arquivos alterados

- `docs/research/08-chrome-headless.md`
