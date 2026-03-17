# Task 014 — Pesquisa WebCodecs API

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar WebCodecs API como alternativa para decodificação de vídeo no browser (substituir WebRTC ou Canvas MJPEG).

## O que foi feito

- WebCodecs + WebSocket vs WebRTC: latência 20-30ms menor, infra mais simples (só WebSocket), cacheability
- Desvantagens: suporte browser limitado, implementação manual de congestion control, keyframe loss problem
- createImageBitmap vs WebCodecs: benchmarking (Canvas 2D slow, BitmapRenderer 4x mais rápido)
- Backpressure crítico: decoder.decodeQueueSize > 10-15 deve drop frames
- Exemplo real: Helix ML escolheu JPEG polling (100ms constante) vs H.264 WebSocket (30-45s latency em WiFi ruim)
- Codec strings recomendadas (VP8, VP9, H.264, AV1)
- Recomendação: simplicidade e confiabilidade > performance bruta

## Resultado

Valida a escolha atual de Canvas MJPEG para Serende. WebCodecs é overkill e introduz complexidade desnecessária.

## Arquivos alterados

- `docs/research/20-webcodecs-api.md`
