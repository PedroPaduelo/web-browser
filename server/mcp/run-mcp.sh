#!/bin/bash
cd /workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/server/mcp
export MCP_PORT=3334
export SERENDE_API=http://localhost:3336
export AUTH_API_KEY=serende-dev-key-2024
exec node index.js
