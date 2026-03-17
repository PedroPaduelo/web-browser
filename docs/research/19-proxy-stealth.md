# Proxy & Stealth para Automação de Browser

**Data da Pesquisa**: 2025-03-17
**Foco**: Anti-detection, proxies residenciais e fingerprinting para automação browser
**Projeto Aplicado**: Serende (sistema de orquestração de sessões remotas)

---

## Sumário

1. [Configurando Proxy por Sessão no Chrome](#configurando-proxy-por-sessão-no-chrome)
2. [Implementação de Proxies Residenciais no Browserbase](#implementação-de-proxies-residenciais-no-browserbase)
3. [puppeteer-extra-plugin-stealth](#puppeteer-extra-plugin-stealth)
4. [Fingerprinting: Canvas, WebGL, Timezone, User-Agent](#fingerprinting-canvas-webgl-timezone-user-agent)
5. [Randomização de Fingerprint via CDP](#randomização-de-fingerprint-via-cdp)
6. [Modificando User-Agent com Chrome DevTools Protocol](#modificando-user-agent-com-chrome-devtools-protocol)
7. [Detecção de Bots: Cloudflare & PerimeterX](#detecção-de-bots-cloudflare--perimeterx)
8. [Recomendações para Anti-Detection no Serende](#recomendações-para-anti-detection-no-serende)

---

## Configurando Proxy por Sessão no Chrome

### Flag `--proxy-server`

O Chrome/Chromium permite configurar proxies por sessão usando a flag de linha de comando `--proxy-server`. Esta configuração é **por aplicação** (não afeta outras aplicações do sistema) e é ideal para sessões isoladas de automação.

### Sintaxe Básica

```bash
--proxy-server=<scheme>=<uri>[:<port>][;...] | <uri>[:<port>] | "direct://"
```

### Formas de Especificação

1. **Mapeamento por esquema** (recomendado):
   ```bash
   --proxy-server="http=proxy1.example.com:8080;https=proxy2.example.com:3128"
   ```

2. **Proxy único para todos os protocolos**:
   ```bash
   --proxy-server="socks5://proxy.example.com:1080"
   ```

3. **Sem proxy**:
   ```bash
   --proxy-server="direct://"
   ```

### Protocolos Suportados

- HTTP (padrão se omitido)
- HTTPS
- SOCKS4
- SOCKS5 (usar `socks5://`)

**Nota**: `"socks"` é equivalente a `"socks5"`.

### Exemplos Práticos

```bash
# SOCKS5 para automação
chrome --proxy-server="socks5://185.199.229.156:7497"

# HTTP com autenticação (usuário:senha)
chrome --proxy-server="http://user:password@proxy.example.com:8080"

# Diferentes proxies por protocolo
chrome --proxy-server="http=proxy-http.example.com:80;https=proxy-https.example.com:443"
```

### Flag Complementar: `--proxy-bypass-list`

Para excluir determinados hosts do proxy:

```bash
--proxy-bypass-list="*.google.com;127.0.0.1;localhost"
```

### Flag `--host-resolver-rules` (para SOCKS)

Evita que o Chrome envie consultas DNS pela rede (importante para SOCKS):

```bash
--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE proxy.example.com"
```

Este comando mapeia todas as resoluções DNS para um endereço inválido, exceto para o próprio proxy.

### Limitações Importantes

1. **DNS Prefetching**: O Chrome pode emitir consultas DNS locais mesmo com proxy ativo. Desative com:
   ```bash
   --disable-async-dns
   ```

2. **Credenciais**: A flag `--proxy-server` **não suporta** passar credenciais pela linha de comando no Linux/Windows. No entanto, a sintaxe `user:password@host:port` funciona no macOS.

3. **Componentes que ignoram proxy**:
   - DNS prefetcher
   - Extensões
   - Certificados CRL/OCSP

4. **Proxy authentication**: Para proxiess com autenticação, use:
   - Extensão do Chrome que gerencia credenciais
   - Proxy local que adiciona headers de autenticação
   - Environment variables (depende do SO)

### Métodos de Aplicação por Sessão

**Windows**:
- Adicionar flags nas propriedades do atalho do Chrome
- Target: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --proxy-server="socks5://proxy:port"`

**Linux**:
```bash
# Alias
alias chrome-proxy='google-chrome --proxy-server="socks5://proxy:port" --user-data-dir="/tmp/chrome-session-$(uuidgen)"'

# Ou direto
/usr/bin/google-chrome --proxy-server="socks5://proxy:port"
```

**macOS**:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --proxy-server="socks5://proxy:port"
```

### Sessão Isolada com User Data Dir

Para garantir isolamento total (cookies, cache, fingerprint) use `--user-data-dir`:

```bash
chrome \
  --user-data-dir="/tmp/chrome-profile-$(uuidgen)" \
  --proxy-server="socks5://residential-proxy.example.com:1080" \
  --disable-blink-features=AutomationControlled \
  https://httpbin.org/ip
```

**Fonte**: [Chromium - Network Settings](https://www.chromium.org/developers/design-documents/network-settings/) | [LinuxBabe - Proxy Configuration](https://www.linuxbabe.com/desktop-linux/configure-proxy-chromium-google-chrome-command-line)

---

## Implementação de Proxies Residenciais no Browserbase

### O que é o Browserbase?

O Browserbase é uma plataforma de automação de browsers que oferece acesso a **proxies residenciais** integrados, escalabilidade e APIs para controle via Puppeteer/Playwright.

Diferente de soluções tradicionais, o Browserbase roda browsers em infrastructure real (não headless), o que reduz drasticamente a detecção.

### Arquitetura de Proxies Residenciais

1. **Rede P2P de IPs Residenciais**
   - Browserbase (ou Bright Data, similar) opera uma rede de milhões de IPs residenciais reais
   - IPs são emprestados de usuários que instalaram extensões/sdk em troca de benefícios
   - Cada sessão do browser pode ter um IP residencial único geolocalizado

2. **Sidecar Proxy Architecture**
   ```
   Seu Script (Puppeteer/Playwright)
                ↓
         Browserbase API
                ↓
         Proxy Manager + Rotation
                ↓
    Residential IP Pool (Millions)
                ↓
      Target Website
   ```

3. **Rotação Automática**
   - O sistema gerencia automaticamente a rotação de IPs por sessão
   - Failover inteligente se um IP for bloqueado
   - Assistente de CAPTCHA integrado

### Como Implementar (Exemplo Prático)

```javascript
const { createBrowser } = require('@browserbasehq/sdk');

const browser = await createBrowser({
  proxy: {
    // Opcional: proxy residencial específico ou deixe o sistema escolher
    // endpoint: 'residential-us-east'
    // Se não especificado, usa pool automático
  },
  headless: false, // Browser real (headful)
  browser: 'chrome'
});

const page = await browser.newPage();
await page.goto('https://target-site.com');

// IP que está usando (pode verificar via httpbin.org/ip)
const ip = await page.evaluate(async () => {
  const res = await fetch('https://api.ipify.org?format=json');
  return res.json();
});
console.log('Current IP:', ip);
```

### Benefícios vs Proxies Tradicionais

| Característica | Proxies Datacenter | **Residenciais** |
|----------------|-------------------|------------------|
| Detecção por Cloudflare | Alta | Baixa |
| Geolocalização precisa | Limitada | Excelente |
| Reputação de IP | Ruim (bloqueado) | Boa (usuário real) |
| Custo | Baixo | Alto (USD $15-100/GB) |
| Velocidade | Variável | Mais estável |

### Integração com Infraestrutura Própria

Se quiser implementar sistema similar:

1. **Setup de Proxy SOCKS por sessão**:
   ```javascript
   const browser = await puppeteer.launch({
     args: [
       `--proxy-server=socks5://${sessionProxyHost}:${sessionProxyPort}`,
       '--user-data-dir=/tmp/profile-' + sessionId
     ]
   });
   ```

2. **Pool de Proxies Residenciais**:
   - Comprar pacote da Bright Data/Oxylabs/GeoSurf
   - Gerenciar allocation por sessão
   - Implementar health-check e fallback

3. **Geolocalização**:
   - Selecionar proxy por país/cidade
   - Passar headers `Accept-Language` correspondentes

**Fonte**: [Bright Data - Browser API](https://brightdata.com/products/scraping-browser) | [Bright Data - Browser Automation Explained](https://brightdata.com/blog/proxy-101/browser-automation-explained)

---

## puppeteer-extra-plugin-stealth

### O que é?

`puppeteer-extra` é uma extensão do Puppeteer que permite plugins modulares. O plugin `stealth` implementa múltiplas técnicas para **tornar a automação de Puppeteer indetectável** por sites que verificam se o tráfego é gerado por bot.

**Repository**: https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth

### O que o Plugin Faz?

O plugin aplica automaticamente dezenas de evasões que mascaram evidências de automação. As principais alterações:

1. **Remove flags de automação**:
   - Remove `navigator.webdriver = true`
   - Remove `window.chrome` ausente/vazio

2. **Spoof de plugins e mime types**:
   - Preenche `navigator.plugins` com lista realista
   - Configura `navigator.mimeTypes` com valores plausíveis

3. **Correções de User-Agent**:
   - Ajusta `navigator.userAgent` para incluir tokens reais
   - Corrige versões de Chrome/Firefox/OS

4. **Permissões e WebGL**:
   - Spoof de `navigator.permissions.query`
   - Modifica `WebGLRenderer` e `WebGLVendor` para valores realistas

5. **Languages, Platform, Hardware**:
   - `navigator.languages`
   - `navigator.platform`
   - `navigator.hardwareConcurrency`

6. **Chrome-specific**:
   - Spoof de `chrome.runtime` e extensões
   - `chrome.loadTimes()` (função antiga mas ainda verificada)
   - Correção de `Permissions.query()` para `notifications`

7. **Touch points e_device memory**:
   - `navigator.maxTouchPoints` → 0 (desktop)
   - `navigator.deviceMemory` → 8 (valor realista)

### Como Funciona Internamente?

O plugin usa **CDP (Chrome DevTools Protocol)** e `page.evaluateOnNewDocument()` para injetar código JavaScript **antes** de qualquer script da página carregar.

```javascript
// Estrutura simplificada
module.exports = async (browser, options) => {
  browser.on('targetcreated', async (target) => {
    const page = await target.page();
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      // Spoof plugins, languages, etc...
    });
  });
};
```

### Lista de Evasões Implementadas (v0.6.x)

| Evasão | O que Corrige |
|--------|---------------|
| `userAgent` | Token Chrome, versão OS |
| `navigator.webdriver` | Flag de automação |
| `navigator.plugins` | Lista vazia em headless |
| `navigator.languages` | Array vazio incomum |
| `navigator.permissions` | Negação de notifications |
| `chrome.runtime` | Objeto ausente no headless |
| `WebGLRenderer` | "Google SwiftShader" (GPU fake) |
| `navigator.platform` | Linux em vez de Windows/Mac |
| `navigator.hardwareConcurrency` | Valor realista |
| `navigator.maxTouchPoints` | Zero em desktops |
| `navigator.deviceMemory` | Valor ausente em headless |
| `HTMLIFrameElement` | `contentWindow`痕迹 |
| `MediaDevices` | EnumerateDevices mock |
| `WebRTC` | IP leakage via RTCPeerConnection |

### Como Usar

```javascript
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('https://bot.sannysoft.com'); // Testar detecção
```

### Limitações

- **Não é perfeito**: Detecções avançadas ainda conseguem identificar automação
- **Canvas/WebGL fingerprint**: O plugin **não** randomiza outputs, apenas corrige alguns valores
- **Timezones, Locale**: Não modifica `Intl` APIs por padrão
- **Detecção comportamental**: Análise de padrões de mouse/teclado não é tratada

### Detecção do Próprio Plugin

Sites como `bot.sannysoft.com` ou `intoli.com/blog/not-possible-to-block-bots` detectam Puppeteer mesmo com stealth plugin ativo, pois:

- Verificam se há inconsistências (ex: User-Agent Windows mas platform Linux)
- Checam versões específicas de chrome.runtime
- Analisam WebGL renderer vs User-Agent GPU
- Usam `navigator.plugins` length patterns específicos

### Alternativas e Complementos

1. **puppeteer-extra-plugin-recaptcha**: Solve CAPTCHAs automaticamente
2. **puppeteer-extra-plugin-adblocker**: Bloqueia anúncios e trackers
3. **Camouflage via extensions**: Carregar extensões reais do Chrome
4. **Anti-detect browsers**: Multilogin, Kameleo, GoLogin (mais robustos)

**Fonte**: [GitHub - puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra-plugin-stealth) | [Artigo sobre detecção](https://intoli.com/blog/not-possible-to-block-bots/)

---

## Fingerprinting: Canvas, WebGL, Timezone, User-Agent

### O que é Browser Fingerprinting?

**Fingerprinting** é a técnica de coletar múltiplas características do browser/dispositivo para gerar um identificador único (ou semi-único). Diferente de cookies (que podem ser deletados), o fingerprint é baseado em propriedades do ambiente que são difíceis de modificar sem parecer falso.

### Principais.Componentes Fingerprint

#### 1. User-Agent

**O que é**: String que identifica browser, versão, sistema operacional, engine.

**Exemplo**:
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**Detecção**:
```javascript
console.log(navigator.userAgent);
// Se contém "HeadlessChrome" ou "Headless" → Detectado
```

**Valores suspeitos**:
- `HeadlessChrome` em User-Agent
- Versão desatualizada incomum
- Mismatch entre OS e userAgent

---

#### 2. Canvas Fingerprinting

**Como funciona**:
1. Script desenha texto/imagem no elemento `<canvas>`
2. Chama `canvas.toDataURL()` ou `canvas.getImageData()`
3. Gera hash dos pixels renderizados

**Por que é único**: O renderização varia por:
- GPU e drivers
- Sistema Operacional
- Versão do browser
- Fontes instaladas
- Subpixel rendering settings

**Código de exemplo**:
```javascript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
ctx.textBaseline = 'top';
ctx.font = '14px "Arial"';
ctx.fillStyle = '#f0f0f0';
ctx.fillRect(0, 0, 300, 50);
ctx.fillStyle = '#000000';
ctx.fillText('Canvas fingerprint', 2, 2);
const fingerprint = canvas.toDataURL();
```

**Detecção Canvas spoof**:
- Verificar se canvas está vazio ou constantemente randomizado
- Comparar hash em diferentes momentos
- Testar com imagens específicas

---

#### 3. WebGL Fingerprinting

**Como funciona**:
1. Obtém contexto WebGL (`canvas.getContext('webgl')`)
2. Lê `gl.getParameter()` para:
   - `WEBGL_RENDERER` (ex: "ANGLE (NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0)")
   - `WEBGL_VENDOR` (ex: "Google Inc.")
   - `WEBGL_VERSION`
   - Shader compilation nuances

**Por que é difícil de spoofar**:
- Baseado em hardware (GPU) real
- Variações a nível de floating-point精度
- Shader compilation differs entre GPUs

**Código**:
```javascript
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl');
const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
console.log(renderer, vendor);
```

**Detecção spoof WebGL**:
- Comparar renderer com User-Agent GPU (deve coincidir)
- Verificar floating-point precision ($0.1 + 0.2 === 0.30000000000000004$)
- Executar shaders específicos e analisar rounding errors

---

#### 4. Timezone & Locale

**Coletado por**:
- `Intl.DateTimeFormat().resolvedOptions().timeZone`
  - Ex: "America/New_York"
- `Intl.DateTimeFormat().format(new Date())`
- `Date.prototype.getTimezoneOffset()`

**Problema**: Se o proxy é de outro país/timezone mas o sistema local é diferente, há inconsistência.

**Detecção**:
```javascript
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const offset = new Date().getTimezoneOffset(); // minutos do UTC
// Se proxy é em Tokyo (-540) mas sistema mostra -180 → inconsistência
```

**Solução**: Forçar timezone correspondente ao país do proxy via:
- CDP `Emulation.setTimezoneOverride`
- Spoof no `Intl` API via `page.evaluateOnNewDocument`

---

#### 5. Plugins & MimeTypes

**navigator.plugins** retorna array de Plugin objects:
```javascript
// Headless Chrome → []
// Real Chrome → [
  {name: "Chrome PDF Viewer", filename: "internal-pdf-viewer"},
  {name: "Chrome PDF Viewer", filename: "internal-pdf-viewer"},
  {name: "Widevine Content Decryption Module", ...},
  ...
]
```

**Detecção**: `navigator.plugins.length === 0` é strong signal de headless/automation

---

#### 6. Languages

```javascript
navigator.languages
// Real Chrome: ["en-US", "en"]
// Headless/Puppeteer: [] ou ["en-US"]
```

**Padrão esperado**: Pelo menos 2 idiomas, primeiro é o principal.

---

#### 7. Platform

```javascript
navigator.platform
// Windows: "Win32"
// Linux: "Linux x86_64"
// macOS: "MacIntel"
```

**Detecção**: Se User-Agent diz Windows mas platform é Linux → Bot

---

## Randomização de Fingerprint via CDP

### Chrome DevTools Protocol (CDP)

CDP permite controlar Chrome remotamente e modificar suas propriedades em tempo real via comandos.

### Técnicas de Randomização Consistente

**Importante**: Randomização por request é detectável. O correto é:
1. Gerar fingerprint **realista** único por sessão/profile
2. Mantê-lo **consistente** durante toda a sessão
3. Não mudar entre page reloads

### CDP Commands para Fingerprint

#### 1. Set User-Agent (Network)

```javascript
// Via Puppeteer
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

// CDP direto
await client.send('Network.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; ...',
  acceptLanguage: 'en-US,en;q=0.9',
  platform: 'Windows'
});
```

#### 2. Override Geolocalização

```javascript
// Via CDP
await client.send('Emulation.setGeolocationOverride', {
  latitude: 40.7128,
  longitude: -74.0060,
  accuracy: 100
});
```

#### 3. Device Metrics (Screen Resolution)

```javascript
await client.send('Emulation.setDeviceMetricsOverride', {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false
});
```

#### 4. Timezone Override

```javascript
await client.send('Emulation.setTimezoneOverride', {
  timezoneId: 'America/New_York'  # IANA timezone
});
```

#### 5. Script Execution - Injetar Spoof Global

```javascript
await page.evaluateOnNewDocument(() => {
  // Navigator properties
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
  });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      {0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Chrome PDF Viewer"}, length: 1},
      // ... mais plugins realistas
    ]
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en']
  });

  // WebGL spoof (avançado)
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) {
      return 'ANGLE (NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)'; // UNMASKED_RENDERER_WEBGL
    }
    if (parameter === 37446) {
      return 'Google Inc. (NVIDIA)';
    }
    return getParameter.apply(this, [parameter]);
  };
});
```

### Ordem Recomendada de Configuração

```javascript
async function setupStealthSession(page) {
  const client = await page.target().createCDPSession();

  // 1. User-Agent + Platform + Language
  await client.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Windows',
    acceptLanguage: 'en-US,en;q=0.9'
  });

  // 2. Screen resolution
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  // 3. Timezone (match com geolocalização do proxy)
  await client.send('Emulation.setTimezoneOverride', {
    timezoneId: 'America/New_York'
  });

  // 4. Geolocation (opcional)
  await client.send('Emulation.setGeolocationOverride', {
    latitude: 40.7128,
    longitude: -74.0060,
    accuracy: 100
  });

  // 5. Injeta JavaScript spoof (depois das properties CDP)
  await page.evaluateOnNewDocument(() => {
    // ... código de spoof
  });

  // 6. Permissões
  await client.send('Browser.grantPermissions', {
    permissions: ['geolocation', 'notifications']
  });
}
```

### Valores Realistas por Região

| Região | Timezone | Platform | Languages | Common Resolutions |
|--------|----------|----------|-----------|-------------------|
| US | America/New_York | Win32 | en-US,en | 1920x1080, 1366x768 |
| UK | Europe/London | Win32 | en-GB,en | 1920x1080, 1536x864 |
| DE | Europe/Berlin | Win32 | de-DE,de,en | 1920x1080 |
| BR | America/Sao_Paulo | Win32 | pt-BR,pt,en-US | 1366x768, 1920x1080 |

---

## Modificando User-Agent com Chrome DevTools Protocol

### Network.setUserAgentOverride

O comando CDP `Network.setUserAgentOverride` modifica o User-Agent **para requests de rede** (não altera `navigator.userAgent` no JavaScript). Use **ambos** para consistência.

#### Parâmetros

```typescript
interface Network.SetUserAgentOverrideRequest {
  userAgent?: string;           // Override do User-Agent
  acceptLanguage?: string;      // Cabeçalho Accept-Language
  platform?: string;            // String de platform (navigator.platform)
  revenueUserAgent?: string;    // [deprecated]
  receiveUpdates?: boolean;      // Receber updates?
}
```

#### Exemplo Completo

```javascript
const client = await page.target().createCDPSession();

// Configurar User-Agent para requests HTTP
await client.send('Network.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  acceptLanguage: 'en-US,en;q=0.9',
  platform: 'macOS'
});

// Invalidar cache para forçar novo request com novo UA
await client.send('Network.clearBrowserCache');
```

#### Verificação

```javascript
// User-Agent enviado via CDP (Network)
const response = await page.goto('https://httpbin.org/user-agent');
const data = await response.json();
console.log(data['user-agent']); // Deve refletir o override

// User-Agent JavaScript (navigator)
const jsUA = await page.evaluate(() => navigator.userAgent);
console.log(jsUA); // Deve ser override também (via page.setUserAgent ou script)
```

### page.setUserAgent (Puppeteer API)

Atalho que faz duas coisas:
1. Chama `Network.setUserAgentOverride`
2. Injeção de script para modificar `navigator.userAgent`

```javascript
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
```

**Nota**: `page.setUserAgent` não modifica `navigator.platform` ou `navigator.languages`. Para isso, injete via `evaluateOnNewDocument`.

### CDP Emulation.setUserAgentOverride (Obsoleto?)

⚠️ **Cuidado**: Há dois comandos similares:
- `Network.setUserAgentOverride` → Para requests HTTP
- `Emulation.setUserAgentOverride` → Mais antigo, ainda funcional mas preferir `Network`

Use `Network.setUserAgentOverride` como padrão.

### User-Agent Real vs Fake

**User-Agent real de Chrome 120 no Windows 10**:
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**User-Agent real de Chrome 120 no macOS**:
```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**Valores importantes**:
- Chrome versão: deve ser atual (não usar versão antiga que não recebe security updates)
- Safari/WebKit: sempre incluir, mesmo no Chrome
- Plataforma: Win64/Win32, MacIntel, Linux x86_64

### Detecção de User-Agent Inconsistente

Sites podem detectar:
1. User-Agent Windows mas `navigator.platform` retorna "Linux"
2. User-Agent macOS mas accept-language é "de-DE"
3. User-Agment mobile mas viewport é desktop size
4. Chrome 120 mas plugins length é 0

**Solução**: Manter todos os campos consistentes entre si e com a geolocalização do proxy.

### Otimização: Pool de User-Agents

Para automação em larga escala, gere pool de User-Agents realistas:

```javascript
const USER_AGENTS = [
  // Chrome 120 Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Chrome 120 macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Firefox (se usar)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
```

---

## Detecção de Bots: Cloudflare & PerimeterX

### O que Cloudflare Detecta?

Cloudflare (Turnstile, Bot Management) usa centenas de sinais para identificar tráfego automatizado.

#### 1. Headless Detection

**Sinais clássicos**:
- `navigator.webdriver === true`
- `window.chrome === undefined` (Chrome headless não tem extensions API)
- `navigator.plugins.length === 0`
- `navigator.languages === []`
- `navigator.permissions.query({name:'notifications'})` → Promise<denied> inconsistency

**CDP Mitigations**:
```javascript
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [...realisticPlugins] });
});
```

#### 2. Fingerprint Consistency

Cloudflare coleta ~50+ signals:
- Canvas fingerprint hash
- WebGL renderer & vendor strings
- Audio fingerprint (AudioContext)
- Device memory, hardware concurrency
- Timezone offset e Intl.timeZone
- Screen resolution, pixel ratio
- Fonts list (via Flash/Java/Canvas)
- CSS媒体 queriesatuais

**Score**: Cada sinal contribui para um bot score (0-100). Se score > threshold → CAPTCHA/block.

#### 3. Behavioral Analysis

- **Mouse movements**: Bots não movem mouse naturalmente. Padrões lineares ou jumps.
- **Typing cadence**: Humanos digite com pausas variáveis, bots são constantes.
- **Scroll behavior**: Bots usam `window.scrollTo` ou PageDown. Humanos têm aceleração/desaceleração.
- **Click timing**: Delay entre mouseover e click (humanos: 100-300ms, bots: 0ms).
- **Interaction timeline**: Order de eventos (mousemove → mousedown → mouseup → click)

**Mitigation**:
```javascript
// Human-like mouse movements
const target = {x: 100, y: 200};
const steps = 20;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  const x = startX + (target.x - startX) * easeOut(t);
  const y = startY + (target.y - startY) * easeOut(t);
  await page.mouse.move(x, y);
  await page.waitForTimeout(random(10, 30));
}
```

#### 4. TLS/HTTP Fingerprint

Cloudflare analisa:
- TLS fingerprint (cipher suites, extensions, elliptic curves)
- HTTP/2 frame order
- ALPN negotiation

**Problema**: Puppeteer/Playwright usam TLS stack do Chrome → fingerprintable.

**Mitigation**: Usar **proxies que fazem TLS termination** (Cloudflare não vê fingerprint do cliente, só do proxy).

---

### PerimeterX (PerimeterX Human Challenge)

PerimeterX é outro serviço anti-bot usado por eBay, Glassdoor, etc.

#### Sinais que capturam:

1. **Browser Core Extensions**:
   - Verifica se Chrome extensions instaladas são reais
   - `chrome.runtime` object structure

2. **DOM Manipulation Patterns**:
   - Scripts que removem/alteram elementos específicos
   - Timing de `setTimeout` calls

3. **Canvas & WebGL**:
   - Similar ao Cloudflare
   - + Shader compilation timing

4. **N Navigator properties**:
   - `navigator.hardwareConcurrency`
   - `navigator.deviceMemory`
   - `navigator.maxTouchPoints`

5. **Timing Attacks**:
   - Scripts medem tempo de execução de certas operações
   - Se muito rápido (máquina virtual) ou inconsistente → bot

---

### Como Cloudflare Atua

**Workflow de detecção**:

```
Cliente → Request → Cloudflare Edge
         ↓
   Bot Management Module
   ├─> Fingerprint Check
   ├─> Behavioral Analysis (first few requests)
   ├─> IP Reputation (datacenter vs residential)
   ├─> TLS Fingerprint
   └─> JavaScript Challenge (Turnstile)
         ↓
   Score Calculation (0-100)
         ↓
   ├─ Score < 20 → Allow
   ├─ 20-50 → JS Challenge (Turnstile)
   ├─ 50-80 → Interactive CAPTCHA
   └─ Score > 80 → Block + JS Challenge
```

**Cloudflare Turnstile**: CAPTCHA invisível que roda challenge em background. Se score baixo, exibe widget interativo.

---

### Detectando Se Você Está Bloqueado

```javascript
// Cloudflare page
if (document.title.includes('Just a moment...') ||
    document.querySelector('#challenge-running') ||
    document.querySelector('.turnstile')) {
  console.log('BLOCKED BY CLOUDFLARE');
}

// PerimeterX
if (window._pxIsBot) {
  console.log('PerimeterX detected bot');
}

// Generic hCaptcha/CAPTCHA
if (document.querySelector('.challenge-container')) {
  console.log('CAPTCHA detected');
}
```

---

## Recomendações para Anti-Detection no Serende

### Contexto: O que é o Serende?

O **Serende** é o sistema de orquestração de sessões remotas deste projeto. Ele já possui:
- CDP para controle de Chrome
- Input dispatch (teclado/mouse)
- WebRTC streaming (VNC-like)
- Múltiplas sessões simultâneas

Falta: proteção contra detecção em sites protegidos (Cloudflare, PerimeterX, reCAPTCHA).

---

### Recomendação 1: Camada de Proxies Residenciais

**Implementar**: Pool de proxies residenciais por sessão.

```javascript
// Em session-manager.js ou proxy-manager.js
class ProxyManager {
  constructor() {
    this.proxies = [
      // Buscar de config ou pool externo (Bright Data, Oxylabs)
      { host: 'proxy1.residential.com', port: 4444, country: 'US', type: 'socks5' },
    ];
  }

  async acquireProxy(sessionId) {
    // Round-robin ou random
    const proxy = this.proxies[Math.floor(Math.random() * this.proxies.length)];
    return proxy;
  }
}

// Ao criar sessão Chrome:
const proxy = await proxyManager.acquireProxy(sessionId);
await browser.launch({
  args: [
    `--proxy-server=socks5://${proxy.host}:${proxy.port}`,
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.host}`,
    `--user-data-dir=/tmp/serende-session-${sessionId}`
  ]
});
```

**Proxy providers recomendados**:
- Bright Data (maior pool)
- Oxylabs (bom para geo-targeting)
- Smartproxy (balance custo/qualidade)
- GeoSurf (específico geo)

**Custo**: ~$15-100/GB. Para 1000 sessões/dia com 100MB cada → ~$1500-5000/mês.

---

### Recomendação 2: Fingerprint Spoofing por Sessão

**Gerar fingerprint único por sessão**, consistente durante a vida da sessão.

```javascript
// fingerprint-generator.js
class FingerprintProfile {
  constructor(country = 'US') {
    this.profile = this.generate(country);
  }

  generate(country) {
    const profiles = {
      'US': {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'Win32',
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
        resolution: { width: 1920, height: 1080 },
        webglRenderer: 'ANGLE (NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0)',
        webglVendor: 'Google Inc. (NVIDIA)'
      },
      'GB': {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'Win32',
        languages: ['en-GB', 'en'],
        timezone: 'Europe/London',
        resolution: { width: 1920, height: 1080 },
        webglRenderer: 'ANGLE (Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
        webglVendor: 'Google Inc. (Intel)'
      },
      // ... mais países
    };
    return profiles[country] || profiles['US'];
  }
}

// Aplicar na sessão
const fp = new FingerprintProfile(proxy.country);

await page.setUserAgent(fp.profile.userAgent);
await client.send('Network.setUserAgentOverride', {
  userAgent: fp.profile.userAgent,
  platform: fp.profile.platform,
  acceptLanguage: fp.profile.languages.join(',')
});
await client.send('Emulation.setDeviceMetricsOverride', {
  width: fp.profile.resolution.width,
  height: fp.profile.resolution.height,
  deviceScaleFactor: 1
});
await client.send('Emulation.setTimezoneOverride', {
  timezoneId: fp.profile.timezone
});

// Injetar spoof JS
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => createFakePlugins() });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  // WebGL spoof avançado...
});
```

---

### Recomendação 3: Anti-Detection Plugin Customizado

**Criar plugin próprio no estilo puppeteer-extra-plugin-stealth**, adaptado para o orquestrador.

Estrutura sugerida:

```javascript
// modules/anti-detection.js
class AntiDetection {
  constructor(page) {
    this.page = page;
    this.client = null;
    this.profile = null;
  }

  async initialize(profile) {
    this.profile = profile;
    this.client = await this.page.target().createCDPSession();

    // 1. CDP overrides
    await this.applyCDPOverrides();

    // 2. JS spoof injection
    await this.injectSpoofScript();
  }

  async applyCDPOverrides() {
    await this.client.send('Network.setUserAgentOverride', {
      userAgent: this.profile.userAgent,
      platform: this.profile.platform,
      acceptLanguage: this.profile.languages.join(',')
    });
    await this.client.send('Emulation.setTimezoneOverride', {
      timezoneId: this.profile.timezone
    });
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width: this.profile.resolution.width,
      height: this.profile.resolution.height,
      deviceScaleFactor: 1,
      mobile: false
    });
  }

  async injectSpoofScript() {
    const script = `
      (function() {
        // webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // plugins
        const fakePlugins = [
          {0: {type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format'}, length: 1},
          {0: {type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Chrome PDF Viewer'}, length: 1},
        ];
        Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });

        // languages
        Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(this.profile.languages)} });

        // permissions
        const originalQuery = navigator.permissions.query;
        navigator.permissions.query = (params) => {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: 'granted' });
          }
          return originalQuery(params);
        };
      })();
    `;
    await this.page.evaluateOnNewDocument(script);
  }
}
```

**Integração**: Chamar `new AntiDetection(page).initialize(profile)` após criar página Chrome.

---

### Recomendação 4: Behavior Simulation (Anti-Behavioral Detection)

Cloudflare/PerimeterX analisam comportamentos. Simular humano:

#### Mouse Movement

```javascript
async function humanMove(page, x, y) {
  const start = await page.evaluate(() => ({
    x: window.mouseX || 100,
    y: window.mouseY || 100
  }));

  const steps = 20 + Math.random() * 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const targetX = start.x + (x - start.x) * eased;
    const targetY = start.y + (y - start.y) * eased;

    await page.mouse.move(targetX, targetY);
    await page.waitForTimeout(10 + Math.random() * 20);
  }
}
```

#### Typing Simulation

```javascript
async function humanType(page, selector, text) {
  await page.click(selector);
  await page.waitForTimeout(100 + Math.random() * 200);

  for (let char of text) {
    await page.keyboard.type(char);
    const delay = 50 + Math.random() * 150; // 50-200ms entre teclas
    await page.waitForTimeout(delay);
  }
}
```

#### Scrolling

```javascript
async function humanScroll(page, distance) {
  const steps = Math.ceil(Math.abs(distance) / 100);
  const stepDistance = distance / steps;

  for (let i = 0; i < steps; i++) {
    await page.evaluate((d) => window.scrollBy(0, d), stepDistance);
    await page.waitForTimeout(20 + Math.random() * 50);
  }
}
```

---

### Recomendação 5: Rotação de Sessões & Fingerprints

**NÃO reutilizar fingerprints** entre sessões diferentes.

```javascript
class SessionOrchestrator {
  constructor() {
    this.fingerprintPool = [];
    this.activeSessions = new Map();
  }

  async createSession(options) {
    const sessionId = uuidv4();

    // 1. Gerar fingerprint único
    const fingerprint = await this.generateUniqueFingerprint();

    // 2. Adquirir proxy residencial
    const proxy = await this.acquireResidentialProxy();

    // 3. Criar Chrome com flags
    const browser = await puppeteer.launch({
      args: [
        `--proxy-server=socks5://${proxy.host}:${proxy.port}`,
        `--user-data-dir=/tmp/serende-session-${sessionId}`,
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ]
    });

    const page = await browser.newPage();
    await this.applyAntiDetection(page, fingerprint, proxy);

    const session = {
      id: sessionId,
      browser,
      page,
      fingerprint,
      proxy,
      createdAt: Date.now()
    };

    this.activeSessions.set(sessionId, session);
    return session;
  }

  async applyAntiDetection(page, fingerprint, proxy) {
    const antiDetection = new AntiDetection(page);
    await antiDetection.initialize(fingerprint);

    // Aplicar viewport
    await page.setViewport({
      width: fingerprint.resolution.width,
      height: fingerprint.resolution.height,
      deviceScaleFactor: 1,
      isMobile: false
    });
  }

  async generateUniqueFingerprint() {
    // Combinar componentes realistas
    const countries = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'BR'];
    const country = countries[Math.floor(Math.random() * countries.length)];

    return {
      // Assemblar perfil realista
      userAgent: getRealisticUA(country),
      platform: 'Win32',
      languages: getLanguagesForCountry(country),
      timezone: getTimezoneForCountry(country),
      resolution: getRandomResolution(),
      webglRenderer: getRealisticWebGL(),
      webglVendor: 'Google Inc.'
    };
  }
}
```

---

### Recomendação 6: Detecção & Recovery

**Monitorar se sessão foi bloqueada**:

```javascript
async function detectBlock(page) {
  // 1. Verificar Cloudflare
  const title = await page.title();
  if (title.includes('Just a moment') ||
      title.includes('Checking your browser')) {
    return 'CLOUDFLARE';
  }

  // 2. Verificar CAPTCHA
  const hasCaptcha = await page.$('.turnstile, .challenge-container, [class*="captcha"]');
  if (hasCaptcha) {
    return 'CAPTCHA';
  }

  // 3. Verificar bloqueio HTTP (403/429)
  const response = await page.goto('https://target.com', { waitUntil: 'domcontentloaded' });
  if (response.status() === 403 || response.status() === 429) {
    return 'HTTP_BLOCK';
  }

  return null; // Não bloqueado
}

// Recuperação: trocar proxy/fingerprint
async function recoverSession(session) {
  console.log(`Session ${session.id} blocked, recovering...`);

  // 1. Fechar browser atual
  await session.browser.close();

  // 2. Gerar novo fingerprint
  const newFingerprint = await generateUniqueFingerprint();

  // 3. Obter proxy diferente
  const newProxy = await acquireResidentialProxy();

  // 4. Recriar browser
  const newBrowser = await puppeteer.launch({ /* args */ });
  const newPage = await newBrowser.newPage();

  await applyAntiDetection(newPage, newFingerprint, newProxy);

  session.browser = newBrowser;
  session.page = newPage;
  session.fingerprint = newFingerprint;
  session.proxy = newProxy;
}
```

---

### Recomendação 7: Headless Chrome com UI (Headful)

**Usar `--headless=new` (Chrome 109+) que simula janela real**.

```javascript
await puppeteer.launch({
  headless: 'new',  // Chrome 109+ headless mode com UI virtual
  args: [
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ]
});
```

**Diferenças**:
- `headless: true` (old): Altamente detectável, `HeadlessChrome` no UA
- `headless: 'new'` (Chrome 109+): Não inclui "HeadlessChrome", mais difícil de detectar
- `headless: false`: Mais seguro, mas requer X11/Xvfb no servidor

**Recomendação Serende**: Usar `headless: 'new'` + Xvfb se necessário, ou rodar com `headless: false` se o servidor tiver GPU/X.

---

### Recomendação 8: Proxy Authentication & Health Check

```javascript
class HealthyProxyPool {
  constructor(proxies) {
    this.proxies = proxies;
    this.health = new Map();
  }

  async testProxy(proxy) {
    try {
      const browser = await puppeteer.launch({
        args: [`--proxy-server=socks5://${proxy.host}:${proxy.port}`]
      });
      const page = await browser.newPage();
      await page.goto('https://httpbin.org/ip', { timeout: 10000 });
      const data = await page.evaluate(() => {
        return fetch('https://api.ipify.org?format=json').then(r => r.json());
      });

      await browser.close();

      this.health.set(proxy.id, {
        lastSeen: Date.now(),
        externalIP: data.ip,
        status: 'healthy'
      });

      return { ok: true, ip: data.ip };
    } catch (error) {
      this.health.set(proxy.id, { status: 'dead', error: error.message });
      return { ok: false };
    }
  }

  async getHealthyProxy() {
    const healthy = this.proxies.filter(p => {
      const h = this.health.get(p.id);
      return !h || h.status === 'healthy' || (Date.now() - h.lastSeen < 5 * 60 * 1000);
    });

    if (healthy.length === 0) {
      throw new Error('No healthy proxies available');
    }

    const proxy = healthy[Math.floor(Math.random() * healthy.length)];
    return proxy;
  }
}
```

---

### Recomendação 9: CAPTCHA Solving Integration

**Integrar serviço de CAPTCHA solving**:

- **2Captcha, Anti-Captcha, CapMonster**: Serviços humanos/solver
- **Local solver**: Open-source como `capsolver` (menos confiável)

```javascript
class CaptchaSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.service = '2captcha'; // ou 'anticaptcha'
  }

  async solveTurnstile(siteKey, pageUrl) {
    const result = await this.createTask(siteKey, pageUrl);
    return result; // token para submit
  }

  async createTask(siteKey, pageUrl) {
    // API call para 2captcha
    const response = await axios.post('http://2captcha.com/in.php', {
      key: this.apiKey,
      method: 'turnstile',
      sitekey: siteKey,
      pageurl: pageUrl
    });
    const taskId = response.data.request;

    // Poll for result
    for (let i = 0; i < 20; i++) {
      const result = await axios.get('http://2captcha.com/res.php', {
        params: { key: this.apiKey, action: 'get', id: taskId }
      });
      if (result.data.status === 1) {
        return result.data.request; // token
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    throw new Error('Captcha solve timeout');
  }
}

// Uso:
if (detectedCaptcha) {
  const token = await captchaSolver.solveTurnstile(siteKey, pageUrl);
  await page.evaluate((t) => {
    document.querySelector('#cf-turnstile-response').value = t;
    // submit form...
  }, token);
}
```

---

### Recomendação 10: Logging & Auditing

**Registrar cada sessão com fingerprint usado**:

```javascript
class SessionLogger {
  async logSessionStart(session) {
    await db.sessions.insert({
      id: session.id,
      fingerprint: session.fingerprint,
      proxy: {
        host: session.proxy.host,
        country: session.proxy.country,
        ip: session.proxy.externalIP
      },
      createdAt: new Date(),
      status: 'active'
    });
  }

  async logBlock(sessionId, reason, details) {
    await db.blocks.insert({
      sessionId,
      reason,
      details,
      fingerprintHash: await this.hashFingerprint(session.fingerprint),
      timestamp: new Date()
    });
  }
}
```

**Objetivo**: Permite analisar padrões de bloqueio e ajustar fingerprints.

---

### Checklist de Implementação Serende

- [ ] **Proxy Pool**: Integrar Bright Data ou similar com sessões rotativas
- [ ] **Fingerprint profiles**: Gerar perfis realistas por país/theme
- [ ] **CDP Spoofing**: Aplicar User-Agent, timezone, resolution por sessão
- [ ] **JS Injection**: Spoof de navigator.webdriver, plugins, languages
- [ ] **WebGL/Canvas**: Override de renderer strings via CDP
- [ ] **Behavior Sim**: Mouse movements, typing delays, scrolling natural
- [ ] **Health Check**: Testar proxies periodicamente
- [ ] **CAPTCHA Solver**: Service integration para Turnstile/hCaptcha
- [ ] **Monitoring**: Log de bloqueios para análise de fingerprints problemáticos
- [ ] **Session Rotation**: Auto-recovery com novo proxy/fingerprint se bloqueado

---

## Fontes e Referências

### Chrome & CDP
- [Chromium Network Settings](https://www.chromium.org/developers/design-documents/network-settings/)
- [Chromium SOCKS Proxy](https://www.chromium.org/developers/design-documents/network-stack/socks-proxy/)
- [CDP Protocol Spec](https://chromedevtools.github.io/devtools-protocol/)

### Fingerprinting
- [BrowserLeaks - Canvas](https://browserleaks.com/canvas)
- [Canvas Fingerprinting - Wikipedia](https://en.wikipedia.org/wiki/Canvas_fingerprinting)
- [WebGL Fingerprint Defender](https://webbrowsertools.com/webgl-fingerprint/)
- [Canvas Audio WebGL Deep Dive](https://blog.octobrowser.net/canvas-audio-and-webgl-an-in-depth-analysis-of-fingerprinting-technologies)
- [ZenRows - WebGL Bypass](https://www.zenrows.com/blog/webgl-fingerprinting)
- [Fingerprint.com Blog](https://fingerprint.com/blog/browser-fingerprinting-techniques/)
- [7 Best Fingerprint Evasion Techniques](https://soax.com/blog/prevent-browser-fingerprinting)

### Anti-Detection
- [puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra-plugin-stealth)
- [Intoli Blog - Not Possible to Block Bots](https://intoli.com/blog/not-possible-to-block-bots/)
- [Cloudflare Bot Management](https://www.cloudflare.com/learning/bot-management/)
- [PerimeterX Detection](https://www.perimeterx.com/)

### Residential Proxy
- [Bright Data Browser API](https://brightdata.com/products/scraping-browser)
- [Bright Data Browser Automation Explained](https://brightdata.com/blog/proxy-101/browser-automation-explained)
- [Research on Scraping Browsers Comparison](https://research.aimultiple.com/scraping-browser/)

### Multilogin/Anti-Detect Browsers
- [Multilogin - Canvas Fingerprint Guide](https://multilogin.com/blog/the-great-myth-of-canvas-fingerprinting/)
- [Multilogin - WebGL Fingerprint](https://multilogin.com/glossary/webgl-fingerprint/)

---

**Documento preparado em**: 2025-03-17
**Revisão recomendada**: Atualizar quarterly (Cloudflare/PerimeterX mudam frequentemente)
