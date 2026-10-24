const { spawn } = require('child_process');
const path = require('path');

function createInputHandler(displayNum = '100', opts = {}) {
  let proc = null;
  let alive = false;
  let retries = 0;
  let sessionId = opts.sessionId || null;
  // Coalescing de mousemove: só o último ponto da rajada é encaminhado.
  let pendingMove = null;
  let moveScheduled = false;

  const tag = () => `[x11-input display=:${displayNum} session=${sessionId || '-'}]`;

  function start() {
    const scriptPath = path.join(__dirname, 'x11-input.py');
    proc = spawn('python3', ['-u', scriptPath], {
      env: { ...process.env, SERENDE_DISPLAY: `:${displayNum}`, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg.includes('Connected to display')) {
        alive = true;
        retries = 0;
      } else if (/error|fail|exception|traceback/i.test(msg)) {
        console.error(`${tag()} backend x11:`, msg.slice(0, 300));
      }
    });

    proc.on('error', (e) => {
      alive = false; proc = null;
      console.error(`${tag()} falha ao iniciar x11-input.py:`, (e && e.message) || e);
    });
    proc.on('exit', (code, signal) => {
      alive = false;
      proc = null;
      pendingMove = null; moveScheduled = false;
      const why = signal ? `signal=${signal}` : `code=${code}`;
      if (retries < 3) {
        retries++;
        setTimeout(start, 300);
      } else {
        console.error(`${tag()} x11-input.py saiu, desistindo (${why})`);
      }
    });
  }

  function write(msg) {
    if (!alive || !proc || !proc.stdin || !proc.stdin.writable) return;
    let line;
    try {
      line = JSON.stringify(msg) + '\n';
    } catch (e) {
      console.error(`${tag()} evento não serializável (${msg && msg.type}):`, (e && e.message) || e);
      return;
    }
    try {
      proc.stdin.write(line);
    } catch (e) {
      console.error(`${tag()} falha ao encaminhar ${msg.type}:`, (e && e.message) || e);
    }
  }

  // Descarrega o último mousemove coalescido (1 write por tick).
  function flushMove() {
    moveScheduled = false;
    if (!pendingMove) return;
    const m = pendingMove; pendingMove = null;
    write(m);
  }

  start();

  return {
    sendInput(msg, ctx) {
      if (!msg || typeof msg.type !== 'string') return;
      if (ctx && ctx.sessionId) sessionId = ctx.sessionId;
      else if (msg.sessionId) sessionId = msg.sessionId;
      // Normaliza coordenadas: inteiras, sem NaN (o backend Python espera números).
      if (msg.x !== undefined || msg.y !== undefined) {
        msg = { ...msg };
        if (msg.x !== undefined) msg.x = Number.isFinite(+msg.x) ? Math.round(+msg.x) : 0;
        if (msg.y !== undefined) msg.y = Number.isFinite(+msg.y) ? Math.round(+msg.y) : 0;
      }
      if (msg.type === 'mousemove') {
        // Coalescing: rajadas colapsam no último ponto, 1 write por tick.
        pendingMove = msg;
        if (!moveScheduled) { moveScheduled = true; setImmediate(flushMove); }
        return;
      }
      write(msg);
    },
    setSessionId(id) { sessionId = id || null; },
    stop() {
      alive = false;
      retries = 99;
      pendingMove = null; moveScheduled = false;
      if (proc) {
        try { proc.stdin.end(); } catch {}
        try { proc.kill(); } catch {}
        proc = null;
      }
    },
  };
}

module.exports = { createInputHandler };
