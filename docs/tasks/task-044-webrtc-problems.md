# Task 044 — Pesquisa WebRTC NAT Traversal e Alternativas

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar por que WebRTC falha em containers/NAT, STUN vs TURN, @roamhq/wrtc em containers, mediasoup como alternativa, custo de TURN server.

## O que foi feito

- **WebRTC em containers/NAT**: IPs Docker privados (172.17.x.x), 2 níveis de NAT (provedor + Docker). STUN sozinho é insuficiente
- **STUN vs TURN**: STUN 75-85% dos casos, custo ~$0; TURN 15-25%, custo alto por relay. Symmetric NAT é o inimigo #1
- **@roamhq/wrtc**: srflx candidates não gerados (issue #293). Timeout de 1.5s insuficiente para STUN/TURN (deveria ser 5-10s)
- **mediasoup**: PlainTransport para injeção de vídeo customizada. NÃO resolve NAT traversal — ainda precisa TURN
- **Custo TURN**: Self-hosted (coturn) Hetzner €4.50/mês + 20TB; Open Relay (Metered.ca) 20GB/mês grátis
- **Consumo**: 1 sessão HD 720p = ~1.08 GB/hora via TURN relay
- **MJPEG vs WebRTC**: MJPEG ~500ms latência mas funciona sempre; WebRTC+TURN ~150-250ms mas complexo
- **Decisão framework**: fluxograma de perguntas, A/B testing com Open Relay gratuito por 30 dias

## Arquivos alterados

- `docs/research/09-webrtc-problems.md`
