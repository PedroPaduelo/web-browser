# Task 035 — Pesquisa CDP Screenshot e Recording

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar diferenças entre Page.captureScreenshot e Page.startScreencast, gravação de sessão via CDP, e arquitetura híbrida live+recording.

## O que foi feito

- **captureScreenshot vs startScreencast**: snapshot pontual vs stream contínuo
- **Puppeteer Page.screencast() (v22+)**: API nova com opções avançadas
- **Gravação**: CDP puro, Puppeteer screencast, Canvas+MediaRecorder
- **Storage**: local disk, S3 (estrutura de pastas), streaming HLS/RTMP
- **Custo CPU/memória**: benchmarks práticos, tuning para 100+ sessões
- **Arquitetura híbrida**: WebSocket para live viewing + gravação para replay posterior

## Arquivos alterados

- `docs/research/18-cdp-screenshot-recording.md`
