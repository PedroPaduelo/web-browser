# CDP Input Dispatch -- Injecao de Input via Chrome DevTools Protocol

## 1. Visao Geral do Input Domain

O Chrome DevTools Protocol (CDP) expoe o dominio `Input` que permite injetar eventos de
teclado, mouse, touch e texto diretamente no browser engine, sem passar pelo sistema
operacional. A comunicacao acontece via WebSocket entre o cliente e o browser.

Comandos principais do dominio Input:

| Comando | Status | Funcao |
|---------|--------|--------|
| `Input.dispatchKeyEvent` | Estavel | Despacha evento de teclado |
| `Input.dispatchMouseEvent` | Estavel | Despacha evento de mouse |
| `Input.dispatchTouchEvent` | Estavel | Despacha evento de touch |
| `Input.insertText` | Experimental | Insere texto sem simular teclas (IME, emoji) |
| `Input.imeSetComposition` | Experimental | Gerencia composicao IME |
| `Input.setIgnoreInputEvents` | Estavel | Ignora processamento de input |
| `Input.dispatchDragEvent` | Experimental | Despacha evento de drag |
| `Input.emulateTouchFromMouseEvent` | Experimental | Converte mouse em touch |
| `Input.synthesizePinchGesture` | Experimental | Sintetiza pinch gesture |
| `Input.synthesizeScrollGesture` | Experimental | Sintetiza scroll gesture |
| `Input.synthesizeTapGesture` | Experimental | Sintetiza tap gesture |

Referencia oficial: https://chromedevtools.github.io/devtools-protocol/tot/Input/

---

## 2. Input.dispatchKeyEvent

Despacha um evento de teclado para a pagina. Todos os eventos gerados via CDP sao
"trusted" (`isTrusted: true`), diferente de `dispatchEvent()` em JavaScript.

### 2.1 Parametros

| Parametro | Tipo | Obrigatorio | Descricao |
|-----------|------|-------------|-----------|
| `type` | string | Sim | `keyDown`, `keyUp`, `rawKeyDown`, `char` |
| `modifiers` | integer | Nao | Bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8 (default: 0) |
| `timestamp` | TimeSinceEpoch | Nao | Momento do evento |
| `text` | string | Nao | Texto gerado pelo keycode + layout. Necessario para `char`, nao para `keyUp`/`rawKeyDown` |
| `unmodifiedText` | string | Nao | Texto sem modificadores (exceto Shift). Util para atalhos/accelerators |
| `keyIdentifier` | string | Nao | Identificador unico da tecla, ex: `U+0041` |
| `code` | string | Nao | Valor DOM para tecla fisica, ex: `KeyA`, `Enter`, `Tab` |
| `key` | string | Nao | Valor DOM semantico da tecla, ex: `a`, `Enter`, `AltGr` |
| `windowsVirtualKeyCode` | integer | Nao | Windows virtual key code |
| `nativeVirtualKeyCode` | integer | Nao | Codigo nativo da plataforma |
| `autoRepeat` | boolean | Nao | Se foi gerado por auto-repeat |
| `isKeypad` | boolean | Nao | Se veio do keypad numerico |
| `isSystemKey` | boolean | Nao | Se e evento de sistema |
| `location` | integer | Nao | 0=padrao, 1=esquerda, 2=direita |
| `commands` | array[string] | Nao | (Experimental) Comandos de edicao, ex: `selectAll` |

### 2.2 Tipos de Evento de Teclado

Para simular uma tecla pressionada completamente, sao necessarios multiplos eventos:

```
rawKeyDown  ->  Tecla fisica pressionada (sem gerar texto)
keyDown     ->  Tecla logica pressionada
char        ->  Caractere gerado (este que insere texto)
keyUp       ->  Tecla solta
```

Sequencia tipica para digitar a letra "a":

```json
// 1. keyDown
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyDown",
  "key": "a",
  "code": "KeyA",
  "text": "a",
  "windowsVirtualKeyCode": 65
}}

// 2. keyUp
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyUp",
  "key": "a",
  "code": "KeyA",
  "windowsVirtualKeyCode": 65
}}
```

### 2.3 Modifiers (Bitmask)

Os modificadores sao um bit field combinavel com OR:

| Modificador | Valor | Exemplo Combinado |
|-------------|-------|-------------------|
| Nenhum | 0 | - |
| Alt | 1 | Alt+Tab = 1 |
| Ctrl | 2 | Ctrl+C = 2 |
| Meta/Cmd | 4 | Cmd+A = 4 |
| Shift | 8 | Shift+A = 8 |
| Ctrl+Shift | 10 | Ctrl+Shift+End = 10 |
| Ctrl+Alt | 3 | Ctrl+Alt+Del = 3 |
| Ctrl+Alt+Shift | 11 | - |

### 2.4 Teclas Especiais -- Exemplos

**Ctrl+C (copiar):**
```json
// 1. Ctrl down
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyDown",
  "key": "Control",
  "code": "ControlLeft",
  "windowsVirtualKeyCode": 17,
  "modifiers": 2
}}
// 2. C down com modifier Ctrl
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyDown",
  "key": "c",
  "code": "KeyC",
  "windowsVirtualKeyCode": 67,
  "modifiers": 2,
  "text": "\u0003"
}}
// 3. C up
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyUp",
  "key": "c",
  "code": "KeyC",
  "windowsVirtualKeyCode": 67,
  "modifiers": 2
}}
// 4. Ctrl up
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyUp",
  "key": "Control",
  "code": "ControlLeft",
  "windowsVirtualKeyCode": 17
}}
```

**Tab:**
```json
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyDown",
  "key": "Tab",
  "code": "Tab",
  "windowsVirtualKeyCode": 9,
  "nativeVirtualKeyCode": 9
}}
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyUp",
  "key": "Tab",
  "code": "Tab",
  "windowsVirtualKeyCode": 9,
  "nativeVirtualKeyCode": 9
}}
```

**Enter:**
```json
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyDown",
  "key": "Enter",
  "code": "Enter",
  "windowsVirtualKeyCode": 13,
  "text": "\r"
}}
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyUp",
  "key": "Enter",
  "code": "Enter",
  "windowsVirtualKeyCode": 13
}}
```

**Escape:**
```json
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyDown",
  "key": "Escape",
  "code": "Escape",
  "windowsVirtualKeyCode": 27
}}
{"method": "Input.dispatchKeyEvent", "params": {
  "type": "keyUp",
  "key": "Escape",
  "code": "Escape",
  "windowsVirtualKeyCode": 27
}}
```

### 2.5 Tabela de Virtual Key Codes Comuns

| Tecla | windowsVirtualKeyCode | code | key |
|-------|----------------------|------|-----|
| Backspace | 8 | Backspace | Backspace |
| Tab | 9 | Tab | Tab |
| Enter | 13 | Enter | Enter |
| Shift | 16 | ShiftLeft/Right | Shift |
| Control | 17 | ControlLeft/Right | Control |
| Alt | 18 | AltLeft/Right | Alt |
| Escape | 27 | Escape | Escape |
| Space | 32 | Space | (espaco) |
| ArrowLeft | 37 | ArrowLeft | ArrowLeft |
| ArrowUp | 38 | ArrowUp | ArrowUp |
| ArrowRight | 39 | ArrowRight | ArrowRight |
| ArrowDown | 40 | ArrowDown | ArrowDown |
| Delete | 46 | Delete | Delete |
| 0-9 | 48-57 | Digit0-Digit9 | 0-9 |
| A-Z | 65-90 | KeyA-KeyZ | a-z |
| F1-F12 | 112-123 | F1-F12 | F1-F12 |
| Meta (Win/Cmd) | 91 | MetaLeft | Meta |

---

## 3. Input.dispatchMouseEvent

Despacha um evento de mouse para a pagina.

### 3.1 Parametros

| Parametro | Tipo | Obrigatorio | Descricao |
|-----------|------|-------------|-----------|
| `type` | string | Sim | `mousePressed`, `mouseReleased`, `mouseMoved`, `mouseWheel` |
| `x` | number | Sim | Coordenada X em CSS pixels, relativo ao viewport |
| `y` | number | Sim | Coordenada Y em CSS pixels (0 = topo, cresce para baixo) |
| `modifiers` | integer | Nao | Bitmask de modificadores (mesmo do teclado) |
| `timestamp` | TimeSinceEpoch | Nao | Momento do evento |
| `button` | string | Nao | `none`, `left`, `middle`, `right`, `back`, `forward` |
| `buttons` | integer | Nao | Botoes pressionados: Left=1, Right=2, Middle=4, Back=8, Forward=16 |
| `clickCount` | integer | Nao | Numero de cliques (default: 0) |
| `deltaX` | number | Nao | Delta X para mouseWheel |
| `deltaY` | number | Nao | Delta Y para mouseWheel |
| `force` | number | Nao | (Experimental) Pressao normalizada [0,1] |
| `tiltX` | number | Nao | Angulo stylus Y-Z [-90,90] graus |
| `tiltY` | number | Nao | Angulo stylus X-Z [-90,90] graus |
| `pointerType` | string | Nao | `mouse` ou `pen` (default: `mouse`) |

### 3.2 Sequencia para Click

Um click completo requer tres eventos na sequencia:

```json
// 1. Mover o mouse para a posicao
{"method": "Input.dispatchMouseEvent", "params": {
  "type": "mouseMoved",
  "x": 150,
  "y": 200
}}

// 2. Pressionar botao esquerdo
{"method": "Input.dispatchMouseEvent", "params": {
  "type": "mousePressed",
  "x": 150,
  "y": 200,
  "button": "left",
  "clickCount": 1
}}

// 3. Soltar botao esquerdo
{"method": "Input.dispatchMouseEvent", "params": {
  "type": "mouseReleased",
  "x": 150,
  "y": 200,
  "button": "left",
  "clickCount": 1
}}
```

O browser sintetiza o evento `click` a partir da sequencia mousePressed + mouseReleased.
Nao existe um tipo de evento `click` separado no CDP.

### 3.3 Double Click

```json
// Primeiro click (clickCount: 1)
{"method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": 150, "y": 200, "button": "left", "clickCount": 1}}
{"method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": 150, "y": 200, "button": "left", "clickCount": 1}}

// Segundo click (clickCount: 2)
{"method": "Input.dispatchMouseEvent", "params": {"type": "mousePressed", "x": 150, "y": 200, "button": "left", "clickCount": 2}}
{"method": "Input.dispatchMouseEvent", "params": {"type": "mouseReleased", "x": 150, "y": 200, "button": "left", "clickCount": 2}}
```

### 3.4 Scroll (Mouse Wheel)

```json
{"method": "Input.dispatchMouseEvent", "params": {
  "type": "mouseWheel",
  "x": 400,
  "y": 300,
  "deltaX": 0,
  "deltaY": -120
}}
```
Valores negativos de `deltaY` fazem scroll para cima, positivos para baixo.

### 3.5 Drag and Drop

Requer sequencia de eventos:
```
mouseMoved(x1,y1) -> mousePressed(x1,y1) -> mouseMoved(x2,y2) [multiplos] -> mouseReleased(x2,y2)
```
Para que `dragover` funcione em todos os browsers, sao necessarios pelo menos **dois**
`mouseMoved` sobre o alvo de drop.

---

## 4. Input.dispatchTouchEvent

Despacha eventos de touch para a pagina. Util para emular dispositivos moveis.

### 4.1 Parametros

| Parametro | Tipo | Obrigatorio | Descricao |
|-----------|------|-------------|-----------|
| `type` | string | Sim | `touchStart`, `touchEnd`, `touchMove`, `touchCancel` |
| `touchPoints` | array[TouchPoint] | Sim* | Pontos de toque ativos |
| `modifiers` | integer | Nao | Bitmask de modificadores |
| `timestamp` | TimeSinceEpoch | Nao | Momento do evento |

*`touchStart` e `touchMove` devem ter pelo menos 1 ponto. `touchEnd` e `touchCancel`
devem ter 0 pontos.

### 4.2 TouchPoint

| Propriedade | Tipo | Descricao |
|-------------|------|-----------|
| `x` | number | Coordenada X (CSS pixels) |
| `y` | number | Coordenada Y (CSS pixels) |
| `radiusX` | number | Raio X da area de toque (default: 1.0) |
| `radiusY` | number | Raio Y da area de toque (default: 1.0) |
| `rotationAngle` | number | Angulo de rotacao (default: 0.0) |
| `force` | number | Forca do toque (default: 1.0) |
| `id` | number | Identificador unico do ponto de toque entre eventos |

### 4.3 Sequencia para Tap

```json
// touchStart
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchStart",
  "touchPoints": [{"x": 200, "y": 300, "id": 1}]
}}

// touchEnd (sem pontos)
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchEnd",
  "touchPoints": []
}}
```

### 4.4 Sequencia para Swipe

```json
// Inicio do toque
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchStart",
  "touchPoints": [{"x": 200, "y": 400, "id": 1}]
}}

// Movimento (multiplos passos para suavidade)
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchMove",
  "touchPoints": [{"x": 200, "y": 300, "id": 1}]
}}
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchMove",
  "touchPoints": [{"x": 200, "y": 200, "id": 1}]
}}

// Fim do toque
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchEnd",
  "touchPoints": []
}}
```

### 4.5 Multi-touch (Pinch)

```json
// Dois dedos tocam
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchStart",
  "touchPoints": [
    {"x": 150, "y": 300, "id": 1},
    {"x": 250, "y": 300, "id": 2}
  ]
}}

// Dedos se afastam (zoom in)
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchMove",
  "touchPoints": [
    {"x": 100, "y": 300, "id": 1},
    {"x": 300, "y": 300, "id": 2}
  ]
}}

// Fim
{"method": "Input.dispatchTouchEvent", "params": {
  "type": "touchEnd",
  "touchPoints": []
}}
```

---

## 5. Input.insertText

Insere texto diretamente no elemento focado, sem gerar eventos de teclado individuais.
Emula a insercao de texto que nao vem de teclas fisicas (emoji, IME, clipboard).

### 5.1 Parametros

| Parametro | Tipo | Obrigatorio | Descricao |
|-----------|------|-------------|-----------|
| `text` | string | Sim | Texto a inserir |

### 5.2 Quando Usar

- Texto nao-ASCII (chines, japones, coreano, arabe)
- Emojis e simbolos especiais
- Insercao rapida de texto longo (mais eficiente que char por char)
- Quando o JS da pagina nao depende de eventos keydown/keyup

### 5.3 insertText vs dispatchKeyEvent

| Aspecto | dispatchKeyEvent | insertText |
|---------|------------------|------------|
| Gera keydown/keyup/keypress | Sim | Nao |
| Gera InputEvent | Sim (via char) | Sim |
| Requer metadados de tecla | Sim | Nao |
| Suporta teclas especiais (Ctrl, Enter) | Sim | Nao |
| Funciona com IME/emoji/nao-ASCII | Complicado | Sim |
| API experimental | Nao | Sim |
| Chamada unica para texto completo | Nao (precisa loop) | Sim |
| Eventos sao trusted | Sim | Sim |

### 5.4 Padrao Combinado

Para casos como "digitar texto e pressionar Enter para submeter":

```javascript
// 1. Inserir texto rapidamente
await cdp.send('Input.insertText', { text: 'minha busca' });

// 2. Pressionar Enter (precisa de dispatchKeyEvent)
await cdp.send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Enter', code: 'Enter',
  windowsVirtualKeyCode: 13, text: '\r'
});
await cdp.send('Input.dispatchKeyEvent', {
  type: 'keyUp', key: 'Enter', code: 'Enter',
  windowsVirtualKeyCode: 13
});
```

---

## 6. Input.imeSetComposition

Gerencia sessoes de composicao IME (Input Method Editor), usado para idiomas como
chines, japones e coreano onde um caractere final requer multiplas teclas.

### 6.1 Parametros

| Parametro | Tipo | Obrigatorio | Descricao |
|-----------|------|-------------|-----------|
| `text` | string | Sim | Texto candidato da composicao |
| `selectionStart` | integer | Sim | Inicio da selecao |
| `selectionEnd` | integer | Sim | Fim da selecao |
| `replacementStart` | integer | Nao | Inicio do texto a ser substituido |
| `replacementEnd` | integer | Nao | Fim do texto a ser substituido |

### 6.2 Fluxo de Composicao IME

```
1. Usuario comeca a digitar (ex: "ni" em pinyin para chines)
2. imeSetComposition("ni", 0, 2)
   -> Mostra "ni" sublinhado no campo de texto (composicao ativa)

3. IME sugere candidatos: ni, ni hao, etc.
4. imeSetComposition("ni hao", 0, 6)
   -> Atualiza texto sublinhado

5. Usuario seleciona candidato final
6. insertText("你好")
   -> Confirma e insere o texto final

OU para cancelar:
6. imeSetComposition("", 0, 0)
   -> Cancela a composicao
```

### 6.3 Eventos DOM Relacionados

A composicao IME gera eventos DOM especificos:
- `compositionstart` - Inicio da sessao de composicao
- `compositionupdate` - Atualizacao do texto candidato
- `compositionend` - Fim da sessao (confirmacao ou cancelamento)

Frameworks como React usam `onCompositionStart`, `onCompositionUpdate` e
`onCompositionEnd` para gerenciar esses estados. O texto durante composicao nao
deve ser processado como input final ate o `compositionend`.

---

## 7. CDP vs XTEST (xdotool) -- Comparacao

### 7.1 Como XTEST/xdotool Funciona

O xdotool usa dois mecanismos de injecao de input no X11:

**XTEST Extension (mecanismo primario):**
- Injeta eventos no X server como se fossem hardware real
- Eventos NAO carregam a flag `send_event` (nao sao detectaveis como sinteticos)
- Vai para a janela com foco no momento
- Usa `XTestFakeKeyEvent()` e `XTestFakeMotionEvent()`

**XSendEvent (fallback para janelas especificas):**
- Envia eventos diretamente para uma janela especifica pelo window ID
- Eventos tem a flag `send_event = true` (marca de vergonha)
- Muitos programas (xterm, etc) rejeitam esses eventos por seguranca
- Usado quando se especifica `--window` no xdotool

**Mapeamento de teclas no xdotool:**
- Mapeia caracteres para `charcodemap_t` contendo KeyCode, KeySym, group, modmask
- Se a tecla nao existe no keymap atual, encontra um keycode livre e faz binding dinamico
- Suporta toda a sintaxe de KeySym do X11 (ex: `Control_L+c`, `Alt_L+Tab`)

### 7.2 Tabela Comparativa

| Aspecto | CDP Input | XTEST (xdotool) |
|---------|-----------|------------------|
| **Nivel de injecao** | Engine do browser (WebSocket) | X11 display server (OS level) |
| **Escopo** | Somente Chromium | Qualquer app X11 |
| **Deteccao** | Eventos sao trusted no browser | XTEST: indistinguivel de hardware. XSendEvent: detectavel |
| **Foco necessario** | Nao (funciona headless, abas em background) | XTEST: sim, precisa foco. XSendEvent: nao |
| **Latencia** | Baixa (direto no engine) | Media (passa pelo X server) |
| **Coordenadas** | CSS pixels relativo ao viewport | Pixels da tela X11 |
| **Suporte Wayland** | Sim (independente de display server) | Nao funciona no Wayland |
| **Suporte touch** | Sim (dispatchTouchEvent) | Limitado |
| **IME/composicao** | Sim (imeSetComposition) | Nao nativo |
| **Acesso ao DOM** | Sim (mesmo protocolo) | Nenhum |
| **Cross-browser** | Somente Chromium | Qualquer app (Firefox, Chrome, etc) |
| **Headless** | Funciona sem display | Precisa de X server (real ou Xvfb) |
| **Interacao fora do browser** | Nao (file dialogs, popups OS) | Sim |
| **Confiabilidade** | Alta (API deterministica) | Media (depende de foco, timing) |

### 7.3 Quando Usar Cada Um

**Usar CDP Input quando:**
- O alvo e exclusivamente o browser Chromium
- Precisa de controle preciso de eventos DOM
- Operando headless ou em abas sem foco
- Precisa de composicao IME programatica
- Latencia minima e importante
- Precisa combinar com outras operacoes CDP (DOM, Network, etc)

**Usar XTEST/xdotool quando:**
- Precisa interagir com dialogos do OS (file pickers, auth prompts)
- Alvo nao e browser (ou e Firefox/outro browser sem CDP)
- Precisa de input que passa por todo o stack do OS
- Automatizando workflow multi-aplicacao
- Precisa de input indistinguivel de hardware real

### 7.4 Combinando Ambos (Nosso Caso de Uso)

Para um remote browser, o ideal e combinar:

```
Usuario remoto
    |
    v
WebRTC/WebSocket (coordenadas do viewer)
    |
    v
Server traduz coordenadas
    |
    +---> CDP Input (para interacao com paginas web)
    |     - dispatchMouseEvent, dispatchKeyEvent
    |     - Mais rapido, mais preciso, funciona headless
    |
    +---> XTEST/xdotool (fallback para UI do Chrome/OS)
          - File dialogs, extension popups
          - Quando CDP nao alcanca (chrome:// pages)
```

---

## 8. Como Puppeteer Implementa Internamente

Puppeteer e o wrapper oficial do Google sobre o CDP. Suas classes `Keyboard` e `Mouse`
traduzem chamadas de alto nivel em comandos CDP de baixo nivel.

### 8.1 Keyboard

**USKeyboardLayout -- O mapa central de teclas:**

Puppeteer mantem um arquivo `USKeyboardLayout.ts` que exporta `keyDefinitions`,
um objeto que mapeia nomes de teclas para suas propriedades:

```typescript
interface KeyDefinition {
  keyCode?: number;       // Virtual key code
  shiftKeyCode?: number;  // Virtual key code com Shift
  key?: string;           // Valor DOM de key
  shiftKey?: string;      // Valor de key com Shift
  code?: string;          // Valor DOM de code
  text?: string;          // Texto gerado
  shiftText?: string;     // Texto com Shift
  location?: number;      // 0=padrao, 1=left, 2=right, 3=keypad
}

// Exemplos do mapa:
'a':         { keyCode: 65, key: 'a', code: 'KeyA' }
'Backspace': { keyCode: 8,  key: 'Backspace', code: 'Backspace' }
'Enter':     { keyCode: 13, key: 'Enter', code: 'Enter', text: '\r' }
'0':         { keyCode: 48, key: '0', code: 'Digit0' }
```

**keyboard.type(text) -- Fluxo interno:**

```
keyboard.type("Hello")
  |
  Para cada caractere:
  |
  1. Busca o caractere em keyDefinitions
  |
  2. Se encontrou -> keyboard.press(key)
  |     |
  |     +-> keyboard.down(key)
  |     |     +-> CDP: Input.dispatchKeyEvent({
  |     |            type: "keyDown",
  |     |            windowsVirtualKeyCode: keyDef.keyCode,
  |     |            code: keyDef.code,
  |     |            key: keyDef.key,
  |     |            text: keyDef.text
  |     |          })
  |     |     +-> Se tem text: CDP: Input.dispatchKeyEvent({
  |     |            type: "char",
  |     |            text: keyDef.text
  |     |          })
  |     |
  |     +-> keyboard.up(key)
  |           +-> CDP: Input.dispatchKeyEvent({
  |                  type: "keyUp",
  |                  windowsVirtualKeyCode: keyDef.keyCode,
  |                  code: keyDef.code,
  |                  key: keyDef.key
  |                })
  |
  3. Se NAO encontrou (emoji, Unicode) -> CDP: Input.insertText({ text: char })
```

**keyboard.press(key, options) -- Wrapper:**
```javascript
async press(key, options = {}) {
  await this.down(key);
  if (options.delay) await sleep(options.delay);
  await this.up(key);
}
```

**Gerenciamento de modificadores:**

Puppeteer mantem um Set interno de modificadores ativos. Quando `keyboard.down('Control')`
e chamado, adiciona Ctrl ao set. O valor de `modifiers` enviado ao CDP e calculado:

```javascript
_modifierBit(key) {
  if (key === 'Alt') return 1;
  if (key === 'Control') return 2;
  if (key === 'Meta') return 4;
  if (key === 'Shift') return 8;
  return 0;
}
```

### 8.2 Mouse

**mouse.click(x, y, options) -- Fluxo interno:**

```
mouse.click(150, 200, {button: 'left'})
  |
  1. mouse.move(150, 200)
  |     +-> CDP: Input.dispatchMouseEvent({
  |            type: "mouseMoved", x: 150, y: 200
  |          })
  |
  2. mouse.down({button: 'left'})
  |     +-> CDP: Input.dispatchMouseEvent({
  |            type: "mousePressed", x: 150, y: 200,
  |            button: "left", clickCount: 1
  |          })
  |
  3. Se options.delay -> await sleep(delay)
  |
  4. mouse.up({button: 'left'})
        +-> CDP: Input.dispatchMouseEvent({
               type: "mouseReleased", x: 150, y: 200,
               button: "left", clickCount: 1
             })
```

**mouse.wheel(options) -- Scroll:**
```javascript
async wheel(options = {}) {
  await this._client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: this._x,
    y: this._y,
    deltaX: options.deltaX || 0,
    deltaY: options.deltaY || 0
  });
}
```

---

## 9. Como Playwright Implementa Internamente

Playwright tem uma arquitetura mais complexa que Puppeteer, suportando multiplos browsers.

### 9.1 Arquitetura de Camadas

```
Codigo do usuario (Python/Java/JS/.NET)
    |
    v  (WebSocket RPC -- Playwright Protocol)
Playwright Node.js Server
    |
    v  (CDP / CDP+ / BiDi)
Browser Engine (Chromium / Firefox / WebKit)
    |
    v
Eventos DOM: keydown, keyup, keypress, mousemove, mousedown, mouseup
```

### 9.2 CDP+ (Extensao do Playwright)

Playwright usa "CDP+" -- uma extensao proprietaria do CDP padrao que inclui:
- Capacidades adicionais para cross-browser
- Tracing e HAR recording
- Suporte a out-of-process iframes
- Patches nos engines Firefox e WebKit para suportar o mesmo protocolo

### 9.3 Diferencas de API

**locator.fill(text) vs locator.pressSequentially(text):**

- `fill()` - Foca o elemento e dispara um `InputEvent` diretamente. Nao gera
  keydown/keyup. Mais rapido mas menos realista.
- `pressSequentially()` - Gera todos os eventos de teclado (keydown, keyup, keypress)
  caracter por caracter. Aceita `delay` entre teclas. Mais lento mas simula usuario real.

### 9.4 Performance

- Puppeteer e 15-20% mais rapido que Playwright em Chromium porque usa CDP nativo
  diretamente
- Playwright adiciona uma camada de abstracao JavaScript para compatibilidade
  cross-browser
- Para performance maxima, alguns projetos usam CDP diretamente via
  `page.context().newCDPSession(page)` mesmo dentro do Playwright

---

## 10. Problemas Conhecidos e Workarounds

### 10.1 Modifiers que Nao Funcionam

Alguns desenvolvedores reportam que `modifiers` nao funciona como esperado. O problema
geralmente e um destes:

1. **Falta o `key` correto do modifier**: Precisa enviar keyDown do modifier ANTES
2. **windowsVirtualKeyCode errado**: Deve corresponder ao `code`
3. **Falta o `text` para char com modifier**: Ctrl+C precisa text: "\u0003"

### 10.2 dispatchMouseEvent Retorna Cedo Demais

`Input.dispatchMouseEvent()` pode retornar antes do handler da pagina processar o click.
Workaround: Adicionar um `Runtime.evaluate` ou `waitForFunction` apos o click
para verificar o efeito esperado.

### 10.3 Eventos em iframes

CDP Input events sao despachados no contexto do frame principal. Para iframes:
- Usar a sessao CDP do iframe especifico (via `Target.attachToTarget`)
- Ou ajustar as coordenadas para serem relativas ao iframe

### 10.4 Keyboard Layout

CDP assume layout US QWERTY por padrao. Para outros layouts:
- `code` sempre representa a tecla fisica (KeyA e sempre a primeira tecla da segunda
  fileira, independente do layout)
- `key` e `text` devem ser ajustados para o caractere correto do layout
- `windowsVirtualKeyCode` segue o padrao Windows para o layout ativo

### 10.5 Nota sobre Alt+Tab e Atalhos do OS

`Alt+Tab` e outros atalhos do window manager NAO funcionam via CDP porque:
- CDP injeta no contexto do browser engine, nao no OS
- O window manager intercepta esses atalhos antes de chegarem ao browser
- Para esses casos, XTEST/xdotool e necessario

---

## 11. Implementacao Recomendada para Remote Browser

### 11.1 Arquitetura de Input Handler

```javascript
class CDPInputHandler {
  constructor(cdpClient) {
    this.cdp = cdpClient;
    this.modifiers = 0; // bitmask de modificadores ativos
  }

  // --- Mouse ---
  async mouseMove(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, modifiers: this.modifiers
    });
  }

  async mouseDown(x, y, button = 'left') {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button,
      clickCount: 1, modifiers: this.modifiers
    });
  }

  async mouseUp(x, y, button = 'left') {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button,
      clickCount: 1, modifiers: this.modifiers
    });
  }

  async click(x, y, button = 'left') {
    await this.mouseMove(x, y);
    await this.mouseDown(x, y, button);
    await this.mouseUp(x, y, button);
  }

  async scroll(x, y, deltaX, deltaY) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY,
      modifiers: this.modifiers
    });
  }

  // --- Keyboard ---
  async keyDown(key, code, keyCode) {
    const mod = this._modifierBit(key);
    if (mod) this.modifiers |= mod;

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key, code,
      windowsVirtualKeyCode: keyCode,
      modifiers: this.modifiers,
      text: this._keyText(key)
    });
  }

  async keyUp(key, code, keyCode) {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key, code,
      windowsVirtualKeyCode: keyCode,
      modifiers: this.modifiers
    });

    const mod = this._modifierBit(key);
    if (mod) this.modifiers &= ~mod;
  }

  async type(text) {
    // Para texto longo, usar insertText (mais rapido)
    await this.cdp.send('Input.insertText', { text });
  }

  async typeSequentially(text, delay = 0) {
    for (const char of text) {
      const keyDef = KEY_MAP[char];
      if (keyDef) {
        await this.keyDown(keyDef.key, keyDef.code, keyDef.keyCode);
        await this.keyUp(keyDef.key, keyDef.code, keyDef.keyCode);
        if (delay > 0) await sleep(delay);
      } else {
        // Caractere sem mapeamento (emoji, unicode)
        await this.cdp.send('Input.insertText', { text: char });
      }
    }
  }

  // --- Touch ---
  async tap(x, y) {
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }]
    });
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    });
  }

  // --- Helpers ---
  _modifierBit(key) {
    switch(key) {
      case 'Alt': return 1;
      case 'Control': return 2;
      case 'Meta': return 4;
      case 'Shift': return 8;
      default: return 0;
    }
  }

  _keyText(key) {
    if (key === 'Enter') return '\r';
    if (key === 'Tab') return '\t';
    if (key.length === 1) return key;
    return '';
  }
}
```

### 11.2 Traducao de Eventos do Cliente WebRTC

O frontend envia eventos do browser do usuario via DataChannel. O server traduz:

```javascript
// Frontend envia:
{
  type: 'mousedown',
  x: 342,          // coordenada no viewer
  y: 189,
  button: 0,       // 0=left, 1=middle, 2=right
  viewportWidth: 1280,
  viewportHeight: 720
}

// Server traduz para CDP:
function translateMouseButton(domButton) {
  switch(domButton) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    case 3: return 'back';
    case 4: return 'forward';
    default: return 'none';
  }
}

// Escalar coordenadas se viewer != browser viewport
function scaleCoords(x, y, viewerWidth, viewerHeight, browserWidth, browserHeight) {
  return {
    x: (x / viewerWidth) * browserWidth,
    y: (y / viewerHeight) * browserHeight
  };
}
```

### 11.3 Traducao de Eventos de Teclado

```javascript
// Frontend envia evento KeyboardEvent nativo:
{
  type: 'keydown',
  key: 'a',
  code: 'KeyA',
  keyCode: 65,     // deprecated mas util
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false
}

// Server converte modifiers para bitmask:
function modifiersToBitmask(event) {
  let mask = 0;
  if (event.altKey) mask |= 1;
  if (event.ctrlKey) mask |= 2;
  if (event.metaKey) mask |= 4;
  if (event.shiftKey) mask |= 8;
  return mask;
}

// E despacha via CDP
async function handleKeyEvent(event) {
  const cdpType = event.type === 'keydown' ? 'keyDown' : 'keyUp';
  await cdp.send('Input.dispatchKeyEvent', {
    type: cdpType,
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.keyCode,
    modifiers: modifiersToBitmask(event),
    text: event.type === 'keydown' ? event.key.length === 1 ? event.key : '' : ''
  });
}
```

---

## 12. Resumo Pratico

1. **CDP Input e a escolha principal** para remote browser porque opera dentro do engine,
   funciona headless, nao precisa de foco e gera eventos trusted.

2. **dispatchKeyEvent** para todas as interacoes de teclado que precisam gerar eventos DOM
   completos (keydown/keyup/keypress). Necessario para atalhos, navegacao e teclas
   especiais.

3. **insertText** para insercao rapida de texto, especialmente nao-ASCII. Nao gera
   eventos de teclado, apenas InputEvent.

4. **imeSetComposition** para suporte a idiomas CJK e outros que usam IME. Permite
   mostrar candidatos e confirmar composicao.

5. **dispatchMouseEvent** para toda interacao de mouse. Lembrar que click = mouseMoved +
   mousePressed + mouseReleased (3 chamadas CDP separadas).

6. **dispatchTouchEvent** para emulacao mobile. touchStart/touchMove precisam de
   touchPoints, touchEnd/touchCancel nao.

7. **XTEST/xdotool como fallback** para dialogs de arquivo, atalhos do window manager
   (Alt+Tab) e interacoes fora do browser que CDP nao alcanca.

8. **Puppeteer/Playwright** servem como referencia de implementacao -- ambos usam CDP
   internamente com a mesma mecanica descrita aqui, adicionando mapeamento de teclas
   (USKeyboardLayout) e gerenciamento de estado de modificadores.
