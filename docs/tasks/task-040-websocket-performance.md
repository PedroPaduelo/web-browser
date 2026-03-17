# Task 040 — Pesquisa WebSocket Binary Frame Performance

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar performance de WebSocket para streaming binário JPEG em Node.js: binary frames, backpressure, cork/uncork, benchmarks, escala.

## O que foi feito

- **Binary frames**: 2-3x mais rápidos que texto (base64)
- **ws lib**: throughput 100 MB/s com bufferutil instalado
- **Backpressure**: 3 estratégias (Buffer Limit + Frame Skip, Adaptive Frame Rate, Online Frame Skipping)
- **Cork/Uncork**: +25% throughput, 90% menos overhead de pacotes TCP
- **Benchmarks reais**: Oat++ 5M conexões (58 MB/s), Hashrocket comparativo multi-engine
- **ws vs uWebSockets.js**: uWS 2.2x mais rápido, 3x menos CPU — migrar com 500+ conexões
- **noVNC optimizations**: tight vs JPEG encoding, qualidade ideal
- **Fragmentação**: tamanho ideal 16KB, evitar latência alta e perda catastrófica
- **10+ sessões**: cluster architecture, kernel tuning, buffer pooling, scaling horizontal
- **Limites**: ~1GB/s por worker (1000 conexões × 15 FPS × 50KB)

## Arquivos alterados

- `docs/research/13-websocket-performance.md`
