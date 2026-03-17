# Task 005 — Pesquisa mediasoup SFU para Remote Browser

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar mediasoup como SFU para streaming de browser remoto, incluindo injeção de vídeo customizada e comparação com WebRTC direto.

## O que foi feito

- Arquitetura mediasoup: Worker → Router → Transport → Producer/Consumer
- Forwarding de pacotes RTP sem transcodificação (latência microsegundos)
- Mecanismo `createPlainTransport()` para fonte customizada (FFmpeg/GStreamer → RTP)
- Comparativo x11grab + mediasoup: latência 80-150ms em LAN
- CDP screencast + recodificação: 300-600ms (mais lento)
- Projetos de referência: Neko (Go+GStreamer+Pion), Selkies, vscreen
- Decisão: para 1 viewer, WebRTC direto (Neko) é mais simples; mediasoup vale para N viewers (scale sem multiplicar uplink)

## Resultado

Documentado que mediasoup é opção válida para scale futuro, mas não necessário no caso atual (1 viewer por sessão).

## Arquivos alterados

- `docs/research/05-mediasoup-sfu.md`
