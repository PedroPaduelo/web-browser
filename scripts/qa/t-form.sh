#!/usr/bin/env bash
# Validacao de fill_form (select), submit_form e os 2 bonus de mentira
# (type_text sem campo focado, click_and_type fora de campo).
set -uo pipefail
QA_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="${KEY:-$(cat "${KEY_FILE:-/tmp/ef.key}")}"
Q() { "$QA_DIR/qa-call.sh" "$KEY" tool "$1" "${2:-\{\}}"; }
sid_of() { printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log((JSON.parse(d).data||{}).sessionId||'')}catch(e){console.log('')}})"; }
data_of() { printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(d).data))}catch(e){console.log('')}})"; }
pass=0; fail=0
chk() {
  if [ -z "$2" ]; then echo "  FAIL  $1 (esperado vazio)"; fail=$((fail+1)); return; fi
  if printf '%s' "$3" | grep -q -- "$2"; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1"; echo "        esperado ~ $2"; echo "        obtido  : $(printf '%s' "$3" | head -c 500)"; fail=$((fail+1)); fi
}

R=$(Q session_start '{"forceNew":true,"resolution":"1280x720"}')
SID=$(sid_of "$R")
echo "sessao: $SID"
if [ -z "$SID" ]; then echo "FALHA: nao criou sessao"; exit 2; fi
S="\"sessionId\":\"$SID\""

Q navigate "{\"url\":\"https://example.com/\",$S}" >/dev/null 2>&1

echo
echo "=== A) fill_form com input texto + select (o bug: o valor do select ia para o campo de texto) ==="
Q evaluate_js "{\"script\":\"document.body.innerHTML='<input id=txt name=t><select id=sel><option value=o1>Um</option><option value=o2>Dois</option><option value=o3>Tres</option></select><input id=txt2>','$S}" >/dev/null 2>&1
RF=$(Q fill_form "{\"fields\":[{\"selector\":\"#txt\",\"value\":\"TEXTO-1\",\"type\":\"text\"},{\"selector\":\"#sel\",\"value\":\"o2\",\"type\":\"select\"}],$S}")
echo "  resposta: $(printf '%s' "$RF" | head -c 300)"
RV=$(Q evaluate_js "{\"script\":\"JSON.stringify({txt:document.getElementById('txt').value,sel:document.getElementById('sel').value,selText:document.getElementById('sel').selectedOptions[0].textContent})\",$S}")
echo "  lido: $RV"
chk "campo texto recebeu TEXTO-1" '"txt":"TEXTO-1"' "$RV"
chk "select recebeu o value o2" '"sel":"o2"' "$RV"
chk "select pegou o texto da option" 'Dois' "$RV"

echo
echo "=== A2) fill_form com select por TEXTO da option (nao por value) ==="
Q evaluate_js "{\"script\":\"document.body.innerHTML='<input id=txt name=t><select id=sel><option value=o1>Um</option><option value=o2>Dois</option></select>','$S}" >/dev/null 2>&1
RF=$(Q fill_form "{\"fields\":[{\"selector\":\"#sel\",\"value\":\"Dois\",\"type\":\"select\"}],$S}")
RV=$(Q evaluate_js "{\"script\":\"JSON.stringify({sel:document.getElementById('sel').value})\",$S}")
echo "  lido: $RV"
chk "select casou pelo texto da option" '"sel":"o2"' "$RV"

echo
echo "=== B) submit_form POSITIVO (o form precisa submeter de verdade) ==="
Q evaluate_js "{\"script\":\"document.body.innerHTML='<form id=f onsubmit=\\\"event.preventDefault();window.__sub=1;document.title=\\\\'SUBMIT\\\\';\\\"><input name=q><button id=b type=submit>Enviar</button></form>','$S}" >/dev/null 2>&1
RS=$(Q submit_form "{\"formSelector\":\"#f\",\"buttonSelector\":\"#b\",$S}")
echo "  resposta: $(printf '%s' "$RS" | head -c 300)"
RV=$(Q evaluate_js "{\"script\":\"JSON.stringify({sub:window.__sub||0,title:document.title})\",$S}")
echo "  lido: $RV"
chk "o evento submit disparou" '"sub":1' "$RV"

echo
echo "=== B2) submit_form NEGATIVO (form sem botao de submit: nao pode dizer submitted:true) ==="
Q evaluate_js "{\"script\":\"document.body.innerHTML='<form id=f2 onsubmit=\\\"event.preventDefault();window.__sub2=1;\\\"><input name=q><button id=b2 type=button>Nao submit</button></form>','$S}" >/dev/null 2>&1
RS=$(Q submit_form "{\"formSelector\":\"#f2\",\"buttonSelector\":\"#b2\",$S}")
echo "  resposta: $(printf '%s' "$RS" | head -c 300)"
if printf '%s' "$RS" | grep -q '"submitted":true'; then echo "  FAIL  menteu: disse submitted:true"; fail=$((fail+1));
else echo "  PASS  nao mentiu (sem submitted:true)"; pass=$((pass+1)); fi
RV=$(Q evaluate_js "{\"script\":\"String(window.__sub2||0)\",$S}")
echo "  lido: $RV"

echo
echo "=== C) type_text SEM campo focado (antes: 'Typed (keys): texto' sem escrever nada) ==="
Q evaluate_js "{\"script\":\"document.body.innerHTML='<div id=alvo style=\\\"border:1px solid #000;width:300px;height:80px\\\"></div>','$S}" >/dev/null 2>&1
RT=$(Q type_text "{\"text\":\"TEXTO-SEM-FOCO\",$S}")
echo "  resposta: $(printf '%s' "$RT" | head -c 300)"
RV=$(Q evaluate_js "{\"script\":\"JSON.stringify({alvo:document.getElementById('alvo').textContent,body:document.body.innerText.trim()})\",$S}")
echo "  lido: $RV"
if printf '%s' "$RV" | grep -q 'TEXTO-SEM-FOCO'; then echo "  FAIL  escreveu texto em pagina sem campo (deveria ter avisado)"; fail=$((fail+1));
else echo "  PASS  nao escreveu em lugar nenhum"; pass=$((pass+1)); fi
if printf '%s' "$RT" | grep -qi 'typed'; then echo "  FAIL  a resposta afirma que digitou ('$(printf '%s' "$RT" | head -c 80)')"; fail=$((fail+1));
else echo "  PASS  a resposta nao afirma que digitou"; pass=$((pass+1)); fi

echo
echo "=== D) click_and_type FORA de um campo (antes: 'Clicked e typed' sem escrever) ==="
Q evaluate_js "{\"script\":\"document.body.innerHTML='<div id=zona style=\\\"width:400px;height:200px;background:#eee\\\"></div>','$S}" >/dev/null 2>&1
RC=$(Q click_and_type "{\"x\":50,\"y\":50,\"text\":\"TEXTO-FORA\",$S}")
echo "  resposta: $(printf '%s' "$RC" | head -c 300)"
RV=$(Q evaluate_js "{\"script\":\"JSON.stringify({zona:document.getElementById('zona').textContent})\",$S}")
echo "  lido: $RV"
if printf '%s' "$RV" | grep -q 'TEXTO-FORA'; then echo "  FAIL  escreveu texto fora de campo (deveria ter avisado)"; fail=$((fail+1));
else echo "  PASS  nao escreveu em lugar nenhum"; pass=$((pass+1)); fi
if printf '%s' "$RC" | grep -qi 'typed'; then echo "  FAIL  a resposta afirma que digitou"; fail=$((fail+1));
else echo "  PASS  a resposta nao afirma que digitou"; pass=$((pass+1)); fi

Q session_stop "{$S}" >/dev/null 2>&1
echo
echo "==================== $pass PASS / $fail FAIL ===================="
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
