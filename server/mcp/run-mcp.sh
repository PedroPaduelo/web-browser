#!/bin/bash
# Sobe o MCP do Serende na porta 4202, apontando para o backend na 4201.
# (O path anterior apontava para /workspace/temp-orquestrador/..., que não
# existe mais nesta sandbox, e as portas 3334/3336 nunca foram usadas aqui.)
set -euo pipefail
cd "$(dirname "$0")"
export MCP_PORT="${MCP_PORT:-4202}"
export SERENDE_API="${SERENDE_API:-http://localhost:4201}"
# Auth: o MCP NÃO carrega o .env do server e não tem fallback de ambiente no
# requireApiKey. A chave do cliente vem sempre no header X-API-Key (obrigatório,
# sem chave a rota /mcp devolve 401) e quem valida é o backend em :4201.
# Aqui o ambiente serve só para porte/URL — nunca para injetar chave.
exec node index.js
