const { spawn } = require('child_process');
const path = require('path');

let x11Process = null;
let inputCount = 0;

function start(displayNum = '100') {
  if (x11Process) return;

  const scriptPath = path.join(__dirname, 'x11-input.py');
  x11Process = spawn('python3', [scriptPath], {
    env: { ...process.env, SERENDE_DISPLAY: `:${displayNum}` },
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  x11Process.stderr.on('data', (d) => {
    console.log(d.toString().trim());
  });

  x11Process.on('error', (err) => {
    console.error('[X11Input] Process error:', err.message);
    x11Process = null;
  });

  x11Process.on('exit', (code) => {
    console.log(`[X11Input] Process exited with code ${code}`);
    x11Process = null;
  });

  console.log('[X11Input] Started python-xlib input handler');
}

function stop() {
  if (x11Process) {
    try { x11Process.stdin.end(); } catch {}
    try { x11Process.kill(); } catch {}
    x11Process = null;
    console.log('[X11Input] Stopped');
  }
}

function handleInput(msg) {
  if (!x11Process || !x11Process.stdin.writable) return;

  inputCount++;
  try {
    x11Process.stdin.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    if (inputCount <= 3) console.error('[X11Input] Write error:', err.message);
  }
}

module.exports = { start, stop, handleInput };
