# Task 022 — Pesquisa CDP Input.dispatch

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar comandos `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`, e eventos de touch via CDP para controle preciso do browser.

## O que foi feito

- Input domain completo: KeyEvent (tipos: keyDown/keyUp/rawKeyDown/char), MouseEvent, TouchEvent, insertText, imeSetComposition
- Virtual key codes, tabela de mapeamento, modificadores (Ctrl/Shift/Alt/Meta)
- Sequências de eventos para click (3 eventos), double-click, drag-and-drop
- CDP vs XTEST (xdotool): comparação 12 aspectos, XTestFakeKeyEvent vs XSendEvent
- Puppeteer/Playwright internals: USKeyboardLayout, bitmask de modificadores, fluxos de `keyboard.type()` e `mouse.click()`
- Implementação de referência: `CDPInputHandler` com tradução de coordenadas e state tracking

## Resultado

Fornece especificação completa para implementar/validar o `cdp-input-handler.js` do Serende.

## Arquivos alterados

- `docs/research/14-cdp-input-dispatch.md`
