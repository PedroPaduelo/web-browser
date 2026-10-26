#!/usr/bin/env bash
# Chamada JSON-RPC ao MCP do web-browser, com estado de sessao por tenant.
#
# Uso:
#   qa-call.sh <KEY> <method> [params-json]
#   qa-call.sh <KEY> tool <nome-da-tool> <args-json>
#
# O script guarda o mcp-session-id do tenant em /tmp/qa-sess-<tenantId>,
# reaproveitando a sessao nas chamadas seguintes.
# Imprime o JSON-RPC "result" (ou "error") em uma linha.
set -euo pipefail

KEY="${1:?falta a KEY}"; shift
METHOD="${1:?falta o method}"; shift
PARAMS="${1:-{}}"

MCP_URL="${MCP_URL:-http://127.0.0.1:4202/mcp}"
TENANT=$(printf %s "$KEY" | sha256sum | cut -c1-16)
SESS_FILE="/tmp/qa-sess-${TENANT}"

ACC='Accept: application/json, text/event-stream'

if [ "$METHOD" = "tool" ]; then
  TOOL_NAME="${1:?falta o nome da tool}"; shift
  TOOL_ARGS="${1:-{\}}"
  BODY=$(node -e "
    const [name, args] = process.argv.slice(1);
    console.log(JSON.stringify({ jsonrpc:'2.0', id: Date.now()%100000, method:'tools/call', params:{ name, arguments: JSON.parse(args) } }));
  " "$TOOL_NAME" "$TOOL_ARGS")
else
  BODY=$(node -e "
    const [m, p] = process.argv.slice(1);
    console.log(JSON.stringify({ jsonrpc:'2.0', id: Date.now()%100000, method: m, params: JSON.parse(p) }));
  " "$METHOD" "$PARAMS")
fi

# Sessao: usa a guardada se existir, senao faz initialize antes
if [ ! -s "$SESS_FILE" ]; then
  node -e "
    const [key, url, file] = process.argv.slice(1);
    const headers = { 'Content-Type':'application/json', 'Accept':'application/json, text/event-stream', 'X-API-Key': key };
    (async () => {
      const init = { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'qa-harness', version:'1' } } };
      let r = await fetch(url, { method:'POST', headers, body: JSON.stringify(init) });
      const sid = r.headers.get('mcp-session-id');
      if (!sid) { console.error('initialize nao devolveu mcp-session-id'); process.exit(2); }
      require('fs').writeFileSync(file, sid);
      const note = { jsonrpc:'2.0', method:'notifications/initialized' };
      await fetch(url, { method:'POST', headers: { ...headers, 'mcp-session-id': sid }, body: JSON.stringify(note) });
    })().catch(e => { console.error(e.message); process.exit(3); });
  " "$KEY" "$MCP_URL" "$SESS_FILE"
  sleep 0.4
fi

SID=$(cat "$SESS_FILE")

# Chamada real (com a sessao)
RAW=$(curl -s --max-time 120 -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' -H "$ACC" -H "X-API-Key: $KEY" -H "mcp-session-id: $SID" \
  -d "$BODY")

printf '%s' "$RAW" | node -e "
  let raw = '';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => {
    const lines = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    let obj = null;
    try { obj = lines.length ? JSON.parse(lines[lines.length-1]) : JSON.parse(raw); } catch (e) {}
    if (!obj) { console.log('SEM JSON:', raw.slice(0, 400)); process.exit(0); }
    // Para tools/call, desembrulha o content[0].text quando for JSON
    if (obj.result && obj.result.content && obj.result.content[0] && obj.result.content[0].text) {
      const txt = obj.result.content[0].text;
      try { console.log(JSON.stringify({ isError: !!obj.result.isError, data: JSON.parse(txt) })); process.exit(0); } catch (e) {}
      console.log(JSON.stringify({ isError: !!obj.result.isError, text: txt })); process.exit(0);
    }
    console.log(JSON.stringify(obj));
  });
"
