# Playwright MCP: Integração de Automação de Browser com Model Context Protocol

Data da Pesquisa: 2025-03-17
Fontes: Microsoft Playwright MCP, projetos CDP MCP, documentação oficial

---

## 1. O que o @playwright/mcp oferece e como funciona

### O que é?

O **@playwright/mcp** é um **Model Context Protocol (MCP) server** desenvolvido pela Microsoft que fornece capacidades de automação de navegadores via Playwright para LLMs e agentes de IA. Ele permite que modelos de linguagem controlem browsers reais através de uma interface padronizada MCP.

### Differencial Principal

Ao contrário de abordagens baseadas em **screenshots** (que requerem modelos de visão) ou **coordenadas de pixel** (imprecisas), o Playwright MCP opera sobre a **árvore de acessibilidade (accessibility tree)** — uma representação estruturada e textual da página. Isso torna a automação:

- **Mais rápida** (dados estruturados vs imagens)
- **Determinística** (não depende de interpretação visual)
- **Token-efficient** (consome ~27k tokens via CLI vs ~114k via MCP screenshot-based para mesma tarefa)
- **LLM-friendly** (funciona com qualquer LLM, sem necessidade de visão)

### Como Funciona

**Arquitetura em 3 camadas:**

```
┌──────────────────────────────────────────────┐
│         MCP Client (Claude, Cursor, Copilot) │
└───────────────┬──────────────────────────────┘
                │ MCP Protocol
                ▼
┌──────────────────────────────────────────────┐
│          Playwright MCP Server               │
│  • Capability Discovery                     │
│  • Tool Execution                           │
│  • Snapshot Management                      │
└───────────────┬──────────────────────────────┘
                │ Playwright API ou CDP
                ▼
┌──────────────────────────────────────────────┐
│        Browser (Chromium/Firefox/WebKit)     │
└──────────────────────────────────────────────┘
```

**Fluxo de execução:**

1. **Descoberta**: Cliente MCP consulta `listTools()` para ver ferramentas disponíveis
2. **Geração de comando**: LLM gera `callTool('browser_click', { ref: 'button-123' })`
3. **Execução**: Server usa Playwright para clicar no elemento referenciado
4. **Retorno**: Resultado estruturado + accessibility tree snapshot atualizado

### Modos de Transporte

- **STDIO** (padrão): Para IDEs (VS Code, Claude Desktop, Cursor)
- **HTTP/SSE**: Para deployments remotos (`--port 8931`)
- **WebSocket**: Para extension bridge

### Inicialização Lazy

O browser só é lançado no **primeiro tool invocation**, não no startup do server. Isso melhora performance e reduz recursos quando o server fica ocioso.

---

## 2. Quais ferramentas (tools) ele expõe via MCP

O Playwright MCP expõe **70+ tools** organizados em **capabilities** (habilitadas via `--caps`).

### Core (sempre habilitado — 21 tools)

#### Navegação

| Tool | Descrição |
|------|-----------|
| `browser_navigate` | Navegar para URL |
| `browser_navigate_back` | Voltar no histórico |
| `browser_close` | Fechar página |

#### Interação

| Tool | Descrição |
|------|-----------|
| `browser_click` | Clicar via ref (accessibility tree) |
| `browser_type` | Digitar texto com opcional submit |
| `browser_fill_form` | Preencher múltiplos campos |
| `browser_hover` | Hover sobre elemento |
| `browser_drag` | Arrastar entre elementos |
| `browser_select_option` | Selecionar em dropdown |
| `browser_press_key` | Pressionar tecla |
| `browser_file_upload` | Upload de arquivos |
| `browser_handle_dialog` | Aceitar/rejeitar dialogs |
| `browser_wait_for` | Esperar por condição/texto |
| `browser_resize` | Redimensionar viewport |

#### Inspeção

| Tool | Descrição |
|------|-----------|
| `browser_snapshot` | Capturar accessibility tree |
| `browser_take_screenshot` | Screenshot visual (png/jpeg, viewport/full-page/element) |
| `browser_evaluate` | Executar JavaScript |
| `browser_run_code` | Executar snippets Playwright |
| `browser_console_messages` | Recuperar output do console |
| `browser_network_requests` | Listar network calls |

#### Tabs

| Tool | Descrição |
|------|-----------|
| `browser_tabs` | Listar, criar, fechar, selecionar tabs |

### Vision (`--caps vision`)

Para interações coordenadas (screenshot-driven):

| Tool | Descrição |
|------|-----------|
| `browser_mouse_click_xy` | Click por coordenadas XY |
| `browser_mouse_move_xy` | Mover mouse por XY |
| `browser_mouse_drag_xy` | Arrastar por coordenadas |

**Nota:** São security-sensitive porque permitem clicar em coordenadas arbitrárias sem validação semântica.

### PDF (`--caps pdf`)

| Tool | Descrição |
|------|-----------|
| `browser_pdf_save` | Exportar página como PDF |

### Testing (`--caps testing`)

| Tool | Descrição |
|------|-----------|
| `browser_verify_element_visible` | Assert visibilidade |
| `browser_verify_text_visible` | Assert texto |
| `browser_verify_list_visible` | Assert conteúdo de lista |
| `browser_verify_value` | Validar input/checkbox |
| `browser_generate_locator` | Criar seletores de teste |

### DevTools/Tracing (`--caps devtools`)

| Tool | Descrição |
|------|-----------|
| `browser_start_tracing` | Iniciar trace de performance |
| `browser_stop_tracing` | Parar e salvar trace (.zip) |
| `browser_start_video` | Gravar sessão em vídeo |
| `browser_stop_video` | Parar gravação |

### Storage (`--caps storage`)

| Tool | Descrição |
|------|-----------|
| `browser_cookie_get/set/delete/list/clear` | Gerenciar cookies |
| `browser_localstorage_get/set/delete/list/clear` | Gerenciar localStorage |
| `browser_sessionstorage_get/set/delete/list/clear` | Gerenciar sessionStorage |
| `browser_storage_state` | Salvar estado completo |
| `browser_set_storage_state` | Restaurar estado |

### Network (`--caps network`)

| Tool | Descrição |
|------|-----------|
| `browser_network_state_set` | Simular offline/online |
| `browser_route` | Mockar respostas HTTP |
| `browser_route_list` | Ver rotas ativas |
| `browser_unroute` | Remover mocks |

### Exemplo de Schema Completo (Core)

```typescript
{
  name: "browser_click",
  description: "Click on an element using its accessibility reference",
  inputSchema: {
    type: "object",
    properties: {
      element: {
        type: "string",
        description: "Human-readable element description (for LLM context)"
      },
      ref: {
        type: "string",
        description: "Accessibility reference from snapshot (format: 'role[name]')"
      },
      button: {
        type: "string",
        enum: ["left", "middle", "right"],
        default: "left"
      },
      doubleClick: {
        type: "boolean",
        default: false
      }
    },
    required: ["ref"]
  }
}
```

---

## 3. Como conectar num Chrome remoto existente (CDP endpoint)

### Pré-requisitos: Iniciar Chrome com Remote Debugging

```bash
# Linux
google-chrome --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/chrome-debug"

# Windows
chrome.exe --remote-debugging-port=9222

# Com perfil específico (preserva cookies, localStorage)
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-profile"
```

Validar:

```bash
curl http://localhost:9222/json
# Retorna array de targets com webSocketDebuggerUrl
```

### Opção 1: CLI Arguments

```bash
npx @playwright/mcp@latest \
  --cdp-endpoint http://localhost:9222 \
  --browser chrome \
  --headed \
  --caps core,devtools
```

### Opção 2: Config JSON (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "playwright-remote": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint", "http://localhost:9222",
        "--browser", "chrome",
        "--headed"
      ],
      "env": {
        "PLAYWRIGHT_MCP_CDP_ENDPOINT": "http://localhost:9222",
        "PLAYWRIGHT_MCP_HEADED": "true"
      }
    }
  }
}
```

### Opção 3: Environment Variables

```bash
export PLAYWRIGHT_MCP_CDP_ENDPOINT="http://localhost:9222"
export PLAYWRIGHT_MCP_BROWSER="chrome"
export PLAYWRIGHT_MCP_HEADLESS="false"
export PLAYWRIGHT_MCP_CAPS="core,devtools"
npx @playwright/mcp@latest
```

### Parâmetros Avançados de CDP

| Parâmetro | Env Variable | Descrição |
|-----------|--------------|-----------|
| `--cdp-endpoint` | `PLAYWRIGHT_MCP_CDP_ENDPOINT` | URL do endpoint (ws:// ou http://) |
| `--cdp-header` | `PLAYWRIGHT_MCP_CDP_HEADERS` | Headers customizados (JSON) |
| `--cdp-timeout` | `PLAYWRIGHT_MCP_CDP_TIMEOUT` | Timeout ms (padrão: 30000) |

Exemplo com headers:

```bash
export PLAYWRIGHT_MCP_CDP_HEADERS='{"Authorization": "Bearer token"}'
npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222
```

### Conexão a Chrome já aberto

1. Inicie Chrome: `chrome --remote-debugging-port=9222`
2. Conectar Playwright MCP: `npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222`
3. Use `browser_tabs` para ver abas existentes
4. Use `browser_tab_select` para mudar entre elas

---

## 4. Diferença entre usar Playwright localmente vs conectar em Chrome remoto

### Comparação Rápida

| Aspecto | Playwright Local (default) | CDP Connect (remoto) |
|---------|----------------------------|----------------------|
| **Browser** | Executável do Playwright (Chromium/Firefox/WebKit) | Chrome/Chromium existente do sistema |
| **Setup** | Automático (download na primeira execução) | Manual (iniciar Chrome com flag) |
| **Isolation** | Total (contexto separado) | Compartilhado (sessão do usuário) |
| **Persistence** | Opcional (--user-data-dir) | Automática ( Cookies, localStorage do perfil Chrome) |
| **Performance** | Inicialização lenta (novo processo) | Rápido ( Chrome já rodando) |
| **Debug** | Via Playwright traces | DevTools nativo em tempo real |
| **Multi-tenant** | 1 browser por instância MCP | Pode conectar a qualquer Chrome |
| **Uso de disco** | Baixo (cache isolation) | Alto (profile compartilhado) |

### Quando Usar Cada Um

**Playwright Local:**

- ✅ **CI/CD**: Automação em pipelines, sem interference de UI
- ✅ **Testing isolado**: Cada test executa em contexto limpo
- ✅ **Batch processing**: Scraping em escala
- ✅ **Multi-browser**: Testar Chromium, Firefox, WebKit
- ✅ **Predictable**: Versão fixa do browser (não depende do Chrome instalado)

**CDP Connect:**

- ✅ **Debug development**: Aplicação em dev com hot reload
- ✅ **Reuse authenticated sessions**: Login já feito no Chrome aberto
- ✅ **Test with extensions**: Chrome com plugins específicos
- ✅ **Real browser conditions**: Testar com cache, cookies reais
- ✅ **Low-latency start**: Browser já inicializado

### Exemplo Prático

```bash
# Cenário 1: Automação limpa (local)
npx @playwright/mcp@latest --browser chromium --headless

# Cenário 2: Debug de app local (CDP)
# Abra seu app no Chrome: http://localhost:3000
# Inicie Chrome: chrome --remote-debugging-port=9222
npx @playwright/mcp@latest \
  --cdp-endpoint ws://localhost:9222 \
  --browser chrome \
  --headed
```

---

## 5. Como o projeto Serende pode se beneficiar da arquitetura do playwright-mcp

### Contexto: Serende

Serende é um sistema de **orquestração de sessões de browser remoto** com:

- Container Docker por sessão (isolamento)
- CDP endpoint por sessão
- API REST para criar/controlar sessões
- Frontend com visualização em tempo real (MJPEG)

### Benefícios

#### 1. Standardização via MCP

Atualmente, Serende expõe APIs customizadas. Adotar MCP permitiria:

- **Interoperabilidade** com qualquer cliente MCP (Claude Desktop, Cursor, GitHub Copilot)
- **Ecosistema** — usar skills/agents já-existentes na comunidade
- **Discovery automático** — clients sabem quais tools estão disponíveis

#### 2. Accessibility-First vs Pixel-Based

O Serende atual usa **screenshot+MJPEG** + **coordenadas XY** para interações. Isso requer:

- LLM com visão (GPT-4V, Claude 3.5 Sonnet) → caro
- Alto consumo de tokens (screenshot base64)
- Imprecisão em elementos dinâmicos

**Adotando accessibility snapshots:**

- Funciona com **qualquer LLM** (GPT-4, Claude Haiku, etc)
- **Determinístico**: IDs únicos para elementos
- **Token-efficient**: 20-60x menos tokens que screenshots
- **Robusto**: Atualizações de layout não quebram (IDs baseados em roles, não posição)

#### 3. Multi-Session como Resources

Cada sessão Serende poderia ser exposta como um **MCP resource**:

```typescript
// O cliente discovers automaticamente:
{
  resources: [
    { uri: "serende://session/abc123", name: "Sessão ABC" },
    { uri: "serende://session/def456", name: "Sessão DEF" }
  ]
}
```

#### 4. CDP Gateway Pattern

Serende já gerencia sessões com CDP endpoints. Podemos wrappear isso num MCP server:

```bash
# Cada sessão Serende inicia:
docker run -p 9222:9222 chrome-session-xyz

# MCP server conecta via CDP a cada uma:
npx @playwright/mcp@latest \
  --cdp-endpoint http://localhost:9222 \
  --custom-context-getter serende-gateway
```

Serende pode implementar `contextGetter` que:

1. Consulta seu registry de sessões ativas
2. Conecta à sessão solicitada via WebSocket CDP
3. Retorna Playwright `BrowserContext` para aquele Chrome

#### 5. Observability em Tempo Real

Playwright MCP suporta **notifications** (eventos streaming):

- `console_message` — log em tempo real
- `network_request` — requisições conforme acontecem
- `page_error` — erros de JavaScript

Serende poderia implementar MCP notifications para que o LLM reaja a eventos (ex: esperar por login success, detectar CAPTCHA).

#### 6. Device Emulation

Flag `--device "iPhone 15"` do Playwright emula viewport, user-agent, touch events, device pixel ratio automaticamente. Útil para testar mobile sem devices reais.

Serende poderia:

```bash
# Criar sessão com device profile
serende mcp-create-session --device "iPhone 15"
```

#### 7. CLI + SKILLs para Coding Agents

Microsoft descobriu que **CLI é mais eficiente** que MCP para coding agents:

- MCP: ~114k tokens por task
- CLI: ~27k tokens por task (4x menos)

Mecanismo: CLI salva screenshots/snapshots em disco em vez de streamar pro LLM.

**Implicação para Serende:**

- Para agents que têm filesystem access (Claude Code, Cursor): usar **CLI interface**
- Para agents isolados (Claude Desktop): usar **MCP**
- Oferecer ambas as interfaces

---

## 6. Código de exemplo de como criar um MCP server que conecta em Chrome via CDP

### Estrutura do Projeto

```bash
serende-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts        # MCP server principal
│   ├── cdpgateway.ts    # Gateway Playwright + CDP
│   └── tools/
│       ├── navigation.ts
│       ├── interaction.ts
│       ├── inspection.ts
│       └── networking.ts
└── README.md
```

### package.json

```json
{
  "name": "@serende/mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/server.js",
  "bin": {
    "serende-mcp": "dist/server.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "playwright": "^1.48.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.5.0"
  }
}
```

### src/server.ts

```typescript
#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { CDPGateway } from "./cdpgateway.js";
import { navigationTools } from "./tools/navigation.js";
import { interactionTools } from "./tools/interaction.js";
import { inspectionTools } from "./tools/inspection.js";

// CDP endpoint via env var ou argumento
const CDP_ENDPOINT = process.env.SERENDE_CDP_ENDPOINT ||
  process.argv.find(arg => arg === '--cdp-endpoint') ?
    process.argv[process.argv.indexOf('--cdp-endpoint') + 1] :
    "http://localhost:9222";

async function main() {
  const server = new Server(
    {
      name: "serende-mcp",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Inicializar gateway CDP
  const gateway = new CDPGateway(CDP_ENDPOINT);
  await gateway.connect();

  // Registrar todos os tools
  const allTools: Tool[] = [
    ...navigationTools(gateway),
    ...interactionTools(gateway),
    ...inspectionTools(gateway)
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    for (const tool of allTools) {
      if (tool.name === name && tool.handler) {
        try {
          const result = await tool.handler(args);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error.message}`
              }
            ],
            isError: true
          };
        }
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  // Cleanup no SIGINT
  process.on("SIGINT", async () => {
    await gateway.disconnect();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main:", error);
  process.exit(1);
});
```

### src/cdpgateway.ts

```typescript
import { chromium, Browser, BrowserContext, Page } from "playwright";

export class CDPGateway {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdpEndpoint: string;

  constructor(cdpEndpoint: string) {
    this.cdpEndpoint = cdpEndpoint;
  }

  async connect() {
    // Conectar a Chrome remoto via CDP
    this.browser = await chromium.connectOverCDP(this.cdpEndpoint);

    // Usar contexto existente ou criar novo isolado
    const contexts = this.browser.contexts();
    if (contexts.length > 0) {
      this.context = contexts[0];
    } else {
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 }
      });
    }

    // Obter ou criar página
    const pages = this.context.pages();
    if (pages.length > 0) {
      this.page = pages[0];
    } else {
      this.page = await this.context.newPage();
    }

    console.log(`✅ Connected to CDP endpoint: ${this.cdpEndpoint}`);
    console.log(`📄 Active page: ${this.page.url()}`);
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("No page available. Call connect() first.");
    }
    return this.page;
  }

  async disconnect() {
    if (this.context) {
      await this.context.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
    console.log("🔌 Disconnected from CDP");
  }

  async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
    const page = this.getPage();
    return await page.screenshot({ ...options, type: "png" });
  }

  async accessibilitySnapshot(): Promise<any> {
    const page = this.getPage();
    return await page.accessibility.snapshot();
  }
}
```

### src/tools/navigation.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CDPGateway } from "../cdpgateway.js";

export function navigationTools(gateway: CDPGateway): Tool[] {
  return [
    {
      name: "browser_navigate",
      description: "Navigate to a URL",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to navigate to"
          }
        },
        required: ["url"]
      },
      handler: async ({ url }: { url: string }) => {
        const page = gateway.getPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return {
          url: page.url(),
          status: "navigated"
        };
      }
    },
    {
      name: "browser_navigate_back",
      description: "Go back in history",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const page = gateway.getPage();
        await page.goBack();
        return { url: page.url(), status: "went back" };
      }
    },
    {
      name: "browser_get_current_url",
      description: "Get current page URL",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const page = gateway.getPage();
        return {
          url: page.url(),
          title: await page.title()
        };
      }
    }
  ];
}
```

### src/tools/interaction.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CDPGateway } from "../cdpgateway.js";

export function interactionTools(gateway: CDPGateway): Tool[] {
  return [
    {
      name: "browser_snapshot",
      description: "Get accessibility tree snapshot of current page",
      inputSchema: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: "Optional accessibility node ID to snapshot from"
          }
        },
        required: []
      },
      handler: async ({ root }: { root?: string }) => {
        const snapshot = await gateway.accessibilitySnapshot();
        return {
          snapshot,
          summary: `Snapshot captured with ${countNodes(snapshot)} nodes`
        };
      }
    },
    {
      name: "browser_click",
      description: "Click an element by accessibility reference",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "Accessibility reference (format: 'role[name]')"
          }
        },
        required: ["ref"]
      },
      handler: async ({ ref }: { ref: string }) => {
        const page = gateway.getPage();
        // Implementação real: usar page.getByRole() ou mapear ref -> selector
        const element = page.getByRole('button', { name: ref });
        await element.click();
        return { clicked: ref, status: "success" };
      }
    },
    {
      name: "browser_type",
      description: "Type text into an input field",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element reference" },
          text: { type: "string", description: "Text to type" },
          clear: { type: "boolean", default: true, description: "Clear field before typing" }
        },
        required: ["ref", "text"]
      },
      handler: async ({ ref, text, clear }: { ref: string; text: string; clear: boolean }) => {
        const page = gateway.getPage();
        const element = page.getByLabel(ref); // Usar accessibility label

        if (clear) {
          await element.clear();
        }
        await element.fill(text);

        return { typed: text, into: ref, status: "success" };
      }
    },
    {
      name: "browser_screenshot",
      description: "Take a screenshot of current page",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", default: false },
          path: { type: "string", description: "Save to file path" }
        },
        required: []
      },
      handler: async ({ fullPage, path }: { fullPage?: boolean; path?: string }) => {
        const buffer = await gateway.screenshot({ fullPage });
        if (path) {
          require("fs").writeFileSync(path, buffer);
          return { saved: path, size: buffer.length };
        }
        return {
          data: buffer.toString("base64"),
          size: buffer.length,
          format: "png"
        };
      }
    }
  ];
}

function countNodes(node: any): number {
  if (!node || typeof node !== "object") return 0;
  let count = 1;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}
```

### src/tools/inspection.ts

```typescript
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CDPGateway } from "../cdpgateway.js";

export function inspectionTools(gateway: CDPGateway): Tool[] {
  return [
    {
      name: "browser_console_messages",
      description: "Get console messages from the page (requires CDP listener)",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 50 }
        }
      },
      handler: async ({ limit }: { limit?: number }) => {
        // Implementar via page.on('console')
        return { messages: [], summary: "Requires console listener setup" };
      }
    },
    {
      name: "browser_network_requests",
      description: "Get network requests (requires CDP listener)",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "number", description: "Filter by HTTP status" }
        }
      },
      handler: async ({ status }: { status?: number }) => {
        // Implementar via CDP Domain.Network.requestWillBeSent
        return { requests: [], summary: "Requires network listener setup" };
      }
    }
  ];
}
```

### Build & Execução

```bash
npm install
npm run build
node dist/server.js

# Com CDP endpoint
SERENDE_CDP_ENDPOINT="ws://localhost:9222" node dist/server.js
```

### Configuração no Claude Desktop

```json
{
  "mcpServers": {
    "serende": {
      "command": "node",
      "args": ["/absolute/path/to/serende-mcp/dist/server.js"],
      "env": {
        "SERENDE_CDP_ENDPOINT": "http://localhost:9222"
      }
    }
  }
}
```

---

## 7. O que aprender do playwright-mcp para melhorar o MCP do Serende

### 7.1 Adotar Accessibility Snapshots (ALTO IMPACTO)

**Problema atual:** Serende usa screenshots → LLM precisa visão → tokens caros (200-600k por screenshot)

**Solução:** Implementar `browser_snapshot` que retorna accessibility tree via CDP:

```typescript
// Acessar CDP Domain.Accessibility
const { Accessibility } = require('playwright');

// Retornar formato legível:
- heading "Login" clickable
- button "Submit" [ref: button-submit] clickable
- textbox "Email" [ref: input-email] editable
```

**Benefício:** 20-60x menos tokens, funciona com qualquer LLM.

### 7.2 Implementar Ref System (ALTO IMPACTO)

Cada elemento interativo ganha um **ref ID** único e estável:

```bash
# Snapshot retorna:
{
  "elements": [
    { "role": "button", "name": "Submit", "ref": "btn-abc123", "clickable": true },
    { "role": "textbox", "name": "Email", "ref": "txt-def456", "editable": true }
  ]
}

# LLM usa:
browser_click({ ref: "btn-abc123" })  # Determinístico, sem ambiguidade
```

No Serende atual: precisamos usar coordenadas (x, y) → impreciso.

**Implementação:**
- Gerar ref a partir de `role + name + index` (ex: `button-Submit-0`)
- Cachear mapeamento `ref → CDP nodeId` (ou selector CSS)
- Atualizar cache após cada ação (snapshot novo)

### 7.3 Tab Management (ALTO IMPACTO, BAIXO ESFORÇO)

Via CDP `Target` domain:

```typescript
// Tools propostos:
browser_tabs()                 // Lista { id, title, url, active }
browser_tab_create({ url })    // Cria nova tab
browser_tab_select({ id })     // Seleciona tab
browser_tab_close({ id })      // Fecha tab
```

O Serende atual não tem suporte a múltiplas tabs.

### 7.4 Snapshot Modes (MÉDIO IMPACTO)

Playwright suporta:

- `incremental` (default): só envia mudanças
- `full`: snapshot completo
- `none`: desabilitado

**Para Serende:**

```bash
serende-mcp --snapshot-mode incremental  # Econômico
serende-mcp --snapshot-mode full        # Para inspeção completa
```

Ajuda a controlar trade-off velocidade vs completude.

### 7.5 Storage & Cookies via CDP Nativo (MÉDIO IMPACTO)

Atualmente Serende usa `document.cookie` (JS inject):

- ❌ Não acessa httpOnly cookies
- ❌ Limitado ao contexto da página

**Mudar para CDP nativo:**

```typescript
// Cookies
Network.getCookies()  // Inclui httpOnly
Network.setCookie({ name, value, httpOnly: true })

// localStorage/sessionStorage
DOMStorage.getDOMStorageItems({ storageId })
```

### 7.6 Screenshot Params (MÉDIO IMPACTO)

Playwright suporta:

- Formatos: `png` (lossless) vs `jpeg` (comprimido)
- Âmbitos: viewport, fullPage, element-specific
- Qualidade: JPEG quality 0-100

**Para Serende:**

```bash
browser_screenshot({ format: "jpeg", quality: 80 })
browser_screenshot({ fullPage: true })
browser_screenshot({ elementRef: "btn-abc123" })  # Screenshot só do elemento
```

Reduz tamanho das imagens enviadas ao LLM.

### 7.7 Browser Resize (MÉDIO IMPACTO)

Tool `browser_resize({ width, height })` para testar responsividade.

Via CDP: `Emulation.setDeviceMetricsOverride`

### 7.8 File Upload (MÉDIO IMPACTO)

Tool `browser_file_upload({ ref, files: ["/path/file.pdf"] })`

Via CDP: `DOM.setFileInputFiles`

Atualmente Serende não tem upload nativo (precisa drag&drop via coordenadas).

### 7.9 Capabilities Flags (BAIXO IMPACTO)

Agrupar tools por grupo (`--caps core,vision,devtools`) permite:

- Desabilitar tools perigosos em ambientes restritos
- Ligar/desligar features conforme necessidade
- Melhorar performance (menos tools para schemas)

**Para Serende:**

```bash
serende-mcp --caps core,devtools  # Sem vision (coord-based disables)
serende-mcp --caps core,vision    # Permite clicar por XY também
```

### 7.10 Security Model (MÉDIO IMPACTO)

Playwright MCP tem:

- `--allowed-origins` / `--blocked-origins` para requests
- `--grant-permissions` para permissões browser (geolocation, clipboard)
- Detecção de DNS rebinding

Serende poderia adicionar controle similar:

```bash
serende-mcp \
  --allowed-domains "*.meuapp.com,localhost:3000" \
  --blocked-domains "ads.*,trackers.*"
```

### 7.11 Incremental Updates (ALTO IMPACTO, ALTO ESFORÇO)

Quando o LLM executa uma ação (ex: `browser_click`), o Playwright MCP retorna **apenas as mudanças** na accessibility tree, não o snapshot completo.

**Exemplo:**

```json
// Antes: snapshot completo (10KB)
// Depois: só o botão mudou de "enabled" → "disabled" (100 bytes)
{
  "changes": [
    { "ref": "btn-submit", "attributes": { "disabled": true } }
  ]
}
```

**Para Serende:**

Implementar diff da árvore de acessibilidade entre estados e enviar apenas deltas.

Reduz drasticamente tokens, mas requer:

- Cache do snapshot anterior
- Algoritmo de diff (pode usar `hpatch` ou custom)
- Identificadores estáveis (ref system)

### 7.12 Multi-Browser Support (BAIXO IMPACTO)

Playwright suporta Chromium, Firefox, WebKit, Edge com mesma API.

Serende limitado a Chrome. Podemos expandir:

```bash
serende-mcp --browser firefox --session-id xyz
serende-mcp --browser webkit --session-id abc
```

Útil para cross-browser testing.

---

## 8. Resumo das Ações Recomendadas para o Serende

### Fase 1 — Imediato (1-4 semanas)

1. ✅ **Implementar accessibility snapshot** via CDP `Accessibility.getFullAXTree()`
2. ✅ **Gerar ref IDs** para elementos interativos
3. ✅ **Tab management** via CDP `Target` domain
4. ✅ **Storage nativo** (cookies, localStorage) via CDP

**Resultado:** LLMs sem visão podem usar Serende; tokens ↓ 80%

### Fase 2 — Médio prazo (2-3 meses)

5. ✅ **Snapshot modes** (incremental/full)
6. ✅ **Screenshot params** (format, quality, element-scoped)
7. ✅ **Browser resize** tool
8. ✅ **File upload** tool
9. ✅ **Capabilities flags** (`--caps core,devtools,vision`)
10. ✅ **Security model** (allowed/blocked origins)

**Resultado:** Mais controle, melhor segurança, menor custo

### Fase 3 — Longo prazo (3-6 meses)

11. ⚠️ **Incremental diffs** (alta eficiência de tokens)
12. ⚠️ **Multi-browser** (Firefox/WebKit)
13. ⚠️ **Extension mode** (conectar a Chrome aberto do usuário)
14. ⚠️ **Tracing/video** (debug avançado)

**Resultado:** Paridade com Playwright MCP + diferencial Serende (streaming viewer, multi-tenant)

---

## 9. Referências

- [GitHub: microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
- [npm: @playwright/mcp](https://www.npmjs.com/package/@playwright/mcp)
- [Playbooks: Playwright MCP](https://playbooks.com/mcp/microsoft/playwright-mcp)
- [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/how-to-integrate-playwright-mcp-for-ai-driven-test-automation/4470372)
- [ExecuteAutomation fork](https://github.com/executeautomation/mcp-playwright) — 143 dispositivos
- [ChromeDevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

## 10. Conclusão

O **@playwright/mcp** estabeleceu o padrão ouro para automação de browser via MCP:

- ✅ Accessiblity-first (não pixel-based)
- ✅ Determinístico (ref system)
- ✅ Token-efficient (4x vs screenshot MCP)
- ✅ Multi-browser (Chromium/Firefox/WebKit)
- ✅ Rico em features (tabs, storage, network, tracing)

Para o **Serende**, a lição principal é:

> **Abandonar pixel-based input + screenshots como primary mechanism → Adotar accessibility tree + ref IDs como primary, screenshots como fallback only.**

Isso permite que o Serende:

1. Funcione com **qualquer LLM** (não só multimodais caros)
2. Seja **determinístico** (coordenadas → IDs estáveis)
3. Reduza **custos de tokens** drasticamente
4. Aumente **confiabilidade** de automações

Combine isso com os diferenciais atuais do Serende (multi-tenant, streaming viewer, session persistence) e teremos um MCP browser server de próxima geração.

---
**Próxima ação:** Protótipo de `browser_snapshot` + `click_ref` no Serende-MCP existente (branch `feature/accessibility-snapshots`).
