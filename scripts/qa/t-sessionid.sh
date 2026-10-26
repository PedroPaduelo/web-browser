#!/usr/bin/env bash
# Aceitação do sessionId explícito (task 6b57b9c9).
# Reproduz o cenário que o QA reprovou: 2+ sessões do MESMO tenant e
# operações sem id explícito.
set -uo pipefail
MCP_URL="${MCP_URL:-http://127.0.0.1:4202/mcp}"
QA_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="${KEY:-$(cat "${KEY_FILE:-/tmp/ef.key}")}"
Q() { "$QA_DIR/qa-call.sh" "$KEY" tool "$1" "${2:-\{\}}"; }

pass=0; fail=0
# O qa-call desembrulha o content[0].text: a saida e {isError, data:{...}}.
sid_of() { printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log((r.data&&r.data.sessionId)||'')}catch(e){console.log('')}})"; }
chk() { # chk <nome> <esperado> <obtido>
  if [ -z "$2" ]; then echo "  FAIL  $1 (esperado vazio)"; fail=$((fail+1)); return; fi
  if printf '%s' "$3" | grep -q -- "$2"; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1"; echo "        esperado ~ $2"; echo "        obtido  : $(printf '%s' "$3" | head -c 400)"; fail=$((fail+1)); fi
}

echo "=== 1) limpeza: fecha sessoes do tenant ==="
Q list_sessions '{}' > /tmp/t_list.json 2>&1
for sid in $(node -e "try{const d=require('/tmp/t_list.json');console.log(((d.data||{}).sessions||[]).map(s=>s.sessionId).join(' '))}catch(e){}" 2>/dev/null); do
  Q session_stop "{\"sessionId\":\"$sid\"}" >/dev/null 2>&1
done
echo "  restam: $(Q list_sessions '{}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(((JSON.parse(d).data||{}).sessions||[]).length)}catch(e){console.log('?')}})")"

echo "=== 2) session_start sem forceNew (caminho legado de 1 sessao) ==="
R1=$(Q session_start '{}')
S1=$(sid_of "$R1")
chk "session_start devolve sessionId" "$S1" "$R1"
echo "  S1=$S1"

echo "=== 3) operacao SEM sessionId com 1 sessao: funciona (legado) ==="
R=$(Q navigate "{\"url\":\"https://example.com/?p=one\"}")
chk "navigate sem id (1 sessao) deu certo" "example.com" "$R"
chk "resposta ecoa a sessao" "$S1" "$R"

echo "=== 4) segunda sessao: session_start forceNew com resolucao diferente ==="
R2=$(Q session_start '{"forceNew":true,"resolution":"1440x900"}')
S2=$(sid_of "$R2")
chk "session_start devolve o 2o sessionId" "$S2" "$R2"
chk "resolucao 1440x900 foi respeitada" "1440" "$R2"
echo "  S2=$S2"

echo "=== 5) operacao SEM sessionId com 2 sessoes: RECUSA (fail-closed) ==="
R=$(Q navigate '{"url":"https://example.com/?p=ambiguous"}')
chk "navigate sem id foi recusado" "ambiguous_session" "$R"
chk "recusa lista as sessoes" "$S1" "$R"

echo "=== 6) operacao COM sessionId: opera na certa ==="
R=$(Q navigate "{\"url\":\"https://example.com/?p=A\",\"sessionId\":\"$S1\"}")
chk "navigate na S1 deu certo" "p=A" "$R"
chk "resposta ecoa S1" "$S1" "$R"
R=$(Q navigate "{\"url\":\"https://example.com/?p=B\",\"sessionId\":\"$S2\"}")
chk "navigate na S2 deu certo" "p=B" "$R"
chk "resposta ecoa S2" "$S2" "$R"

echo "=== 7) ISOLAMENTO: cada sessao ve a sua URL ==="
RU1=$(Q get_url "{\"sessionId\":\"$S1\"}")
RU2=$(Q get_url "{\"sessionId\":\"$S2\"}")
chk "S1 ve p=A" "p=A" "$RU1"
chk "S2 ve p=B" "p=B" "$RU2"
echo "  S1 url: $RU1"
echo "  S2 url: $RU2"

echo "=== 8) id de sessao inexistente: erro claro ==="
R=$(Q get_url '{"sessionId":"nao-existe-mesmo"}')
chk "id invalido recusado" "session_not_found" "$R"

echo "=== 9) operacao na S2 NAO arrasta a S1 (evaluate_js) ==="
R=$(Q evaluate_js "{\"script\":\"document.title\",\"sessionId\":\"$S2\"}")
chk "evaluate_js na S2 respondeu" "Example Domain" "$R"

echo
echo "==================== $pass PASS / $fail FAIL ===================="
echo "S1=$S1 S2=$S2" > /tmp/t_sessions.txt
[ "$fail" -eq 0 ]
