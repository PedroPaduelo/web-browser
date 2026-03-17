# Task 013 — Pesquisa RustDesk Architecture

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar arquitetura do RustDesk (open source remote desktop) para entender protocolos e técnicas de streaming.

## O que foi feito

- Protocolo custom: TCP/KCP/WebSocket + Protocol Buffers + criptografia E2E
- Servidores hbbs (rendezvous) + hbbr (relay)
- NAT traversal via hole punching, fallback para relay em symmetric NAT
- Web client: WebCodecs API (hardware decode VP8/9/H264) ou Broadway.js fallback
- Latência real: 30-120ms LAN P2P, 1500ms+ com tráfego concorrente
- RustDesk vs noVNC: codec de vídeo real vs dirty rectangles
- Lição: multicast de codec + WebCodecs é viável, mas WebRTC oferece better congestion control

## Resultado

Confirmado que WebRTC é a escolha correta para Serende (melhor que WebSocket puro ou protocolo custom). RustDesk serve como referência de baixa latência.

## Arquivos alterados

- `docs/research/19-rustdesk-architecture.md`
