# Task 038 — Pesquisa Chrome Extensions em Remote Browser

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar como carregar extensões Chrome em automação remota, limitações no headless, isolamento por tenant, e segurança.

## O que foi feito

- **--load-extension**: sintaxe, exemplos Puppeteer/Selenium
- **Chrome 137+**: Flag --load-extension REMOVIDO de builds oficiais (ATENÇÃO!)
- **Headless**: Extensões NÃO funcionam no Chrome headless (usar GUI + XVFB ou Firefox)
- **Extensões úteis**: uBlock Origin (MV2 vs MV3), VPNs, Stealth, CAPTCHA solvers
- **Isolamento por tenant**: 5 estratégias (perfis separados, extension IDs únicos, browser contexts, containers Docker)
- **Segurança multi-tenant**: vetores de vazamento (storage, background page, content scripts, network), mitigações
- **CDP Extensions domain**: loadUnpacked, enable, disable, getViews
- **Manifest V3**: uBlock Origin MV2 não funciona mais no Chrome

## Arquivos alterados

- `docs/research/17-chrome-extensions.md`
