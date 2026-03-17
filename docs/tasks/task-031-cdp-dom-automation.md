# Task 031 — Pesquisa CDP DOM Automation

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar técnicas de automação de DOM via Chrome DevTools Protocol: Runtime.evaluate, Runtime.callFunctionOn, DOM traversal, network interception, cookie/storage management, e accessibility tree para AI agents.

## O que foi feito

- **CDP domains**: DOM, Runtime, Network, Accessibility, Page, CSS, etc. (~300+ comandos).
- **Runtime.evaluate**: executa JavaScript no contexto da página, retorna valor; `returnByValue` para objetos simples.
- **Runtime.callFunctionOn**: chama função em objeto específico (ex: elemento DOM), mais seguro que eval.
- **DOM traversal**: `DOM.describeNode`, `DOM.querySelector`, `DOM.querySelectorAll`, `DOM.getDocument`.
- **Network interception**: `Network.setRequestInterception`, `Network.requestIntercepted` para modificar/bloquear requests.
- **Cookie management**: `Network.getAllCookies`, `Network.setCookie`, `Network.deleteCookies`.
- **Storage**: `DOMStorage.getDOMStorageItems` para localStorage/sessionStorage.
- **Accessibility tree**: `Accessibility.getFullAXTree` retorna árvore acessível — útil para AI agents navegar sistematicamente.
- **Playwright/Puppeteer internals**: como usam CDP por baixo; exemplo de abstração `page.$()` sobre `DOM.querySelector`.
- **MCP tools ideais**: `dom_query(selector)`, `dom_click(handleId)`, `dom_type(handleId, text)`, `network_intercept(pattern)`, `cookies_get()`, `storage_get(key)`.

## Resultado

Fornece catálogo de operações DOM para expor via MCP tools no Serende, permitindo controle preciso do browser por IA.

## Arquivos alterados

- `docs/research/22-cdp-dom-automation.md`
