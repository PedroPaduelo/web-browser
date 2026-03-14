#!/usr/bin/env python3
import sys
import os
import json
import select
from Xlib import X, XK, display
from Xlib.ext import xtest

DISPLAY_NUM = os.environ.get('SERENDE_DISPLAY', ':100')

d = None
screen = None
root = None

KEY_MAP = {
    'Enter': 'Return', 'Backspace': 'BackSpace', 'Tab': 'Tab',
    'Escape': 'Escape', 'Delete': 'Delete', 'Insert': 'Insert',
    'Home': 'Home', 'End': 'End', 'PageUp': 'Page_Up', 'PageDown': 'Page_Down',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Control': 'Control_L', 'Shift': 'Shift_L', 'Alt': 'Alt_L', 'Meta': 'Super_L',
    'CapsLock': 'Caps_Lock', 'NumLock': 'Num_Lock',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
    'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
    'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
    ' ': 'space',
}

BUTTON_MAP = {0: 1, 1: 2, 2: 3}

_kc_cache = {}

def init_display():
    global d, screen, root
    d = display.Display(DISPLAY_NUM)
    screen = d.screen()
    root = screen.root

def get_keycode(key):
    cached = _kc_cache.get(key)
    if cached is not None:
        return cached

    mapped = KEY_MAP.get(key)
    ks = 0
    if mapped:
        ks = XK.string_to_keysym(mapped)
    if not ks and len(key) == 1:
        ks = XK.string_to_keysym(key)
        if not ks:
            ks = ord(key)
    if not ks:
        ks = XK.string_to_keysym(key)

    kc = d.keysym_to_keycode(ks) if ks else 0
    _kc_cache[key] = kc
    return kc

fi = xtest.fake_input
_pending = 0

def handle_msg(msg):
    global _pending
    t = msg.get('type')

    if t == 'mousemove':
        fi(d, X.MotionNotify, x=int(msg['x']), y=int(msg['y']), root=root)
        _pending += 1

    elif t == 'click':
        x, y = int(msg['x']), int(msg['y'])
        btn = BUTTON_MAP.get(msg.get('button', 0), 1)
        fi(d, X.MotionNotify, x=x, y=y, root=root)
        fi(d, X.ButtonPress, detail=btn, root=root)
        fi(d, X.ButtonRelease, detail=btn, root=root)
        _pending += 3

    elif t == 'mousedown':
        x, y = int(msg['x']), int(msg['y'])
        btn = BUTTON_MAP.get(msg.get('button', 0), 1)
        fi(d, X.MotionNotify, x=x, y=y, root=root)
        fi(d, X.ButtonPress, detail=btn, root=root)
        _pending += 2

    elif t == 'mouseup':
        x, y = int(msg['x']), int(msg['y'])
        btn = BUTTON_MAP.get(msg.get('button', 0), 1)
        fi(d, X.ButtonRelease, detail=btn, root=root)
        _pending += 1

    elif t == 'scroll':
        x, y = int(msg['x']), int(msg['y'])
        dy = msg.get('deltaY', 0)
        fi(d, X.MotionNotify, x=x, y=y, root=root)
        btn = 4 if dy < 0 else 5
        clicks = max(1, min(abs(int(dy)) // 40, 10))
        for _ in range(clicks):
            fi(d, X.ButtonPress, detail=btn, root=root)
            fi(d, X.ButtonRelease, detail=btn, root=root)
        _pending += 1 + clicks * 2

    elif t == 'keydown':
        kc = get_keycode(msg.get('key', ''))
        if kc:
            fi(d, X.KeyPress, detail=kc, root=root)
            _pending += 1

    elif t == 'keyup':
        kc = get_keycode(msg.get('key', ''))
        if kc:
            fi(d, X.KeyRelease, detail=kc, root=root)
            _pending += 1

    else:
        return

if __name__ == '__main__':
    init_display()
    sys.stderr.write(f'[X11Input] Connected to display {DISPLAY_NUM}\n')
    sys.stderr.flush()

    stdin_fd = sys.stdin.fileno()
    stdin = os.fdopen(stdin_fd, 'r', buffering=1)
    loads = json.loads
    _pending = 0

    while True:
        line = stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            handle_msg(loads(line))
        except Exception as e:
            sys.stderr.write(f'[X11Input] Error: {e}\n')
            sys.stderr.flush()
            continue

        while True:
            ready, _, _ = select.select([stdin_fd], [], [], 0)
            if not ready:
                break
            extra = stdin.readline()
            if not extra:
                break
            extra = extra.strip()
            if extra:
                try:
                    handle_msg(loads(extra))
                except Exception as e:
                    sys.stderr.write(f'[X11Input] Error: {e}\n')
                    sys.stderr.flush()

        if _pending > 0:
            d.flush()
            _pending = 0
