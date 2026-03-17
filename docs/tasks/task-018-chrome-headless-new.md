# Task 018 — Pesquisa Chrome Headless New Mode

**Status**: ✅ Concluida
**Inicio**: 2026-03-14
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar Chrome headless new mode (`--headless=new`) para eventual migração do Xvfb.

## O que foi feito

- Old vs new headless: arquitetura unificada, performance, fingerprint
- Page.startScreencast: parametros, frame ACK, ~30fps limite
- Xvfb-free: funciona sem display server, `--screen-info` para configuracao virtual
- Remote debugging: `--remote-debugging-port`, conexao CDP
- Extensoes: suporte total no new headless, `--load-extension`
- WebGL/Canvas: SwiftShader removido Chrome 137+, flags necessarias
- Performance: PDF 10x mais lento, RAM/CPU +10-15%
- Setup completo: Dockerfile otimizado + codigo Node.js

## Resultado

Chrome headless new e alternativa viavel a Xvfb no futuro. Para Serende, Xvfb continua necessario porque headless nao expoe framebuffer para x11grab.

## Arquivos alterados

- `docs/research/21-chrome-headless-new.md`
