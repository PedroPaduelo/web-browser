# Task 047 — Pesquisa MJPEG WebSocket Streaming Optimization

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar como MJPEG over WebSocket funciona, latência end-to-end, renderização eficiente, backpressure, comparação com alternativas.

## O que foi feito

- **Pipeline**: captura 1-5ms, encode 2-15ms, network 10-100ms, decode 1-5ms, render 1-2ms → total 15-127ms
- **Renderização canvas**: createImageBitmap (5-10ms, GPU accelerated), OffscreenCanvas + bitmaprenderer (mais rápido, worker thread)
- **Backpressure**: Buffer Limit + Frame Skip, Adaptive Frame Rate, Online Frame Skipping
- **Comparação**: MJPEG vs HLS vs WebRTC vs Canvas Streaming (tabela detalhada)
- **Otimizações servidor**: buffer management com memory pool, frame skip strategies, libjpeg-turbo
- **Otimizações cliente**: rAF integration, OffscreenCanvas + Web Worker, double buffering, frame drop detection
- **Projetos open source**: noVNC (WebSocket + VNC encodings), Apache Guacamole (command-based streaming)
- **Recomendação**: Stack híbrida WebRTC + MJPEG fallback

## Arquivos alterados

- `docs/research/04-mjpeg-streaming.md`
