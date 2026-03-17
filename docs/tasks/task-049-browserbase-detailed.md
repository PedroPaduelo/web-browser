# Task 049 — Pesquisa Browserbase Architecture (Detalhada)

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar Browserbase, Steel.dev e browser-use.com em profundidade: streaming de vídeo, multi-tenancy, decisões arquiteturais.

## O que foi feito

### Browserbase
- Closed-source, enterprise-focused
- Usa CDP + Debugger URL (iframe) para live view (NÃO usa WebRTC)
- Stagehand v3 migrado para CDP nativo (+44% performance)
- Multi-region obrigatório (latência travel time domina)
- Contexts API para persistência
- MCP server oficial

### Steel.dev
- Open-source (6.5K stars), self-hostable
- Performance: 229ms control plane vs 1.6× slower Browserbase
- Success rate 70% vs 50% Browserbase
- Docker-based multi-tenancy built-in
- Vendor-neutral CDP

### Browser-use.com
- 81K GitHub stars, YC W24 ($17M seed)
- Custom LLMs treinados para browser automation
- CLI tools para debugging
- AgentMail (temporary accounts)

### Streaming de Vídeo
- CDP screencast nativo: simples mas bandwidth hungry
- Custom pipeline (FFmpeg/WebRTC): complexo mas <100ms
- Recomendação: CDP screencast otimizado default, WebRTC se latency crítica

### Lições para Serende
1. Open-source first + vendor-neutral CDP
2. Multi-tenancy by design
3. Session persistence como feature premium
4. MCP integration como diferencial

## Arquivos alterados

- `docs/research/02-browserbase-architecture.md`
