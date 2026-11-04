// Wrapper anti-órfão do ffmpeg (movido de session-manager.js, byte-idêntico).
//
// O ffmpeg roda dentro de um `sh` que vigia dois sinais —
//   (1) EOF no stdin  => o Node pai morreu (exit/SIGTERM) => mata o ffmpeg;
//   (2) PPID mudou     => o pai morreu por SIGKILL e fomos reparentados => mata.
// MEDIDO: ffmpeg puro NÃO morre com EOF no stdin — o wrapper é obrigatório.
// O `exec 3<&0` duplica o stdin real ANTES do fork: em shell não-interativo o
// stdin de um job em background vira /dev/null e a detecção de EOF nunca
// dispara (foi exatamente o que quebrou na primeira versão).
//
// ATENÇÃO (invariante do capture-service.js): o fd 3 pertence ao wrapper.
// Qualquer pipe que o Node mapeasse para o fd 3 seria destruído — por isso o
// spawn usa stdio ['pipe','pipe','pipe','ignore','pipe'] e o rawvideo sai no
// pipe:4 (fd >= 4 atravessa o `sh` intacto até o neto ffmpeg).
const FFMPEG_WRAPPER_SCRIPT = `
FFBIN="$1"
shift
PARENT_PID="$PPID"
"$FFBIN" "$@" &
FF_PID=$!
cleanup() {
  kill -TERM "$FF_PID" 2>/dev/null || true
  # O ffmpeg trata SIGTERM como shutdown gracioso e pode ficar preso na leitura
  # do display X: por isso o cleanup escala para SIGKILL depois de 2s. Sem isso
  # o produtor sobrevive à sessão encerrada segurando o socket X do display.
  ( sleep 2; kill -KILL "$FF_PID" 2>/dev/null || true ) &
}
# No TERM/INT o shell precisa SAIR, não só rodar o cleanup: com o trap simples
# o script continuava no loop, o ffmpeg só recebia o SIGTERM e ninguém
# escalonava — o wrapper (e o ffmpeg) viviam depois da sessão encerrada.
trap 'cleanup; exit 0' TERM INT
trap cleanup EXIT
exec 3<&0
( cat <&3 > /dev/null; cleanup ) &
READER_PID=$!
while kill -0 "$FF_PID" 2>/dev/null; do
  if [ "$PPID" != "$PARENT_PID" ]; then
    cleanup
    break
  fi
  sleep 1
done
wait "$FF_PID"
STATUS=$?
kill "$READER_PID" 2>/dev/null || true
wait "$READER_PID" 2>/dev/null || true
exit "$STATUS"
`;

module.exports = { script: FFMPEG_WRAPPER_SCRIPT };
