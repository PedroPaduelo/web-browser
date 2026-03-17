const { spawn } = require('child_process');
const path = require('path');

function createInputHandler(displayNum = '100') {
  let proc = null;
  let alive = false;
  let retries = 0;

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
      }
    });

    proc.on('error', () => { alive = false; proc = null; });
    proc.on('exit', () => {
      alive = false;
      proc = null;
      if (retries < 3) {
        retries++;
        setTimeout(start, 300);
      }
    });
  }

  start();

  return {
    sendInput(msg) {
      if (!alive || !proc) return;
      proc.stdin.write(JSON.stringify(msg) + '\n');
    },
    stop() {
      alive = false;
      retries = 99;
      if (proc) {
        try { proc.stdin.end(); } catch {}
        try { proc.kill(); } catch {}
        proc = null;
      }
    },
  };
}

module.exports = { createInputHandler };
