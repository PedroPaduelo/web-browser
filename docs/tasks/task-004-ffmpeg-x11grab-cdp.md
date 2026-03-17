# Task 004 — Pesquisa ffmpeg x11grab vs CDP

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Comparar performance de x11grab (ffmpeg) vs CDP Page.screencastFrame para streaming do browser.

## O que foi feito

- Benchmark detalhado: MIT-SHM ~1-2ms, conversao RGB-YUV +400-600ms
- Latencia total: 500-700ms padrao, ~150ms com MJPEG
- Comparativo x11grab vs CDP:
  - CDP: menor latencia bruta (~50-100ms) mas overhead no Chrome renderer (memory leak bug #40934921)
  - x11grab: captura tudo (popups, dialogs OS, cursor, extensoes), nao interfere no Chrome
  - Para remote browser, x11grab e melhor escolha
- Configuracao otima MJPEG: `-framerate 24 -q:v 8 -threads 2` para 720p (~150ms)
- Alternativas: kmsgrab (GPU), Direct XShmGetImage + libjpeg-turbo

## Resultado

**Confirmado:** O projeto ja usa x11grab + MJPEG via WebSocket. A pesquisa valida essa escolha.

## Arquivos alterados

- `docs/research/10-ffmpeg-x11grab-performance.md` — documento de pesquisa (379 linhas)
