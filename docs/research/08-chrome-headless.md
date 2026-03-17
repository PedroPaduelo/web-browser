# Chrome Headless: Guia Completo para Remote Browser Services

**Data:** 2026-03-17
**Fontes:** Documentação oficial do Chrome for Developers, Chromium bug tracker, Puppeteer, Playwright, Chrome DevTools Protocol

---

## 1. Diferença entre Chrome Headless Old e New (--headless=new)

### 1.1 Histórico e Evolução

O modo headless do Chrome existe desde o **Chrome 59 (2017)**. Por anos, foi uma implementação separada do browser — empacotada no mesmo binário, mas construída sobre a camada `//content` do Chromium, sem usar o código de `//chrome`.

A partir do **Chrome 112 (Março 2023)**, o Chrome introduziu o `--headless=new`: um modo headless completamente reescrito que unifica o headless com o browser headful, compartilhando todo o código.

### Linha do tempo oficial:

| Versão | Evento |
|--------|--------|
| Chrome 59 (2017) | Primeiro `--headless` lançado |
| Chrome 96 (2021) | Novo modo disponível como `--headless=chrome` (experimental) |
| Chrome 109 (2023) | Renomeado para `--headless=new` |
| Chrome 112 (Março 2023) | `--headless=new` entra em estabilidade |
| Chrome 128 (Agosto 2024) | `--headless` sem sufixo passa a apontar para o novo modo |
| Chrome 132 (Janeiro 2025) | Modo antigo removido do Chrome; disponível apenas como binário separado `chrome-headless-shell` |

### 1.2 Arquitetura: Old vs New

#### Old Headless (`--headless=old` / `chrome-headless-shell`)

- Implementação separada sobre a camada `//content` do Chromium
- **NÃO** usa o código de `//chrome` (sem perfis de usuário, sem extensões, sem sync)
- Mais leve: sem D-Bus, sem X11, sem dependências de UI
- Um "segundo browser" no mesmo binário
- Totalmente independente da stack de UI do Chrome

#### New Headless (`--headless=new` / `--headless`)

- Usa o Chrome completo (`//chrome`) — mesmo código do browser headful
- Chrome cria janelas de plataforma, mas **não as exibe**
- Mesma base de código que o Chrome que usuários usam no desktop
- Mais pesado, mas com **paridade total de funcionalidades**
- Mesmo ciclo de renderização do browser real

> **Citando a documentação oficial:** "Chrome creates, but doesn't display, any platform windows. All other functions, existing and future, are available with no limitations."

### 1.3 Comparação de Recursos

| Recurso | Old Headless | New Headless |
|---------|-------------|--------------|
| Extensões Chrome | ❌ Não suportadas | ✅ Suportadas (`--load-extension`) |
| Service Workers | ⚠️ Limitado | ✅ Total |
| WebGL | ⚠️ Limitado/bugado | ✅ Total (com flags corretas) |
| Canvas 2D | ✅ Total | ✅ Total |
| User-Agent | Expõe `HeadlessChrome/N.N` | UA idêntico ao browser headful |
| `window.chrome` | ❌ Ausente | ✅ Presente |
| `navigator.plugins` | ⚠️ Vazio | ✅ Preenchido |
| Fingerprint de detecção | ❌ Fácil de detectar | ✅ Difícil de detectar |
| Consumo de RAM | ~200-300MB | ~300-450MB (+10-15%) |
| Consumo de CPU idle | Menor | ~10-15% maior |
| Performance PDF | ✅ Rápido | ⚠️ Significativamente mais lento (10x relatado) |
| X11/Display requerido | ❌ Não | ❌ Não |
| Xvfb requerido | ❌ Não | ❌ Não |
| CDP completo | ⚠️ Maioria das APIs | ✅ Todas as APIs |
| Chrome DevTools | Limitado | Completo |

### 1.4 Mudanças no User-Agent

```javascript
// Old headless (Chrome 111)
Mozilla/5.0 ... HeadlessChrome/111.0.5555.0 Safari/537.36

// New headless (Chrome 128+)
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ... Chrome/128.0.0.0 Safari/537.36
// Sem "HeadlessChrome" — idêntico ao browser headful
```

A remoção da string `HeadlessChrome` do user-agent foi uma mudança crítica para evitar detecção simples de bots.

---

## 2. Funciona CDP Page.startScreencast no Modo Headless?

### Status: ✅ Totalmente Suportado

O `Page.startScreencast` funciona **perfeitamente** no `--headless=new`. Esta é uma das principais razões para usar o novo modo.

### 2.1 Como Funciona

O `Page.startScreencast` é o mecanismo principal de captura de frames em tempo real via CDP (Chrome DevTools Protocol). Ele transmite frames renderizados como eventos `Page.screencastFrame`.

#### Parâmetros:

```typescript
{
  format: 'jpeg' | 'png',    // Formato do frame
  quality: number,            // 0-100 (apenas JPEG)
  maxWidth?: number,          // Largura máxima do frame (px)
  maxHeight?: number,         // Altura máxima do frame (px)
  everyNthFrame?: number      // Captura a cada N frames renderizados
}
```

#### Evento `Page.screencastFrame`:

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

### 2.2 Mecanismo de Confirmação (Frame Ack)

**CRÍTICO:** Cada frame recebido DEVE ser confirmado com `Page.screencastFrameAck`. Sem isso:

- O Chrome para de enviar frames
- Ocorre backlog de memória
- A captura trava

```javascript
Page.screencastFrame(async ({ data, metadata, sessionId }) => {
  // Processar frame...
  const buffer = Buffer.from(data, 'base64');
  // Enviar para cliente WebSocket, etc.

  // OBRIGATÓRIO: confirmar o frame
  await Page.screencastFrameAck({ sessionId });
});
```

### 2.3 Comportamento de Frame Rate

- Chrome renderiza internamente a **60fps**
- CDP `Page.startScreencast` entrega no máximo **~30fps** (overhead de rede/serialização)
- `everyNthFrame: 1` = máximo de frames disponíveis (~30fps)
- `everyNthFrame: 2` = ~15fps (skip de frames pares)
- **Frames só são enviados quando há mudança na página** (não em intervalos fixos)
- Para captura de animações a 60fps via CDP, a latência de rede se torna o gargalo

### 2.4 Limitações do Screencast CDP

- **Máximo ~30fps** via `Page.startScreencast` (overhead de serialização base64)
- Frames só emitidos em mudanças de tela (não em intervalo fixo)
- **Sem captura de áudio nativa** — CDP não captura áudio do browser
- `everyNthFrame` controla skip de frames mas não garanta taxa fixa
- Para captura de animações fluidas a 60fps, considerar alternativas (FFMPEG com Xvfb headful)
- Latência típica: 50-200ms dependendo da rede e compressão

---

## 3. Limitações de Rendering no Modo Headless

### 3.1 GPU e WebGL

#### O Problema Core

Por padrão, o Chrome headless **desabilita GPU acceleration**. Isso significa:

- WebGL cai para fallback de software (SwiftShader) ou fica desabilitado
- Animações WebGL/Metal podem ser bugadas ou lentas
- Antes de Chrome 137: fallback automático para SwiftShader funcionava
- Chrome 137+: fallback automático foi removido para economizar espaço binário

#### Habilitação de GPU no Headless (Linux)

Para habilitar GPU em containers Linux:

```bash
google-chrome \
  --headless=new \
  --no-sandbox \
  --use-angle=vulkan \
  --enable-features=Vulkan \
  --disable-vulkan-surface \
  --enable-unsafe-webgpu \
  about:blank
```

Flags detalhadas:

| Flag | Descrição |
|------|-----------|
| `--no-sandbox` | Desabilita sandbox de segurança (necessário em Docker rodando como root) |
| `--use-angle=vulkan` | Usa Vulkan backend para ANGLE (traduz OpenGL ES → Vulkan) |
| `--enable-features=Vulkan` | Habilita backend Vulkan para compositing e rasterização |
| `--disable-vulkan-surface` | Desabilita extensão VK_KHR_surface; usa Bit blit para presente |
| `--enable-unsafe-webgpu` | Habilita API WebGPU experimental no Linux |

#### Verificação de WebGL

```javascript
const result = await Runtime.evaluate({
  expression: `
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    gl ? gl.getParameter(gl.RENDERER) : 'WebGL not supported';
  `
});
console.log(result.result.value);
// Com SwiftShader: "ANGLE (SwiftShader Device (LLVM 17.0.6) (0x0000C0DE))"
// Com GPU real: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 ...)"
```

### 3.2 Canvas 2D

Canvas 2D **funciona perfeitamente** no `--headless=new` sem flags especiais. Renderiza via Skia (renderer de software) quando não há GPU.

### 3.3 Limitações de UI e Extensões

| Funcionalidade | Status em headless=new |
|----------------|----------------------|
| Popup de extensão (UI) | ❌ Não disponível (sem display) |
| Browser Action ícones | ❌ Não exibidos |
| `chrome.windows.create()` com UI | ⚠️ Sem efeito visual |
| Permissões nativas (geolocation, notifications) | ✅ Funciona via CDP override |
| `alert()`, `confirm()`, `prompt()` | ⚠️ Precisam ser tratados via CDP (`Page.javascriptDialogOpening`) |
| File Picker nativo | ⚠️ Interage, mas UI não é visível |

### 3.4 Limitações de Múltiplas Janelas/Monitores

- Até Chrome 141: `--window-size` único para todas as janelas
- Chrome 142+: `Emulation.addScreen`/`Emulation.removeScreen` permite configurar múltiplos displays virtuais
- Para diferentes viewports, usar DP ratio em elementos específicos

---

## 4. Headless vs Xvfb (Headful)

### 4.1 O que é Xvfb?

**Xvfb (X Virtual Framebuffer)** é um display server virtual para Unix. Ele permite rodar aplicações gráficas (como Chrome) sem um display físico.

**Diferença fundamental:**

- **Headless (`--headless=new`)**: Chrome **cria** janelas internamente, mas **não** usa display server
- **Xvfb + Headful**: Chrome roda **normalmente** (headful) mas renderiza em memória via Xvfb

### 4.2 Comparação Detalhada

| Aspecto | Headless Chrome | Xvfb + Headful Chrome |
|---------|----------------|----------------------|
| **Arquitetura** | Sem display server | Display server virtual (X11) |
| **Instalação** | Simples (só Chrome) | Requer Xvfb + configuração |
| **Uso de RAM** | ~300-450MB | ~400-600MB (+ Xvfb overhead) |
| **Uso de CPU** | Menor | ~15-20% maior |
| **Rendering fidelity** | Pode diferir do browser real | ⭐ Próximo de 100% (mesmo código) |
| **Extensões** | ✅ Suportadas | ✅ Suportadas |
| **WebGL/GPU** | ⚠️ Requer flags especiais | ✅ Hardware acceleration nativo |
| **Debugging** | Remoto (DevTools) | Pode usar VNC para visualização direta |
| **Bot detection** | Mais facilmente detectável | Difícil de detectar (muito similar a real) |
| **Popups/modals** | Funcionam logicamente | Funcionam visualmente |
| **Screen capture** | Via CDP screencast (~30fps) | Via X11 grab (ffmpeg/x11grab, até 60fps) |
| **Captura de áudio** | ❌ Não nativa | ✅ Possível com PulseAudio virtual |
| **Setup complexity** | ⭐ Baixa | ⚠️ Média/Alta |

### 4.3 Performance: Benchmark Real

**Benchmark do grupo Chromium headless-dev:**

- Chromium + Xvfb: 39 segundos para carregar site pesado 3 vezes
- Headless Chrome (Debug build): 129 segundos
- Headless Chrome (Release build): 81 segundos para 10 cargas
- Chromium + Xvfb: 96 segundos para 10 cargas

**Conclusão:** Em Release mode, **headless Chrome é mais rápido** (~15% mais rápido). O teste inicial mostrou o oposto devido a Debug build.

### 4.4 Problemas Específicos de Xvfb

1. **Sessões concorrentes**: Se rodar múltiplas abas no mesmo processo Xvfb:
   - Cookies/localStorage podem interferir
   - Só é possível fazer screenshot da aba ativa
   - Workaround: processos Xvfb separados por sessão

2. **Escalabilidade**:
   - Cada instância Xvfb consome ~50-100MB extra
   - Limite prático: ~20-30 sessões por servidor (vs 50-100 com headless puro)

3. **Performance de vídeo**:
   - X11 grab (ffmpeg) tem ~5-10% overhead
   - Compressão via CPU pode ser pesada
   - Headless + CDP screencast tem overhead de serialização base64

---

## 5. Performance: Headless vs Xvfb

### 5.1 Métricas Comparativas

| Métrica | Headless New | Xvfb + Headful |
|---------|--------------|----------------|
| Startup time | ~1-2s | ~2-3s (+ Xvfb init) |
| RAM por sessão | 300-450MB | 450-650MB |
| CPU page load | Baseline | +15-20% |
| PDF generation | ⚠️ 10x mais lento (bug conhecido) | ✅ Mais rápido |
| Screenshot latency | ~100ms | ~150ms |
| Screencast fps | ~30fps (CDP limit) | ✅ 60fps (X11 grab) |
| Concurrency (por servidor) | 50-100 sessões | 20-30 sessões |

### 5.2 Por que o New Headless é mais lento para PDF

O old headless gerava PDFs diretamente via pipeline do Chromium headless, sem passar pelo browser completo. O new headless usa o pipeline completo do Chrome, incluindo:

- Perfil de usuário
- Extensões
- Networking stack completo
- Compositor

Para geração de PDF em massa, usar `chrome-headless-shell` (old headless) se performance for crítica.

### 5.3 Otimizações de Performance

#### Para Headless:

```bash
google-chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-extensions \
  --mute-audio \
  --window-size=1280,800 \
  about:blank
```

- `--disable-dev-shm-usage`: Evita OOM em Docker (usa /tmp)
- `--disable-background-networking`: Desabilita networking de fundo
- `--disable-sync`: Desabilita Chrome Sync
- `--disable-extensions`: Extensões já não carregam, mas evita verificação

#### Para Xvfb:

```bash
# Iniciar Xvfb
Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &

# Exportar display
export DISPLAY=:99

# Rodar Chrome normal
google-chrome \
  --no-sandbox \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  about:blank
```

---

## 6. Problemas Conhecidos com CDP no Headless Mode

### 6.1 Page.startScreencast

- **Limitação de 30fps**: Overhead de serialização base64
- **Frames only on change**: Não há intervalo fixo; só envia quando tela muda
- **Memory leak sem Ack**: Esqueceu `screencastFrameAck`? Chrome para de enviar e acumula memória
- **Resolução bugada**: Em Chrome 110-119, `--window-size` com `--headless=new` ignorava o tamanho. Use `--screen-info`.

### 6.2 Input Events

- `Input.dispatchMouseEvent` e `Input.dispatchKeyEvent` funcionam
- **Coordinates relative to viewport**, não à página (scroll offset)
- Touch events requerem `Input.dispatchTouchEvent`

### 6.3 Emulation.setDeviceMetricsOverride

- Muda viewport size, device pixel ratio,mobile emulation
- Em `--headless=new`, precisa de `Emulation.addScreen` (Chrome 142+) para屏幕 info correto
- Versões antigas: `--window-size` pode não funcionar como esperado

### 6.4 Debugger Protocol

- `Debugger.*` funciona, mas breakpoints em scripts inline podem falhar
- Source maps funcionam normalmente

### 6.5 Target Management

- `Target.createTarget` — ✅ funciona
- `Target.attachToTarget` — ✅ funciona
- `Target.closeTarget` — ✅ funciona
- Novo: `--headless=new` suporta `Target.activateTarget` corretamente

---

## 7. Como o Playwright Usa Headless Mode

### 7.1 Estratégia do Playwright

O **Playwright** usa automaticamente o **`--headless=new`** quando `headless: true` (default).

```javascript
// Playwright usa new headless automaticamente
const browser = await playwright.chromium.launch({
  headless: true,  // Default — usa --headless=new automaticamente
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage'
  ]
});
```

Internamente, Playwright:
1. Detecta versão do Chrome
2. Se Chrome ≥ 128, usa `--headless`
3. Se Chrome 112-127, usa `--headless=new` explicitamente
4. Se Chrome < 112, usa `--headless` (old)

### 7.2 Vantagens do Playwright sobre CDP cru

- **Abstrai os details de CDP** — você não precisa lidar com `screencastFrameAck`
- **Melhor handling de frames** — Playwright gerencia throughput automaticamente
- **Screenshots de alta qualidade** — usa `page.screenshot()` em vez de screencast CDP
- **Gravação de vídeo** — suporte nativo a vídeo (usando MP4 box em Chromium)
- **Tracing** — gravação de trace para análise
- **Auto-wait** — espera elementos automaticamente

### 7.3 Playwright Video Recording

Playwright usa uma API diferente do CDP screencast:

```javascript
const context = await browser.newContext({
  recordVideo: {
    dir: 'videos/',
    size: { width: 1280, height: 720 }
  }
});
```

Internamente, Playwright usa:
- Chromium's `Page.startScreencast` internamente
- Mas empacota com codec otimizado
- Salva como `.webm` (VP8/VP9) diretamente, sem overhead de base64

### 7.4 Quando usar Playwright vs CDP cru

| Caso de Uso | Recomendação |
|-------------|-------------|
| Remote browser service (screencast em tempo real) | CDP cru (mais controle, overhead menor) |
| Testes automatizados E2E | Playwright ( abstrai complexidade) |
| Scraping simples | Playwright ou Puppeteer |
| AI agent interagindo com página | Playwright (auto-wait útil) |
| Screencast customizado + websocket | CDP cru (controle total de cada frame) |

### 7.5 Playwright Headless vs Headful

```javascript
// Headless (default)
const browser = await playwright.chromium.launch({ headless: true });

// Headful (com Xvfb implícito, Playwright gerencia)
const browser = await playwright.chromium.launch({ headless: false });
```

- `headless: false` requer display X11 (Xvfb em servidor)
- Playwright NÃO usa Xvfb automaticamente em `headless: false`
- Você precisa configurar Xvfb manualmente

---

## 8. Recomendação: Qual Usar para Remote Browser Service?

### 8.1 Nossa Situação

Este projeto (`remote-browser`) precisa:
- ✅ Screencast em tempo real (baixa latência)
- ✅ Input injection (mouse, teclado)
- ✅ Suporte a múltiplas sessões concorrentes
- ✅ Baixo overhead de recursos
- ✅ CDP para automação avançada
- ✅ Compatibilidade com páginas modernas (WebGL, Canvas)

### 8.2 Opção Escolhida: `--headless=new` + CDP Screencast

#### Por quê?

1. **Não requer Xvfb** — Simplifica deployments, menos dependências
2. **Performance** — ~15% menos RAM/CPU que Xvfb + headful
3. **Screencast nativo** — CDP `Page.startScreencast` funciona perfeitamente
4. **Concorrência** — 50-100 sessões por servidor possível
5. **Fingerprint melhor** — Menor detecção como bot
6. **Extensões suportadas** — Se precisar no futuro
7. **WebGL + flags** — Funciona com configuração adequada
8. **Setup simples** — Só rodar Chrome com flags

#### Limitações aceitáveis:

- ~30fps no screencast (vs 60fps com Xvfb)
- Sem áudio via CDP (pode ser contornado com Web Audio API no lado do browser)
- Sem UI visual de popups (mas inputs funcionam)

### 8.3 Configuração Recomendada

```bash
google-chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --no-sandbox \
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
  --autoplay-policy=no-user-gesture-required \
  about:blank
```

**Flags críticas:**
- `--headless=new` — Usa o novo modo (paridade total)
- `--no-sandbox` — Necessário em Docker (root user)
- `--disable-dev-shm-usage` — Evita OOM, usa /tmp
- `--disable-gpu-sandbox` — Evita crashes sem GPU real
- `--window-size` — Define viewport inicial
- `--autoplay-policy=no-user-gesture-required` — Vídeos auto-play

### 8.4 Quando Considerar Xvfb

Use **Xvfb + Headful** apenas se:

1. **Precisa de 60fps screencast** (animações fluidas, vídeos)
2. **WebGL pesado** (modelos 3D, jogos) — GPU acceleration nativo
3. **Captura de áudio** necessária (Voice bots, reuniões)
4. **Bot detection extrema** — headless ainda é detectável em cenários avançados
5. **Debug visual** — Precisa ver o que está acontecendo em tempo real (VNC)

Cenário típico: Serviço de **auto-attending meetings** (Zoom, Google Meet) onde áudio e vídeo são críticos.

### 8.5 Stack Técnica Recomendada

```javascript
// 1. Iniciar Chrome
const { spawn } = require('child_process');
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--remote-debugging-port=9222',
  '--remote-debugging-address=0.0.0.0',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--window-size=1920,1080',
  '--disable-gpu-sandbox',
  '--mute-audio',
  'about:blank'
]);

// 2. Esperar Chrome estar pronto (aguardar stdout "DevTools listening")
await waitForDebuggerPort(9222);

// 3. Conectar via CDP
const client = await CDP({ port: 9222 });
const { Page, Input, Runtime } = client;

// 4. Criar página
await Page.enable();
await Runtime.evaluate({ expression: 'document.title = "Sessão 001"' });

// 5. Navegar
await Page.navigate({ url: 'https://example.com' });
await Page.loadEventFired();

// 6. Iniciar screencast
await Page.startScreencast({
  format: 'jpeg',
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1
});

Page.screencastFrame(async ({ data, metadata, sessionId }) => {
  // Enviar frame via WebSocket para cliente
  ws.send(JSON.stringify({
    type: 'frame',
    data: data, // base64 JPEG
    width: metadata.deviceWidth,
    height: metadata.deviceHeight,
    timestamp: metadata.timestamp
  }));

  // Confirmação obrigatória
  await Page.screencastFrameAck({ sessionId });
});

// 7. Input injection
await Input.dispatchMouseEvent({
  type: 'mousePressed',
  x: 100,
  y: 200,
  button: 'left',
  clickCount: 1
});

await Input.dispatchKeyEvent({
  type: 'keyDown',
  key: 'a',
  text: 'a'
});

// 8. Cleanup
await Page.stopScreencast();
await client.close();
chrome.kill();
```

---

## 9. Troubleshooting

### 9.1 Chrome não inicia em Docker

**Problema:** `Running as root without --no-sandbox is not supported`

**Solução:** Adicionar `--no-sandbox` e `--disable-setuid-sandbox`

### 9.2 CDP connection refused

**Problema:** Porta 9222 não respondendo

**Solução:**
```bash
# Verificar se Chrome está rodando
ps aux | grep chrome

# Verificar logs do Chrome
docker logs <container>

# Testar endpoint
curl http://localhost:9222/json/version
```

### 9.3 WebGL não funciona

**Problema:** `gl.getParameter(gl.RENDERER)` retorna "SwiftShader" ou "Software"

**Solução:**
```bash
# Instalar drivers Vulkan (NVIDIA)
apt-get install -y vulkan-tools libnvidia-gl-525

# Usar flags corretas
--use-gl=egl --use-angle=swiftshader
# ou com GPU real
--use-gl=egl --no-sandbox
```

### 9.4 Screencast não envia frames

**Problema:** Evento `Page.screencastFrame` nunca dispara

**Solução:**
- Verificar se `Page.enable()` foi chamado
- Garantir que `Page.startScreencast()` completou antes de esperar frames
- Verificar se há mudança na página (frames só em mudanças)
- Testar com `everyNthFrame: 1`
- Confirmar que `screencastFrameAck` está sendo chamado

### 9.5 Memória vazando

**Problema:** Consumo de RAM cresce indefinidamente

**Solução:**
- Sesões não estão sendo cleanup (Page.close, client.close)
- `Page.stopScreencast()` não está sendo chamado
- Verificar se há listeners órfãos no EventEmitter

---

## 10. Fontes

- [Chrome Headless Mode — Chrome for Developers](https://developer.chrome.com/docs/chromium/headless)
- [Download old Headless Chrome as chrome-headless-shell](https://developer.chrome.com/blog/chrome-headless-shell)
- [Screen configuration for Chrome Headless](https://developer.chrome.com/blog/screen-configuration-with-chrome-headless)
- [Chrome DevTools Protocol — Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Headless is Going Away! — Selenium Blog](https://www.selenium.dev/blog/2023/headless-is-going-away/)
- [New in Chrome 109 — Chrome for Developers](https://developer.chrome.com/blog/new-in-chrome-109)
- [New headless Chrome fingerprint analysis](https://antoinevastel.com/bot%20detection/2023/02/19/new-headless-chrome.html)
- [Headless Chrome performance discussion (Chromium group)](https://groups.google.com/a/chromium.org/g/headless-dev/c/J6SjKnRQGQc)
- [GPU/WebGL in headless Chrome](https://developer.chrome.com/blog/supercharge-web-ai-testing)
- [Playwright Chromium launcher](https://playwright.dev/docs/browsers)
- [Puppeteer headless mode](https://pptr.dev/guides/headless-mode)
- [Screencast frame rate discussion — Chromium](https://groups.google.com/a/chromium.org/g/headless-dev/c/6XKLTi5bsZA)
- [WebGL in headless Chrome bug #617551](https://bugs.chromium.org/p/chromium/issues/detail?id=617551)

---

## 11. Conclusão

Para um **remote browser service** baseado em CDP screencast:

✅ **Use `--headless=new`** (Chrome 112+)
- Simplicidade de deployment
- Performance adequada
- CDP completo
- Concorrência alta

⚠️ **Configure corretamente:**
- Flags de segurança (`--no-sandbox`, `--disable-dev-shm-usage`)
- Tamanho de viewport (`--window-size` ou `--screen-info`)
- GPU/WebGL se necessário (flags específicas)

❌ **Não use Xvfb** a menos que precise:
- Captura de áudio
- 60fps screencast
- WebGL pesado com GPU nativo
- Bot detection evasion extrema

A arquitetura escolhida (`--headless=new` + CDP screencast) é a **recomendação moderna** da indústria para serviços de remote browser em 2025.
