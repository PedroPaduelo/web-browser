# Task 024 — Pesquisa noVNC e Protocolo RFB

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar o protocolo RFB (usado pelo VNC) e a implementação noVNC para entender técnicas de streaming de desktop remoto alternativas ao WebRTC/MJPEG.

## O que foi feito

- **Arquitetura noVNC**: Cliente HTML5 + websockify proxy + VNC server
- **Protocolo RFB**: Rectangle-based updates, handshake, encodings múltiplos
- **Encodings comparados**: Raw, CopyRect, Hextile, ZRLE (zlib+tiling+RLE), Tight (zlib+JPEG+heuristic), TightPNG
- **Latência real medida**: <10ms render, ~8.4 FPS interativo com 10ms RTT, ~1 frame/2s passivo
- **Problema fundamental**: poll-before-push (cliente pede updates) vs push contínuo
- **Input pipeline**: DOM events → keysym conversion → RFB KeyEvent/PointerEvent
- **Comparativo VNC vs MJPEG vs WebRTC**: VNC tem delta encoding (só retângulos alterados), MJPEG simples, WebRTC baixa latência mas complexo
- **SoluesRFB extensions**: Continuous Updates, Fence extension para reduzir polling

## Resultado

Fornece especificação completa para avaliar se VNC/noVNC é viável como alternativa ao MJPEG atual no Serende. VNC oferece melhor eficiência de banda (delta rectangles) mas sofre de latência dependente de polling (50-200ms típico).

## Arquivos alterados

- `docs/research/08-novnc-rfb.md`
