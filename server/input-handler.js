const { spawn } = require('child_process');
const path = require('path');

function createInputHandler(displayNum = '100') {
  let x11Process = null;

  const scriptPath = path.join(__dirname, 'x11-input.py');
  x11Process = spawn('python3', [scriptPath], {
    env: { ...process.env, SERENDE_DISPLAY: `:${displayNum}` },
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  x11Process.stderr.on('data', (d) => {
    console.log(d.toString().trim());
  });

  x11Process.on('error', (err) => {
    console.error(`[X11Input:${displayNum}] Process error:`, err.message);
    x11Process = null;
  });

  x11Process.on('exit', (code) => {
    console.log(`[X11Input:${displayNum}] Process exited with code ${code}`);
    x11Process = null;
  });

  console.log(`[X11Input:${displayNum}] Started python-xlib input handler`);

  return {
    sendInput(msg) {
      if (!x11Process || !x11Process.stdin.writable) return;
      try {
        x11Process.stdin.write(JSON.stringify(msg) + '\n');
      } catch {}
    },
    stop() {
      if (x11Process) {
        try { x11Process.stdin.end(); } catch {}
        try { x11Process.kill(); } catch {}
        x11Process = null;
        console.log(`[X11Input:${displayNum}] Stopped`);
      }
    },
  };
}

module.exports = { createInputHandler };
