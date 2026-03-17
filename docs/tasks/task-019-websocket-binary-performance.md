# Task 019 — Pesquisa WebSocket Binary Framing Performance

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar otimizações de performance para WebSocket binary framing no contexto de streaming JPEG.

## O que foi feito

- Binary frames obrigatórios para JPEG (opcode 0x2, arraybuffer)
- Backpressure: bufferedAmount, writableNeedDrain, drain events, createWebSocketStream
- perMessageDeflate: DEVE ser desabilitado para JPEG (zero compressão + CPU waste)
- TCP (WebSocket) vs UDP (WebRTC): head-of-line blocking 100-200ms em 1% loss
- ws Node.js: bufferutil addon, Buffer not base64, monitoring metrics
- Frame dropping: 6 estratégias (buffer threshold, pull-based, motion estimation, adaptive quality/framerate)
- WebTransport (QUIC): 35% menor latência que WebSocket em benchmarks

## Resultado

Valida config atual do Serende (perMessageDeflate: false). Identificadas otimizações: frame dropping adaptativo e bufferutil addon.

## Arquivos alterados

- `docs/research/25-websocket-binary-performance.md`
