#!/bin/bash
# Sobe o MCP do Serende na porta 4202, apontando para o backend na 4201.
# (O path anterior apontava para /workspace/temp-orquestrador/..., que não
# existe mais nesta sandbox, e as portas 3334/3336 nunca foram usadas aqui.)
set -euo pipefail
cd "$(dirname "$0")"
export MCP_PORT="${MCP_PORT:-4202}"
export SERENDE_API="${SERENDE_API:-http://localhost:4201}"
# AUTH_API_KEY vem do ambiente (ou do .env do server), nunca com default aqui.
exec node index.js
