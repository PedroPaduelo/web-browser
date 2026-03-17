# Task 025 — Pesquisa MCP TypeScript SDK Usage

**Status**: ✅ Concluída
**Início**: 2026-03-17
**Fim**: 2026-03-17

## O que foi pedido

Pesquisar o SDK TypeScript do Model Context Protocol (@modelcontextprotocol/sdk) para entender como implementar servidores MCP com Streamable HTTP, retornar imagens base64, gerenciar sessões stateful e integrar com Claude Desktop/Code.

## O que foi feito

- **SDK v1.x vs v2**: v1.x estável, v2 pre-alpha. Imports diferentes entre versões.
- **Transportes disponíveis**: Streamable HTTP (recomendado para remoto), stdio (local), HTTP+SSE (depreciado).
- **StreamableHTTPServerTransport**: server stateless (novo transport por request) vs stateful (sessões com session ID header).
- **Implementação de referência**: McpServer com StreamableHTTPServerTransport, registro de tools com Zod schemas.
- **Retorno de imagens**: ImageContent com data base64 e mimeType (ex: image/jpeg).
- **Cliente MCP**: StreamableHTTPClientTransport para conectar ao server remoto.
- **Integração Claude Desktop/Code**: configurar mcpServers com url e headers no Claude Desktop settings.

## Resultado

Fornece guia completo para implementar/validar o servidor MCP do Serende usando Streamable HTTP, com suporte a sessões stateful e retorno de screenshots como ImageContent.

## Arquivos alterados

- `docs/research/22-mcp-sdk-usage.md`
