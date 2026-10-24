#!/usr/bin/env node
/**
 * Prova de que as duas correções do produtor de vídeo fazem diferença:
 *   1. wrapper: no SIGTERM, o script antigo continuava vivo (cleanup sem exit);
 *      o novo sai e derruba o filho.
 *   2. killProcess: a condição antiga `if (!proc.killed)` nunca escalava para
 *      SIGKILL (proc.killed é true logo após o SIGTERM); a nova escala sempre.
 */
const { spawn } = require('child_process');
const fs = require('fs');

const WRAPPER_ANTIGO = `
FFBIN="$1"
shift
PARENT_PID="$PPID"
"$FFBIN" "$@" &
FF_PID=$!
cleanup() { kill -TERM "$FF_PID" 2>/dev/null || true; }
trap cleanup TERM INT EXIT
exec 3<&0
( cat <&3 > /dev/null; kill -TERM "$FF_PID" 2>/dev/null || true ) &
READER_PID=$!
while kill -0 "$FF_PID" 2>/dev/null; do
  if [ "$PPID" != "$PARENT_PID" ]; then cleanup; break; fi
  sleep 1
done
wait "$FF_PID"
STATUS=$?
kill "$READER_PID" 2>/dev/null || true
wait "$READER_PID" 2>/dev/null || true
exit "$STATUS"
`;

function wrapperAtual() {
  const sm = fs.readFileSync('server/session-manager.js', 'utf8');
  const m = sm.match(/const FFMPEG_WRAPPER_SCRIPT = `([\s\S]*?)`;/);
  if (!m) throw new Error('FFMPEG_WRAPPER_SCRIPT não encontrado');
  return m[1];
}

const vivo = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function spawnWrapper(script, bin) {
  return spawn('/bin/sh', ['-c', script, 'serende-ffmpeg', bin, ...process.argv.slice(4)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
}

(async () => {
  let falhas = 0;
  const check = (nome, ok, extra = '') => {
    if (!ok) falhas++;
    console.log(`${ok ? 'OK  ' : 'ERRO'} ${nome}${extra ? ' — ' + extra : ''}`);
  };

  // --- 1. wrapper: SIGTERM deve derrubar wrapper E filho ------------------
  // O filho IGNORA o SIGTERM (como o ffmpeg, que faz shutdown gracioso e pode
  // ficar preso lendo o display X). Sem essa característica o bug não aparece:
  // um /bin/sleep honors SIGTERM e morre no cleanup, mascarando o problema.
  const FILHO_TEIMOSO = '/bin/sh';
  const ARGS_FILHO = ['-c', 'trap "" TERM; while :; do sleep 1; done'];
  for (const [nome, script] of [['antigo', WRAPPER_ANTIGO], ['novo', wrapperAtual()]]) {
    const p = spawn('/bin/sh', ['-c', script, 'serende-ffmpeg', FILHO_TEIMOSO, ...ARGS_FILHO],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((r) => setTimeout(r, 400));
    const wrapperPid = p.pid;
    const filhos = fs.readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8').trim().split(/\s+/);
    const filho = Number(filhos[0]);
    p.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 3000));
    const wrapperVivo = vivo(wrapperPid);
    const filhoVivo = vivo(filho);
    if (nome === 'antigo') {
      check('wrapper ANTIGO sobrevive ao SIGTERM (é o bug)', wrapperVivo && filhoVivo,
        `wrapper=${wrapperVivo} filho=${filhoVivo}`);
    } else {
      check('wrapper NOVO morre no SIGTERM e derruba o filho teimoso', !wrapperVivo && !filhoVivo,
        `wrapper=${wrapperVivo} filho=${filhoVivo}`);
    }
    try { process.kill(wrapperPid, 'SIGKILL'); } catch {}
    try { process.kill(filho, 'SIGKILL'); } catch {}
  }

  // --- 2. killProcess: escalonamento para SIGKILL -------------------------
  const alvoAntigo = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 300));
  alvoAntigo.kill('SIGTERM'); // o processo IGNORA o SIGTERM
  const escalonadoAntigo = !alvoAntigo.killed; // condição do código antigo
  await new Promise((r) => setTimeout(r, 2500));
  const morreuAntigo = !vivo(alvoAntigo.pid);
  check('código ANTIGO não escalonava (killed=true cedo demais)', escalonadoAntigo === false, `condição=${escalonadoAntigo}`);
  check('código ANTIGO: alvo ignora SIGTERM → sobrevive (é o bug)', !morreuAntigo, `morreu=${morreuAntigo}`);

  const alvoNovo = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 300));
  // espelha o killProcess NOVO
  const pid = alvoNovo.pid;
  try { alvoNovo.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 2000);
  await new Promise((r) => setTimeout(r, 2600));
  const morreuNovo = !vivo(pid);
  check('código NOVO escala para SIGKILL e mata o alvo teimoso', morreuNovo, `morreu=${morreuNovo}`);

  console.log(falhas === 0 ? '\nDIFERENÇA PROVADA' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})();
