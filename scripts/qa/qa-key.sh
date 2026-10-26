#!/usr/bin/env bash
# Cria uma chave de API temporaria (tenant proprio) para um lote de QA.
# Uso: qa-key.sh <nome-do-lote>
# Imprime: KEY=<chave>  TENANT=<tenantId>  (o log do banco vai para stderr)
set -euo pipefail

NOME="${1:?informe o nome do lote}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

node -e "
const ks = require('$ROOT/server/key-store.js');
const k = ks.createKey(process.argv[1], { maxSessions: 5, maxSessionDuration: 3600, maxIdleTimeout: 900 });
console.log('KEY=' + k.key);
console.log('TENANT=' + k.id);
" "$NOME" 2>/dev/null | grep -E '^(KEY|TENANT)='
