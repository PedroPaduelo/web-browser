const { exec } = require('child_process');

const displayNum = process.env.DISPLAY_NUM || '99';
const DISPLAY = `DISPLAY=:${displayNum}`;

const KEY_MAP = {
  'Enter': 'Return',
  'Backspace': 'BackSpace',
  'Tab': 'Tab',
  'Escape': 'Escape',
  'Delete': 'Delete',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Control': 'Control_L',
  'Shift': 'Shift_L',
  'Alt': 'Alt_L',
  'Meta': 'Super_L',
  ' ': 'space',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'Prior',
  'PageDown': 'Next',
  'Insert': 'Insert',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  'CapsLock': 'Caps_Lock',
  'NumLock': 'Num_Lock',
  'ScrollLock': 'Scroll_Lock',
  'PrintScreen': 'Print',
  'Pause': 'Pause',
};

function mapKey(jsKey) {
  return KEY_MAP[jsKey] || jsKey;
}

function run(cmd) {
  exec(`${DISPLAY} ${cmd}`, (err) => {
    if (err) console.error('xdotool error:', err.message);
  });
}

function injectMouse(x, y) {
  run(`xdotool mousemove --sync ${x} ${y}`);
}

function injectClick(x, y, button) {
  const btn = button === 0 ? 1 : button === 1 ? 2 : 3;
  run(`xdotool mousemove --sync ${x} ${y} click ${btn}`);
}

function injectScroll(x, y, deltaY) {
  const dir = deltaY > 0 ? 5 : 4;
  const clicks = Math.min(Math.ceil(Math.abs(deltaY) / 120), 10);
  run(`xdotool mousemove --sync ${x} ${y}`);
  for (let i = 0; i < clicks; i++) {
    run(`xdotool click ${dir}`);
  }
}

function injectKeyDown(key) {
  run(`xdotool keydown ${mapKey(key)}`);
}

function injectKeyUp(key) {
  run(`xdotool keyup ${mapKey(key)}`);
}

function injectType(text) {
  const escaped = text.replace(/"/g, '\\"');
  run(`xdotool type --delay 0 "${escaped}"`);
}

module.exports = { injectMouse, injectClick, injectScroll, injectKeyDown, injectKeyUp, injectType };
