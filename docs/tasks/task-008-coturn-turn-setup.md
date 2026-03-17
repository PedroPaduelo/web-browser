# Task 008 — Pesquisa coturn TURN Server Setup

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar configuracao de servidor TURN (coturn) para resolver falhas de WebRTC em ambientes Docker/NAT.

## O que foi feito

- STUN vs TURN: custos, comparativo detalhado
- Mecanismo ICE: candidatos host/srflx/relay
- Instalacao coturn (apt, Docker, docker-compose)
- Configuracao minima: `turnserver.conf` com `use-auth-secret` (credenciais efemeras HMAC-SHA1)
- Portas: 3478 (UDP/TCP), 5349 (TLS), relay range
- Uso com @roamhq/wrtc: iceServers, `iceTransportPolicy: 'relay'`
- Testes: Trickle ICE, turnutils_uclient, logs coturn
- Open Relay Project (metered.ca) como alternativa gratuita (20GB/mês)
- Custo de banda: calculos Hetzner vs AWS vs GCP
- Configuracao completa de producao com TLS + HMAC secret

## Resultado

Documentacao completa para implementar TURN quando necessario. Recomendacao: comecar com Open Relay (zero infra) e migrar para coturn proprio se volumes justificarem.

## Arquivos alterados

- `docs/research/17-coturn-turn-setup.md`
