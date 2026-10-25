const WebSocket = require('./node_modules/ws');

const BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right' };
// Bitmask "buttons" do Input.dispatchMouseEvent (ordem própria do CDP).
const BUTTON_MASK = { left: 1, middle: 4, right: 2 };
// Bitmask "modifiers" do CDP: Alt=1, Ctrl=2, Meta=4, Shift=8.
const MOD_ALT = 1, MOD_CTRL = 2, MOD_META = 4, MOD_SHIFT = 8;

// Teclas de controle que o Chrome converte em caractere. Só estas levam
// `text` no keyDown — sem ele o CDP não gera `keypress`, e sem keypress o
// browser não faz a ação implícita (Enter não submete form).
// Deliberadamente TAB, Escape, setas e F-keys ficam de fora: elas não têm
// char, e mandar text faria o browser digitar onde devia navegar.
const CHAR_BY_KEY = {
  Enter: '\r',
  NumpadEnter: '\r',
  Space: ' ',
  ' ': ' ',
};

// Teclas especiais -> { key, code, windowsVirtualKeyCode }.
// Antes só o `key` textual ia no dispatchKeyEvent; sem code/virtualKey o Chrome
// ignorava Enter/Tab/Esc/setas/F-keys. Mapa completo dos especiais + modificadores.
const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ' ': { key: ' ', code: 'Space', vk: 32 },
  Spacebar: { key: ' ', code: 'Space', vk: 32 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', vk: 20 },
  NumLock: { key: 'NumLock', code: 'NumLock', vk: 144 },
  ScrollLock: { key: 'ScrollLock', code: 'ScrollLock', vk: 145 },
  Pause: { key: 'Pause', code: 'Pause', vk: 19 },
  PrintScreen: { key: 'PrintScreen', code: 'PrintScreen', vk: 44 },
  F1: { key: 'F1', code: 'F1', vk: 112 },
  F2: { key: 'F2', code: 'F2', vk: 113 },
  F3: { key: 'F3', code: 'F3', vk: 114 },
  F4: { key: 'F4', code: 'F4', vk: 115 },
  F5: { key: 'F5', code: 'F5', vk: 116 },
  F6: { key: 'F6', code: 'F6', vk: 117 },
  F7: { key: 'F7', code: 'F7', vk: 118 },
  F8: { key: 'F8', code: 'F8', vk: 119 },
  F9: { key: 'F9', code: 'F9', vk: 120 },
  F10: { key: 'F10', code: 'F10', vk: 121 },
  F11: { key: 'F11', code: 'F11', vk: 122 },
  F12: { key: 'F12', code: 'F12', vk: 123 },
};

// Virtual-key codes do Windows por `code` de tecla de pontuação.
// O `charCodeAt` do caractere NÃO é o VK: o Chrome reconstrói o texto a
// partir do VK, então mandar o ASCII (39 para "'", 46 para ".") faz a tecla
// simplesmente não digitar nada. Fonte: US keyboard layout.
const VK_BY_CODE = {
  Quote: 222,      // '
  Period: 190,     // .
  Slash: 191,      // /
  Semicolon: 186,  // ;
  Comma: 188,      // ,
  Backslash: 220,  // \
  BracketLeft: 219,// [
  BracketRight: 221,// ]
  Minus: 189,      // -
  Equal: 187,      // =
  Backquote: 192,  // `
  IntlBackslash: 220,
};

function lookupKey(rawKey, code) {
  return SPECIAL_KEYS[rawKey] || (code && SPECIAL_KEYS[code]) || null;
}

// VK genérico a partir do `code` (KeyA -> 65, Digit1 -> 49, Numpad0 -> 96).
function vkFromCode(code) {
  if (!code) return 0;
  if (VK_BY_CODE[code]) return VK_BY_CODE[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return 96 + Number(m[1]);
  return 0;
}

function vkForKey(rawKey, code) {
  const spec = lookupKey(rawKey, code);
  if (spec) return spec.vk;
  const byCode = vkFromCode(code);
  if (byCode) return byCode;
  if (typeof rawKey === 'string' && rawKey.length === 1) {
    const c = rawKey.toUpperCase().charCodeAt(0);
    // Fallback: só A-Z e 0-9. Os demais ASCII têm VK próprio (VK_BY_CODE) —
    // mandar o ASCII como VK faz o Chrome descartar a tecla.
    if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return c;
  }
  return 0;
}

function getModifiers(msg) {
  if (!msg) return undefined;
  if (typeof msg.modifiers === 'number') return msg.modifiers;
  let m = 0;
  if (msg.altKey) m |= MOD_ALT;
  if (msg.ctrlKey) m |= MOD_CTRL;
  if (msg.metaKey) m |= MOD_META;
  if (msg.shiftKey) m |= MOD_SHIFT;
  return m || undefined;
}

function createInputHandler(displayNum, opts = {}) {
  let ws = null;
  let msgId = 0;
  let connected = false;
  let retries = 0;
  let sessionId = opts.sessionId || null;
  // Escala cliente -> viewport do Chrome (setViewport/setScale atualizam sem recriar).
  let scaleX = opts.scaleX || 1;
  let scaleY = opts.scaleY || scaleX;
  // Viewport REAL do Chrome: o --window-size do Xvfb é a TELA, não a área de
  // conteúdo. Em --app o viewport é menor (medido: 1279x663 num 1280x720) e
  // cssLayoutViewport.clientWidth ainda exclui a scrollbar (1264). A métrica
  // que bate 1:1 com o frame pintado é innerWidth/innerHeight (1279x663).
  let chromeW = opts.chromeWidth || 0;
  let chromeH = opts.chromeHeight || 0;
  let layoutReqId = 0;
  let innerReqId = 0;
  let layoutTimer = null;
  // Coalescing de mousemove + botões segurados (drag fiel).
  let pendingMove = null;
  let moveScheduled = false;
  let pressedMask = 0;
  // Botão segurado no momento ('left'|'middle'|'right'|null). O Chrome só
  // mantém o gesto de arraste se o `mouseMoved` vier com o campo `button`
  // (bissecção CDP do QA: com `button` a seleção de texto deu len:18; sem,
  // len:0 — o mousemove virava só hover).
  let pressedButton = null;
  // Último clickCount despachado (press/release): permite saber se o
  // dblclick já foi entregue e não duplicar o par de eventos.
  let lastPressCC = 0;
  let lastReleaseCC = 0;
  // Último release entregue (coords + instante): o ramo 'dblclick' usa isso
  // para NÃO duplicar — o Chrome já sintetiza o dblclick a partir do par
  // press/release com clickCount 2.
  let lastReleaseAt = 0;
  let lastReleaseX = -1;
  let lastReleaseY = -1;
  // Quem está esperando o WS do CDP conectar. Sem isso, a PRIMEIRA ação de
  // input depois de abrir a sessão era descartada (sendInput só age com
  // `connected`), e o gesto (arrasto/clique) começava pela metade.
  const readyWaiters = [];

  const CDP_BASE_PORT = 9222;
  const DISPLAY_MIN = 100;
  const cdpPort = opts.cdpPort || (CDP_BASE_PORT + (displayNum - DISPLAY_MIN));
  // Reconsulta periódica do viewport (resize/navegação mudam clientWidth/Height).
  const LAYOUT_REFRESH_MS = 3000;

  const tag = () => `[input display=:${displayNum} session=${sessionId || '-'}]`;

  // Coordenadas do cliente -> viewport do Chrome: escala, arredonda (CDP usa int)
  // e protege contra NaN/negativo.
  // O cliente manda fw/fh = tamanho REAL do frame pintado; a escala é
  // chromeW/fw (chromeH/fh) — sem isso o clique erra a altura inteira
  // (medido: 79px em 90% da altura) e cai fora do viewport.
  function scalePoint(msg) {
    let sx = scaleX, sy = scaleY;
    const fw = Number(msg && msg.fw);
    const fh = Number(msg && msg.fh);
    if (chromeW > 0 && chromeH > 0 && fw > 0 && fh > 0) {
      sx = chromeW / fw;
      sy = chromeH / fh;
    }
    let x = Math.round(Number(msg.x) * sx);
    let y = Math.round(Number(msg.y) * sy);
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(y)) y = 0;
    return { x: Math.max(0, x), y: Math.max(0, y) };
  }

  async function connect() {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page');
      if (!page) {
        if (retries < 5) { retries++; setTimeout(connect, 500); }
        else console.error(`${tag()} sem target page no CDP :${cdpPort} após ${retries} tentativas`);
        return;
      }

      ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.on('open', () => {
        connected = true; retries = 0;
        // Libera quem estava esperando o input ficar pronto.
        while (readyWaiters.length) readyWaiters.shift()();
        requestLayoutMetrics();
        startLayoutTimer();
      });
      ws.on('message', (raw) => {
        // Respostas de discovery do viewport real:
        //  - Page.getLayoutMetrics -> cssLayoutViewport (fallback; sem scrollbar)
        //  - Runtime.evaluate(innerWidth/innerHeight) -> bate 1:1 com o frame
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || data.id === undefined) return;
        if (data.id === layoutReqId) {
          const vp = data.result && data.result.cssLayoutViewport;
          if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
            chromeW = vp.clientWidth;
            chromeH = vp.clientHeight;
          }
          return;
        }
        if (data.id === innerReqId) {
          const v = data.result && data.result.result && data.result.result.value;
          if (v && Number.isFinite(v.w) && Number.isFinite(v.h) && v.w > 0 && v.h > 0) {
            chromeW = v.w;
            chromeH = v.h;
          }
        }
      });
      ws.on('close', (code, reason) => {
        connected = false; ws = null;
        pendingMove = null; moveScheduled = false;
        const why = reason && reason.length ? ` code=${code} reason=${reason}` : ` code=${code || '?'}`;
        if (retries < 5) { retries++; setTimeout(connect, 1000); }
        else console.error(`${tag()} CDP fechado, desistindo:${why}`);
      });
      ws.on('error', (e) => {
        console.error(`${tag()} erro no WS do CDP :${cdpPort}:`, (e && e.message) || e);
      });
    } catch (e) {
      if (retries < 5) { retries++; setTimeout(connect, 1000); }
      else console.error(`${tag()} falha ao conectar no CDP :${cdpPort}:`, (e && e.message) || e);
    }
  }

  setTimeout(connect, 300);

  function send(method, params) {
    if (!connected || !ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ id: ++msgId, method, params }));
    } catch (e) {
      console.error(`${tag()} falha ao enviar ${method}:`, (e && e.message) || e);
    }
  }

  // Descobre o viewport real do Chrome. Duas fontes:
  //  1) Runtime.evaluate(innerWidth/innerHeight) — bate 1:1 com o frame pintado
  //     (inclui a scrollbar, onde o clique NÃO chega: elementFromPoint devolve
  //     null na faixa da scrollbar).
  //  2) Page.getLayoutMetrics(cssLayoutViewport) — fallback.
  function requestLayoutMetrics() {
    if (!connected || !ws || ws.readyState !== 1) return;
    layoutReqId = ++msgId;
    innerReqId = ++msgId;
    try {
      ws.send(JSON.stringify({
        id: layoutReqId, method: 'Page.getLayoutMetrics', params: {},
      }));
      ws.send(JSON.stringify({
        id: innerReqId, method: 'Runtime.evaluate',
        params: {
          expression: '({w: window.innerWidth, h: window.innerHeight})',
          returnByValue: true,
        },
      }));
    } catch (e) {
      // Sem viewport real: segue com scaleX/scaleY.
    }
  }

  // Reconsulta periódica: resize da janela / navegação mudam o viewport.
  function startLayoutTimer() {
    if (layoutTimer) return;
    layoutTimer = setInterval(() => {
      if (!connected) return;
      requestLayoutMetrics();
    }, LAYOUT_REFRESH_MS);
    if (layoutTimer.unref) layoutTimer.unref();
  }

  // Descarrega o último mousemove coalescido (1 comando CDP por tick).
  function flushMove() {
    moveScheduled = false;
    if (!pendingMove) return;
    const m = pendingMove; pendingMove = null;
    send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: m.x, y: m.y,
      modifiers: m.modifiers, buttons: m.buttons,
      // `button` = botão pressionado durante o gesto. SEM ele o Chrome
      // ignora o movimento como parte do arraste (o QA mediu len:0 na
      // seleção de texto; com `button` mediu len:18).
      // `undefined` => a chave some do JSON (equivalente ao default 'none').
      button: pressedButton || undefined,
    });
  }

  function buildKeyParams(msg, cdpType) {
    const rawKey = typeof msg.key === 'string' ? msg.key : '';
    const spec = lookupKey(rawKey, msg.code);
    const params = { type: cdpType };
    params.key = (spec && spec.key) || rawKey || 'Unidentified';
    const code = msg.code || (spec && spec.code);
    if (code) params.code = code;
    const vk = vkForKey(rawKey, msg.code);
    if (vk) params.windowsVirtualKeyCode = vk;
    const modifiers = getModifiers(msg);
    if (modifiers) params.modifiers = modifiers;
    if (cdpType === 'keyDown') {
      if (msg.repeat) {
        // Tecla SEGURADA: precisa ser keyDown (não rawKeyDown) COM text e
        // autoRepeat — rawKeyDown só gera keydown, sem keypress/input, então
        // o valor do input não muda ao segurar a tecla (medido: "aaa" só
        // aparecia com keyDown+text+autoRepeat).
        params.type = 'keyDown';
        params.autoRepeat = true;
        if (params.key.length === 1) {
          params.text = params.key;
        } else if (typeof msg.text === 'string' && msg.text) {
          params.text = msg.text;
        }
      } else if (params.key.length === 1) {
        params.text = params.key;
      } else if (typeof msg.text === 'string' && msg.text) {
        params.text = msg.text;
      } else {
        // Tecla de controle que o Chrome traduz em char: sem `text` o CDP emite
        // só keydown+keyup, e NUNCA o `keypress` de que o browser precisa para
        // agir. Medido no DOM com Enter: ['keydown','keyup'] — sem keypress o
        // form NÃO é submetido (a busca da Wikipedia não acontecia).
        // Só as que têm tradução própria (CHAR_BY_KEY); Tab, Esc, setas e
        // F-keys continuam sem text, senão o browser as trataria como caractere.
        const ch = CHAR_BY_KEY[params.key];
        if (ch) params.text = ch;
      }
    }
    return params;
  }

  function clickCountOf(msg) {
    const n = Number(msg.clickCount || msg.detail || 1);
    return Math.min(3, Math.max(1, Math.round(n) || 1));
  }

  return {
    sendInput(msg, ctx) {
      if (!connected) return;
      if (!msg || typeof msg.type !== 'string') return;
      if (ctx && ctx.sessionId) sessionId = ctx.sessionId;
      else if (msg.sessionId) sessionId = msg.sessionId;
      const t = msg.type;
      const modifiers = getModifiers(msg);

      if (t === 'mousemove') {
        // Coalescing: rajadas colapsam no último ponto — 1 dispatchMouseEvent
        // por tick em vez de N (evita fila CDP e cursor atrasado).
        const { x, y } = scalePoint(msg);
        pendingMove = { x, y, modifiers, buttons: pressedMask || undefined };
        if (!moveScheduled) { moveScheduled = true; setImmediate(flushMove); }
      }
      else if (t === 'mousedown') {
        const { x, y } = scalePoint(msg);
        const button = BUTTON_MAP[msg.button] || 'left';
        // ORDEM: o mousemove tem de chegar ANTES do press, senão o :hover não
        // é aplicado no elemento e o clique cai no alvo errado (medido: a
        // ordem real no Chrome era press -> release -> move).
        if (pendingMove) { flushMove(); }
        pressedMask |= BUTTON_MASK[button] || 1;
        pressedButton = button;
        const cc = clickCountOf(msg);
        lastPressCC = cc;
        // Novo press invalida o release anterior (evita dedupe de dblclick
        // velho contaminar este par).
        lastReleaseCC = 0;
        send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y,
          button, clickCount: cc, modifiers, buttons: pressedMask,
        });
      }
      else if (t === 'mouseup') {
        const { x, y } = scalePoint(msg);
        const button = BUTTON_MAP[msg.button] || 'left';
        const mask = BUTTON_MASK[button] || 1;
        // FLUSH do movimento pendente ANTES do release. Sem isso o Chrome
        // recebe o `mousemove` DEPOIS do `mouseup` — ordem real medida no
        // DOM: pointerdown → mousedown → pointerup → mouseup → click →
        // pointermove → mousemove — e o gesto de arraste morre no meio.
        if (pendingMove) { flushMove(); }
        pressedMask &= ~mask;
        if (!pressedMask) pressedButton = null;
        // clickCount no release também: sem ele o Chrome nunca monta o
        // dblclick (detail=2), porque o par press/release precisa bater.
        const cc = msg.clickCount || (lastPressCC > 1 ? lastPressCC : 1);
        lastReleaseCC = cc;
        lastReleaseAt = Date.now();
        lastReleaseX = x; lastReleaseY = y;
        send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button, clickCount: cc,
          modifiers, buttons: pressedMask || undefined,
        });
      }
      else if (t === 'click' || t === 'dblclick') {
        const { x, y } = scalePoint(msg);
        const button = BUTTON_MAP[msg.button] || 'left';
        const cc = t === 'dblclick' ? 2 : clickCountOf(msg);
        // dblclick: press com clickCount 2 + release com clickCount 2.
        if (pendingMove) { flushMove(); }
        // Dedupe: se o release com clickCount 2 acabou de sair nestas
        // coordenadas, o Chrome JÁ sintetizou o dblclick — despachar outro
        // par aqui geraria dblclick duplicado (2 eventos no DOM).
        if (t === 'dblclick' && lastReleaseCC >= 2 &&
            Date.now() - lastReleaseAt < 400 &&
            lastReleaseX === x && lastReleaseY === y) {
          lastPressCC = 0; lastReleaseCC = 0;
          return;
        }
        lastPressCC = cc;
        lastReleaseCC = cc;
        lastReleaseAt = Date.now();
        lastReleaseX = x; lastReleaseY = y;
        send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y,
          button, clickCount: cc, modifiers, buttons: BUTTON_MASK[button] || 1,
        });
        send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button, clickCount: cc, modifiers,
        });
      }
      else if (t === 'scroll' || t === 'wheel') {
        const { x, y } = scalePoint(msg);
        send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y, modifiers,
          deltaX: Math.round(Number(msg.deltaX) || 0),
          deltaY: Math.round(Number(msg.deltaY) || 0),
        });
      }
      else if (t === 'keydown') {
        send('Input.dispatchKeyEvent', buildKeyParams(msg, 'keyDown'));
      }
      else if (t === 'keyup') {
        // keyUp leva code + virtualKey para casar com o keyDown no Chrome.
        send('Input.dispatchKeyEvent', buildKeyParams(msg, 'keyUp'));
      }
      else if (t === 'keypress') {
        const down = buildKeyParams(msg, 'keyDown');
        send('Input.dispatchKeyEvent', down);
        send('Input.dispatchKeyEvent', buildKeyParams(msg, 'keyUp'));
      }
    },

    setViewport(w, h) {
      if (Number.isFinite(+w) && +w > 0) chromeW = +w;
      if (Number.isFinite(+h) && +h > 0) chromeH = +h;
    },

    // Descarrega o mousemove pendente AGORA. O batch (/api/input/batch)
    // usa isso entre as ações: sem o flush, o coalescing (pendingMove +
    // setImmediate) entrega o movimento só no fim — e o Chrome o recebe
    // depois do `mouseup`, o que desfaz o arraste.
    flush() {
      if (pendingMove) flushMove();
    },

    // Espera (bounded) o WS do CDP ficar conectado. O handler abre a
    // conexão 300ms depois de criado; até lá `sendInput` descarta tudo — e a
    // primeira ação de input da sessão (o primeiro arrasto/clique) chegava
    // pela metade. Resolve `true` quando conectou, `false` no timeout.
    waitReady(timeoutMs = 3000) {
      if (connected) return Promise.resolve(true);
      return new Promise((resolve) => {
        let done = false;
        const onReady = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          const i = readyWaiters.indexOf(onReady);
          if (i >= 0) readyWaiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
        readyWaiters.push(onReady);
      });
    },

    setScale(sx, sy) {
      if (Number.isFinite(+sx) && +sx > 0) scaleX = +sx;
      scaleY = (Number.isFinite(+sy) && +sy > 0) ? +sy : scaleX;
    },

    setSessionId(id) { sessionId = id || null; },

    reconnect() {
      retries = 0;
      pendingMove = null; moveScheduled = false; pressedMask = 0; pressedButton = null;
      lastPressCC = 0; lastReleaseCC = 0;
      if (ws) { try { ws.close(); } catch (e) { console.error(`${tag()} erro ao fechar WS no reconnect:`, (e && e.message) || e); } ws = null; }
      connected = false;
      setTimeout(connect, 100);
    },

    stop() {
      retries = 99;
      connected = false;
      pendingMove = null; moveScheduled = false; pressedMask = 0; pressedButton = null;
      lastPressCC = 0; lastReleaseCC = 0;
      if (layoutTimer) { clearInterval(layoutTimer); layoutTimer = null; }
      if (ws) { try { ws.close(); } catch (e) { console.error(`${tag()} erro ao fechar WS no stop:`, (e && e.message) || e); } ws = null; }
    },

    // Viewport real do Chrome (cssLayoutViewport) — diagnóstico.
    getViewport() { return { width: chromeW, height: chromeH }; },
  };
}

module.exports = { createInputHandler };
