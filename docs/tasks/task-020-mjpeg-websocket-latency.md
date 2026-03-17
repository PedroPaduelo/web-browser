# Task 020 — Pesquisa MJPEG WebSocket Latency Benchmarks

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar benchmarks de latência para MJPEG over WebSocket e técnicas de otimização.

## O que foi feito

- Latência real medida: WebSocket RTT <1ms LAN, ~87ms cloud; MJPEG E2E ~50ms a 30 FPS
- HTTP Multipart vs WebSocket: comparison table
- Otimizações: send only latest frame, backpressure client, skip redundant frames, desabilitar permessage-deflate, adaptive quality/framerate
- Codec comparison: JPEG (simples), WebP (10-20% melhor), H.264/VP9 (5x compressão mas latency 300-600ms)
- Implementação de referência: Node.js server + client com createImageBitmap
- Guia de medição de latência

## Resultado

Valida a abordagem atual do Serende (MJPEG WebSocket). Configuração ótima: quality 70-80, disable permessage-deflate (já feito), adaptive framerate.

## Arquivos alterados

- `docs/research/11-mjpeg-websocket-latency.md`
