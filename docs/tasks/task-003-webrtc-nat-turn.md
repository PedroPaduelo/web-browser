# Task 003 — Pesquisa WebRTC NAT/TURN

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar solucoes de WebRTC NAT/TURN para entender por que o WebRTC falha em ambiente Docker/NAT e quais opcoes estao disponiveis para resolver.

## O que foi feito

- Analise de NAT em Docker (camada dupla)
- Documentacao de 4 tipos de NAT (Full Cone, Restricted Cone, Port Restricted Cone, Symmetric)
- Comparativo de solucoes TURN (coturn, Open Relay Project, Metered.ca, Xirsys)
- Codigo para configurar ICE servers com @roamhq/wrtc
- Latencia real estimada (+100 a +300ms round-trip)
- Plano de implementacao em 2 fases

## Arquivos alterados

- `docs/research/04-webrtc-nat-turn.md` — documento de pesquisa completo (21KB)
