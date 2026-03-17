# Task 015 — Pesquisa @roamhq/wrtc Node WebRTC

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar a biblioteca @roamhq/wrtc para implementação de WebRTC no backend Node.js.

## O que foi feito

- @roamhq/wrtc: fork ativo do node-webrtc, libwebrtc M98, suporte Node 20/22
- RTCVideoSource API: `nonstandard.RTCVideoSource()` → `onFrame({width, height, data: Uint8ClampedArray I420})`
- Conversão RGBA→I420 via libyuv (muito rápida)
- Controle manual de framerate, `isScreencast: true` para otimizações de tela
- Limitações: encoding VP8/VP9 software-only (CPU intensivo), memory leaks em versões antigas, ICE srflx candidates podem não aparecer, H.264 desabilitado nos prebuilt
- Comparação: node-webrtc (abandonado), werift (TypeScript puro, opera em RTP packets)

## Resultado

Biblioteca correta para implementação futura de WebRTC com TURN. Documentadas limitações e requisitos.

## Arquivos alterados

- `docs/research/13-roamhq-wrtc.md`
