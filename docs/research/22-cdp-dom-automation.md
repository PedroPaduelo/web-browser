# CDP DOM Automation - Guia Completo

*Documento researched e compilado em 2025-03-17*

## Índice

1. [Introdução ao Chrome DevTools Protocol](#introdução)
2. [Principais Métodos CDP para Automação de DOM](#principais-metodos)
3. [Runtime.evaluate vs Runtime.callFunctionOn](#runtime-methods-comparison)
4. [Como Playwright usa CDP Internamente](#playwright-cdp-internals)
5. [Network Interception via CDP](#network-interception)
6. [Cookie Management via CDP](#cookie-management)
7. [LocalStorage/SessionStorage via CDP](#storage-management)
8. [Accessibility Tree via CDP para AI Agents](#accessibility-tree)
9. [Melhores Tools para Expor via MCP usando CDP](#mcp-tools)
10. [Exemplos Práticos Completo](#exemplos-praticos)

---

## <a name="introdução"></a>1. Introdução ao Chrome DevTools Protocol

### O que é CDP?

**Chrome DevTools Protocol (CDP)** é um protocolo de baixo nível que permite controlar programaticamente navegadores Chromium via WebSocket. Com aproximadamente **300+ comandos** organizados em domínios como:

- **Page** - navegação, capturas,等等
- **DOM** - manipulação do DOM
- **Runtime** - execução de JavaScript
- **Network** - interceptação de rede
- **Accessibility** - árvore de acessibilidade
- **Storage** - cookies, localStorage, sessionStorage
- **Input** - eventos de mouse/teclado
- **CSS** - manipulação de estilos

### Arquitetura CDP

```
┌─────────────────┐
│   Seu Script    │
│  (Node/Python)  │
└────────┬────────┘
         │ WebSocket
         ▼
┌─────────────────┐
│    CDP Session  │
│ (Browser WS)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Chromium     │
│  (Internals)    │
└─────────────────┘
```

### Conexão

```javascript
// JavaScript (Node.js)
const CDP = require('chrome-remote-interface');

CDP(async (client) => {
  const { DOM, Runtime, Page } = client;
  await Page.enable();
  // ... use os domínios
}).on('error', (err) => {
  console.error(err);
});
```

```python
# Python
import asyncio
from pycdp import browser, dom, runtime, page

async def main():
    async with browser.loop():
        conn = await browser.connect('http://localhost:9222')
        tab = (await conn.targets[0].create_session())[0]
        await page.enable(tab)
        # ... use os domínios

asyncio.run(main())
```

---

## <a name="principais-metodos"></a>2. Principais Métodos CDP para Automação de DOM

### 2.1 DOM Domain

O domínio **DOM** fornece métodos para inspecionar e modificar a árvore DOM de uma página.

#### **DOM.enable**

Ativa o domínio DOM para começar a coletar informações.

```javascript
await DOM.enable();
```

#### **DOM.getDocument**

Retorna o nó raiz do documento DOM.

```javascript
const result = await DOM.getDocument({
  depth: -1,           // -1 para toda a árvore
  pierce: true,        // atravessa frames
  // slice: { index, count } para paginação
});
```

Retorna:
```json
{
  "root": {
    "nodeId": 1,
    "nodeType": 9,
    "nodeName": "#document",
    "childNodeCount": 5
  }
}
```

#### **DOM.requestNode**

Obtém um nó DOM baseado em um `objectId` do runtime.

```javascript
const node = await DOM.requestNode({
  objectId: '{"type":"object","subtype":"node","unused":0}'
});
// Retorna: { nodeId: 123 }
```

#### **DOM.describeNode**

Obtém informações detalhadas sobre um nó (incluindo box model).

```javascript
const info = await DOM.describeNode({
  nodeId: 123,
  // backendNodeId: 456,  // alternativa
  // objectId: "..."      // alternativa
});
```

#### **DOM.querySelector / DOM.querySelectorAll**

Executa querySelector no DOM.

```javascript
// querySelector retorna o primeiro elemento
const { nodeId } = await DOM.querySelector({
  nodeId: 1,  // nó raiz ou outro
  selector: 'div.content > p.intro'
});

// querySelectorAll retorna todos
const { nodeIds } = await DOM.querySelectorAll({
  nodeId: 1,
  selector: '.item'
});
```

#### **DOM.setAttributeValue**

Modifica um atributo HTML.

```javascript
await DOM.setAttributeValue({
  nodeId: 123,
  name: 'class',
  value: 'new-class active'
});
```

#### **DOM.removeAttribute**

Remove um atributo.

```javascript
await DOM.removeAttribute({
  nodeId: 123,
  name: 'disabled'
});
```

#### **DOM.setNodeName**

Renomeia um elemento.

```javascript
await DOM.setNodeName({
  nodeId: 123,
  name: 'SPAN'
});
```

#### **DOM.insertBefore / DOM.appendChild**

Manipulação de estrutura.

```javascript
// Insere um novo nó
const { nodeId: newNodeId } = await DOM.pushNodeByFrontendId({
  parentId: 123,
  frontendId: 456,
  nodeType: 1,
  tagName: 'DIV'
});

// Insere antes de outro nó
await DOM.insertBefore({
  parentId: 123,
  referenceNodeId: 456,
  nodeId: newNodeId
});
```

#### **DOM.removeNode**

Remove um nó do DOM.

```javascript
await DOM.removeNode({
  nodeId: 123
});
```

#### **DOM.setInnerHTML / DOM.getOuterHTML**

Manipulação de HTML.

```javascript
// Define HTML interno
await DOM.setInnerHTML({
  nodeId: 123,
  innerHTML: '<span>Hello World</span>'
});

// Obtém HTML externo
const { outerHTML } = await DOM.getOuterHTML({
  nodeId: 123
});
```

#### **DOM.getBoxModel**

Obtém o box model (posição e dimensões) de um nó.

```javascript
const { model } = await DOM.getBoxModel({
  nodeId: 123
});
// model: { content, padding, border, margin, shapeOutside }
```

### 2.2 DOMSnapshot Domain (Performance)

Para capturas rápidas do DOM completo:

```javascript
await DOMSnapshot.enable();

const { documents } = await DOMSnapshot.captureSnapshot({
  computedStyles: ['font-size', 'color', 'display'],
  includeDOMRects: true,
  includePaintOrder: true,
  // includeEventListeners: true, // se habilitado
  // includeUserAgentShadowDOM: true
});

// documents[0].nodes contém array de strings concatênados
// com attributes, children, nodeType, etc.
```

---

## <a name="runtime-methods-comparison"></a>3. Runtime.evaluate vs Runtime.callFunctionOn

Esta é uma das distinções mais importantes na automação CDP.

### Runtime.evaluate

Executa código JavaScript **no contexto global da página**.

#### Características:

- Executa no **contexto principal** (main world)
- Pode acessar variáveis globais `window`
- Retorna o resultado serializado (JSON-compatible)
- Suporta `returnByValue` ou `returnObjectId`
- **Contexto de segurança**: `executionContextId`

```javascript
// Avalia expressão e retorna valor
const { result } = await Runtime.evaluate({
  expression: 'document.title',
  // returnByValue: true,  // default: retorna valor serializado
  // awaitPromise: true,  // await promises automaticamente
  // userGesture: true,   // simula gesto de usuário
});

console.log(result.value); // "Minha Página"
```

#### Exemplos:

```javascript
// 1. Extrair dados do DOM
const { result } = await Runtime.evaluate({
  expression: `
    Array.from(document.querySelectorAll('.product'))
      .map(el => ({
        title: el.querySelector('h2')?.textContent,
        price: el.querySelector('.price')?.textContent
      }))
  `
});

// 2. Clique via JavaScript (sem eventos reais)
await Runtime.evaluate({
  expression: 'document.querySelector("#submit").click()'
});

// 3. Aguardar condição
await Runtime.evaluate({
  expression: `
    new Promise(resolve => {
      if (document.readyState === 'complete') {
        resolve();
      } else {
        window.addEventListener('load', resolve);
      }
    })
  `,
  awaitPromise: true
});

// 4. Executar código com contexto isolado
const { executionContextId } = await Runtime.evaluate({
  expression: '1 + 1',
  returnByValue: true
});
```

### Runtime.callFunctionOn

Executa uma função **em um objeto específico** (não no contexto global).

#### Características:

- Executa em um **objeto específico** (elemento DOM, window, etc.)
- `objectId` é obrigatório
- A função recebe o objeto como `this`
- Melhor para operações em elementos específicos
- Pode passar parâmetros para a função
- **Preserva contexto de execução**

```javascript
// Primeiro, obter o objectId de um elemento
const { nodeId } = await DOM.querySelector({
  nodeId: 1,
  selector: '#my-button'
});

const { objectId } = await DOM.resolveNode({
  nodeId: nodeId
});

// Chamar método no elemento
const { result } = await Runtime.callFunctionOn({
  objectId: objectId,
  functionDeclaration: `
    function() {
      this.style.backgroundColor = 'red';
      this.textContent = 'Clicked!';
      return this.id;
    }
  `,
  // arguments: [],  // parâmetros para a função
  // returnByValue: true
});
```

#### Exemplo prático - Clique seguro:

```javascript
// Obter elemento
const { nodeId } = await DOM.querySelector({
  nodeId: 1,
  selector: '.submit-btn'
});
const { objectId } = await DOM.resolveNode({
  nodeId: nodeId
});

// Executar click com opções
const { result } = await Runtime.callFunctionOn({
  objectId: objectId,
  functionDeclaration: `
    function(x, y, button) {
      const rect = this.getBoundingClientRect();
      this.dispatchEvent(new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + x,
        clientY: rect.top + y,
        button: button || 0
      }));
      return this.disabled;
    }
  `,
  arguments: [
    { value: 10 },  // x offset
    { value: 5 },   // y offset
    { value: 0 }    // button (0 = left)
  ],
  returnByValue: true
});

if (result.value === true) {
  console.log('Botão estava desabilitado');
}
```

### Comparação Direta

| Aspecto | Runtime.evaluate | Runtime.callFunctionOn |
|---------|------------------|-----------------------|
| **Contexto** | Global (window) | Objeto específico |
| **Objetivo** | Avaliar expressões | Chamar métodos em objetos |
| **objectId** | Opcional | Obrigatório |
| **`this`** | window | O objeto alvo |
| **Parâmetros** | N/A (código completo) | Via `arguments[]` |
| **Uso típico** | Extração de dados, waits | Manipulação de elementos |
| **Performance** | Mais rápido para código inline | Melhor para reutilização |

### Exemplo Completo - Diferença Prática:

```javascript
// RUNTIME.EVALUATE - Avalia no contexto global
const title = await Runtime.evaluate({
  expression: 'document.title'
}).then(r => r.result.value);

// RUNTIME.CALLFUNCTIONON - Opera em elemento específico
// Primeiro, obtém o elemento
const { nodeId } = await DOM.querySelector({
  nodeId: 1,
  selector: 'h1'
});
const { objectId } = await DOM.resolveNode({
  nodeId: nodeId
});

// Executa método no elemento
const { result } = await Runtime.callFunctionOn({
  objectId: objectId,
  functionDeclaration: 'function() { return this.textContent; }',
  returnByValue: true
});
const heading = result.value;
```

### Contextos de Execução (ExecutionContext)

```javascript
// Listar contextos de execução
const { contexts } = await Runtime.getExecutionContexts();

// Criar novo contexto isolado
const { executionContextId } = await Runtime.evaluate({
  expression: '1 + 1',
  contextId: undefined,
  // generatePreview: true
});
```

---

## <a name="playwright-cdp-internals"></a>4. Como Playwright usa CDP Internamente

### Arquitetura Playwright

```
┌─────────────┐     WebSocket     ┌──────────────┐     CDP/CDP+     ┌─────────────┐
│  Cliente    │ ──────────────► │ Playwright   │ ──────────────► │  Chromium   │
│  (JS/Py/...)│ ◄────────────── │   Server     │ ◄────────────── │   (Browser) │
└─────────────┘                 └──────────────┘                 └─────────────┘
       │                                                               │
       └─ Selenium/WebDriver BiDi (Firefox/WebKit) ───────────────────┘
```

### 4.1 CDP+ (Playwright's Extension)

Playwright estende o CDP padrão com **CDP+**, adicionando:

1. **Comandos customizados** para multi-frame
2. **Sincronização automática** de elementos
3. **Abstração de target/frame/session**
4. **Auto-waiting integrado**

#### Exemplo de CDP+:

```javascript
// Comando Playwright (internamente usa CDP+)
await page.click('button.submit');

// Internamente aproximadamente:
// 1. Waiting (smart wait)
// 2. Locate element via DOM.querySelector + DOM.resolveNode
// 3. Runtime.callFunctionOn para dispatch mouse events
// 4. CDP+ commands para trackear frames state
```

### 4.2 Smart Waiting - Como Funciona

Playwright implementa **esperas inteligentes** que monitoram eventos CDP:

```javascript
// Espera automática que Playwright faz:
const waitForNavigation = async () => {
  // 1. Sobrescreve Fetch para pausar requisições
  await client.send('Fetch.enable');

  // 2. Aguarda Page.loadEventFired
  client.on('Page.loadEventFired', resolve);

  // 3. Monitora DOM.contentLoaded, network idle, etc.
  await Promise.race([
    waitForDOMContentLoaded(),
    waitForNetworkIdle(),
    waitForTimeout(timeout)
  ]);
};
```

**Eventos monitorados**:
- `Page.frameStartedLoading`
- `Page.frameNavigated`
- `Page.frameStoppedLoading`
- `Page.loadEventFired`
- `Page.domContentEventFired`
- `Network.loadingFinished`
- `Network.loadingFailed`

### 4.3 Cross-Frame Handling

```javascript
// Playwright abstrai frames, mas internamente usa:
const frameTree = await Page.getResourceTree();

// Para cada frame, mantém:
// - frameId: identificador CDP
// - parentFrameId: hierarquia
// - executionContextId: contexto Runtime
```

### 4.4 Element Mapping

```javascript
// ElementHandle interno de Playwright:
class ElementHandle {
  async _getBackendNodeId() {
    const { nodeId } = await DOM.querySelector({
      nodeId: this._frame._mainContextId,
      selector: this._selector
    });

    const { backendNodeId } = await DOM.describeNode({
      nodeId
    });

    return backendNodeId; // Usado em CDP calls
  }
}
```

### 4.5 Performance: Por que Raw CDP é Mais Rápido

**Playwright** (exemplo de 1000 cliques):
```
Script → Playwright Server (Node.js) → CDP+ → Browser
      [326KB WebSocket overhead]
      [Latência extra: ~2-10ms por hop]
      [Abstração de frames/contexts]
```

**Raw CDP**:
```
Script → CDP → Browser
      [11KB WebSocket overhead]
      [Direto, sem hop]
      [Mais perto do metal]
```

**Benchmarks** (Browser Use):
- Puppeteer (raw CDP): 15-20% mais rápido que Playwright
- Captura de DOM: Playwright 326KB vs Puppeteer 11KB
- Screenshot: Raw CDP 3-5x mais rápido em servidores headless

### 4.6 Playwright com CDP Direto

```javascript
// Acessar CDP diretamente em uma página Playwright:
const client = await page.context().newCDPSession(page);

// Usar comandos CDP nativos:
await client.send('Network.enable');
await client.send('Runtime.evaluate', { expression: 'location.href' });

// Misturar Playwright + CDP:
await page.goto('https://example.com');  // Playwright API
await client.send('Network.setCacheDisabled', { cacheDisabled: true });  // CDP
await page.click('button');  // Playwright again
```

---

## <a name="network-interception"></a>5. Network Interception via CDP

### Domínio Fetch (Moderno - Recomendado)

O domínio **Fetch** é o método moderno para interceptação (substituiu `Network.setRequestInterception`).

#### **Fetch.enable**

Ativa interceptação de requisições.

```javascript
await Fetch.enable({
  patterns: [
    {
      urlPattern: '*',           //catchall
      resourceType: 'Document', // filtro por tipo
      requestStage: 'Request'   // Request | Response
    }
  ],
  handleAuthRequests: true  //lidar com autenticação
});
```

#### Evento: Fetch.requestPaused

Disparado quando uma requisição é pausada.

```javascript
client.on('Fetch.requestPaused', (event) => {
  const { requestId, request, frameId, resourceType } = event;

  console.log('Request:', request.url);
  console.log('Method:', request.method);
  console.log('Headers:', request.headers);

  // Decidir o que fazer:
  // 1. Continuar normally
  // 2. Mock response
  // 3. Fail request
  // 4. Auth challenge
});
```

#### **Fetch.continueRequest**

Continua a requisição original (opcionalmente modificando parâmetros).

```javascript
await Fetch.continueRequest({
  requestId: event.requestId,
  // url: 'https://new-url.com',    // modifica URL
  // method: 'POST',                // modifica método
  // postData: Buffer.from('...'),  // modifica body
  // headers: [{ name: 'X-Custom', value: 'test' }]
});
```

#### **Fetch.fulfillRequest**

Fornece uma resposta customizada (mock).

```javascript
await Fetch.fulfillRequest({
  requestId: event.requestId,
  responseCode: 200,
  responseHeaders: [
    { name: 'Content-Type', value: 'application/json' }
  ],
  body: Buffer.from(JSON.stringify({ mock: true })).toString('base64')
});
```

#### **Fetch.failRequest**

Faz a requisição falhar.

```javascript
await Fetch.failRequest({
  requestId: event.requestId,
  errorReason: 'Aborted'  // ou 'Failed', 'AccessDenied', etc.
});
```

#### **Fetch.continueWithAuth**

Continua uma requisição que requer autenticação.

```javascript
await Fetch.continueWithAuth({
  requestId: event.requestId,
  authChallengeResponse: {
    response: 'ProvideCredentials',
    username: 'user',
    password: 'pass'
  }
});
```

### Domínio Network (Para Cookies, Headers)

Para capturar **todas** as requisições e respostas, use também `Network`:

```javascript
await Network.enable();

// Eventos importantes:
client.on('Network.requestWillBeSent', (params) => {
  console.log('→', params.request.method, params.request.url);
});

client.on('Network.responseReceived', (params) => {
  console.log('←', params.response.status, params.response.url);
});

client.on('Network.loadingFinished', (params) => {
  console.log('✓ Completed:', params.requestId);
});

client.on('Network.loadingFailed', (params) => {
  console.log('✗ Failed:', params.errorText);
});
```

### Exemplo Completo: Interceptor Universal

```javascript
const CDP = require('chrome-remote-interface');

CDP(async (client) => {
  const { Fetch, Network, Page } = client;

  await Promise.all([
    Page.enable(),
    Network.enable(),
    Fetch.enable({
      patterns: [{ urlPattern: '*' }]
    })
  ]);

  // Armazenar requests
  const requests = new Map();

  // Capturar todas as requisições
  client.on('Network.requestWillBeSent', (params) => {
    requests.set(params.requestId, {
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      timestamp: params.timestamp
    });
  });

  // Capturar respostas
  client.on('Network.responseReceived', async (params) => {
    const req = requests.get(params.requestId);
    if (req) {
      req.status = params.response.status;
      req.mimeType = params.response.mimeType;
      req.headers = params.response.headers;
    }
  });

  // Pausar e inspecionar antes de continuar
  client.on('Fetch.requestPaused', async (event) => {
    console.log('[Intercepted]', event.request.url);

    // Mock JSON API
    if (event.request.url.includes('/api/data')) {
      await Fetch.fulfillRequest({
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' }
        ],
        body: Buffer.from(JSON.stringify({
          mocked: true,
          timestamp: Date.now()
        })).toString('base64')
      });
    } else {
      // Continuar normalmente
      await Fetch.continueRequest({
        requestId: event.requestId
      });
    }
  });

  // Navegar
  await Page.navigate({ url: 'https://example.com' });

}).on('error', console.error);
```

### CDP vs Playwright - Interceptação

**Playwright** (abstração):
```javascript
// Simples, mas menos controle
await page.route('**/api/**', route => {
  route.continue({
    headers: { ...route.request.headers(), 'X-Mock': 'true' }
  });
});
```

**CDP** (controle total):
```javascript
// Todo controle, múltiplos estágios
await Fetch.enable({ patterns: [...] });
client.on('Fetch.requestPaused', event => {
  // Inspecionar request, modificar headers, body, mock response,
  // autenticação, etc.
});
```

---

## <a name="cookie-management"></a>6. Cookie Management via CDP

### Domínio Network

Cookies são gerenciados via domínio **Network**.

#### **Network.getCookies**

Obtém todos os cookies para uma URL.

```javascript
const { cookies } = await Network.getCookies({
  // urls: ['https://example.com']  // opcional, default = current page
});

cookies.forEach(cookie => {
  console.log(`${cookie.name}=${cookie.value}`);
  console.log('  Domain:', cookie.domain);
  console.log('  Path:', cookie.path);
  console.log('  Expires:', cookie.expires);
  console.log('  HttpOnly:', cookie.httpOnly);
  console.log('  Secure:', cookie.secure);
  console.log('  SameSite:', cookie.sameSite);
});
```

#### **Network.setCookies**

Define cookies.

```javascript
await Network.setCookies({
  cookies: [
    {
      name: 'session_id',
      value: 'abc123',
      domain: 'example.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600, // timestamp em segundos
      // httpOnly: true,
      // secure: true,
      // sameSite: 'Lax'  // 'Strict' | 'Lax' | 'None'
    }
  ]
});
```

#### **Network.deleteCookies**

Remove cookies.

```javascript
await Network.deleteCookies({
  name: 'session_id',
  // url: 'https://example.com/path',  // ou domain + path
  domain: 'example.com',
  path: '/'
});
```

#### **Network.clearBrowserCookies**

Limpa todos os cookies.

```javascript
await Network.clearBrowserCookies();
```

### Exemplo: Cookie Manager Completo

```javascript
class CookieManager {
  constructor(client) {
    this.client = client;
    this.network = client.Network;
  }

  async init() {
    await this.network.enable();
  }

  async getAllCookies(url = null) {
    const params = url ? { urls: [url] } : {};
    const { cookies } = await this.network.getCookies(params);
    return cookies;
  }

  async setCookie(cookie) {
    await this.network.setCookies({
      cookies: [cookie]
    });
  }

  async setMultiple(cookies) {
    await this.network.setCookies({ cookies });
  }

  async deleteCookie({ name, url, domain, path }) {
    await this.network.deleteCookies({ name, url, domain, path });
  }

  async exportCookies() {
    const cookies = await this.getAllCookies();
    return JSON.stringify(cookies);
  }

  async importCookies(jsonString) {
    const cookies = JSON.parse(jsonString);
    await this.setMultiple(cookies);
  }
}

// Uso:
const client = await CDP.connect(...);
const cookieManager = new CookieManager(client);
await cookieManager.init();

const cookies = await cookieManager.getAllCookies();
await cookieManager.setCookie({
  name: 'auth_token',
  value: 'xxx',
  domain: 'app.example.com',
  path: '/',
  httpOnly: true,
  secure: true
});
```

### Observação sobre Segurança

- **HttpOnly**: Cookie só acessível via HTTP, não via JavaScript
- **Secure**: Só enviado via HTTPS
- **SameSite**: Controle CSRF (`Strict` | `Lax` | `None`)
- CDP **pode** modificar HttpOnly cookies (é uma ferramenta de debug)

---

## <a name="storage-management"></a>7. LocalStorage/SessionStorage via CDP

### Domínio DOM Storage (Deprecated)

O domínio `DOMStorage` está **deprecated** em favor de `Runtime.evaluate` para acesso a storage.

#### **DOMStorage.enable** (Legado)

```javascript
await DOMStorage.enable();

// Obter itens
const { entries } = await DOMStorage.getDOMStorageItems({
  storageId: {
    securityOrigin: 'https://example.com',
    isLocalStorage: true  // false = sessionStorage
  }
});

// Setar item
await DOMStorage.setDOMStorageItem({
  storageId: {
    securityOrigin: 'https://example.com',
    isLocalStorage: true
  },
  key: 'token',
  value: 'abc123'
});

// Remover item
await DOMStorage.removeDOMStorageItem({
  storageId: { ... },
  key: 'token'
});

// Limpar tudo
await DOMStorage.clearDOMStorage({
  storageId: { ... }
});
```

### Método Moderno: Runtime.evaluate

```javascript
// LocalStorage
const { result } = await Runtime.evaluate({
  expression: `
    (() => {
      const keys = Object.keys(localStorage);
      return Object.fromEntries(
        keys.map(k => [k, localStorage.getItem(k)])
      );
    })()
  `
});

const localStorageData = result.value;

// Setar valor
await Runtime.evaluate({
  expression: `localStorage.setItem('token', 'abc123')`
});

// Remover
await Runtime.evaluate({
  expression: `localStorage.removeItem('token')`
});

// Limpar tudo
await Runtime.evaluate({
  expression: `localStorage.clear()`
});

// SessionStorage (mesmo padrão)
await Runtime.evaluate({
  expression: `sessionStorage.getItem('user')`
});
```

### Exemplo: Gerenciador de Storage

```javascript
class StorageManager {
  constructor(client) {
    this.client = client;
    this.runtime = client.Runtime;
  }

  async getLocalStorage() {
    const { result } = await this.runtime.evaluate({
      expression: `
        (() => {
          const keys = Object.keys(localStorage);
          return keys.reduce((acc, key) => {
            acc[key] = localStorage.getItem(key);
            return acc;
          }, {});
        })()
      `
    });
    return result.value;
  }

  async setLocalStorage(key, value) {
    await this.runtime.evaluate({
      expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
    });
  }

  async getSessionStorage() {
    const { result } = await this.runtime.evaluate({
      expression: `
        (() => {
          const keys = Object.keys(sessionStorage);
          return keys.reduce((acc, key) => {
            acc[key] = sessionStorage.getItem(key);
            return acc;
          }, {});
        })()
      `
    });
    return result.value;
  }

  async clearAllStorage() {
    await this.runtime.evaluate({
      expression: `localStorage.clear(); sessionStorage.clear();`
    });
  }
}
```

### Limitações

- `localStorage` e `sessionStorage` são **origin-bound** (por protocolo + domínio)
- Acesso só é possível se a página já carregou (não em about:blank)
- Storage vazio retorna `{}`

---

## <a name="accessibility-tree"></a>8. Accessibility Tree via CDP para AI Agents

### Domínio Accessibility

A árvore de acessibilidade é **extremamente útil para AI agents** porque:

1. **Semântica enriquecida**: Roles, states, properties
2. **Texto legível**: O que um screen reader lê
3. **Hierarquia clara**: Árvore lógica (não visual)
4. **Interação**: Focus, selection states
5. **Performance**: Menor overhead que extrair DOM completo

#### **Accessibility.enable**

Ativa o domínio.

```javascript
await Accessibility.enable();
```

#### **Accessibility.getFullAXTree**

Obtém a árvore completa de acessibilidade.

```javascript
const { nodes } = await Accessibility.getFullAXTree();

// nodes[] é um array plano:
// {
//   nodeId: string,
//   role: { value: 'button', localized: 'Botão' },
//   name: { value: 'Submit', ... },
//   properties: [ { name: 'checked', value: { value: true } } ],
//   childIds: [2, 3, 4],
//   backendDOMNodeId: 123,
//   frameId: '...'
// }
```

#### **Accessibility.axNodeIdForObject**

Mapeia um objeto do Runtime para um nó de acessibilidade.

```javascript
const { axNodeId } = await Accessibility.axNodeIdForObject({
  objectId: objectId  // do Runtime.resolveNode
});
```

#### **Accessibility.getChildAXNodes**

Obtém filhos de um nó específico.

```javascript
const { nodes } = await Accessibility.getChildAXNodes({
  id: { backendNodeId: 123 }
});
```

### Exemplo: Extrator de Acessibilidade para AI

```javascript
class AccessibilityExtractor {
  constructor(client) {
    this.client = client;
    this.ax = client.Accessibility;
    this.dom = client.DOM;
  }

  async getStructuredAXTree() {
    await this.ax.enable();

    const { nodes } = await this.ax.getFullAXTree();

    // Construir árvore hierárquica
    const tree = this.buildTree(nodes);

    // Converter para formato amigável para AI
    return this.formatForAI(tree);
  }

  buildTree(nodes) {
    const map = new Map();

    // Criar mapa de nós
    nodes.forEach(node => {
      map.set(node.nodeId, {
        role: node.role.value,
        name: node.name.value,
        properties: this.extractProperties(node.properties),
        children: [],
        backendDOMNodeId: node.backendDOMNodeId
      });
    });

    // Construir hierarquia
    const roots = [];
    nodes.forEach(node => {
      const item = map.get(node.nodeId);
      if (item) {
        node.childIds.forEach(childId => {
          const child = map.get(childId);
          if (child) item.children.push(child);
        });
        if (!node.parentId || !map.has(node.parentId)) {
          roots.push(item);
        }
      }
    });

    return roots;
  }

  extractProperties(properties) {
    const props = {};
    properties.forEach(prop => {
      if (prop.value && 'value' in prop.value) {
        props[prop.name] = prop.value.value;
      } else if (prop.value && 'type' in prop.value) {
        props[prop.name] = prop.value.type;
      }
    });
    return props;
  }

  formatForAI(tree) {
    // Formato simplificado para LLM
    return this.simplifyNode(tree);
  }

  simplifyNode(nodes, depth = 0) {
    return nodes.map(node => {
      const simplified = {
        role: node.role,
        name: node.name,
        interactive: node.properties.hasOwnProperty('editable') ||
                     ['button', 'link', 'textbox', 'checkbox', 'radio'].includes(node.role)
      };

      if (node.children.length > 0) {
        simplified.children = this.simplifyNode(node.children, depth + 1);
      }

      return simplified;
    });
  }
}

// Uso:
const extractor = new AccessibilityExtractor(client);
const axTree = await extractor.getStructuredAXTree();
console.log(JSON.stringify(axTree, null, 2));
```

### Comparação: DOM vs Accessibility Tree

```javascript
// DOM: Estrutura visual (tags HTML)
<div class="container">
  <button class="btn primary">Submit</button>
</div>

// Accessibility Tree: Estrutura semântica
Role: group
Name: ""
Children:
  - Role: button
    Name: "Submit"
    Properties: { focusable: true, actionable: true }
```

**Para AI agents**, a accessibility tree é geralmente **superior** porque:

- Remina tags técnicas (div, span) vs. roles semânticas
- Expõe apenas elementos interativos/úteis
- Inclui estados (checked, expanded, selected)
- Fornece nomes acessíveis (já processados)

### Exemplo: Localizar botão clicável

```javascript
// DOM approach (complicado)
const buttons = await DOM.querySelectorAll({
  nodeId: 1,
  selector: 'button, [role="button"], input[type="submit"]'
});

// Accessibility approach (simples)
const axNodes = await Accessibility.getFullAXTree();
const clickables = axNodes.nodes.filter(node =>
  ['button', 'link', 'textbox', 'checkbox', 'radio', 'searchbox'].includes(node.role.value) &&
  node.name.value // tem texto/label
);
```

---

## <a name="mcp-tools"></a>9. Melhores Tools para Expor via MCP usando CDP

**MCP (Model Context Protocol)** é um protocolo para conectar LLMs a ferramentas externas. Para browser automation via CDP, expor:

### 9.1 Categorias de Tools

#### Navigation Tools

```javascript
{
  name: 'browser_navigate',
  description: 'Navigate to a URL',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to' },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        default: 'load'
      }
    },
    required: ['url']
  }
}

// Implementação CDP:
async function navigate(url, waitUntil = 'load') {
  await Page.navigate({ url });

  if (waitUntil === 'load') {
    await waitForLoad();
  } else if (waitUntil === 'domcontentloaded') {
    await waitForDOMContent();
  } else if (waitUntil === 'networkidle') {
    await waitForNetworkIdle();
  }
}
```

#### DOM Querying Tools

```javascript
{
  name: 'browser_query_selector',
  description: 'Find element using CSS selector',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string' },
      all: { type: 'boolean', default: false }
    },
    required: ['selector']
  }
}

{
  name: 'browser_screenshot',
  description: 'Take screenshot of page or element',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string' },  // optional, full page if not provided
      fullPage: { type: 'boolean', default: false }
    }
  }
}
```

#### Runtime Evaluation Tools

```javascript
{
  name: 'browser_evaluate',
  description: 'Execute JavaScript in page context and return result',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string' },
      awaitPromise: { type: 'boolean', default: false }
    },
    required: ['expression']
  }
}
```

#### Network Tools

```javascript
{
  name: 'browser_enable_network_interception',
  description: 'Enable network request interception with patterns',
  inputSchema: {
    type: 'object',
    properties: {
      patterns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            urlPattern: { type: 'string' },
            resourceType: { type: 'string' },
            requestStage: { type: 'string', enum: ['Request', 'Response'] }
          }
        }
      }
    }
  }
}

{
  name: 'browser_get_network_requests',
  description: 'Get all captured network requests (requires interception enabled)',
  inputSchema: {
    type: 'object',
    properties: {
      includeResponses: { type: 'boolean', default: false }
    }
  }
}

{
  name: 'browser_mock_response',
  description: 'Mock a network response',
  inputSchema: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      responseCode: { type: 'number' },
      body: { type: 'string' },
      contentType: { type: 'string' }
    },
    required: ['requestId', 'responseCode']
  }
}
```

#### Cookie Tools

```javascript
{
  name: 'browser_get_cookies',
  description: 'Get all cookies for current page',
  inputSchema: {
    type: 'object'
  }
}

{
  name: 'browser_set_cookie',
  description: 'Set a cookie',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      value: { type: 'string' },
      domain: { type: 'string' },
      path: { type: 'string', default: '/' },
      httpOnly: { type: 'boolean' },
      secure: { type: 'boolean' },
      sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] }
    },
    required: ['name', 'value']
  }
}
```

#### Storage Tools

```javascript
{
  name: 'browser_get_local_storage',
  description: 'Get all localStorage items',
  inputSchema: { type: 'object' }
}

{
  name: 'browser_set_local_storage',
  description: 'Set localStorage item',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' }
    },
    required: ['key', 'value']
  }
}
```

#### Accessibility Tools (Para AI Agents)

```javascript
{
  name: 'browser_get_accessibility_tree',
  description: 'Get accessibility tree (semantic structure for AI)',
  inputSchema: {
    type: 'object',
    properties: {
      simplified: { type: 'boolean', default: true }
    }
  }
}

{
  name: 'browser_find_interactive_elements',
  description: 'Find all clickable/interactive elements via accessibility',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['button', 'link', 'textbox', 'checkbox', 'radio']
      }
    }
  }
}
```

### 9.2 Exemplo: MCP Server Completo CDP

```javascript
// server.js - MCP Server com CDP
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'cdp-browser', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

let client = null;
let { Page, DOM, Runtime, Network, Fetch, Accessibility } = {};

// Conectar ao CDP
async function connectCDP() {
  const CDP = require('chrome-remote-interface');
  client = await CDP();
  ({ Page, DOM, Runtime, Network, Fetch, Accessibility } = client);

  await Promise.all([
    Page.enable(),
    DOM.enable(),
    Runtime.enable(),
    Network.enable(),
    Fetch.enable({ patterns: [{ urlPattern: '*' }] }),
    Accessibility.enable()
  ]);

  console.log('✓ CDP Connected');
}

// Tool: Navigate
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'browser_navigate':
        await Page.navigate({ url: args.url });
        if (args.waitUntil !== 'none') {
          await waitForEvent(Page, args.waitUntil);
        }
        return { content: [{ type: 'text', text: `Navigated to ${args.url}` }] };

      case 'browser_query_selector':
        const { nodeId } = await DOM.querySelector({
          nodeId: 1,  // document
          selector: args.selector
        });

        if (nodeId === undefined && args.all) {
          const { nodeIds } = await DOM.querySelectorAll({
            nodeId: 1,
            selector: args.selector
          });
          return { content: [{ type: 'text', text: JSON.stringify(nodeIds) }] };
        }

        return { content: [{ type: 'text', text: `Found nodeId: ${nodeId}` }] };

      case 'browser_evaluate':
        const { result } = await Runtime.evaluate({
          expression: args.expression,
          awaitPromise: args.awaitPromise || false,
          returnByValue: true
        });
        return { content: [{ type: 'text', text: JSON.stringify(result.value) }] };

      case 'browser_screenshot':
        const { data } = await Page.captureScreenshot({
          format: 'png',
          fromSurface: true
        });
        return {
          content: [{
            type: 'image',
            data: Buffer.from(data, 'base64').toString('base64'),
            mimeType: 'image/png'
          }]
        };

      case 'browser_get_accessibility_tree':
        const { nodes } = await Accessibility.getFullAXTree();
        const tree = args.simplified
          ? simplifyAXTree(nodes)
          : nodes;
        return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
  }
});

// Helpers
async function waitForEvent(domain, eventName, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      domain.removeListener(eventName, onEvent);
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeout);

    const onEvent = (...args) => {
      clearTimeout(timer);
      domain.removeListener(eventName, onEvent);
      resolve(args);
    };

    domain.on(eventName, onEvent);
  });
}

function simplifyAXTree(nodes) {
  return nodes.map(node => ({
    role: node.role.value,
    name: node.name.value,
    interactive: ['button', 'link', 'textbox', 'checkbox', 'radio'].includes(node.role.value),
    focused: node.properties?.find(p => p.name === 'focused')?.value.value || false
  }));
}

// Start server
async function main() {
  await connectCDP();
  await server.connect(new StdioServerTransport());
}

main().catch(console.error);
```

---

## <a name="exemplos-praticos"></a>10. Exemplos Práticos Completos

### 10.1 Web Scraper Inteligente com CDP

```javascript
const CDP = require('chrome-remote-interface');

class SmartScraper {
  constructor(port = 9222) {
    this.port = port;
    this.client = null;
    this.requests = [];
  }

  async connect() {
    this.client = await CDP({ port: this.port });
    const { Page, Network, DOM, Runtime } = this.client;

    await Promise.all([
      Page.enable(),
      Network.enable(),
      DOM.enable(),
      Runtime.enable()
    ]);

    this.setupNetworkCapture();
  }

  setupNetworkCapture() {
    this.client.Network.on('Network.requestWillBeSent', (params) => {
      this.requests.push({
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        timestamp: params.timestamp
      });
    });
  }

  async goto(url, waitUntil = 'networkidle') {
    const { Page } = this.client;
    await Page.navigate({ url });
    await this.waitForLoad(waitUntil);
  }

  async waitForLoad(waitUntil) {
    const { Page } = this.client;

    if (waitUntil === 'load') {
      await new Promise(resolve => {
        Page.on('Page.loadEventFired', () => resolve());
      });
    } else if (waitUntil === 'domcontentloaded') {
      await new Promise(resolve => {
        Page.on('Page.domContentEventFired', () => resolve());
      });
    } else if (waitUntil === 'networkidle') {
      await this.waitForNetworkIdle();
    }
  }

  async waitForNetworkIdle(timeout = 30000) {
    const { Network } = this.client;
    const start = Date.now();
    let idleStart = Date.now();
    let pendingRequests = 0;

    Network.on('Network.requestWillBeSent', () => pendingRequests++);
    Network.on('Network.loadingFinished', () => pendingRequests--);
    Network.on('Network.loadingFailed', () => pendingRequests--);

    return new Promise((resolve, reject) => {
      const check = () => {
        if (pendingRequests === 0 && Date.now() - idleStart > 1000) {
          resolve();
        } else if (Date.now() - start > timeout) {
          reject(new Error('Network idle timeout'));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  async extractData(selector, extractor) {
    const { DOM, Runtime } = this.client;

    // Encontrar elementos
    const { nodeIds } = await DOM.querySelectorAll({
      nodeId: 1,
      selector
    });

    if (nodeIds.length === 0) return [];

    // Obter objectIds
    const objectPromises = nodeIds.map(async (nodeId) => {
      const { objectId } = await DOM.resolveNode({ nodeId });
      return objectId;
    });
    const objectIds = await Promise.all(objectPromises);

    // Extrair dados via Runtime
    const extractFn = `
      function(obj) {
        ${extractor}
      }
    `;

    const results = [];
    for (const objectId of objectIds) {
      const { result } = await Runtime.callFunctionOn({
        objectId,
        functionDeclaration: extractFn,
        returnByValue: true,
        args: []
      });
      results.push(result.value);
    }

    return results;
  }

  async screenshot(path = 'screenshot.png') {
    const { Page } = this.client;
    const { data } = await Page.captureScreenshot({
      format: 'png',
      fromSurface: true
    });

    const fs = require('fs');
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  async close() {
    if (this.client) {
      await this.client.Page.close();
      await this.client.close();
    }
  }
}

// Uso:
(async () => {
  const scraper = new SmartScraper(9222);
  await scraper.connect();

  await scraper.goto('https://news.ycombinator.com');

  const titles = await scraper.extractData('.storylink', `
    return {
      text: this.textContent,
      href: this.href
    }
  `);

  console.log(titles);

  await scraper.screenshot('hn.png');
  await scraper.close();
})();
```

### 10.2 Browser Automation com Smart Selector

```javascript
class SmartBrowser {
  constructor(port = 9222) {
    this.client = null;
    this.cdp = null;
  }

  async connect() {
    this.cdp = await CDP({ port });
    this.client = this.cdp;

    await Promise.all([
      this.cdp.Page.enable(),
      this.cdp.DOM.enable(),
      this.cdp.Runtime.enable(),
      this.cdp.Input.enable()
    ]);

    this.setupEventListeners();
  }

  setupEventListeners() {
    this.cdp.Page.on('Page.loadEventFired', () => {
      console.log('Page loaded');
    });

    this.cdp.Page.on('Page.frameStartedLoading', (params) => {
      console.log('Frame loading:', params.frameId);
    });

    this.cdp.Page.on('Page.frameStoppedLoading', (params) => {
      console.log('Frame loaded:', params.frameId);
    });
  }

  async click(selector, options = {}) {
    const { DOM, Runtime, Input } = this.cdp;

    // 1. Encontrar elemento
    const { nodeId } = await DOM.querySelector({
      nodeId: 1,
      selector
    });

    if (!nodeId) {
      throw new Error(`Element not found: ${selector}`);
    }

    // 2. Obter backendNodeId para interactions
    const { backendNodeId } = await DOM.describeNode({
      nodeId
    });

    // 3. Obter box model para coordenadas
    const { model } = await DOM.getBoxModel({
      nodeId
    });

    const contentBox = model.content;
    const x = (contentBox[0] + contentBox[2]) / 2;
    const y = (contentBox[1] + contentBox[3]) / 2;

    // 4. Dispatch mouse events via Runtime
    const { objectId } = await DOM.resolveNode({
      nodeId
    });

    await Runtime.callFunctionOn({
      objectId,
      functionDeclaration: `
        function(x, y) {
          const rect = this.getBoundingClientRect();
          this.dispatchEvent(new MouseEvent('mousedown', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: rect.left + x,
            clientY: rect.top + y,
            button: 0
          }));
          this.dispatchEvent(new MouseEvent('mouseup', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: rect.left + x,
            clientY: rect.top + y,
            button: 0
          }));
          this.dispatchEvent(new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: rect.left + x,
            clientY: rect.top + y,
            button: 0
          }));
          return true;
        }
      `,
      arguments: [
        { value: x - (contentBox[0] + contentBox[2]) / 2 },
        { value: y - (contentBox[1] + contentBox[3]) / 2 }
      ],
      returnByValue: true
    });

    // Ou usar Input.dispatchMouseEvent (mais baixo nível)
    await Input.dispatchMouseEvent({
      type: 'mousePressed',
      x: Math.floor(x),
      y: Math.floor(y),
      button: 'left',
      clickCount: 1
    });

    await Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x: Math.floor(x),
      y: Math.floor(y),
      button: 'left',
      clickCount: 1
    });
  }

  async type(selector, text) {
    // Focar no elemento primeiro
    await this.click(selector);

    // Limpar campo se necessário
    await this.evaluate(`
      document.activeElement.value = '';
    `);

    // Digitar caractere por caractere
    for (const char of text) {
      await this.evaluate(`
        document.activeElement.value += '${char}';
        document.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async evaluate(expression) {
    const { result } = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return result.value;
  }

  async getPageContent() {
    return this.evaluate('document.documentElement.outerHTML');
  }

  async waitForSelector(selector, timeout = 10000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const { nodeId } = await this.client.DOM.querySelector({
        nodeId: 1,
        selector
      });

      if (nodeId) return nodeId;

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }
}

// Uso:
(async () => {
  const browser = new SmartBrowser(9222);
  await browser.connect();

  await browser.cdp.Page.navigate({ url: 'https://google.com' });

  await browser.waitForSelector('textarea[name="q"]');
  await browser.type('textarea[name="q"]', 'CDP automation');

  await browser.click('input[name="btnG"]');

  const html = await browser.getPageContent();
  console.log('Page title:', await browser.evaluate('document.title'));

  await browser.cdp.close();
})();
```

### 10.3 Mock Server com Interceptação de Rede

```javascript
class MockNetworkServer {
  constructor(client) {
    this.client = client;
    this.rules = [];
    this.storage = new Map();
  }

  async enable() {
    const { Fetch } = this.client;
    await Fetch.enable({
      patterns: [{ urlPattern: '*' }]
    });

    Fetch.on('Fetch.requestPaused', this.handleRequest.bind(this));
  }

  async handleRequest(event) {
    const { requestId, request } = event;

    // Verificar regras
    const rule = this.rules.find(r => this.matches(request, r));

    if (rule) {
      if (rule.action === 'mock') {
        const body = typeof rule.response.body === 'string'
          ? rule.response.body
          : JSON.stringify(rule.response.body);

        await this.client.Fetch.fulfillRequest({
          requestId,
          responseCode: rule.response.status || 200,
          responseHeaders: [
            { name: 'Content-Type', value: rule.response.contentType || 'application/json' }
          ],
          body: Buffer.from(body).toString('base64')
        });
      } else if (rule.action === 'delay') {
        setTimeout(async () => {
          await this.client.Fetch.continueRequest({ requestId });
        }, rule.delay || 1000);
      } else if (rule.action === 'fail') {
        await this.client.Fetch.failRequest({
          requestId,
          errorReason: 'Aborted'
        });
      } else {
        await this.client.Fetch.continueRequest({ requestId });
      }
    } else {
      await this.client.Fetch.continueRequest({ requestId });
    }
  }

  matches(request, rule) {
    if (rule.url && !request.url.includes(rule.url)) return false;
    if (rule.method && rule.method !== request.method) return false;
    if (rule.resourceType && rule.resourceType !== request.resourceType) return false;
    return true;
  }

  addRule(rule) {
    this.rules.push(rule);
  }

  clearRules() {
    this.rules = [];
  }
}

// Uso:
const mock = new MockNetworkServer(client);
await mock.enable();

// Mock API
mock.addRule({
  url: '/api/users',
  method: 'GET',
  action: 'mock',
  response: {
    status: 200,
    contentType: 'application/json',
    body: { users: [{ id: 1, name: 'Mock User' }] }
  }
});

// Simular delay
mock.addRule({
  url: '/api/slow',
  action: 'delay',
  delay: 5000  // 5 segundos
});

// Simular erro
mock.addRule({
  url: '/api/error',
  action: 'fail'
});
```

### 10.4 Auto-Login com Cookies

```javascript
class BrowserAuth {
  constructor(client) {
    this.client = client;
    this.Network = client.Network;
  }

  async saveSession(sessionName) {
    const cookies = await this.Network.getCookies();
    const localStorage = await this.client.Runtime.evaluate({
      expression: `(() => { const out = {}; Object.keys(localStorage).forEach(k => out[k] = localStorage.getItem(k)); return out; })()`,
      returnByValue: true
    });

    const session = {
      cookies,
      localStorage: localStorage.value,
      timestamp: Date.now()
    };

    const fs = require('fs');
    fs.writeFileSync(`./sessions/${sessionName}.json`, JSON.stringify(session, null, 2));
  }

  async loadSession(sessionName) {
    const fs = require('fs');
    const session = JSON.parse(
      fs.readFileSync(`./sessions/${sessionName}.json`, 'utf8')
    );

    // Restaurar cookies
    await this.Network.clearBrowserCookies();
    await this.Network.setCookies({ cookies: session.cookies });

    // Restaurar localStorage
    await this.client.Runtime.evaluate({
      expression: `Object.entries(${JSON.stringify(session.localStorage)}).forEach(([k,v]) => localStorage.setItem(k, v))`
    });
  }
}

// Uso:
const auth = new BrowserAuth(client);

// Salvar sessão logada
await auth.saveSession('my-account');

// Recarregar em nova sessão
await auth.loadSession('my-account');
```

### 10.5 Accessibility-First AI Agent

```javascript
class AIAgent {
  constructor(client) {
    this.client = client;
    this.ax = client.Accessibility;
    this.runtime = client.Runtime;
  }

  // Obter árvore simplificada para LLM
  async getPageContext() {
    const { nodes } = await this.ax.getFullAXTree();

    // Filtrar elementos relevantes
    const relevant = nodes.filter(node =>
      this.isRelevant(node)
    );

    // Extrair contexto
    const context = relevant.map(node => ({
      role: node.role.value,
      name: node.name.value,
      state: this.extractState(node.properties),
      actionable: this.isActionable(node)
    }));

    return context;
  }

  isRelevant(node) {
    // Elementos com nome e/interação
    const hasName = node.name.value && node.name.value.trim().length > 0;
    const isInteractive = this.isActionable(node);
    const isContainer = ['group', 'region', 'generic'].includes(node.role.value);

    return hasName && (isInteractive || isContainer);
  }

  isActionable(node) {
    const actionableRoles = [
      'button', 'link', 'textbox', 'searchbox',
      'checkbox', 'radio', 'switch', 'combobox',
      'menuitem', 'tab', 'option'
    ];

    if (actionableRoles.includes(node.role.value)) return true;

    // Verificar propriedades
    const props = this.extractState(node.properties);
    return props.editable || props.clickable || props.submit;
  }

  extractState(properties) {
    const state = {};
    properties.forEach(prop => {
      if (prop.value && typeof prop.value === 'object' && 'value' in prop.value) {
        state[prop.name] = prop.value.value;
      } else if (typeof prop.value === 'boolean') {
        state[prop.name] = prop.value;
      }
    });
    return state;
  }

  // Interpretar comando natural e executar
  async executeCommand(command) {
    const context = await this.getPageContext();

    // Embeddings/LLM aqui (simulado)
    const action = this.interpretAction(command, context);

    switch (action.type) {
      case 'click':
        await this.click(action.selector);
        break;
      case 'type':
        await this.type(action.selector, action.text);
        break;
      case 'scroll':
        await this.scroll(action.direction);
        break;
    }
  }

  async click(selector) {
    const { nodeId } = await this.client.DOM.querySelector({
      nodeId: 1,
      selector
    });

    if (!nodeId) throw new Error('Element not found');

    const { objectId } = await this.client.DOM.resolveNode({ nodeId });

    await this.client.Runtime.callFunctionOn({
      objectId,
      functionDeclaration: `
        function() {
          this.click();
          return true;
        }
      `,
      returnByValue: true
    });
  }

  async type(selector, text) {
    await this.click(selector);
    await this.client.Runtime.evaluate({
      expression: `
        const el = document.activeElement;
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      `
    });

    for (const char of text) {
      await this.client.Runtime.evaluate({
        expression: `
          document.activeElement.value += '${char}';
          document.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
        `
      });
      await new Promise(r => setTimeout(r, 30));
    }
  }
}
```

---

## Conclusão

### Recap: Ferramentas Essenciais CDP

1. **DOM**: `querySelector`, `querySelectorAll`, `getDocument`, `getBoxModel`
2. **Runtime**: `evaluate` (global), `callFunctionOn` (element-specific)
3. **Page**: `navigate`, `captureScreenshot`, reload
4. **Network/Fetch**: request interception, mocking
5. **Accessibility**: `getFullAXTree` para AI agents
6. **Storage**: Cookies via Network, localStorage via Runtime

### Quando Usar CDP Puro vs Playwright

**Use CDP puro**:
- Performance crítica (scraping massivo)
- Controle total sobre protocolo
- Debugging avançado
- CDP-only features (Fetch interception, Accessibility tree)
- Custo reduzido (sem abstração)

**Use Playwright**:
- Cross-browser Firefox/WebKit
- Time savings (abstração pronta)
- Auto-waits (mesmo que mais lento)
- Equipe familiarizada

### Para MCP Servers

Expor as **core tools**:

1. `browser_navigate` - Page.navigate
2. `browser_evaluate` - Runtime.evaluate
3. `browser_query` - DOM.querySelector + resolveNode
4. `browser_click` - Runtime.callFunctionOn + Input.dispatchMouseEvent
5. `browser_screenshot` - Page.captureScreenshot
6. `browser_get_network` - Network.requestWillBeSent + Fetch
7. `browser_get_accessibility` - Accessibility.getFullAXTree
8. `browser_set_cookie` - Network.setCookies
9. `browser_get_storage` - Runtime.evaluate(localStorage)
10. `browser_wait_for` - Page/Network events

---

## Referências

- [Chrome DevTools Protocol Documentation](https://chromedevtools.github.io/devtools-protocol/)
- [Playwright Architecture](https://playwright.dev/docs/internals)
- [Browser Use - CDP vs Playwright](https://browser-use.com/posts/playwright-to-cdp)
- [CDP Fetch Domain](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
- [CDP Accessibility Domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)
- [PyCDP Documentation](https://py-cdp.readthedocs.io/)
- [Chrome Remote Interface](https://github.com/cyrus-and/chrome-remote-interface)

---

**Documento gerado**: 2025-03-17
**Versão**: 1.0
**Status**: Completo