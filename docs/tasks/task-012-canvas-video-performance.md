# Task 012 — Pesquisa Canvas vs Video Element Performance

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Comparar performance de Canvas (para MJPEG) vs Video Element (para WebRTC streaming) no contexto de remote browser.

## O que foi feito

- Latência: Canvas drawImage(ImageBitmap) ~20ms/frame vs Video Element +1-2 frames (~20-21fpslimit)
- requestAnimationFrame: orçamento 16ms (60Hz), desincronizado do clock de vídeo
- desynchronized canvas context: bypass compositor, menor latência
- OffscreenCanvas + Worker: 4x mais rápido (0.20ms vs 0.80ms)
- Jitter buffer tuning: 30-40ms vs padrão 80ms
- Referências: Stadia, GeForce NOW (targets ≤20ms)
- Recomendações por cenário: A) video simples, B) overlay, C) ML/filters

## Resultado

Valida a escolha atual do Canvas para MJPEG. Identifica otimizações possíveis (desynchronized, OffscreenCanvas).

## Arquivos alterados

- `docs/research/23-canvas-video-performance.md`
