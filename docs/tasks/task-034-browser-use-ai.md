# Task 034 — Pesquisa Browser-Use AI Agent Framework

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar o framework browser-use, sua arquitetura, e como ele implementa automação de navegador com IA.

## O que foi feito

### Browser-Use Framework
- **Biblioteca Python open-source**: 80k+ estrelas no GitHub
- **Migração Playwright → CDP**: Mudança aumentou performance 3-5x, reduziu latência, melhorou suporte a cross-origin iframes
- **Ações do Agent**: navegação, click, input, scroll, screenshot, sistema extensível de tools customizadas
- **LLM Integration**: Suporte a ChatBrowserUse (otimizado), Claude, GPT-4, Gemini, Ollama via function-calling
- **Visão da Página**: Accessibility tree (padrão), screenshots com anotações, multimodal completa

### Arquitetura do Serende como Backend
- **Session manager**: gerenciamento de sessões CDP
- **Browser pool**: pool de processos Chrome reutilizáveis
- **CDP proxy**: gateway para múltiplas sessões
- **Proxy rotation**: rotação de proxies por sessão

### Integração MCP
- Implementação de MCP server para conectar ao Claude Code/Cursor via JSON-RPC padrão
- Tools expostas: navigate, click, input, scroll, screenshot, execute_script

### Lições de Arquitetura (10 padrões críticos)
1. CDP nativo (sem Playwright)
2. Event-driven subscriptions (não polling)
3. Snapshot com accessibility tree + refs determinísticos
4. Security sandbox (whitelist domínios, limites de ações)
5. Session pooling + fingerprinting para cloud
6. Multi-tenant isolation por container
7. Observabilidade (metrics/logs/tracing)
8. Graceful shutdown e cleanup
9. Rate limiting e quotas
10. Versionamento de API

### Recomendações para Serende
- Adotar accessibility snapshots + ref system (reduz custo 20-60x vs screenshots)
- Manter diferencial: multi-tenant + streaming viewer
- Implementar MCP server para integração universal

## Arquivos alterados

- `docs/research/14-browser-use-ai.md`
