# Task 042 — Pesquisa CDP Input Events (Teclado e Mouse)

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar métodos de input via CDP: mouse events, keyboard events, touch events, scroll, coordenadas, latência.

## O que foi feito

- **Input.dispatchMouseEvent**: clickCount, modifiers bitfield, button types, buttons mask, coordenadas
- **Input.dispatchKeyEvent**: keyDown/keyUp/rawKeyDown/char, DOM code, virtual key codes, modifiers
- **Input.dispatchTouchEvent**: Touch points, IDs, multi-touch, gesture synthesis
- **Input.synthesizeScrollGesture**: Scroll via touch gesture com overscroll/bounce
- **Input.synthesizeTapGesture**: Tap simples e duplo
- **Input.synthesizePinchGesture**: Zoom in/out
- **Conversão coordenadas**: Page → viewport → DPR-aware
- **Problemas conhecidos**: Fake screenX/screenY (detectado por Cloudflare), protocol timeouts, race conditions
- **Playwright vs CDP**: Como Playwright injeta eventos nativos para contornar limitações CDP
- **Latência**: X11 5-20ms vs CDP 20-40ms (problema é detectability, não velocidade)

## Arquivos alterados

- `docs/research/12-cdp-input.md`
