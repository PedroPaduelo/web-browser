# Task 051 — Pesquisa Xvfb e Alternativas (Detalhada)

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar Xvfb architecture, overhead, alternativas, conflitos de display, gestão no projeto atual, melhorias.

## O que foi feito

- **Xvfb Architecture**: funcionamento interno, consumo RAM (12-73 MB/sessão), CPU (2-85%)
- **Alternativas**: Xvnc (+VNC, +15-25 MB), Xdummy (driver dummy Xorg), Weston headless (Wayland, 15-40 MB), DRM/KMS (GPU direta)
- **Headful vs Headless**: Chrome `--headless.new` 15% mais rápido, mas NÃO suporta extensões nem captura framebuffer. Xvfb + headful única opção para streaming WebRTC
- **Conflitos display**: Lock files `/tmp/.X*-lock`, race conditions, memory leak sem `-noreset`, CDP port mapping
- **Gestão atual**: algoritmo alocação linear :100-:199, MAX_SESSIONS=10, display→porta CDP, cooldown 2s
- **Melhorias propostas**: pre-allocation com pointer, health check zumbis, tenant-aware display pools, resource-aware scheduling
- **Limites práticos**: servidor 16 GB suporta ~4-8 sessões 1080p simultâneas

## Arquivos alterados

- `docs/research/10-xvfb-alternatives.md`
- `docs/research/12-xvfb-alternatives.md`
