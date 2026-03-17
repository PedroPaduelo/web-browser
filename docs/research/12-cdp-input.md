# Chrome DevTools Protocol (CDP) - Input Methods

## 📋 Índice

1. [Visão Geral](#visão-gera)
2. [Métodos Principais](#métodos-principais)
3. [Input.dispatchMouseEvent](#inputdispatchmouseevent)
4. [Input.dispatchKeyEvent](#inputdispatchkeyevent)
5. [Input.dispatchTouchEvent](#inputdispatchtouchevent)
6. [Scroll e Gestos](#scroll-e-gestos)
7. [Conversão de Coordenadas](#conversão-de-coordenadas)
8. [Problemas Conhecidos](#problemas-conhecidos)
9. [Playwright vs CDP Direto](#playwright-vs-cdp-direto)
10. [Latência e Performance](#latência-e-performance)
11. [Exemplos Práticos](#exemplos-práticos)

---

## Visão Geral

O **Chrome DevTools Protocol (CDP)** é o protocolo subjacente que permite instrumentar, inspecionar, debugar e perfilar navegadores Chromium/Chrome. O domínio `Input` fornece métodos para simular eventos de entrada do usuário (mouse, teclado, toque).

### Características Importantes

- **Synthetic vs Native**: Eventos CDP são **sintéticos** e não equivalentes a eventos nativos do sistema operacional
- **Coordenadas**: Sempre relativas ao viewport da main frame em **CSS pixels**
- **Modificadores**: Bitfield representando teclas modificadoras pressionadas
- **Protocolo assíncrono**: Comandos são enviados via WebSocket e requerem acknowledgement

---

## Métodos Principais

### Lista Completa

| Método | Descrição | Tipo |
|--------|-----------|------|
| `Input.dispatchMouseEvent` | Despacha evento de mouse | Core |
| `Input.dispatchKeyEvent` | Despacha evento de teclado | Core |
| `Input.dispatchTouchEvent` | Despacha evento de toque | Core |
| `Input.dispatchDragEvent` | Despacha evento de drag-and-drop | Experimental |
| `Input.emulateTouchFromMouseEvent` | Converte mouse → touch | Experimental |
| `Input.insertText` | Insere texto (emoji, IME) | Experimental |
| `Input.setIgnoreInputEvents` | Ignora eventos de entrada | Utility |
| `Input.setInterceptDrags` | Intercepta drag-and-drop | Experimental |
| `Input.synthesizePinchGesture` | Sintetiza gesto de pinça | Experimental |
| `Input.synthesizeScrollGesture` | Sintetiza gesto de scroll | Experimental |
| `Input.synthesizeTapGesture` | Sintetiza gesto de tap | Experimental |
| `Input.imeSetComposition` | Define composição IME | Experimental |

---

## Input.dispatchMouseEvent

### Especificação Completa

```typescript
interface MouseEventParams {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;                          // Coordenada X em CSS pixels (relativo ao viewport)
  y: number;                          // Coordenada Y em CSS pixels (relativo ao viewport)
  modifiers?: number;                 // Bitfield de teclas modificadoras
  timestamp?: number;                 // TimeSinceEpoch (segundos desde 1970-01-01 UTC)
  button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
  buttons?: number;                   // Bitmask de botões pressionados
  clickCount?: number;                // Número de cliques (0=single, 1=double, 2=triple)
  force?: number;                     // Pressão normalizada [0,1] (pen/stylus)
  tangentialPressure?: number;        // Pressão tangencial normalizada [-1,1]
  tiltX?: number;                     // Ângulo tilt [-90,90] (positivo → direita)
  tiltY?: number;                     // Ângulo tilt [-90,90] (positivo → usuário)
  twist?: number;                     // Rotação do stylus [0-359°] (sentido horário)
  deltaX?: number;                    // Delta horizontal do scroll (apenas mouseWheel)
  deltaY?: number;                    // Delta vertical do scroll (apenas mouseWheel)
  pointerType?: 'mouse' | 'pen';      // Tipo de dispositivo apontador
}
```

###Tipos de Evento (`type`)

| Tipo | Descrição | Uso Típico |
|------|-----------|------------|
| `mousePressed` | Botão pressionado | Begin click, start drag |
| `mouseReleased` | Botão liberado | End click, end drag |
| `mouseMoved` | Mouse moveu (sem botão) | Hover, move |
| `mouseWheel` | Evento de scroll/rodinha | Scroll vertical/horizontal |

### Botões (`button`)

```typescript
enum MouseButton {
  'none'    = 0,  // Nenhum botão
  'left'    = 1,  // Botão esquerdo (primário)
  'middle'  = 2,  // Botão do meio (scroll)
  'right'   = 3,  // Botão direito (context menu)
  'back'    = 4,  // Botão voltar (navegador)
  'forward' = 5   // Botão avançar (navegador)
}
```

### Bitmask de Botões Pressionados (`buttons`)

Valores são **acumulativos** (soma binária OR):

```typescript
const ButtonsMask = {
  NONE:   0,    // 0b00000
  LEFT:   1,    // 0b00001
  RIGHT:  2,    // 0b00010
  MIDDLE: 4,    // 0b00100
  BACK:   8,    // 0b01000
  FORWARD: 16   // 0b10000
};

// Exemplo: Left + Right = 1 | 2 = 3
// Exemplo: All buttons = 1|2|4|8|16 = 31
```

### Modificadores (`modifiers`) - Bitfield

```typescript
const ModifierMask = {
  Alt:    1,    // 0b0001
  Ctrl:   2,    // 0b0010
  Meta:   4,    // 0b0100 (Command no macOS)
  Shift:  8     // 0b1000
};

// Exemplos de combinações:
// Shift+Ctrl = 8 | 2 = 10
// Ctrl+Alt+Shift = 2 | 1 | 8 = 11
// Nenhum = 0
```

### Click Count (`clickCount`)

| Valor | Significado | Tempo entre cliques |
|-------|-------------|---------------------|
| 0 | Single click | N/A (evento move) |
| 1 | Double click | ~300ms (varia por SO) |
| 2 | Triple click | ~300ms entre cada |

**Nota**: CDP **não** calcule automaticamente o intervalo entre cliques — você deve enviar os eventos sequencialmente com delay apropriado.

---

## Input.dispatchKeyEvent

### Especificação Completa

```typescript
interface KeyEventParams {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  modifiers?: number;                 // Bitfield (Alt=1, Ctrl=2, Meta=4, Shift=8)
  timestamp?: number;                 // TimeSinceEpoch
  text?: string;                      // Texto gerado (para 'char' ou 'keyDown')
  unmodifiedText?: string;            // Texto sem modificadores (ex: para atalhos)
  keyIdentifier?: string;             // Ex: "U+0041" (deprecated)
  code?: string;                      // Código físico DOM: "KeyA", "Digit1", "ArrowLeft"
  key?: string;                       // Valor DOM considerando layout: "a", "A", "å"
  windowsVirtualKeyCode?: number;     // VK code Windows (ex: 65 = 'A')
  nativeVirtualKeyCode?: number;      // VK code nativo do SO
  autoRepeat?: boolean;               // Evento gerado por auto-repeat?
  isKeypad?: boolean;                // Veio do teclado numérico?
  isSystemKey?: boolean;             //Tecla de sistema (ex: Alt+F4)?
  location?: number;                  // Posição física: 0=standard, 1=left, 2=right
  commands?: string[];                // Comandos de edição: ['selectAll', 'copy', 'paste']
}
```

### Tipos de Key Event

| Tipo | Quando usar | O que envia |
|------|-------------|-------------|
| `keyDown` | Tecla物理 pressionada | keyDown event com `code`, `key` |
| `keyUp` | Tecla física liberada | keyUp event |
| `rawKeyDown` | Pressionamento cru (sem mapeamento layout) | Usado internamente, raramente necessário |
| `char` | Caractere resultante (após modifier processing) | Input event com texto |

### Fluxo Correto para Digitação

```javascript
// Digitar texto "Hello" (caixa de texto vazia)

// 1. Focus no elemento (via mouse ou JS)
await sendCDP('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: inputX, y: inputY,
  button: 'left'
});
await sendCDP('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: inputX, y: inputY,
  button: 'left'
});

// 2. Para CADA caractere:

// Para 'H':
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyDown',
  code: 'KeyH',                    // Código físico
  key: 'H',                        // Considerando Shift ativo
  windowsVirtualKeyCode: 72,       // VK para 'H'
  modifiers: ModifierShift         // Shift pressionado
});
await sendCDP('Input.dispatchKeyEvent', {
  type: 'char',
  text: 'H',
  unmodifiedText: 'h'              // Sem Shift seria 'h'
});
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyUp',
  code: 'KeyH'
});
```

### Atalhos de Teclado

```javascript
// Ctrl+S (Salvar)
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyDown',
  code: 'KeyS',
  key: 'S',
  modifiers: ModifierCtrl
});
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyUp',
  code: 'KeyS',
  modifiers: ModifierCtrl
});

// Meta+Enter no macOS (Command+Enter)
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyDown',
  code: 'Enter',
  key: 'Enter',
  modifiers: ModifierMeta
});
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyUp',
  code: 'Enter'
});

// Comandos de Edição (Select All)
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyDown',
  code: 'KeyA',
  key: 'a',
  modifiers: ModifierCtrl,
  commands: ['selectAll']  // ou Ctrl+A
});
await sendCDP('Input.dispatchKeyEvent', {
  type: 'keyUp',
  code: 'KeyA'
});
```

### Input.insertText (Texto IME/Emoji)

Para texto que não vem de keypress físico (emoji, composição IME):

```javascript
await sendCDP('Input.insertText', {
  text: '👋 Olá Mundo 🌍'
});
```

---

## Input.dispatchTouchEvent

### Especificação Completa

```typescript
interface TouchEventParams {
  type: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel';
  touchPoints: Array<{
    x: number;                        // Coordenada X em CSS pixels
    y: number;                        // Coordenada Y em CSS pixels
    radiusX?: number;                 // Raio X da área de toque (default: 1.0)
    radiusY?: number;                 // Raio Y da área de toque (default: 1.0)
    rotationAngle?: number;           // Ângulo de rotação da ellipse (default: 0.0)
    force?: number;                   // Força da pressão [0,1] (default: 1.0)
    id?: number;                      // ID único do toque (obrigatório)
    // Campos experimentais:
    tangentialPressure?: number;      // Pressão tangencial [-1,1]
    tiltX?: number;                   // Tilt X [-90,90]
    tiltY?: number;                   // Tilt Y [-90,90]
    twist?: number;                   // Rotação [0-359]
  }>;
  modifiers?: number;                 // Bitfield modificadores
  timestamp?: number;                 // TimeSinceEpoch
}
```

### Regras Críticas

- **`touchStart` e `touchMove`**: **DEVEM** ter `touchPoints.length >= 1`
- **`touchEnd` e `touchCancel`**: **DEVEM** ter `touchPoints.length === 0`
- Cada toque em sequência precisa de `id` único persistente até `touchEnd`

### Single Tap (Toque Simples)

```javascript
const TOUCH_ID = 12345;
const x = 100, y = 200;

// 1. touchStart
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{
    x, y,
    id: TOUCH_ID,
    radiusX: 2.5,      // Aproximado do dedo (~5mm em 2x DPR)
    radiusY: 2.5,
    force: 1.0
  }]
});

// 2. Pequena pausa (opcional, ~50ms)
await sleep(50);

// 3. touchEnd
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchEnd',
  touchPoints: [],        // Vazio obrigatório!
  modifiers: 0
});
```

### Double Tap (Toque Duplo)

```javascript
const TOUCH_ID = 54321;
const x = 150, y = 250;

// Primeiro tap
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x, y, id: TOUCH_ID }]
});
await sleep(100);  // 100ms entre taps
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchEnd',
  touchPoints: []
});

// Segundo tap
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x, y, id: TOUCH_ID }]
});
await sleep(50);
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchEnd',
  touchPoints: []
});
```

### Multi-Touch (2 dedos)

```javascript
// Dois toques simultâneos
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [
    { x: 100, y: 200, id: 1 },
    { x: 120, y: 220, id: 2 }  // ~20px de separação
  ]
});

// Movimento em paralelo (pinch/spread)
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchMove',
  touchPoints: [
    { x: 90, y: 190, id: 1 },   // Dedos se aproximando
    { x: 130, y: 230, id: 2 }
  ]
});
```

### Drag via Touch

```javascript
// Simular arrastar um elemento de (startX,startY) para (endX,endY)
const TOUCH_ID = 999;
const STEPS = 20;

// 1. touchStart no elemento
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: startX, y: startY, id: TOUCH_ID }]
});
await sleep(50);

// 2. Interpolar caminho
for (let i = 1; i <= STEPS; i++) {
  const ratio = i / STEPS;
  const cx = startX + (endX - startX) * ratio;
  const cy = startY + (endY - startY) * ratio;

  await sendCDP('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: cx, y: cy, id: TOUCH_ID }]
  });
  await sleep(16); // ~60fps
}

// 3. touchEnd
await sendCDP('Input.dispatchTouchEvent', {
  type: 'touchEnd',
  touchPoints: []
});
```

---

## Scroll e Gestos

### Scroll via Mouse Wheel

```javascript
// Scroll vertical para baixo (200px)
await sendCDP('Input.dispatchMouseEvent', {
  type: 'mouseWheel',
  x: viewportX, y: viewportY,  // Ponto de scroll (centro da tela ou alvo)
  deltaX: 0,                   // 0 para scroll puramente vertical
  deltaY: 200,                 // Positivo = scroll para baixo (content move up)
  modifiers: 0
});

// Scroll horizontal para esquerda (100px)
await sendCDP('Input.dispatchMouseEvent', {
  type: 'mouseWheel',
  x: viewportX, y: viewportY,
  deltaX: -100,                // Negativo = scroll para esquerda
  deltaY: 0
});
```

**Obs**: `deltaY` positivo → conteúdo move para **cima** (viewport desce). Isso segue a convenção do DOM WheelEvent.

### Scroll via Touch Gesture (Sintético)

```javascript
// Scroll vertical para baixo usando Input.synthesizeScrollGesture
await sendCDP('Input.synthesizeScrollGesture', {
  x: viewportX,
  y: viewportY,
  xDistance: 0,
  yDistance: 200,              // Positivo = scroll para baixo
  xOverscroll: 0,
  yOverscroll: 0,
  preventFling: true,
  speed: 800,                  // pixels/segundo
  gestureSourceType: 'touch'   // Gera eventos touch
});

// Scroll com "bounce" (iOS overscroll)
await sendCDP('Input.synthesizeScrollGesture', {
  x: viewportX,
  y: viewportY,
  xDistance: 0,
  yDistance: 300,
  yOverscroll: 100,            // Scroll extra + bounce de 100px
  preventFling: false,
  speed: 800
});
```

### Tap Gesture

```javascript
// Simple tap (melhor que dispatchMouseEvent para mobile)
await sendCDP('Input.synthesizeTapGesture', {
  x: 100,
  y: 200,
  duration: 50,                // ms entre touchDown e touchUp
  tapCount: 1,
  gestureSourceType: 'touch'
});

// Double tap
await sendCDP('Input.synthesizeTapGesture', {
  x: 150, y: 250,
  tapCount: 2,
  duration: 100
});
```

### Pinch/Zoom Gesture

```javascript
// Zoom in (scale factor > 1.0)
await sendCDP('Input.synthesizePinchGesture', {
  x: viewportCenterX,
  y: viewportCenterY,
  scaleFactor: 1.5,            // 1.5x zoom in
  relativeSpeed: 800,
  gestureSourceType: 'touch'
});

// Zoom out
await sendCDP('Input.synthesizePinchGesture', {
  x: viewportCenterX,
  y: viewportCenterY,
  scaleFactor: 0.7,            // 0.7x = zoom out
  relativeSpeed: 800
});
```

---

## Conversão de Coordenadas

### Sistemas de Coordenadas

```
┌─────────────────────────────────────────┐
│ DOM / Viewport (CSS pixels)             │
│   y↓                                    │
│   ┌─────────────────────────────┐      │
│   │                             │      │
│   │    Page Content             │      │
│   │    (scrollX, scrollY)       │      │
│   │       ↓                     │      │
│   │    Viewport (0,0) ← top-left│      │
│   │      x→                     │      │
│   └─────────────────────────────┘      │
│                                         │
│ CDP.dispatchMouseEvent usa VIEWPORT    │
│ (coordenadas ajustadas por scroll)     │
└─────────────────────────────────────────┘

Screen (físico, pixels device)
│   x→
└──┘
```

### Convertendo Page → Viewport (CDP)

```javascript
/**
 * Converte coordenadas absolutas da página para coordenadas
 * relativas ao viewport (como CDP espera)
 *
 * @param pageX - Coordenada X absoluta da página
 * @param pageY - Coordenada Y absoluta da página
 * @param scrollX - window.scrollX
 * @param scrollY - window.scrollY
 * @param devicePixelRatio - window.devicePixelRatio (1 ou 2+)
 * @returns {x, y} em CSS pixels relativos ao viewport
 */
function pageToViewport(pageX, pageY, scrollX, scrollY, devicePixelRatio = 1) {
  return {
    x: Math.round((pageX - scrollX) * devicePixelRatio),
    y: Math.round((pageY - scrollY) * devicePixelRatio)
  };
}

/**
 * Converte coordenadas da viewport (CSS pixels) para
 * coordenadas do dispositivo (DPR-aware)
 *
 * CDP espera coordenadas em CSS pixels, mas para event
 * synthesis precisamos considerar DPR?
 * Resposta: CDP NO MANIPULA DPR automaticamente
 */
function viewportToDevice(viewportX, viewportY, devicePixelRatio) {
  return {
    x: viewportX * devicePixelRatio,
    y: viewportY * devicePixelRatio
  };
}
```

### Exemplo Prático: Clicar em Elemento

```javascript
async function clickElementViaCDP(page, selector) {
  // 1. Obter bounding box do elemento
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('Element not found');
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,     // Centro X
      y: rect.top + rect.height / 2,    // Centro Y
      width: rect.width,
      height: rect.height,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
  }, selector);

  // 2. Converter para viewport coordinates (CDP-native)
  const vpX = Math.round(box.x - box.scrollX);  // = box.x se viewport já está ajustado
  const vpY = Math.round(box.y - box.scrollY);

  // 3. Move mouse
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: vpX,
    y: vpY
  });

  // 4. Click (press + release)
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: vpX, y: vpY,
    button: 'left',
    clickCount: 1
  });

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: vpX, y: vpY,
    button: 'left',
    clickCount: 1
  });
}
```

### Considerações DPR (Device Pixel Ratio)

**Importante**: CDP opera em **CSS pixels**. Em telas HiDPI (DPR=2), um `x=100` corresponde a 200物理 pixels.

```javascript
// Se você calcula coordenadas baseado em canvas size:
const canvas = document.querySelector('canvas');
const rect = canvas.getBoundingClientRect();
const cssX = rect.left + 50;  // 50px dentro do canvas em CSS
const cssY = rect.top + 50;

// CDP espera esse valor CSS diretamente
await sendCDP('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: cssX,
  y: cssY
});
```

**Não multiply por DPR!** CDP lida com a conversão internamente.

### Viewport vs Page vs Screen

- **Viewport (CDP default)**: Coordenadas relativas à área visível (ajustada por scroll)
- **Page**: Coordenadas absolutas desde o topo da página (pageX, pageY em mouse events)
- **Screen**: Coordenadas da tela física (screenX, screenY)

CDP **não** suporta `screenX/screenY` nativamente — são "fake" (ver Problemas Conhecidos).

---

## Problemas Conhecidos

### 1. Fake `screenX` e `screenY`

**Problema**: Quando `Input.dispatchMouseEvent` é chamado, o `MouseEvent`/`PointerEvent` gerado possui `screenX` e `screenY` **falsos** — eles são definidos como os mesmos valores de `x` e `y`. Isso diverge de eventos nativos do mouse.

```javascript
// Com CDP:
const e = await page.evaluate(() => {
  document.addEventListener('click', (ev) => {
    console.log('screenX:', ev.screenX, 'clientX:', ev.clientX);
  });
  document.click();
});
// Output: screenX: 100, clientX: 100 (falso! screenX deveria ser relativo à tela)
```

**Impacto**:
- Cloudflare Turnstile detecta essa anomalia e marca o browser como bot
- reCAPTcha pode falhar em detectar interações genuínas
- Scripts anti-bot que verificam `screenX/screenY` consistency irão falhar

**Mitigação**: Nenhuma via CDP puro. Playwright injeta código JS para corrigir (ver seção Playwright).

### 2. Timeout de Protocolo

**Erro**: `ProtocolError: Input.dispatchMouseEvent timed out`

**Causas**:
- Páginas com reCAPTcha em Docker/cabeçalho
- Chrome/CDP travando sob carga
-Timeout padrão (30s-5min?) insuficiente

**Solução**: Aumentar `protocolTimeout` ao conectar:

```javascript
// Puppeteer example
const browser = await puppeteer.launch({
  protocolTimeout: 120000  // 2 minutos
});

// CDP via WebSocket
const client = new WebSocket(url, { handshakeTimeout: 120000 });
```

**Nota**: Mesmo aumentando, reCAPTcha ainda pode travar.

### 3. "Target closed" em Drag-and-Drop

**Erro**: `Error: Protocol error (Input.dispatchMouseEvent): Target closed`

**Causa**:
- Target (page) foi fechado/destruído durante sequência de eventos
- Race condition: eventos enfileirados sem await apropriado
- Frame navigation durante input

**Mitigação**:
```javascript
// ❌ ERRADO: enfileirar sem esperar
await Promise.all([
  cdpsend({type:'mousePressed', x:100, y:100}),
  cdpsend({type:'mouseReleased', x:200, y:200})
]);

// ✅ CORRETO: aguardar cada ack
await cdpsend({type:'mousePressed', x:100, y:100});
await sleep(50);
await cdpsend({type:'mouseReleased', x:200, y:200});
```

### 4. Sequência Drag-and-Drop Misaligned

**Problema**: Se você emitir todos eventos de uma sequência drag sem esperar ACKs, o comportamento diverge de navegadores reais, onde eventos são sincronizados com renderização.

**Exemplo problemático**:
```javascript
// Quick fire (rápido demais)
for (let i=0; i<10; i++) {
  await cdpsend({type:'mouseMove', x:startX+i*10, y:startY});
  // Sem delay, não tem tempo de layout/repaint
}
```

**Solução**: Delay de **~50ms entre eventos** para matched com input humano.

### 5. Mozilla CDP Bug - Undefined Promise

No Firefox, await `undefined` resolves imediatamente, causando falsos positivos em testes:

```javascript
// Bug Mozilla: a promise undefined → resolves instantly
// Testes podem passar mesmo se evento não disparou
await someCDPCall();  // Na verdade retorna undefined!
// Test continua sem saber que falhou
```

**Workaround**: Validar manualmente que ação ocorreu no DOM.

### 6. Button ≠ buttons Inconsistency

Em alguns browsers/chrome versions:

```javascript
// Se você envia:
{ button: 'left', buttons: 1 }  // Consistente

// Mas se envia apenas button sem buttons:
{ button: 'left' }  // buttons default para undefined → interpretado como 0 (nenhum)
```

**Regra**: Sempre envie `buttons` em conjunto com `button`.

### 7. Wheel Delta Precision

`deltaX`/`deltaY` são **CSS pixels por evento wheel**, não por frame. Lines-to-pixel conversion é browser-dependent.

**Heurística**:
```javascript
// 1 linha de wheel ≈ 100-150 CSS pixels (varia por chrome flag: --enable-precise-mouse-wheel)
const LINE_HEIGHT = 100;
const pixelsToScroll = lines * LINE_HEIGHT;
```

### 8. Touch Event IDs Must Persist

Se você reutilizar o mesmo `touchPoint.id` em diferentes eventos sem `touchEnd`, comportamentos estranhos ocorrem (fantasma touches).

**Regra**:
```javascript
// ❌ BAD: reuse ID sem touchEnd
dispatch({type:'touchStart', points:[{id:1, x:100, y:100}]});
dispatch({type:'touchStart', points:[{id:1, x:200, y:200}]}); // Erro!

// ✅ GOOD: único ID até touchEnd
dispatch({type:'touchStart', points:[{id:1, x:100, y:100}]});
dispatch({type:'touchMove', points:[{id:1, x:150, y:150}]});
dispatch({type:'touchEnd', points:[]}); // ID liberado
dispatch({type:'touchStart', points:[{id:1, x:200, y:200}]}); // OK reusar
```

---

## Playwright vs CDP Direto

### Por que Playwright é Mais Confiável?

Playwright **não** usa `Input.dispatchMouseEvent` diretamente. Em vez disso, ele injeta uma[s] "helper functions" no contexto da página para simular eventos **nativos**.

#### Arquitetura Playwright

```
┌─────────────────┐    CDP
│ Playwright API  │─────→ Page.evaluate(() => { native events })
└─────────────────┘          ↓
        ↓                   Element.dispatchEvent(new MouseEvent(...))
   Test Code
```

#### Implementação Simplificada

```javascript
// ❌ CDP Direto (Puppeteer/raw CDP)
await page.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: 100, y: 100,
  button: 'left'
});

// ✅ Playwright (usando page.click internamente)
await page.evaluate((x, y) => {
  const el = document.elementFromPoint(x, y);
  const rect = el.getBoundingClientRect();

  // 1. Create NATIVE MouseEvent (não sintético CDP)
  const down = new MouseEvent('mousedown', {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  });

  const up = new MouseEvent('mouseup', {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0
  });

  // 2. Dispatch on target element
  el.dispatchEvent(down);
  el.dispatchEvent(up);

  // 3. Dispara também click (comum em browsers)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, x, y);
```

#### Como Playwright Corrige screenX/screenY Fake

Playwright **sobrescreve** as propriedades após criar o evento:

```javascript
// Dentro de elementHandle.dispatchEvent():
const event = new MouseEvent(type, eventInit);

// Patch screenX/screenY para valores realisticos
Object.defineProperty(event, 'screenX', {
  value: window.screenX + (clientX - window.screenAvailWidth/2),
  writable: false
});
Object.defineProperty(event, 'screenY', {
  value: window.screenY + (clientY - window.screenAvailHeight/2),
  writable: false
});

element.dispatchEvent(event);
```

Dessa forma, `event.screenX` reflete valores plausíveis baseados na posição da janela no sistema.

#### Drag-and-Drop Playwright

```javascript
// Playwright usa source.handle → hover → mousedown → move → mouseup
async function dragAndDrop(source, target) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  // 1. Mouse over source
  await page.mouse.move(
    sourceBox.x + sourceBox.width/2,
    sourceBox.y + sourceBox.height/2
  );

  // 2. Mouse down
  await page.mouse.down();

  // 3. Move para target (com delays realísticos)
  await page.mouse.move(
    targetBox.x + targetBox.width/2,
    targetBox.y + targetBox.height/2,
    { steps: 10 }  // Interpola 10 frames ~ 166ms
  );

  // 4. Mouse up
  await page.mouse.up();
}
```

Internamente, Playwright usa `Input.dispatchMouseEvent` **apenas** para os eventos de `mousedown`, `mousemove`, `mouseup`, mas:

1. **Delay** entre eventos (steps)
2. **Interpolação** linear de coordenadas
3. **Teclas modificadoras** corretas no estado
4. **Timestamps** aproximados de input real
5. **Sobrescrita** de screenX/screenY via JS

---

## Latência e Performance

### Comparativo: CDP vs X11 Input

#### X11 (Input Direto via Sistema)

```bash
# Usando xdotool (simula input no nível X server)
xdotool mousemove 100 200
xdotool click 1
xdotool type "Hello"
```

**Características**:
- **Latência**: ~5-20ms (input → display)
- **Sistema Operacional**: Eventos são **reais** do X11/Wayland
- `screenX/screenY`: Corretos (gerados pelo kernel/display server)
- Limitação: Só funciona em desktop com servidor X11
- Headless? Não (requer DISPLAY)

### CDP (Input Sintético)

```javascript
// Via WebSocket → Chrome DevTools Agent → Blink EventHandler
await sendCDP(...)
```

**Latência**:
- CDP roundtrip WebSocket: ~2-10ms
- Chrome processamento interno: ~2-5ms
- Renderização: ~16ms (1 frame @ 60Hz)
- **Total estimado**: ~20-40ms (sem render block)

### Benchmarks Comparativos

| Métrica | X11 Direct | CDP (`dispatchMouseEvent`) |
|---------|------------|---------------------------|
| Latência point-to-point | 5-20ms | 20-40ms |
| Precisão coordenada | Pixel-perfect (root window) | CSS pixels, viewport-relative |
| screenX/screenY | ✅ Verdadeiros | ❌ Fakes (== clientX/Y) |
| Detecção bot | ❌ Difícil (eventos nativos) | ✅ Fácil (anomalias sintéticas) |
| Headless | ❌ Require Xvfb/Xephyr | ✅ Nativo (--headless) |
| CI/CD | ✅ Com xvfb-run | ✅ Sem X server |
| Multi-frame support | ❌ Window-focused apenas | ✅ Qualquer frame |
| Touch events | ❌ Limitado (XTEST) | ✅ Nativo via `dispatchTouchEvent` |

### Tabela de Latências Observadas

```
┌──────────────────────────────────────────┐
│      Latência (milissegundos)            │
├──────────────────────────────────────────┤
│ Input Humano real → Display              │
│   Teclado → OS → App → Render           │
│   ≈ 40-80ms (varia por hardware)        │
├──────────────────────────────────────────┤
│ X11 xdotool → XServer → Chrome          │
│   ≈ 15-35ms                              │
├──────────────────────────────────────────┤
│ CDP WS → Chrome Agent → Blink → Render  │
│   ≈ 25-60ms                              │
├──────────────────────────────────────────┤
│ Playwright JS injection (page.evaluate) │
│   ≈ 30-70ms ( + overhead JS eval)       │
└──────────────────────────────────────────┘
```

**Conclusão**: CDP tem latência aceitável (30-60ms), comparable a X11. O problema **não** é velocidade, mas **detectability**.

### Por que CDP é Detectable?

1. **Missing `isTrusted` flag**: Eventos criados via `dispatchEvent` (que CDP usa internamente) têm `isTrusted = false`. Eventos nativos (mouse keyboard físico) têm `isTrusted = true`.

```javascript
page.evaluate(() => {
  document.addEventListener('click', (e) => {
    console.log('isTrusted:', e.isTrusted); // true (nativo) vs false (CDP sintético)
  });
});
```

2. **Fake screenX/screenY** (já discutido)
3. **Timing patterns**: CDP envia eventos com间隔 muito regular (exatos 100ms entre keyDown/keyUp), enquanto humano é irregular.
4. **Missing phase events**: CDP pode não disparar todos os eventos de bubbling/capturing em ordem correta.

---

## Exemplos Práticos

### Template Completo de Envio CDP

```javascript
class CDPInput {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.messageId = 0;
    this.pending = new Map();
    this.setupListeners();
  }

  setupListeners() {
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        this.pending.delete(msg.id);
      }
    };
  }

  async send(method, params = {}) {
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id, method, params
      }));
      // Timeout de sicurezza
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout ${method}`));
        }
      }, 30000);
    });
  }
}

// Uso:
const cdp = new CDPInput('ws://localhost:9222/devtools/browser/...');

// Mouse click
async function click(x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1,
    modifiers: 0
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1,
    modifiers: 0
  });
}

// Double click
async function doubleClick(x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 2
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 2
  });
}

// Right click
async function rightClick(x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'right'
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'right'
  });
}

// Keyboard type
async function typeText(text) {
  for (const char of text) {
    const code = this.charToCode(char);
    const modifiers = char === char.toUpperCase() ? ModifierShift : 0;

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      code,
      key: char,
      modifiers,
      windowsVirtualKeyCode: codeToVK(code)
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char',
      text: char
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      code,
      key: char,
      modifiers
    });
    await sleep(50); // humano-like delay
  }
}

// Scroll
async function scroll(deltaX, deltaY) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 500, y: 300,  // centro da tela (viewport)
    deltaX, deltaY
  });
}

// Touch tap
async function tap(x, y) {
  const id = Date.now();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id, radiusX: 2, radiusY: 2 }]
  });
  await sleep(50);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
}
```

### Helper: charToCode mapping

```javascript
const KEY_MAP = {
  'a': 'KeyA', 'b': 'KeyB', 'c': 'KeyC',
  'A': 'Shift+KeyA', 'B': 'Shift+KeyB',
  '1': 'Digit1', '2': 'Digit2',
  'Enter': 'Enter', ' ': 'Space',
  'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
  'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight'
};

function charToCode(char) {
  // Simplificado — em produção use tabela completa
  if (char >= 'a' && char <= 'z') return 'Key' + char.toUpperCase();
  if (char >= 'A' && char <= 'Z') return 'Key' + char;
  if (char >= '0' && char <= '9') return 'Digit' + char;
  return char;
}
```

### Drag via CDP (Sequência Completa)

```javascript
async function dragAndDropCDP(startX, startY, endX, endY, steps = 20) {
  const id = Date.now();

  // 1. Mouse down no elemento (press)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX, y: startY,
    button: 'left',
    clickCount: 0,
    buttons: 1  // Left button pressed
  });
  await sleep(50);

  // 2. Interpola mouseMoved
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    // Easing quadrático para movimento natural
    const eased = ratio * ratio;
    const cx = startX + (endX - startX) * eased;
    const cy = startY + (endY - startY) * eased;

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(cx), y: Math.round(cy),
      button: 'left',
      buttons: 1
    });

    await sleep(1000 / 60); // 60fps
  }

  // 3. Mouse up no destino
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX, y: endY,
    button: 'left',
    clickCount: 0,
    buttons: 0
  });

  // 4. Opcional: click event (browsers disparam click em mouseup se não moveu mais que threshold)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', // Só para gerar click? Não — click é automático em alguns casos
    x: endX, y: endY,
    button: 'left',
    clickCount: 1
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX, y: endY,
    button: 'left',
    clickCount: 1
  });
}
```

### Coordenadas de Canvas (Jogos/WebGL)

```javascript
// Para interagir com elemento canvas:
async function clickCanvas(canvasSelector, canvasX, canvasY) {
  // 1. Posição do canvas na página
  const rect = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, dpr: window.devicePixelRatio };
  }, canvasSelector);

  // 2. Converter canvas-local → viewport
  const vpX = Math.round(rect.left + canvasX * rect.dpr);
  const vpY = Math.round(rect.top + canvasY * rect.dpr);

  // 3. Click
  await click(vpX, vpY);
}
```

### Scroll infinity (lazy load)

```javascript
// Scrolar até o fundo (auto-reload pages)
async function scrollToBottom(page, maxScrolls = 50) {
  let lastHeight = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) break;

    // Scroll por wheel gesture
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 500, y: 300,
      deltaX: 0,
      deltaY: 2000  // Grande enough para skip animations
    });

    await sleep(1000);  // Espera lazy load
    lastHeight = height;
  }
}
```

---

## Referências e Fontes

- [Chrome DevTools Protocol - Input Domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [Chrome DevTools Protocol Documentation](https://chromedevtools.github.io/devtools-protocol/)
- [Puppeteer Issues - dispatchMouseEvent timeout](https://github.com/puppeteer/puppeteer/issues/10513)
- [Cloudflare Turnstile - CDP detection](https://github.com/ObjectAscended/CDP-bug-MouseEvent-.screenX-.screenY-patcher)
- [Playwright Source - Input Handling](https://github.com/microsoft/playwright)
- [Mozilla Bug 1635496 - dispatchMouseEvent](https://bugzilla.mozilla.org/show_bug.cgi?id=1635496)
- [MDN - MouseEvent](https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent)
- [Chromium DevTools Protocol Docs](https://chromium.googlesource.com/devtools/devtools-frontend/+/HEAD/docs/devtools-protocol.md)

---

## 📊 Resumo Final

| Tópico | Recomendação |
|--------|-------------|
| Mouse click | `dispatchMouseEvent` (press + release) com delays 50-100ms |
| Keyboard | `dispatchKeyEvent` + `char` + `keyUp` (respeitar modifiers) |
| Touch | `dispatchTouchEvent` (start/move/end) ou `synthesizeTapGesture` |
| Scroll | `mouseWheel` ou `synthesizeScrollGesture` (mais realista) |
| Drag | Interpolação linear de `mouseMoved` com 60fps (steps=20) |
| Coordenadas | Sempre viewport-relative (ajustar por scrollX/Y) |
| Bot detection | CDP puro **não** funciona; requer JS injection (Playwright-style) |
| Performance | Latência 20-40ms aceitável; problema é detectability |
| Recomendação | Usar Playwright ou injetar JS nativo em vez de CDP raw |

---

## ✅ Checklist para Implementação Robusta

- [ ] Converter page → viewport coordinates corretamente
- [ ] Incluir `buttons` bitmask em todos os mouse events
- [ ] Aguardar ACK entre cada comando CDP (não enfileirar)
- [ ] Delay de ~50-100ms entre keyDown/keyUp/char
- [ ] Interpolar drag com >10 steps e 60fps timing
- [ ] Tratar `isTrusted` limitation (aceitar que é detectável)
- [ ] Increase protocolTimeout para reCAPTcha sites
- [ ] Considerar usar Playwright em vez de CDP raw para sites com bot detection
- [ ] Testar em DPR=1 e DPR=2 screens

---

**Data da Pesquisa**: 2026-03-17
**Versão do Documento**: 1.0
**Fonte das Informações**: Chrome DevTools Protocol官方文档, GitHub issues (Puppeteer, WebdriverIO), Mozilla Bugzilla, Playwright implementation analysis
