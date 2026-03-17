# Model Context Protocol (MCP): Guia Completo para Browser Automation

**Data:** 2025-03-17
**Versão:** 1.0
**Fonte:** Pesquisa baseada em especificação oficial MCP 2025-06-18, SDK TypeScript, e implementações de referência

---

## Sumário

1. [O que é MCP e para que serve](#1-o-que-é-mcp-e-para-que-serve)
2. [Arquitetura do Protocolo](#2-arquitetura-do-protocolo)
3. [Como criar um MCP Server com @modelcontextprotocol/sdk](#3-como-criar-um-mcp-server-com-modelcontextprotocolsdk)
4. [Diferença entre SSE Transport e StreamableHTTP Transport](#4-diferença-entre-sse-transport-e-streamablehttp-transport)
5. [Como definir Tools (Ferramentas) no MCP](#5-como-definir-tools-ferramentas-no-mcp)
6. [Como Claude/AI Agents consomem um MCP Server](#6-como-claudeai-agents-consumem-um-mcp-server)
7. [Melhores Práticas para MCP Servers de Browser Automation](#7-melhores-práticas-para-mcp-servers-de-browser-automation)
8. [Exemplos de Tools Úteis para Controle de Browser via MCP](#8-exemplos-de-tools-úteis-para-controle-de-browser-via-mcp)
9. [Como testar um MCP Server](#9-como-testar-um-mcp-server)
10. [Limitações e Edge Cases do Protocolo MCP](#10-limitações-e-edge-cases-do-protocolo-mcp)

---

## 1. O que é MCP e para que serve

### Definição

O **Model Context Protocol (MCP)** é um protocolo aberto criado pela Anthropic que padroniza a integração entre aplicações LLM (Large Language Models) e ferramentas/dados externos. É basicamente uma "API padrão" que permite que AIs como Claude acessem contexto e executem ações no mundo exterior de forma segura e padronizada.

### Propósito

MCP resolve o problema do **context linking**: como fornecer ao LLM acesso a:
- **Dados externos** (bancos de dados, arquivos, APIs)
- **Ferramentas executáveis** (controle de browser, execução de código, cálculos)
- **Templates de prompts** (para interações estruturadas)

Tudo isso sem que cada aplicação precise reinventar sua própria integração.

### Analogia

Pense no MCP como o **USB-C das integrações de IA**:
- Antes: Cada app precisava criar seu próprio conector específico
- Agora: Um padrão universal que funciona em qualquer lugar

### Casos de Uso Reais

1. **Claude Desktop** → Conecta a servidores MCP para acessar arquivos locais, Git, bancos de dados
2. **Controle de Browser** → Playwright MCP, Puppeteer MCP permitem que Claude automatize navegadores
3. **Ferramentas de Desenvolvedor** → Sentry MCP, GitHub MCP, Linear MCP
4. **Bases de Conhecimento** → Conectar documentação interna, wikis, manuais

### Participantes da Arquitetura

```
┌─────────────────────────────────────────────┐
│           MCP HOST (AI Application)         │
│  (Claude Desktop, Claude Code, Cursor IDE) │
└───────────┬─────────────────────────────────┘
            │ Criencia N conexões MCP Client
            ▼
┌─────────────────────────────────────────────┐
│           MCP CLIENT (por servidor)         │
│  Gerencia conexão + capability negotiation  │
└───────────┬─────────────────────────────────┘
            │ JSON-RPC 2.0 via Transporte
            ▼
┌─────────────────────────────────────────────┐
│         MCP SERVER (sua implementação)      │
│  Expõe tools, resources, prompts           │
└─────────────────────────────────────────────┘
```

- **MCP Host**: A aplicação AI (ex: Claude Desktop)
- **MCP Client**: Componente que mantém conexão com cada servidor MCP
- **MCP Server**: Seu código que expõe funcionalidades (tools, resources)

---

## 2. Arquitetura do Protocolo

### 2.1 Camadas

MCP tem duas camadas distintas:

#### Data Layer (Camada de Dados)
Define o protocolo JSON-RPC 2.0:
- **Lifecycle Management**: Handshake de inicialização e capability negotiation
- **Primitives**:
  - **Tools**: Funções que o LLM pode invocar (model-controlled)
  - **Resources**: Dados que o cliente pode ler (application-controlled)
  - **Prompts**: Templates reutilizáveis (user-controlled)
- **Notifications**: Atualizações em tempo real
- **Client Primitives**: Sampling, elicitation, logging

#### Transport Layer (Camada de Transporte)
Define como as mensagens trafegam:
- **Stdio**: Para servidores locais (default)
- **Streamable HTTP**: Para servidores remotos (recomendado)
- **HTTP+SSE**: Legado (deprecated)

### 2.2 Mensagens JSON-RPC 2.0

Toda comunicação MCP usa JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { ... }
}
```

**Tipos de mensagem:**
1. **Request**: Tem `id`, espera resposta
2. **Response**: Tem mesmo `id` da request
3. **Notification**: NÃO tem `id`, não espera resposta

### 2.3 Ciclo de Vida (Lifecycle)

Todo MCP server começa com handshake de 3 passos:

#### Passo 1: Initialize Request
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": {},
      "resources": {}
    },
    "clientInfo": {
      "name": "claude-code",
      "version": "1.0.0"
    }
  }
}
```

#### Passo 2: Initialize Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": {}
    },
    "serverInfo": {
      "name": "remote-browser",
      "version": "1.0.0"
    }
  }
}
```

#### Passo 3: Initialized Notification
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

**Importante**: Apenas após esse handshake o cliente pode chamar `tools/list`.

### 2.4 Capability Negotiation

Durante `initialize`, ambas as partes declaram o que suportam:

```typescript
// Cliente declara
{
  capabilities: {
    tools: {},           // Suporta tools
    resources: {},       // Suporta resources
    prompts: {}          // Suporta prompts
  }
}

// Servidor declara
{
  capabilities: {
    tools: {
      listChanged: true  // Pode enviar notification tools/list_changed
    },
    logging: {}          // Suporta logging
  }
}
```

Esse "contrato" previne erros em runtime e permite graceful degradation.

---

## 3. Como criar um MCP Server com @modelcontextprotocol/sdk

### 3.1 Instalação

```bash
# Versão estável (recomendado para produção)
npm install @modelcontextprotocol/sdk zod express

# Opcional: dependências de browser
npm install @playwright/mcp playwright
# ou
npm install puppeteer
```

### 3.2 Estrutura mínima (Stateless)

O servidor **stateless** cria uma nova instância por request. Ideal para serverless/autoscaling:

```typescript
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  // Cria server novo por request (stateless)
  const server = new McpServer({
    name: "browser-mcp",
    version: "1.0.0"
  });

  // Define tools
  server.tool(
    "navigate",
    "Navega o browser para uma URL",
    { url: z.string().url() },
    async ({ url }) => {
      // ... lógica de navegação
      return {
        content: [{ type: "text", text: `Navigated to ${url}` }]
      };
    }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined // undefined = stateless
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000, "0.0.0.0", () => {
  console.log("MCP server on http://0.0.0.0:3000/mcp");
});
```

### 3.3 Estrutura Stateful (com sessões)

Servers stateful mantêm estado entre requests usando `Mcp-Session-Id`:

```typescript
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

// Map de sessões ativas
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Estado por sessão (browser state, páginas, cache)
const sessionState: Record<string, {
  currentUrl: string;
  history: string[];
  cookies: any[];
}> = {};

function createServer(sessionId: string): McpServer {
  const server = new McpServer(
    { name: "remote-browser", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  // Tool: navigate
  server.tool(
    "navigate",
    "Navega o browser para uma URL",
    { url: z.string().url() },
    async ({ url }) => {
      if (!sessionState[sessionId]) {
        sessionState[sessionId] = { currentUrl: "", history: [], cookies: [] };
      }
      sessionState[sessionId].currentUrl = url;
      sessionState[sessionId].history.push(url);

      // ... lógica real de navegação ...

      return {
        content: [{ type: "text", text: `Navigated to ${url}` }]
      };
    }
  );

  // Tool: screenshot (retorna imagem)
  server.tool(
    "screenshot",
    "Captura screenshot do browser",
    {
      quality: z.number().min(1).max(100).default(75),
      fullPage: z.boolean().default(false)
    },
    async ({ quality, fullPage }) => {
      // ... uso de CDP, Puppeteer ou Playwright ...
      const base64Data = await captureScreenshot({ quality, fullPage });

      return {
        content: [
          { type: "text", text: `Screenshot captured (quality=${quality})` },
          {
            type: "image",
            data: base64Data,
            mimeType: "image/jpeg"
          }
        ]
      };
    }
  );

  return server;
}

// POST /mcp - Recebe mensagens do client
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Sessão existente
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  // Sessão expirada
  if (sessionId && !transports[sessionId]) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found. Please re-initialize." },
      id: null
    });
    return;
  }

  // Nova sessão (initialize sem session ID)
  if (!sessionId && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`Session initialized: ${id}`);
      }
    });

    // cleanup quando sessão fechar
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessionState[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };

    const server = createServer(newSessionId);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Erro: request mal formado
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad request or missing session" },
    id: null
  });
});

// GET /mcp - SSE stream para notificações server → client
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).send("Invalid session");
  }
});

// DELETE /mcp - Encerrar sessão
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).send("Invalid session");
  }
});

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Browser MCP server on http://0.0.0.0:${PORT}/mcp`);
});
```

### 3.4 Tool com Schema usando Zod

MCP SDK usa **Zod** para validação de parâmetros:

```typescript
import { z } from "zod";

// Schema simples
const navigateSchema = z.object({
  url: z.string().url().describe("URL absoluta para navegar")
});

// Schema complexo com defaults e enums
const screenshotSchema = z.object({
  format: z.enum(["png", "jpeg"]).default("jpeg"),
  quality: z.number().min(1).max(100).default(80),
  selector: z.string().optional().describe("CSS selector para elemento específico")
});

server.tool("navigate", "Descrição", navigateSchema, async (args) => {
  // args já validado e tipado!
  console.log(args.url); // TypeScript sabe que é string
});
```

---

## 4. Diferença entre SSE Transport e StreamableHTTP Transport

### 4.1 SSE Transport (Legacy - 2024-11-05)

**Status**: Deprecated, mas ainda suportado para compatibilidade.

**Arquitetura**: Dois endpoints separados:
```
GET  /sse    → Estabelece conexão SSE persistente
POST /messages → Cliente envia mensagens
```

**Fluxo**:
```
Cliente                     Servidor
  |--- GET /sse ------------>|
  |<-- event: endpoint ------|  (retorna URI de messages)
  |--- POST /messages ------>|  (initialize)
  |<-- SSE: data ------------|  (initialize response)
```

**Código Express (SSE)**:
```typescript
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse";

app.get("/sse", (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  server.connect(transport);
});

app.post("/messages", (req, res) => {
  transport.handlePostMessage(req, res);
});
```

**Limitações**:
- ❌ Requer conexão persistente (SSE long-lived) → não funciona bem em serverless
- ❌ Dois endpoints → mais complexidade
- ❌ Escalabilidade difícil: 1 conexão SSE aberta por cliente
- ❌ HTTP/1.1 issues com proxies intermediaries

### 4.2 StreamableHTTP Transport (Atual - 2025-03-26)

**Status**: Recomendado, padrão atual.

**Arquitetura**: **Endpoint único** `/mcp` com 3 métodos HTTP:

| Método | Função | Headers |
|--------|--------|---------|
| **POST** | Envia mensagens JSON-RPC | `Content-Type: application/json`, `Accept: application/json, text/event-stream` |
| **GET** | Abre SSE stream para notificações server→client | `Accept: text/event-stream` |
| **DELETE** | Encerra sessão | `Mcp-Session-Id: xxx` |

**Regras POST**:
- Request body: 1 JSON-RPC request/notification/response
- Resposta pode ser:
  - `200` + `application/json`: resposta direta
  - `200` + `text/event-stream`: stream SSE com múltiplas mensagens
  - `202`: aceito (notifications, sem body)

**Código Express (StreamableHTTP)**:
```typescript
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  await transport.handleRequest(req, res);
});
```

**Vantagens**:
- ✅ HTTP/2 ready, melhor escalabilidade
- ✅ Connection pooling, keep-alive
- ✅ Funciona com serverless (Vercel, Cloudflare, AWS Lambda)
- ✅ Autenticação padrão (Bearer tokens, API keys)
- ✅ Cache CDN friendly para endpoints GET
- ✅ HTTP status codes semânticos

### 4.3 Tabela Comparativa

| Característica | SSE (Legacy) | StreamableHTTP (Atual) |
|----------------|--------------|------------------------|
| **Endpoints** | 2 (`/sse`, `/messages`) | 1 (`/mcp`) |
| **Persistência** | SSE long-lived obrigatória | Stateless possível |
| **Serverless** | ❌ Ruim | ✅ Bom |
| **Escalabilidade** | ❌ Conns. persistentes | ✅ HTTP normal |
| **Auth** | Custom via query/headers | HTTP auth padrão |
| **Cache** | ❌ Impossível | ✅ GET MSSE cacheável |
| **Status 202** | ❌ | ✅ Para notifications |
| **Protocol Version** | 2024-11-05 | 2025-03-26+ |

### 4.4 Backward Compatibility

Para suportar clientes antigos e novos:

```typescript
app.post("/mcp", async (req, res) => {
  // ... StreamableHTTP handler
});

// Para clientes legados SSE
app.get("/sse", (req, res) => {
  sseTransport = new SSEServerTransport("/messages", res);
  server.connect(sseTransport);
});
app.post("/messages", (req, res) => {
  sseTransport?.handlePostMessage(req, res);
});
```

---

## 5. Como definir Tools (Ferramentas) no MCP

### 5.1 O que são Tools

**Tools** são funções executáveis que o LLM pode invocar automaticamente baseado no contexto. Elas são a interface entre a inteligência do modelo e ações no mundo real.

Exemplo: `"click"`, `"screenshot"`, `"search_database"`, `"send_email"`

### 5.2 Schema de uma Tool

```typescript
{
  name: "tool_name",           // Identificador único
  title: "Tool Title",         // Nome legível
  description: "Long description...", // O que a tool faz
  inputSchema: {               // Schema JSON dos parâmetros
    type: "object",
    properties: {
      param1: { type: "string", description: "..." },
      param2: { type: "number", default: 10 }
    },
    required: ["param1"]
  }
}
```

### 5.3 Definindo Tools com Zod

O SDK usa Zod para schemas type-safe:

```typescript
import { z } from "zod";

// Schema 1: Simples
const simpleSchema = z.object({
  text: z.string().describe("Texto a processar")
});

// Schema 2: Com enums e defaults
const advancedSchema = z.object({
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().min(1).max(100).default(80),
  fullPage: z.boolean().default(false)
});

// Schema 3: Complexo com nested objects
const complexSchema = z.object({
  coordinates: z.object({
    x: z.number(),
    y: z.number()
  }),
  options: z.object({
    clickCount: z.number().min(1).max(3).default(1),
    delay: z.number().positive().optional()
  })
});
```

### 5.4 Tool Completa com Imagem

```typescript
server.tool(
  "screenshot_with_annotation",
  "Captura screenshot e adiciona anotação descritiva",
  {
    format: z.enum(["png", "jpeg"]).default("jpeg"),
    quality: z.number().min(10).max(100).default(75),
    highlightSelector: z.string().optional()
      .describe("CSS selector para destacar elemento")
  },
  async ({ format, quality, highlightSelector }) => {
    // 1. Captura screenshot
    const screenshotBuffer = await captureScreenshot({
      format,
      quality,
      highlight: highlightSelector
    });

    // 2. Converte para base64
    const base64Data = screenshotBuffer.toString("base64");

    // 3. Retorna texto + imagem
    return {
      content: [
        {
          type: "text",
          text: `Screenshot capturado: ${format}, qualidade ${quality}%`
        },
        {
          type: "image",
          data: base64Data,
          mimeType: `image/${format}`,
          annotations: {
            audience: ["user", "assistant"],
            priority: 1.0
          }
        }
      ]
    };
  }
);
```

### 5.5 Content Types Suportados

O campo `content` em tool responses aceita union de tipos:

```typescript
type ContentBlock =
  | TextContent      // { type: "text", text: "..." }
  | ImageContent     // { type: "image", data: "...", mimeType: "..." }
  | AudioContent     // { type: "audio", data: "...", mimeType: "..." }
  | ResourceLink     // { type: "resource_link", uri: "..." }
  | EmbeddedResource // { type: "embedded_resource", ... }
```

### 5.6 Multiple Content Blocks

Uma tool pode retornar múltiplos tipos:

```typescript
return {
  content: [
    { type: "text", text: "Resultado da operação" },
    { type: "image", data: base64Img, mimeType: "image/png" },
    { type: "text", text: "Detalhes adicionais..." }
  ]
};
```

---

## 6. Como Claude/AI Agents consomem um MCP Server

### 6.1 Claude Desktop (Stdio)

Claude Desktop suporta apenas **stdio** nativamente. Para servidores HTTP, usa `mcp-remote` como proxy:

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3000/mcp",
        "--header",
        "Authorization: Bearer ${API_KEY}"
      ],
      "env": {
        "API_KEY": "your-secret-key"
      }
    }
  }
}
```

### 6.2 Claude Code (HTTP Nativo)

Claude Code suporta HTTP diretamente via CLI ou `.mcp.json`:

**CLI**:
```bash
# Adicionar server HTTP
claude mcp add --transport http browser-mcp http://localhost:3000/mcp

# Com headers de autenticação
claude mcp add --transport http browser-mcp http://localhost:3000/mcp \
  --header "Authorization: Bearer token123"

# Via JSON
claude mcp add-json my-server '{
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "X-API-Key": "xxx" }
}'
```

**.mcp.json** (na raiz do projeto):
```json
{
  "mcpServers": {
    "remote-browser": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    },
    "browser-prod": {
      "type": "http",
      "url": "https://browser-api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${BROWSER_API_KEY}"
      }
    }
  }
}
```

### 6.3 Cursor IDE

Cursor suporta MCP com image injection no chat:

```json
// Settings → Features → MCP Servers
{
  "mcpServers": {
    "browser-mcp": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Quando o modelo suporta visão (GPT-4o, Claude 3.5 Sonnet), as imagens retornadas são automaticamente analisadas.

### 6.4 Fluxo de Consumo

```
1. Claude Code lê .mcp.json
2. Para cada server: inicia MCP client
3. Client envia "initialize" → server retorna capabilities
4. Client chama "tools/list" → descobre todas as tools
5. LLM decide quando usar tools (baseado em user prompt)
6. Claude intercepta tool_call → roteia para MCP server
7. Server executa e retorna resultado
8. Claude usa resultado como contexto próxima resposta
```

### 6.5 Exemplo Prático: Claude controlando browser

**User prompt**:
```
Vá para https://example.com, clique no botão de login e digite meu email.
```

**O que acontece internamente**:

1. Claude vê as tools disponíveis: `navigate(url)`, `click(x,y)`, `type_text(text)`

2. LLM decide actions:
   - Tool 1: `navigate` com `url="https://example.com"`
   - Tool 2: Aguarda `tools/list` atualização ou recebe screenshot
   - Tool 3: `click` com coordenadas do botão
   - Tool 4: `type_text` com email

3. Cada tool call vai para `/mcp` com `Mcp-Session-Id`

4. Server retorna resultados (às vezes com screenshots como ImageContent)

5. ClaudeObservation: Claude vê screenshot + conteúdo de texto

6. Continua até completar a tarefa

---

## 7. Melhores Práticas para MCP Servers de Browser Automation

### 7.1 Performance

1. **Compression de Imagens**
   ```typescript
   // Use JPEG com quality 70-80, não PNG
   const buffer = await page.screenshot({
     type: 'jpeg',
     quality: 75,  // Balance qualidade/tamanho
     fullPage: false  // Viewport apenas除非necessário
   });

   // Redimensionar se > 1MB (limite Claude)
   if (buffer.length > 900_000) {
     buffer = await sharp(buffer)
       .resize({ width: 1280, withoutEnlargement: true })
       .jpeg({ quality: 60 })
       .toBuffer();
   }
   ```

2. **Lazy Loading de Browser**
   - Não iniciar browser no initialize
   - Iniciar apenas na primeira navegação
   - Reutilizar mesma instância na sessão

3. **Timeout e Cancellation**
   ```typescript
   const timeoutPromise = new Promise((_, reject) =>
     setTimeout(() => reject(new Error('Timeout')), 30000)
   );

   try {
     await Promise.race([cdpCommand(), timeoutPromise]);
   } catch (err) {
     return {
       content: [{ type: "text", text: `Error: ${err.message}` }],
       isError: true
     };
   }
   ```

4. **Pool de Conexões CDP**
   - Reuse websocket CDP por sessão
   - Reconexão automática se cair

### 7.2 Security

1. **Validação de URLs**
   ```typescript
   // Bloquear URLs perigosas
   const BLOCKED_SCHEMES = ['file:', 'javascript:', 'data:'];
   const url = new URL(input);
   if (BLOCKED_SCHEMES.includes(url.protocol)) {
     throw new Error('URL scheme not allowed');
   }
   ```

2. **Sandbox Isolamento**
   - Cada sessão MCP = instância Chrome separada (user-data-dir)
   - Limitar permissões: `--no-sandbox`, `--disable-dev-shm-usage`
   - Timeout de inatividade: 5min sem uso → kill browser

3. **Rate Limiting por Sessão**
   ```typescript
   const rateLimit = new Map<string, number[]>();

   function checkRateLimit(sessionId: string, maxPerMinute = 60) {
     const now = Date.now();
     const requests = rateLimit.get(sessionId) || [];
     const recent = requests.filter(t => now - t < 60000);

     if (recent.length >= maxPerMinute) {
       throw new Error('Rate limit exceeded');
     }

     recent.push(now);
     rateLimit.set(sessionId, recent);
   }
   ```

4. **Input Sanitization**
   ```typescript
   const MAX_TEXT_LENGTH = 1000;
   if (text.length > MAX_TEXT_LENGTH) {
     text = text.substring(0, MAX_TEXT_LENGTH);
   }
   ```

### 7.3 Reliability

1. **Retry Logic**
   ```typescript
   async function withRetry<T>(
     fn: () => Promise<T>,
     maxAttempts = 3,
     delay = 1000
   ): Promise<T> {
     for (let i = 0; i < maxAttempts; i++) {
       try {
         return await fn();
       } catch (err) {
         if (i === maxAttempts - 1) throw err;
         await new Promise(r => setTimeout(r, delay * (i + 1)));
       }
     }
     throw new Error('Should not reach');
   }
   ```

2. **Graceful Degradation**
   ```typescript
   server.tool("screenshot", ...);

   // Se browser falhar, retorna mensagem útil, não crash
   try {
     const img = await screenshot();
     return { content: [{ type: "image", data: img, mimeType: "image/jpeg" }] };
   } catch (err) {
     return {
       content: [{
         type: "text",
         text: `Unable to capture screenshot: ${err.message}`
       }],
       isError: false  // Não é erro MCP, só informativo
     };
   }
   ```

3. **Health Check Endpoint**
   ```typescript
   app.get("/health", (req, res) => {
     res.json({
       status: "ok",
       sessions: Object.keys(transports).length,
       uptime: process.uptime()
     });
   });
   ```

### 7.4 Observability

1. **Logging Estruturado**
   ```typescript
   import pino from 'pino';
   const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

   server.tool("navigate", async ({ url }) => {
     logger.info({ sessionId, tool: "navigate", url }, "Tool invoked");
     const start = Date.now();
     // ... operação ...
     logger.info({ sessionId, tool: "navigate", duration: Date.now() - start });
   });
   ```

2. **Metrics**
   ```typescript
   const metrics = {
     toolCalls: new Map<string, number>(),
     errors: new Map<string, number>(),
     latencies: new Map<string, number[]>()
   };

   // Coletar para Prometheus endpoint
   app.get("/metrics", (req, res) => {
     let output = "";
     metrics.toolCalls.forEach((count, tool) => {
       output += `mcp_tool_calls{tool="${tool}"} ${count}\n`;
     });
     res.type('text/plain').send(output);
   });
   ```

3. **Tracing**
   - Propagate `sessionId` em todos os logs
   - Adicionar `traceId` via header opcional para spans distríbuidos

### 7.5 Tool Design

1. **Atomicidade**
   - Cada tool faz UMA coisa bem feita
   - Se precisa de múltiplos passos, crie tools separadas

   ```typescript
   // ❌ Ruim: tudo junto
   server.tool("login_and_check", async ({ email, pass }) => {
     // login
     // check dashboard
   });

   // ✅ Bom: separado
   server.tool("login", ...);
   server.tool("get_dashboard", ...);
   ```

2. **Screenshots como Retorno**
   - Após actions visíveis (click, navigate), retornar screenshot
   - Permite LLM "ver" o resultado

   ```typescript
   server.tool("click", async ({ x, y }) => {
     await input.click(x, y);
     const screenshot = await capture();

     return {
       content: [
         { type: "text", text: `Clicked at (${x}, ${y})` },
         { type: "image", data: screenshot, mimeType: "image/jpeg" }
       ]
     };
   });
   ```

3. **Descriptions Precisas**
   ```typescript
   // ❌ Vago
   description: "Clica na tela"

   // ✅ Específico
   description: "Clica em coordenadas absolutas (x, y). Use após obter coordenadas via find_element ou screenshot analysis. x e y de 0 a 1920 (largura) e 1080 (altura). Retorna screenshot pós-clique para confirmação visual."
   ```

4. **Error Messages Semânticas**
   ```typescript
   throw new Error(
     `Element not found with selector "${selector}". ` +
     `Available: ${listVisibleElements()}. ` +
     `Try using coordinates from screenshot or different selector.`
   );
   ```

### 7.6 Session Management

1. **Auto-cleanup**
   ```typescript
   // Expira sessões após 10min de inatividade
   setInterval(() => {
     const now = Date.now();
     for (const [id, state] of Object.entries(sessionState)) {
       if (now - state.lastActivity > 10 * 60 * 1000) {
         delete sessionState[id];
         // Fecha browser
       }
     }
   }, 60_000);
   ```

2. **Session Data Limitation**
   - Armazenar apenas o necessário (cookies, localStorage se precisar persistir)
   - Não guardar screenshots em memória
   - Limitar historico: máximo 100 URLs por sessão

---

## 8. Exemplos de Tools Úteis para Controle de Browser via MCP

### 8.1 Core Navigation

```typescript
server.tool(
  "navigate",
  "Navega o browser para uma URL específica. Espera URL completa com protocolo (http:// ou https://). Retorna screenshot da página carregada.",
  {
    url: z.string().url().describe("URL absoluta (ex: https://example.com)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load")
      .describe("Quando considerar página carregada")
  },
  async ({ url, waitUntil }) => {
    await page.goto(url, { waitUntil });

    const screenshot = await captureScreenshot({ quality: 80 });

    return {
      content: [
        { type: "text", text: `Navegado para: ${url}` },
        {
          type: "image",
          data: screenshot,
          mimeType: "image/jpeg",
          annotations: { audience: ["user", "assistant"], priority: 0.9 }
        }
      ]
    };
  }
);
```

### 8.2 Screenshot Avançado

```typescript
server.tool(
  "screenshot",
  "Captura screenshot do viewport atual ou página completa. Formato JPEG otimizado. Retorna imagem visível para análise do LLM.",
  {
    format: z.enum(["jpeg"]).default("jpeg"), // Apenas JPEG para size
    quality: z.number().min(30).max(95).default(75),
    fullPage: z.boolean().default(false),
    selector: z.string().optional().describe("Se fornecido, captura apenas elemento")
  },
  async ({ quality, fullPage, selector }) => {
    let buffer: Buffer;

    if (selector) {
      const element = await page.$(selector);
      if (!element) {
        return {
          content: [{ type: "text", text: `Element not found: ${selector}` }],
          isError: true
        };
      }
      buffer = await element.screenshot({ type: 'jpeg', quality });
    } else {
      buffer = await page.screenshot({
        type: 'jpeg',
        quality,
        fullPage
      });
    }

    // Compressão adicional se necessário
    const maxSize = 900_000;
    if (buffer.length > maxSize) {
      buffer = await sharp(buffer)
        .resize({ width: 1280, withoutEnlargement: true })
        .jpeg({ quality: Math.max(50, quality - 10) })
        .toBuffer();
    }

    const base64 = buffer.toString('base64');

    return {
      content: [
        {
          type: "text",
          text: `Screenshot: ${formatBytes(buffer.length)}, selector="${selector || 'viewport'}"`
        },
        {
          type: "image",
          data: base64,
          mimeType: "image/jpeg"
        }
      ]
    };
  }
);
```

### 8.3 Click com Coordenadas

```typescript
server.tool(
  "click",
  "Clica em coordenadas absolutas (x, y) do viewport. Coords de 0 à largura/altura. Use após analisar screenshot para identificar elementos. Retorna screenshot pós-clique.",
  {
    x: z.number().int().min(0).max(4096)
      .describe("Coordenada X (pixels da esquerda)"),
    y: z.number().int().min(0).max(4096)
      .describe("Coordenada Y (pixels do topo)"),
    button: z.enum(["left", "middle", "right"]).default("left")
  },
  async ({ x, y, button }) => {
    // Valida se coordenadas dentro do viewport atual
    const viewport = page.viewport();
    if (x > viewport.width || y > viewport.height) {
      return {
        content: [{
          type: "text",
          text: `Coordinates (${x},${y}) fora do viewport (${viewport.width}x${viewport.height})`
        }],
        isError: true
      };
    }

    await page.mouse.click(x, y, { button });

    // Aguarda possíveis mudanças (navegação, modal, etc)
    await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});

    const screenshot = await captureScreenshot({ quality: 80 });

    return {
      content: [
        { type: "text", text: `Clicked at (${x}, ${y}) with ${button} button` },
        { type: "image", data: screenshot, mimeType: "image/jpeg" }
      ]
    };
  }
);
```

### 8.4 Type Text

```typescript
server.tool(
  "type_text",
  "Digita texto no elemento atualmente focado. Use após click em input. Pressiona Enter automaticamente se submit=true.",
  {
    text: z.string().max(500)
      .describe("Texto para digitar (máx 500 caracteres)"),
    submit: z.boolean().default(false)
      .describe("Se true, pressiona Enter após digitar")
  },
  async ({ text, submit }) => {
    // Focus no elemento ativo
    const active = await page.evaluate(() => {
      return document.activeElement?.tagName || null;
    });

    if (!active) {
      return {
        content: [{ type: "text", text: "Nenhum elemento com foco. Clique em um input primeiro." }],
        isError: true
      };
    }

    await page.keyboard.type(text, { delay: 30 }); // delay humanoide

    if (submit) {
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    }

    const screenshot = await captureScreenshot({ quality: 75 });

    return {
      content: [
        { type: "text", text: `Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${submit ? ' + Enter' : ''}` },
        { type: "image", data: screenshot, mimeType: "image/jpeg" }
      ]
    };
  }
);
```

### 8.5 Scroll

```typescript
server.tool(
  "scroll",
  "Rola a página verticalmente. delta: positivo rola baixo, negativo cima. Recomendado: 300-500 pixels por vez.",
  {
    delta: z.number().describe("Pixels para rolar (ex: 300 ou -200)"),
    smooth: z.boolean().default(true)
      .describe("Se true, animação suave; se false, instantâneo")
  },
  async ({ delta, smooth }) => {
    await page.evaluate(({ delta, smooth }) => {
      window.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
    }, { delta, smooth });

    // Aguarda scroll completar se smooth
    if (smooth) {
      await new Promise(r => setTimeout(r, 500));
    }

    const screenshot = await captureScreenshot({ quality: 75 });

    return {
      content: [
        { type: "text", text: `Scrolled by ${delta}px` },
        { type: "image", data: screenshot, mimeType: "image/jpeg" }
      ]
    };
  }
);
```

### 8.6 Get Page Info

```typescript
server.tool(
  "get_page_info",
  "Retorna metadados da página atual: título, URL, viewport size, elementos interativos disponíveis.",
  {},
  async () => {
    const [title, url, viewport, interactiveElements] = await Promise.all([
      page.title(),
      page.url(),
      page.viewport(),
      page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a')).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 50),
          x: el.getBoundingClientRect().x,
          y: el.getBoundingClientRect().y,
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height
        }));
        return buttons;
      })
    ]);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          title,
          url,
          viewport,
          interactiveElements: interactiveElements.slice(0, 20) // Limita output
        }, null, 2)
      }]
    };
  }
);
```

### 8.7 Wait

```typescript
server.tool(
  "wait",
  "Aguarda N segundos ou até condição específica. Útil para carregamento dinâmico (SPAs).",
  {
    duration: z.number().positive().max(30).default(1)
      .describe("Segundos para aguardar (máx 30)"),
    selector: z.string().optional()
      .describe("Se fornecido, espera elemento aparecer")
  },
  async ({ duration, selector }) => {
    if (selector) {
      try {
        await page.waitForSelector(selector, { timeout: duration * 1000 });
        return { content: [{ type: "text", text: `Element appeared: ${selector}` }] };
      } catch {
        return {
          content: [{ type: "text", text: `Timeout: element "${selector}" não apareceu em ${duration}s` }],
          isError: true
        };
      }
    } else {
      await new Promise(r => setTimeout(r, duration * 1000));
      return { content: [{ type: "text", text: `Aguardado ${duration}s` }] };
    }
  }
);
```

### 8.8 Evaluate JavaScript

```typescript
server.tool(
  "evaluate",
  "Executa JavaScript arbitrário na página e retorna resultado serializável. CUIDADO: execução direta de código. Use apenas em ambiente de desenvolvimento/teste.",
  {
    script: z.string().describe("Código JavaScript para executar"),
    args: z.array(z.any()).optional()
  },
  async ({ script, args }) => {
    // Validação básica de segurança
    const dangerousPatterns = [
      /localStorage\.clear/,
      /sessionStorage\.clear/,
      /document\.cookie\s*=/,
      /window\.location\s*=/,
      /\.brewermodified/ // Exemplo de custom
    ];

    if (dangerousPatterns.some(p => p.test(script))) {
      return {
        content: [{ type: "text", text: "Script contém operações perigosas bloqueadas." }],
        isError: true
      };
    }

    try {
      const result = await page.evaluate(([script, args]) => {
        // Executa como função para isolar scope
        const fn = new Function('...args', `${script}\nreturn result;`);
        return fn(...args);
      }, [script, args || []]);

      return {
        content: [{
          type: "text",
          text: `Result: ${JSON.stringify(result, null, 2).substring(0, 2000)}`
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Evaluation error: ${err.message}` }],
        isError: true
      };
    }
  }
);
```

---

## 9. Como testar um MCP Server

### 9.1 MCP Inspector (Recomendado)

**O que é**: Ferramenta oficial de debug/teste do MCP. Interface web可视化 interativa.

**Instalar e rodar**:
```bash
npx @modelcontextprotocol/inspector node build/index.js
# ou
npx -y @modelcontextprotocol/inspector npx @modelcontextprotocol/server-filesystem /tmp
```

**Features**:
- ✅ Listar tools, resources, prompts
- ✅ Testar tool calls com parâmetros custom
- ✅ Ver logs/notifications em tempo real
- ✅ SSE stream inspector

**Acesse**: `http://localhost:6274`

### 9.2 curl (Manual)

#### Passo 1: Initialize
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {"tools": {}},
      "clientInfo": {"name": "test-client", "version": "1.0.0"}
    }
  }' -v

# Extrair session ID do header:
# < Mcp-Session-Id: abc123-...
SESSION_ID="abc123-..."
```

#### Passo 2: List Tools
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }' | jq '.result.tools[] | {name, description, inputSchema}'
```

#### Passo 3: Call Tool
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "navigate",
      "arguments": {"url": "https://example.com"}
    }
  }' | jq .
```

#### Passo 4: Delete Session
```bash
curl -X DELETE http://localhost:3000/mcp \
  -H "Mcp-Session-Id: $SESSION_ID"
```

### 9.3 MCP CLI Tools

**mcp-echo** (debug):
```bash
npx -y @modelcontextprotocol/inspector --cli node build/index.js
```

**mcp-client**:
```bash
npx -y @modelcontextprotocol/cli@latest client \
  --server http://localhost:3000/mcp \
  --session-id $SESSION_ID \
  --request '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 9.4 Playwright Test

```typescript
// test/mcp-server.test.ts
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('MCP server responds to initialize', async () => {
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost:3000/mcp')
  );
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  const result = await client.initialize({
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });

  expect(result.serverInfo.name).toBe('remote-browser');
  expect(result.capabilities.tools).toBeDefined();
});
```

### 9.5 Testes de Stress

```bash
#!/bin/bash
# test-stress.sh
CONCURRENCY=10
REQUESTS=100

for i in $(seq 1 $CONCURRENCY); do
  for j in $(seq 1 $REQUESTS); do
    curl -s -X POST http://localhost:3000/mcp \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
      > /dev/null &
  done
done

wait
echo "Testes concluídos"
```

---

## 10. Limitações e Edge Cases do Protocolo MCP

### 10.1 Tamanho de Payload

**Limite**: Claude Desktop/Code têm limite de **~1MB por tool response**.

**Implicações**: Screenshots em base64 rapidamente excedem:
- 1920x1080 JPEG quality 80 ≈ 500KB
- 1920x1080 PNG ≈ 2-3MB (impossível)

**Solução**: Comprimir para ≤720p, JPEG quality 60-75.

```typescript
// Garantir < 1MB
function ensureUnderLimit(buffer: Buffer, maxBytes = 900_000): Buffer {
  if (buffer.length <= maxBytes) return buffer;

  // Reduz progressivamente
  for (const quality of [70, 60, 50, 40, 30]) {
    const compressed = sharp(buffer).jpeg({ quality }).toBuffer();
    if (compressed.length <= maxBytes) return compressed;
  }

  // Último recurso: redimensiona
  return sharp(buffer)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 30 })
    .toBuffer();
}
```

### 10.2 ImageContent: Somente Base64

**Limitação**: A spec MCP atual NÃO suporta URLs de imagem, apenas `data:image/jpeg;base64,...` inline.

**Issue aberta**: [Discussion #794](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/794)

**Workaround**: Nenhum. obrigatório base64.

### 10.3 Session ID Stale (Claude Code Bug)

**Problema**: Claude Code cacheia `Mcp-Session-Id` e nunca renova. Se o server reinicia, Claude continua enviando session ID antigo → 404 errors.

**Solução**: Reiniciar Claude Code completamente (`/exit` → relaunch).

**Bug**: [Issue #27142](https://github.com/anthropics/claude-code/issues/27142)

**Mitigação no server**: Retornar erro claro:
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "Session expired. Please restart Claude Code."
  }
}
```

### 10.4 Accept Header Required

**Problema**: Alguns clients MCP (Claude Code, Cursor) podem não enviar `Accept: application/json, text/event-stream`.

**Server deve**:
```typescript
app.post("/mcp", async (req, res) => {
  const accept = req.headers.accept || '';

  // Aceitar mesmo sem header correto (permissivo)
  // ou
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    res.status(406).json({
      error: { code: -32600, message: "Accept header required" }
    });
    return;
  }

  // process request...
});
```

**Issue**: [Figma MCP Bug #34498](https://github.com/anthropics/claude-code/issues/34498)

### 10.5 mcp-remote Incompatibility

**Problema**: `mcp-remote` não gerencia session IDs corretamente com FastMCP servers.

**Solução**: No Claude Code, usar `--transport http` direto ao invés de mcp-remote.

**Issue**: [mcp-remote #113](https://github.com/geelen/mcp-remote/issues/113)

### 10.6 Unicode e Escape em JSON

**Edge Case**: Textos com emojis, ligaduras, ou RTL (árabe, hebraico) em tool descriptions podem quebrar JSON encoding.

**Solução**:
```typescript
// Sempre usar JSON.stringify, nunca template strings manual
const json = JSON.stringify(response);
res.send(json);
```

### 10.7 Transport: Stateful vs Stateless

**Conflito**: StreamableHTTP suporta ambos, mas:

- **Stateless** (`sessionIdGenerator: undefined`) → serverless-friendly, mas perde estado entre requests
- **Stateful** → mantém browser state por sessão, mas requer session management

** Para browser automation: Stateful obrigatório** (precisa manter browser instance).

### 10.8 Concurrency na Sessão

**Limitação**: MCP spec não define se múltiplos requests podem concorrer na mesma sessão.

**Assumir**: Sequential processing. Se cliente envia request em paralelo, server pode processar em serie.

```typescript
// Session-based lock
const sessionLocks = new Map<string, boolean>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;

  if (sessionLocks.get(sessionId)) {
    // Retorna error ou enfileira
    res.status(429).json({
      error: { code: -32003, message: "Session busy, try again" }
    });
    return;
  }

  sessionLocks.set(sessionId, true);
  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    sessionLocks.set(sessionId, false);
  }
});
```

### 10.9 Tool List Pagination

**Feature**: `tools/list` suporta paginação (`cursor`), mas poucos clients implementam.

**Edge case**: Se server tem 100+ tools, retornar tudo de uma vez pode ser pesado (token limit no LLM).

**Solução** (futuro): Paginar e client deve seguir cursor.

### 10.10 Notifications Perdidas

**Problema**: Se cliente desconecta do SSE stream, pode perder `tools/list_changed` notifications.

**Resumabilidade**: StreamableHTTP suporta `Last-Event-ID` header para replay, mas implementação inconsistente.

**Workaround**: Client deve periodicamente fazer `tools/list` para refresh.

### 10.11 Protocol Versioning

**Version format**: `YYYY-MM-DD` (ex: "2025-06-18").

**Negociação**: Client envia versão suportada, server responde com versão negociada ou erro se incompatível.

**Risk**: Future versions podem renomear/remover campos. Manter backward compatibility ao menos 6 meses.

### 10.12 Binary Data em Content

**Limitação**: `ImageContent` usa base64 string, não binary buffer.

**Overhead**: Base64 adds 33% de tamanho.

**Melhor prática**: Comprimir ANTES de base64-encode.

### 10.13 Character Encoding

**Spec**: UTF-8 obrigatório.

**Erro comum**: Enviar ISO-8859-1, Windows-1252 em fields → falha de parse no client.

**Solução**:
```typescript
const json = Buffer.from(JSON.stringify(obj), 'utf8');
res.send(json);
```

### 10.14 Tool Execution Timeout

**Problema**: LLMs podem esperar indefinidamente por tool response (token consumption).

**Solução**: Server-side timeout + `isError: true`:

```typescript
server.tool("slow_op", ..., async (args) => {
  const timeoutMs = 30000;

  return await Promise.race([
    doSlowOperation(args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Operation timeout')), timeoutMs)
    ).catch(err => ({
      content: [{ type: "text", text: `Timeout: ${err.message}` }],
      isError: true
    }))
  ]);
});
```

### 10.15 Naming Collisions

**Problema**: Dois servers podem expor tool com mesmo nome.

**Client resolution**: Prefixo do server. Ex: `filesystem_read` vs `sentry_read`.

**Boas prática**: Namespacing explícito:
```typescript
server.tool(
  "browser_navigate",  // Prefixo: browser_
  ...
);
```

### 10.16 Limits de Ferramentas Ativas

**Issue**: Claude tem limite de ~10-20 tools simultâneas na context window.

**Edge case**: Server com 50 tools, LLM ignora muitas.

**Solução**:
- Expor apenas core tools (5-10)
- Tools avançadas como opcional (add via separate server config)

---

## 11. Referências e Fontes

### Especificação Oficial
- [MCP Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/)
- [JSON-RPC 2.0 Spec](https://www.jsonrpc.org/specification)
- [Tools Definition](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

### SDKs
- [@modelcontextprotocol/sdk (TypeScript)](https://github.com/modelcontextprotocol/typescript-sdk)
- [@modelcontextprotocol/sdk (Python)](https://github.com/modelcontextprotocol/python-sdk)

### Transportes
- [StreamableHTTP Transport Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports/)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)

### Browser Automation
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Claude + Playwright Integration Guide](https://alexop.dev/posts/building_ai_qa_engineer_claude_code_playwright/)

### Testing
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [Test MCP with curl](https://medium.com/@umeshkaul_39077/curl-walk-through-of-updated-k8sgpt-mcp-server-d1ba1fad79e0)

### Issues Conhecidas
- [ImageContent support in Cline #1865](https://github.com/cline/cline/issues/1865)
- [Claude Code Session ID Bug #27142](https://github.com/anthropics/claude-code/issues/27142)
- [Accept header bug #34498](https://github.com/anthropics/claude-code/issues/34498)

### Exemplos
- [MCP Reference Servers](https://github.com/modelcontextprotocol/servers)
- [MCP Examples (TypeScript SDK)](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples)

---

## 12. Apêndice: Checklist de Deploy

- [ ] Escolher transport: StreamableHTTP (recomendado)
- [ ] Implementar todos os 3 métodos: POST, GET, DELETE em `/mcp`
- [ ] Configurar `sessionIdGenerator` (stateless vs stateful)
- [ ] Definir tools com Zod schemas válidos
- [ ] Implementar retorno de `ImageContent` (base64) para screenshots
- [ ] Comprimir imagens para <1MB (JPEG quality 60-80)
- [ ] Adicionar timeout e error handling
- [ ] Logging estruturado com session ID
- [ ] Health check endpoint `/health`
- [ ] Testar com `curl` antes de conectar ao Claude
- [ ] Configurar `.mcp.json` ou `claude mcp add`
- [ ] Rate limiting por session
- [ ] Sandbox isolation (user-data-dir separado por sessão)
- [ ] Auto-cleanup de sessões inativas (>10min)
- [ ] Metrics/Prometheus endpoint (opcional)
- [ ] Documentar tools para usuários finais

---

**Documento gerado em**: 2025-03-17
**Baseado em**: MCP Specification 2025-06-18, SDK v1.x, StreamableHTTP transport
