#!/usr/bin/env bash
# Validacao do cookie entre sessoes do MESMO tenant (task 1ce89412).
#
# A correcao publicada (5554a18) introduziu stopChromeAndWait(): SIGTERM no
# Chrome + await do 'exit' ANTES do mergeProfileFromSession(). Sem esperar, o
# merge copiava o Default/Cookies ANTES do Chrome gravar, e o cookie sumia.
#
# O teste anterior falhou com tenant NOVO (sem perfil master para mesclar),
# entao aqui o perfil master precisa existir: a 1a sessao o cria.
set -uo pipefail
QA_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="${KEY:-$(cat "${KEY_FILE:-/tmp/ef.key}")}"
Q() { "$QA_DIR/qa-call.sh" "$KEY" tool "$1" "${2:-\{\}}"; }
sid_of() { printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log((JSON.parse(d).data||{}).sessionId||'')}catch(e){console.log('')}})"; }
jget() { printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d).data||{};console.log(JSON.stringify(j.cookies||j))}catch(e){console.log('')}})"; }

echo "=== 0) garante que nao ha sessao do tenant (estado limpo) ==="
Q list_sessions '{}' > /tmp/c_list.json 2>&1
for s in $(node -e "try{console.log(((JSON.parse(require('fs').readFileSync('/tmp/c_list.json','utf8')).data||{}).sessions||[]).map(x=>x.sessionId).join(' '))}catch(e){}" 2>/dev/null); do
  Q session_stop "{\"sessionId\":\"$s\"}" >/dev/null 2>&1
done
echo "  ok"

# testa um timing: $1 = nome do teste, $2 = segundos de espera antes do stop
testa() {
  local nome="$1" espera="$2" cookie="qa_$1_$(date +%s)"
  echo
  echo "=== $nome (espera ${espera}s antes do stop) ==="
  local r1 sid1
  r1=$(Q session_start '{"forceNew":true,"resolution":"1280x720"}')
  sid1=$(sid_of "$r1")
  if [ -z "$sid1" ]; then echo "  FAIL session_start nao devolveu id: $(printf '%s' "$r1" | head -c 200)"; return 1; fi
  echo "  sessao 1: $sid1"

  Q navigate "{\"url\":\"https://example.com/\",\"sessionId\":\"$sid1\"}" >/dev/null 2>&1
  local rc
  rc=$(Q set_cookie "{\"name\":\"$cookie\",\"value\":\"valor-$nome\",\"path\":\"/\",\"sessionId\":\"$sid1\"}")
  echo "  set_cookie: $(printf '%s' "$rc" | head -c 120)"
  sleep "$espera"

  Q session_stop "{\"sessionId\":\"$sid1\"}" >/dev/null 2>&1
  sleep 3

  local r2 sid2 rc2
  r2=$(Q session_start '{"forceNew":true,"resolution":"1280x720"}')
  sid2=$(sid_of "$r2")
  if [ -z "$sid2" ]; then echo "  FAIL 2a sessao nao subiu"; return 1; fi
  echo "  sessao 2: $sid2"

  rc2=$(Q get_cookies "{\"sessionId\":\"$sid2\"}")
  local tem
  tem=$(printf '%s' "$rc2" | grep -c "$cookie" || true)
  if [ "$tem" -gt 0 ]; then echo "  PASS cookie $cookie SOBREVIVEU"; return 0; else
    echo "  FAIL cookie $cookie NAO sobreviveu"; echo "       cookies lidos: $(jget "$rc2" | head -c 400)"; return 1; fi
}

f=0
testa "A5" 5 || f=1
testa "B0" 0 || f=1
testa "C30" 30 || f=1

echo
echo "=== estado final ==="
Q list_sessions '{}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log('sessoes abertas:',((JSON.parse(d).data||{}).sessions||[]).length)}catch(e){console.log('?')}})"
echo
[ $f -eq 0 ] && echo "=== TODOS OS TIMINGS PASSARAM ===" || echo "=== HOUVE FALHA ==="
exit $f
