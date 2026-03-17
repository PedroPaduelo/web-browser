# Chrome --headless=new: Pesquisa Completa

**Data:** 2026-03-17
**Fontes:** Documentação oficial do Chrome for Developers, Chromium bug tracker, Puppeteer, Chrome DevTools Protocol

---

## 1. Histórico e Contexto

O modo headless do Chrome existe desde o Chrome 59 (2017). Por anos, era uma implementação separada do browser — uma espécie de "segundo browser" empacotado junto com o Chrome, construído em cima da camada `//content` do Chromium, sem usar o código em `//chrome`.

A partir do **Chrome 112 (Março 2023)**, o Chrome introduziu o `--headless=new`: um modo headless completamente reescrito que unifica o headless com o browser headful, compartilhando todo o código de `//chrome`.

### Linha do tempo

| Versão | Evento |
|--------|--------|
| Chrome 59 (2017) | Primeiro `--headless` lançado |
| Chrome 96 (2021) | Novo modo disponível como `--headless=chrome` (experimental) |
| Chrome 109 (2023) | Renomeado para `--headless=new` |
| Chrome 112 (Março 2023) | `--headless=new` entra em estabilidade |
| Chrome 128 (Agosto 2024) | `--headless` sem sufixo passa a apontar para o novo modo |
| Chrome 132 (Janeiro 2025) | Modo antigo removido do Chrome; disponível apenas como binário separado `chrome-headless-shell` |
| Chrome 142 (previsto) | `Emulation.addScreen` / `Emulation.removeScreen` em stable |

---

## 2. Diferenças Fundamentais: Old vs. New Headless

### 2.1 Arquitetura

**Old headless (`--headless=old` / `chrome-headless-shell`):**
- Implementação separada sobre a camada `//content` do Chromium
- NÃO usa o código de `//chrome` (sem perfis de usuário, sem extensões, sem sync, etc.)
- Mais leve: sem D-Bus, sem X11, sem muitas dependências de UI
- Um "segundo browser" no mesmo binário

**New headless (`--headless=new` / `--headless`):**
- Usa o Chrome completo (`//chrome`) — mesmo código do browser headful
- Chrome cria janelas de plataforma, mas não as exibe
- Mesma base de código que o Chrome que usuários usam no desktop
- Mais pesado, mas com paridade total de funcionalidades

### 2.2 Comparação de Recursos

| Recurso | Old Headless | New Headless |
|---------|-------------|--------------|
| Extensões Chrome | Não suportadas | Suportadas (`--load-extension`) |
| Service Workers | Limitado | Total |
| WebGL | Limitado/bugado | Total (com flags corretas) |
| Canvas 2D | Total | Total |
| User-Agent | Expõe `HeadlessChrome/N.N` | UA idêntico ao browser headful |
| `window.chrome` | Ausente | Presente |
| `navigator.plugins` | Vazio | Preenchido |
| Fingerprint de detecção | Fácil de detectar | Difícil de detectar |
| Consumo de RAM | Menor | ~10-15% maior |
| Consumo de CPU | Menor | ~10-15% maior |
| Performance PDF | Rápido | Significativamente mais lento (10x relatado) |
| X11/Display requerido | Não | Não |
| Xvfb requerido | Não | Não |
| CDP completo | Maioria das APIs | Todas as APIs |

### 2.3 User-Agent

```
# Old headless (Chrome 111)
Mozilla/5.0 ... HeadlessChrome/111.0.5555.0 ...

# New headless (Chrome 128+)
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ... Chrome/128.0.0.0 Safari/537.36
# Sem "HeadlessChrome" — idêntico ao browser headful
```

---

## 3. Funcionamento sem Xvfb

### 3.1 Por que o old headless não precisava de Xvfb

O modo antigo era construído sobre `//content` e nunca criava janelas de plataforma. Ele simplesmente não interagia com o display server.

### 3.2 Como o new headless opera sem Xvfb

O `--headless=new` usa uma **tela virtual interna** independente de displays físicos. Quando rodando em headless:

> "Chrome creates, but doesn't display, any platform windows."

O Chrome cria a estrutura interna de janela (compositor, backing store, camadas de renderização), mas não a mapeia para um display X11 real. Isso elimina a necessidade de Xvfb.

### 3.3 Tela virtual e `--screen-info`

A resolução da tela virtual pode ser configurada via flag `--screen-info`:

```bash
# Tela simples 1920x1080
chrome --headless --screen-info="{1920x1080}"

# Com DPI/scale factor
chrome --headless --screen-info="{1920x1080 devicePixelRatio=2.0}"

# Multi-monitor
chrome --headless --screen-info="{1920x1080 label=primary}{1920x1080 label=secondary}"

# Com origem explícita (para multi-monitor adjacente)
chrome --headless --screen-info="{0,0 1920x1080}{1920,0 1920x1080}"
```

Parâmetros do `--screen-info`:
- `X,Y` — origem do display (omitido = `0,0` no primário, adjacente nos secundários)
- `WxH` — largura x altura em pixels
- `devicePixelRatio=N` — fator de escala (DPI)
- `label=nome` — rótulo identificador
- `workArea=X,Y,W,H` — área de trabalho (excluindo taskbar)

Se `{}` vazio, usa padrão `800x600`.

**Nota:** `--screen-info` está disponível desde Chrome 112 em dev/canary; no stable a partir do Chrome 142.

Para versões anteriores, usar `--window-size`:

```bash
chrome --headless --window-size=1920,1080
```

**Alerta conhecido:** Em algumas versões do Chrome 110+, `--window-size` com `--headless=new` produzia screenshots com resolução incorreta (ex: 804x487 em vez de 1920x1080). O `--screen-info` resolve esse problema.

---

## 4. Suporte a CDP (Chrome DevTools Protocol)

### 4.1 Compatibilidade geral

O `--headless=new` tem **suporte completo a todas as APIs CDP**, incluindo domínios que o old headless não suportava ou tinha bugs:

- `Page.*` — completo
- `Network.*` — completo
- `DOM.*` — completo
- `Emulation.*` — completo (incluindo novos `addScreen`/`removeScreen`)
- `Input.*` — completo
- `Runtime.*` — completo
- `Debugger.*` — completo
- `Profiler.*` — completo
- `Target.*` — completo

### 4.2 `Page.startScreencast` — Suporte e Funcionamento

**Status:** Totalmente suportado no `--headless=new`.

O `Page.startScreencast` é o mecanismo principal de captura de frames em tempo real via CDP. Ele transmite frames renderizados como eventos `Page.screencastFrame`.

#### Parâmetros do `Page.startScreencast`

```typescript
{
  format: 'jpeg' | 'png',    // Formato do frame
  quality: number,            // 0-100 (apenas JPEG)
  maxWidth?: number,          // Largura máxima do frame (px)
  maxHeight?: number,         // Altura máxima do frame (px)
  everyNthFrame?: number      // Captura a cada N frames renderizados
}
```

#### Evento `Page.screencastFrame`

```typescript
{
  data: string,              // Frame codificado em base64
  metadata: {
    offsetTop: number,       // Offset do scroll vertical
    pageScaleFactor: number, // Fator de escala da página
    deviceWidth: number,     // Largura do dispositivo
    deviceHeight: number,    // Altura do dispositivo
    scrollOffsetX: number,   // Offset horizontal do scroll
    scrollOffsetY: number,   // Offset vertical do scroll
    timestamp: number        // Timestamp Unix
  },
  sessionId: number          // ID da sessão (necessário para Ack)
}
```

#### OBRIGATÓRIO: `Page.screencastFrameAck`

Cada frame recebido DEVE ser confirmado. Sem isso, o Chrome para de enviar frames e ocorre backlog de memória:

```javascript
Page.screencastFrame(async ({ data, metadata, sessionId }) => {
  // processar frame...
  await Page.screencastFrameAck({ sessionId }); // OBRIGATÓRIO
});
```

#### Comportamento de frame rate

- Chrome renderiza internamente a 60fps
- CDP `Page.startScreencast` entrega no máximo ~30fps (overhead de rede/serialização)
- `everyNthFrame: 1` = máximo de frames disponíveis
- `everyNthFrame: 2` = ~15fps (skip de frames pares)
- Frames só são enviados quando há mudança na página (não em intervalos fixos)
- Para captura de animações a 60fps via CDP, a latência de rede se torna o gargalo

---

## 5. Como Rodar: Configuração Prática

### 5.1 Linha de comando básica

```bash
# Forma mais simples (Chrome 128+, --headless aponta para new)
google-chrome \
  --headless \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --disable-dev-shm-usage \
  about:blank

# Explícito com --headless=new (Chrome 112-127)
google-chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --disable-dev-shm-usage \
  about:blank
```

### 5.2 Flags recomendadas para servidor

```bash
google-chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu-sandbox \
  --window-size=1280,800 \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-extensions \
  --mute-audio \
  about:blank
```

**Flags explicadas:**
- `--no-sandbox` — necessário em containers Docker (root user)
- `--disable-dev-shm-usage` — usa `/tmp` em vez de `/dev/shm` (evita OOM em Docker)
- `--disable-gpu-sandbox` — sandbox de GPU pode causar crashes em ambientes sem GPU
- `--remote-debugging-address=0.0.0.0` — permite conexão de fora do container
- `--mute-audio` — desabilita áudio (sem dispositivo de áudio em servidor)

### 5.3 Descobrir o WebSocket URL

O Chrome imprime o WebSocket URL no stderr quando usa `--remote-debugging-port=0` (porta aleatória):

```bash
# Chrome imprime em stderr:
# DevTools listening on ws://127.0.0.1:XXXXX/devtools/browser/UUID

# Capturar a porta:
chrome --headless=new --remote-debugging-port=0 2>&1 | grep -o 'ws://[^ ]*'
```

Com porta fixa, o endpoint fica em:
```
http://localhost:9222/json/version   → info do browser
http://localhost:9222/json           → lista de targets
ws://localhost:9222/devtools/browser/UUID → WebSocket do browser
```

### 5.4 Conectar via CDP (Node.js)

#### Com `chrome-remote-interface`

```javascript
const CDP = require('chrome-remote-interface');

async function main() {
  const client = await CDP({ port: 9222 });
  const { Page, Network } = client;

  await Page.enable();
  await Network.enable();

  await Page.navigate({ url: 'https://example.com' });
  await Page.loadEventFired();

  // Iniciar screencast
  await Page.startScreencast({
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 720,
    everyNthFrame: 1
  });

  Page.screencastFrame(async ({ data, metadata, sessionId }) => {
    const buf = Buffer.from(data, 'base64');
    // processar buf (JPEG)...
    await Page.screencastFrameAck({ sessionId });
  });

  // Para parar:
  // await Page.stopScreencast();
  // await client.close();
}

main().catch(console.error);
```

#### Com Puppeteer (CDPSession)

```javascript
const puppeteer = require('puppeteer');

async function main() {
  // Conectar a Chrome já rodando
  const browser = await puppeteer.connect({
    browserWSEndpoint: 'ws://localhost:9222/devtools/browser/UUID'
  });

  // Ou lançar novo Chrome:
  const browser2 = await puppeteer.launch({
    headless: true,        // "new" é o default desde Puppeteer 21+
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.goto('https://example.com');

  // Acesso CDP de baixo nível
  const session = await page.createCDPSession();

  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    everyNthFrame: 1
  });

  session.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    // Processar frame base64
    await session.send('Page.screencastFrameAck', { sessionId });
  });
}
```

### 5.5 Exemplo completo: screencast para WebSocket

```javascript
const CDP = require('chrome-remote-interface');
const WebSocket = require('ws');

class ChromeScreencast {
  constructor(cdpPort = 9222) {
    this.cdpPort = cdpPort;
    this.client = null;
    this.streaming = false;
  }

  async connect() {
    this.client = await CDP({ port: this.cdpPort });
    const { Page, Target } = this.client;
    await Page.enable();
    return this;
  }

  async startScreencast(options = {}) {
    const { Page } = this.client;

    const params = {
      format: options.format || 'jpeg',
      quality: options.quality || 80,
      maxWidth: options.maxWidth || 1280,
      maxHeight: options.maxHeight || 720,
      everyNthFrame: options.everyNthFrame || 1
    };

    this.streaming = true;

    Page.screencastFrame(async ({ data, metadata, sessionId }) => {
      if (!this.streaming) return;

      // Emitir frame para listeners
      this.emit('frame', {
        buffer: Buffer.from(data, 'base64'),
        timestamp: metadata.timestamp,
        width: metadata.deviceWidth,
        height: metadata.deviceHeight
      });

      // OBRIGATÓRIO: confirmar o frame
      try {
        await Page.screencastFrameAck({ sessionId });
      } catch (e) {
        // Ignorar erros se já parou
      }
    });

    await Page.startScreencast(params);
  }

  async stopScreencast() {
    this.streaming = false;
    await this.client.Page.stopScreencast();
  }

  async close() {
    await this.client.close();
  }

  // EventEmitter omitido para brevidade
  emit(event, data) { /* ... */ }
}
```

---

## 6. Extensões

### 6.1 Suporte no new headless

O `--headless=new` **suporta extensões Chrome**, ao contrário do old headless que as bloqueava.

Como carregar extensões:

```bash
google-chrome \
  --headless=new \
  --load-extension=/path/to/unpacked/extension \
  --user-data-dir=/tmp/chrome-profile \
  https://example.com
```

**Requisitos:**
- `--load-extension` — caminho para a extensão descompactada (não CRX)
- `--user-data-dir` — diretório de perfil persistente (necessário junto com `--load-extension`)

### 6.2 Limitações de extensões em headless

| Funcionalidade | Status em headless=new |
|----------------|----------------------|
| Background scripts / Service Workers | Funciona |
| Content scripts | Funciona |
| Storage API (`chrome.storage`) | Funciona |
| Declarative Net Request | Funciona |
| Popup (UI de extensão) | Não disponível (sem display) |
| Browser Action / Page Action ícones | Não exibidos |
| `chrome.windows.create()` com UI | Sem efeito visual |
| Extensions instáveis do Manifest V2 | Suporte reduzido |

### 6.3 Mudanças previstas

- Chrome 135: `userScripts.execute()` adicionado
- Chrome 139: Flags `--extensions-on-chrome-urls` e `--disable-extensions-except` removidas dos builds oficiais do Chrome (mas presentes no Chromium)

---

## 7. WebGL e Canvas

### 7.1 Suporte a Canvas 2D

Canvas 2D é totalmente suportado no `--headless=new` sem necessidade de flags especiais. Funciona via renderer de software (Skia) quando não há GPU.

### 7.2 WebGL — Situação por versão

**Até Chrome ~136 (2024):**
Chrome caía automaticamente para SwiftShader (CPU-based software renderer) quando não havia GPU hardware. Funcionava silenciosamente.

**Chrome 137+ (2025):**
O fallback automático para SwiftShader foi depreciado e removido para economizar espaço binário e memória. Chrome desabilita WebGL se não há GPU hardware, a não ser que você configure explicitamente.

**Solução necessária (2025+):**

```bash
google-chrome \
  --headless=new \
  --use-gl=angle \
  --use-angle=swiftshader \
  --no-sandbox \
  --disable-dev-shm-usage \
  https://example.com
```

Flags de rendering:

```bash
# Software rendering via ANGLE + SwiftShader (CPU)
--use-gl=angle --use-angle=swiftshader

# Mesa/LLVM pipe (Linux, quando disponível)
--use-gl=egl --use-angle=swiftshader

# Hardware GPU (quando disponível via NVIDIA, AMD)
--use-gl=egl   # EGL para Linux com GPU real

# Força desabilitar aceleração de hardware (fallback total para software)
--disable-gpu --disable-software-rasterizer
```

### 7.3 WebGL com GPU real em servidor

Para usar GPU hardware em container Linux:

```bash
# NVIDIA
docker run --gpus all ...
google-chrome --headless=new --use-gl=egl --no-sandbox ...

# Mesa/LLVM (sem GPU dedicada)
google-chrome --headless=new --use-gl=egl --use-angle=swiftshader ...
```

### 7.4 Verificar suporte a WebGL via CDP

```javascript
const result = await Runtime.evaluate({
  expression: `
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    gl ? gl.getParameter(gl.RENDERER) : 'WebGL not supported';
  `
});
console.log(result.result.value);
// Output com SwiftShader: "ANGLE (SwiftShader Device (LLVM 17.0.6) (0x0000C0DE))"
// Output com GPU real: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 ...)"
```

---

## 8. Performance

### 8.1 Comparação de overhead

| Métrica | Old Headless / chrome-headless-shell | New Headless (--headless=new) |
|---------|--------------------------------------|-------------------------------|
| RAM base | ~200-300MB | ~300-450MB |
| CPU idle | Menor | ~10-15% maior |
| Geração de PDF (10 páginas) | ~2.9s | ~36.7s (relatado) |
| Page load simples | Mais rápido | ~2-3x mais lento |
| Renderização GPU | Limitada | Total |
| Fingerprint evasão | Fácil de detectar | Difícil de detectar |

**Atenção:** Os benchmarks de "10x mais lento" referem-se principalmente a **geração de PDF** no Puppeteer, uma operação específica. Para uso como remote browser (screencast), o overhead é muito menor.

### 8.2 Por que o new headless é mais lento para PDF

O old headless gerava PDFs diretamente via Chromium headless, sem processar eventos do browser. O new headless passa pelo pipeline completo do Chrome, incluindo perfil de usuário, extensões, networking stack, etc.

### 8.3 Recomendações de performance

Para **remote browser / screencast** (nosso caso de uso):
- `--headless=new` é adequado
- O overhead de performance para renderização de páginas e screencast é aceitável
- O bottleneck será rede e codec, não o Chrome

Para **geração de PDF em volume**:
- Usar `chrome-headless-shell` (old headless) se performance for crítica

Para **scraping / automação simples**:
- `chrome-headless-shell` é mais eficiente
- `--headless=new` se precisar de extensões ou paridade total com browser real

---

## 9. Limitações Conhecidas

### 9.1 Limitações técnicas

1. **GPU sem hardware:** WebGL requer flags explícitas desde Chrome 137 (SwiftShader não é automático)
2. **Áudio:** CDP não captura áudio. Para captura de áudio headless, usar:
   - Web Audio API para capturar no lado do browser
   - PulseAudio virtual em Linux
   - Ferramentas externas de captura de áudio
3. **`--window-size` bug:** Em algumas versões do Chrome 110-119, `--window-size` com `--headless=new` não respeitava o tamanho. Usar `--screen-info` como alternativa.
4. **Popups e dialogs nativos:** `alert()`, `confirm()`, `prompt()` precisam ser tratados via CDP (`Page.javascriptDialogOpening`)
5. **Screen-info em stable:** `Emulation.addScreen`/`Emulation.removeScreen` só no stable a partir do Chrome 142

### 9.2 Limitações de extensões

- Extensões com UI (popup, sidebar) sem efeito visual
- Algumas extensões verificam `window.innerWidth`/`innerHeight` e podem comportar-se diferente
- Extensões que dependem de input de usuário real (mouse, teclado) precisam de simulação CDP

### 9.3 Limitações do screencast CDP

- **Máximo ~30fps** via `Page.startScreencast` (overhead de serialização base64)
- Frames só emitidos em mudanças de tela (não em intervalo fixo)
- Sem captura de áudio nativa
- `everyNthFrame` controla skip de frames mas não garante taxa fixa
- Para captura de animações fluidas a 60fps, considerar alternativas (FFMPEG com Xvfb headful)

### 9.4 Compatibilidade com automação

Frameworks e suas estratégias:

| Framework | Headless New | Configuração |
|-----------|-------------|-------------|
| Puppeteer 21+ | `headless: true` (default) | Default é new |
| Puppeteer < 21 | `headless: 'new'` | Explícito |
| Playwright | `headless: true` | Usa new automaticamente |
| Selenium 4.8+ | `--headless=new` option | Suportado |
| Cypress | Usa `--headless` | Migra automaticamente |

---

## 10. Casos de Uso: Quando Usar Cada Modo

### Use `--headless=new` quando:
- Precisar de **extensões Chrome**
- Necessitar de **paridade total** com browser real (fingerprint, JS APIs)
- Implementar **remote browser** com CDP screencast
- Precisar de **WebGL** com software renderer
- Executar **testes E2E** que devem simular usuário real
- Usar APIs modernas do browser que o old headless não suportava

### Use `chrome-headless-shell` (old headless) quando:
- **Geração de PDF/screenshots em volume** (performance crítica)
- **Scraping simples** sem necessidade de extensões
- **Ambientes muito restritos** de recursos (RAM/CPU)
- Não precisar de extensões ou APIs modernas

---

## 11. Setup Completo para Remote Browser com CDP Screencast

### 11.1 Docker — Dockerfile mínimo

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    wget curl gnupg ca-certificates \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 \
    libexpat1 libfontconfig1 libgbm1 libgcc1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    lsb-release xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Instalar Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | \
    gpg --dearmor > /usr/share/keyrings/google-chrome.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
    http://dl.google.com/linux/chrome/deb/ stable main" > \
    /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && \
    apt-get install -y google-chrome-stable && \
    rm -rf /var/lib/apt/lists/*

# Criar usuário não-root
RUN useradd -m -s /bin/bash chrome
USER chrome

EXPOSE 9222

CMD ["google-chrome", \
     "--headless=new", \
     "--remote-debugging-port=9222", \
     "--remote-debugging-address=0.0.0.0", \
     "--no-sandbox", \
     "--disable-dev-shm-usage", \
     "--disable-gpu-sandbox", \
     "--window-size=1280,800", \
     "--no-first-run", \
     "--no-default-browser-check", \
     "--mute-audio", \
     "about:blank"]
```

### 11.2 Obtendo o WebSocket URL programaticamente

```javascript
const http = require('http');

async function getChromeWSEndpoint(host = 'localhost', port = 9222) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const info = JSON.parse(data);
        resolve(info.webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
}

// Uso:
const wsUrl = await getChromeWSEndpoint();
// ws://localhost:9222/devtools/browser/UUID
```

### 11.3 Screencast completo com Node.js

```javascript
const CDP = require('chrome-remote-interface');
const WebSocket = require('ws');

class BrowserSession {
  constructor({ host = 'localhost', port = 9222 } = {}) {
    this.host = host;
    this.port = port;
    this.cdp = null;
    this.screencasting = false;
    this.frameListeners = new Set();
  }

  async init() {
    this.cdp = await CDP({ host: this.host, port: this.port });
    const { Page, Network, Input } = this.cdp;
    await Page.enable();
    await Network.enable();
    return this;
  }

  async navigate(url) {
    await this.cdp.Page.navigate({ url });
    await this.cdp.Page.loadEventFired();
  }

  async startScreencast({ format = 'jpeg', quality = 80, width = 1280, height = 720 } = {}) {
    if (this.screencasting) return;
    this.screencasting = true;

    this.cdp.Page.screencastFrame(async ({ data, metadata, sessionId }) => {
      if (!this.screencasting) return;

      const frame = {
        data: Buffer.from(data, 'base64'),
        timestamp: metadata.timestamp,
        width: metadata.deviceWidth,
        height: metadata.deviceHeight
      };

      for (const listener of this.frameListeners) {
        listener(frame);
      }

      // Frame ACK — OBRIGATÓRIO
      try {
        await this.cdp.Page.screencastFrameAck({ sessionId });
      } catch (_) {}
    });

    await this.cdp.Page.startScreencast({
      format,
      quality,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1
    });
  }

  onFrame(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async stopScreencast() {
    this.screencasting = false;
    this.frameListeners.clear();
    try {
      await this.cdp.Page.stopScreencast();
    } catch (_) {}
  }

  async sendMouseEvent(type, x, y, button = 'none') {
    await this.cdp.Input.dispatchMouseEvent({
      type,         // 'mouseMoved', 'mousePressed', 'mouseReleased'
      x,
      y,
      button,       // 'left', 'right', 'middle', 'none'
      clickCount: type === 'mousePressed' ? 1 : 0,
      modifiers: 0
    });
  }

  async sendKeyEvent(type, key, text) {
    await this.cdp.Input.dispatchKeyEvent({
      type,         // 'keyDown', 'keyUp', 'char'
      key,
      text: text || key
    });
  }

  async close() {
    await this.stopScreencast();
    await this.cdp.close();
  }
}

// Uso:
const session = await new BrowserSession({ port: 9222 }).init();
await session.navigate('https://example.com');
await session.startScreencast({ format: 'jpeg', quality: 80 });

const unsubscribe = session.onFrame(({ data, timestamp }) => {
  // data = Buffer com JPEG
  // Enviar para clientes WebSocket, etc.
});
```

---

## 12. Fontes

- [Chrome Headless Mode — Chrome for Developers](https://developer.chrome.com/docs/chromium/headless)
- [Download old Headless Chrome as chrome-headless-shell](https://developer.chrome.com/blog/chrome-headless-shell)
- [Screen configuration for automation and testing with Chrome Headless](https://developer.chrome.com/blog/screen-configuration-with-chrome-headless)
- [Getting Started with Headless Chrome (2017, histórico)](https://developers.google.com/web/updates/2017/04/headless-chrome)
- [Chrome DevTools Protocol — Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Headless is Going Away! — Selenium Blog](https://www.selenium.dev/blog/2023/headless-is-going-away/)
- [New headless Chrome fingerprint analysis](https://antoinevastel.com/bot%20detection/2023/02/19/new-headless-chrome.html)
- [Chrome headless modes: Key differences — Nutrient](https://www.nutrient.io/guides/dotnet/troubleshooting/headless-modes-google-chrome/)
- [chrome-remote-interface — npm](https://www.npmjs.com/package/chrome-remote-interface)
- [Screencast frame rate discussion — Chromium headless-dev](https://groups.google.com/a/chromium.org/g/headless-dev/c/6XKLTi5bsZA)
- [FPS option for Page.startScreencast — CDP issue #63](https://github.com/ChromeDevTools/devtools-protocol/issues/63)
- [Puppeteer headless PDF performance issue #10071](https://github.com/puppeteer/puppeteer/issues/10071)
- [How to use Headless Chrome Extensions — ScrapFly](https://scrapfly.io/blog/posts/how-to-use-browser-extensions-with-playwright-puppeteer-and-selenium)
- [WebGL in headless Chrome — Chromium bug #617551](https://bugs.chromium.org/p/chromium/issues/detail?id=617551)
- [Supercharge Web AI: WebGPU, WebGL, Headless Chrome — GitHub Gist](https://gist.github.com/beaufortfrancois/bd9752460d59a7d8ed54e444665c8ab9)
- [--screen-info README — Chromium source](https://chromium.googlesource.com/chromium/src/+/main/components/headless/screen_info/README.md)
