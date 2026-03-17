# Task 026 — Pesquisa Canvas Video Performance

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar técnicas de renderização de vídeo no browser, comparando `canvas.drawImage(ImageBitmap)` vs `video.srcObject(MediaStream)`, e investigar o impacto de `requestAnimationFrame` na latência.

## O que foi feito

- **drawImage(ImageBitmap)**: latência ~20ms ou menos, decodificação fora da thread principal, 60% mais rápido que métodos alternativos (50ms → 20ms).
- **video.srcObject/MediaStream**: pipeline adds 1-2+ frames de latência, capado em ~20-21 fps em testes M1, overhead de captureStream e composição.
- **requestAnimationFrame**: sincroniza com ciclo de renderização, orçamento de ~16ms em 60Hz, frames acima de 50ms são Long Animation Frames (LoAF) indicando sobrecarga.
- **desynchronized canvas context**: técnica para reduzir latência (ignora v-sync).
- **Double buffering**: prev tearing mas adiciona um frame de delay.
- **OffscreenCanvas**: permite renderização em worker thread, não bloqueia thread principal.
- **WebGL/WebGPU decode**: aceleração por hardware para decodificação de vídeo.

## Resultado

Valida a abordagem atual do Serende (canvas + drawImage) como a opção de menor latência. Destaca importância de manter processamento por frame <16ms para 60fps. Recomenda OffscreenCanvas para não bloquear UI.

## Arquivos alterados

- `docs/research/23-canvas-video-performance.md`
