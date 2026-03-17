# Task 032 — Pesquisa noVNC e Guacamole

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar o protocolo noVNC (RFB) e a arquitetura do Apache Guacamole para entender soluções de streaming de desktop remoto.

## O que foi feito

### noVNC / Protocolo RFB
- **Arquitetura**: Cliente HTML5 + websockify proxy + VNC server
- **Protocolo RFB**: rectangle-based updates, handshake, múltiplos encodings (Raw, CopyRect, Hextile, ZRLE, Tight, TightPNG)
- **Latência real**: <10ms render, ~8.4 FPS interativo com 10ms RTT, ~1 frame/2s passivo
- **Problema fundamental**: poll-before-push (cliente pede updates)
- **Soluções**: Continuous Updates extension, Fence extension
- **Comparativo**: VNC delta encoding (bandwidth eficiente) vs MJPEG (simples) vs WebRTC (latência ideal)

### Apache Guacamole
- **Arquitetura**: guacd (C daemon) + WebSocket + protocolo próprio length-prefixed
- **Streaming**: retângulos PNG/JPEG/WebP com encoding adaptativo (lossless texto, lossy dinâmico)
- **Latência**: 100-500ms+, limitado por compressão CPU-bound
- **Escala**: suporta Kubernetes, multi-user sharing, connection balancing
- **Comparação vs MJPEG/WebRTC**: tabela detalhada com trade-offs
- **Recomendação para Serende**: WebRTC para stream principal + canal lossless para texto (accessibility tree ou canvas overlay)

## Arquivos alterados

- `docs/research/07-novnc-guacamole.md` (completo)
- `docs/research/15-guacamole-architecture.md` (completo)
