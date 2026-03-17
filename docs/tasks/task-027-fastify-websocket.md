# Task 027 — Pesquisa Fastify WebSocket Plugin

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar o plugin `@fastify/websocket` para entender como migrar de Express+ws para Fastify, configuring streaming binário e avaliando performance comparativa.

## O que foi feito

- **Plugin oficial**: `@fastify/websocket` versão 5.x (v4 descontinuada), construído sobre `ws`.
- **Registro obrigatório**: deve ser registered antes das rotas WebSocket (`await server.register(fastifyWebSocket)`).
- **Sintaxe**: `server.get('/ws', { websocket: true }, (connection, request) => { ... })`.
- **Streaming binário**: `connection.send(Buffer)` funciona nativamente; `perMessageDeflate` configurável no server level.
- **Performance**: overhead mínimo (~1-2%) comparado a `ws` standalone; ganho porintegrar com Fastify lifecycle.
- **Migração**: substituir `ws.createServer` por plugin; rotas Express.app -> Fastify app; handler upgrade não necessário.
- **Vantagens Fastify**: tipagem nativa, schema validation, hooks, encapsulamento.

## Resultado

Fornece diretrizes para migrar o backend Serende de Express para Fastify mantendo funcionalidade WebSocket. Recomenda usar plugin oficial e desabilitar perMessageDeflate para streaming JPEG.

## Arquivos alterados

- `docs/research/23-fastify-websocket.md`
