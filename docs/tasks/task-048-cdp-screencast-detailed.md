# Task 048 — Pesquisa CDP Screencast (Detalhada)

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar Page.startScreencast em profundidade: latência, otimizações, alternativas, projetos de referência.

## O que foi feito

- **Latência típica**: 150-500ms (frame-to-display)
- **FPS máximo prático**: 10-15 FPS (não é streaming real)
- **CPU overhead**: 100-300% (páginas com animação)
- **Formato**: JPEG (recomendado) ou PNG
- **ACK Throttling**: Issue #11062 — ACKs imediatos causam CPU 250-400%. Batch de 10 ACKs a cada 50ms reduz para 120-200%
- **everyNthFrame**: NÃO é FPS target (issue #63, won't fix). Se página renderiza a 6 FPS, everyNthFrame:2 resulta em ~3 FPS
- **Browserless.io**: migrou de CDP screencast para MediaRecorder+canvas custom
- **FFmpeg x11grab**: latência 30-80ms vs 150-500ms do CDP, com hardware acceleration (VAAPI/NVENC)
- **Projetos referência**: Vercel agent-browser (CDP + Rust relay), Browserless, Chromedp, Playwright video API
- **Recomendações**: quality 60-70, ACK throttling, considerar FFmpeg para < 100ms

## Arquivos alterados

- `docs/research/01-cdp-screencast.md`
