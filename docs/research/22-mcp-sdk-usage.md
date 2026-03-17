# MCP TypeScript SDK - Guia Completo

Pesquisa sobre `@modelcontextprotocol/sdk` (npm): como usar `McpServer` com
`StreamableHTTPServerTransport`, retornar imagens base64, sessoes stateful,
session ID no header, e conexao do Claude Desktop/Code a MCP servers HTTP.

---

## 1. Visao Geral do SDK

O pacote npm `@modelcontextprotocol/sdk` e o SDK oficial TypeScript para o
Model Context Protocol. Ele permite criar MCP servers que expoe resources,
prompts e tools, e MCP clients que se conectam a qualquer server MCP.

### Instalacao

```bash
# v1.x (estavel, recomendado para producao)
npm install @modelcontextprotocol/sdk zod express

# v2 (em desenvolvimento, pre-alpha - previsto estavel Q1 2026)
npm install @modelcontextprotocol/server @modelcontextprotocol/express zod express
```

### Imports Principais (v1.x)

```typescript
// Server
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// Client
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

### Imports Principais (v2 - main branch)

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { isInitializeRequest } from "@modelcontextprotocol/server";
```

> **Nota**: A branch `main` contem v2 do SDK (pre-alpha). A branch `v1.x` e a
> versao estavel recomendada. Os imports sao diferentes entre versoes.

### Transportes Disponiveis

| Transporte | Uso | Status |
|---|---|---|
| **Streamable HTTP** | Servers remotos (HTTP) | Recomendado (spec 2025-03-26) |
| **stdio** | Servers locais | Estavel |
| **HTTP + SSE** | Servers remotos (legado) | Depreciado |

---

## 2. McpServer com StreamableHTTPServerTransport

### 2.1 Server Stateless (Sem Sessoes)

O modo stateless cria um transport novo por request. Ideal para servers simples,
scale-to-zero e autoscaling sem gerenciamento de sessoes.

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
  // Cria server e transport novos por request (stateless)
  const server = new McpServer({
    name: "my-server",
    version: "1.0.0",
  });

  // Registra tools
  server.tool(
    "screenshot",
    "Captura screenshot do browser",
    { format: z.enum(["jpeg", "png"]).default("jpeg") },
    async ({ format }) => {
      // ... logica de captura ...
      return {
        content: [{ type: "text", text: "Screenshot captured" }],
      };
    }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // undefined = stateless
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000, "127.0.0.1", () => {
  console.log("MCP server (stateless) on http://127.0.0.1:3000/mcp");
});
```

### 2.2 Server Stateful (Com Sessoes)

O modo stateful mantem um `StreamableHTTPServerTransport` por sessao, permitindo
estado persistente entre requests do mesmo client. Usa o header
`Mcp-Session-Id` para rotear requests.

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

// Map de sessoes: sessionId -> transport
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Cria uma instancia do McpServer com as tools
function createServer(): McpServer {
  const server = new McpServer(
    { name: "browser-mcp", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  server.tool(
    "navigate",
    "Navega para uma URL",
    { url: z.string().url() },
    async ({ url }) => {
      return {
        content: [{ type: "text", text: `Navigated to ${url}` }],
      };
    }
  );

  return server;
}

// ============================================================
// POST /mcp - Recebe mensagens do client
// ============================================================
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Caso 1: Sessao existente - reutiliza transport
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  // Caso 2: Nova sessao - request de initialize sem session ID
  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`Session initialized: ${id}`);
      },
    });

    // Limpa sessao quando transport fecha
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Caso 3: Sessao invalida ou request mal formado
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Invalid session or missing session ID",
    },
    id: null,
  });
});

// ============================================================
// GET /mcp - SSE stream para notificacoes server -> client
// ============================================================
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;

  if (sessionId && transports[sessionId]) {
    // O transport lida com SSE automaticamente
    await transports[sessionId].handleRequest(req, res);
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Invalid or missing session" },
    id: null,
  });
});

// ============================================================
// DELETE /mcp - Encerra sessao
// ============================================================
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
    // Transport se auto-limpa via onclose callback
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Invalid session" },
    id: null,
  });
});

app.listen(3000, "0.0.0.0", () => {
  console.log("MCP server (stateful) on http://0.0.0.0:3000/mcp");
});
```

### 2.3 Endpoint Unico - Resumo do Protocolo

O Streamable HTTP usa um **unico endpoint** (ex: `/mcp`) que suporta 3 metodos:

| Metodo | Funcao | Quando Usar |
|---|---|---|
| **POST** | Client envia mensagens (requests, responses, notifications) | Toda comunicacao client -> server |
| **GET** | Server abre SSE stream para notificacoes | Server precisa enviar dados nao solicitados |
| **DELETE** | Client encerra sessao | Fim da sessao |

---

## 3. Retornando Imagens (Base64 JPEG) em Tool Responses

### 3.1 Formato da Especificacao MCP

A especificacao MCP define o tipo `ImageContent` para retornar imagens em tool
responses. O formato e exclusivamente **base64** (URLs de imagem NAO sao
suportadas na spec atual).

```typescript
// Estrutura de um ImageContent na spec MCP
{
  type: "image",       // Tipo obrigatorio
  data: string,        // Dados da imagem em base64 (SEM prefixo data:...)
  mimeType: string,    // Ex: "image/jpeg", "image/png"
  annotations?: {      // Opcional
    audience?: ("user" | "assistant")[],
    priority?: number  // 0.0 a 1.0
  }
}
```

### 3.2 Exemplo: Tool que Retorna Screenshot JPEG

```typescript
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "browser-mcp",
  version: "1.0.0",
});

server.tool(
  "take_screenshot",
  "Captura screenshot do browser e retorna como imagem JPEG",
  {
    quality: z.number().min(1).max(100).default(80)
      .describe("Qualidade JPEG de 1 a 100"),
    selector: z.string().optional()
      .describe("CSS selector para capturar elemento especifico"),
  },
  async ({ quality, selector }) => {
    // Exemplo: captura screenshot via CDP (Chrome DevTools Protocol)
    const screenshotResult = await cdpSession.send(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: quality,
        clip: selector ? await getElementClip(selector) : undefined,
      }
    );

    // screenshotResult.data ja vem em base64 do CDP
    const base64Data: string = screenshotResult.data;

    return {
      content: [
        {
          type: "image" as const,
          data: base64Data,        // Base64 puro, SEM prefixo "data:image/jpeg;base64,"
          mimeType: "image/jpeg",
        },
      ],
    };
  }
);
```

### 3.3 Exemplo: Retornando Imagem + Texto

```typescript
server.tool(
  "screenshot_with_description",
  "Captura screenshot e retorna com descricao",
  {
    url: z.string().url(),
  },
  async ({ url }) => {
    // Navega e captura
    await page.goto(url);
    const buffer = await page.screenshot({ type: "jpeg", quality: 75 });
    const base64Data = buffer.toString("base64");

    return {
      content: [
        {
          type: "text",
          text: `Screenshot da pagina ${url} (${buffer.length} bytes)`,
        },
        {
          type: "image",
          data: base64Data,
          mimeType: "image/jpeg",
        },
      ],
    };
  }
);
```

### 3.4 Limitacoes Conhecidas

| Limitacao | Detalhes |
|---|---|
| **Somente base64** | A spec MCP nao suporta URLs de imagem em tool results (apenas `data` base64) |
| **Limite de tamanho** | Claude Desktop tem limite de ~1MB por conteudo retornado por tool. Imagens acima de 1MB podem falhar |
| **Overhead base64** | Base64 aumenta o tamanho em ~33% em relacao ao binario original |
| **Sem URL support** | Issue aberta no repo oficial pedindo suporte a URLs: [Discussion #794](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/794) |

### 3.5 Boas Praticas para Imagens

```typescript
// Comprima JPEG adequadamente para ficar abaixo de 1MB
function compressForMcp(buffer: Buffer, maxSizeBytes = 900_000): {
  data: string;
  mimeType: string;
} {
  let quality = 80;
  let compressed = buffer;

  // Reduz qualidade iterativamente se necessario
  while (compressed.length > maxSizeBytes && quality > 10) {
    quality -= 10;
    compressed = sharp(buffer)
      .jpeg({ quality })
      .toBuffer();
  }

  // Se ainda muito grande, redimensiona
  if (compressed.length > maxSizeBytes) {
    compressed = sharp(buffer)
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
  }

  return {
    data: compressed.toString("base64"),
    mimeType: "image/jpeg",
  };
}
```

---

## 4. Sessoes Stateful e o Header `Mcp-Session-Id`

### 4.1 Ciclo de Vida de uma Sessao

```
Client                                    Server
  |                                          |
  |--- POST /mcp (initialize, sem header) -->|  1. Client envia initialize
  |                                          |     Server cria nova sessao
  |<-- 200 OK + Mcp-Session-Id: abc123 ------|  2. Server retorna session ID
  |                                          |     no header da resposta
  |                                          |
  |--- POST /mcp                         --->|  3. Requests subsequentes
  |    Header: Mcp-Session-Id: abc123        |     DEVEM incluir o session ID
  |<-- 200 OK -------------------------------|
  |                                          |
  |--- GET /mcp                          --->|  4. SSE stream (opcional)
  |    Header: Mcp-Session-Id: abc123        |     Para notificacoes server->client
  |<-- SSE stream (text/event-stream) -------|
  |                                          |
  |--- DELETE /mcp                       --->|  5. Encerrar sessao
  |    Header: Mcp-Session-Id: abc123        |
  |<-- 200 OK -------------------------------|
```

### 4.2 Como o Session ID Funciona

1. **Inicializacao**: Client envia POST com `isInitializeRequest` sem header
   `Mcp-Session-Id`
2. **Atribuicao**: Server gera UUID, cria `StreamableHTTPServerTransport`, e
   retorna o ID no header `Mcp-Session-Id` da resposta
3. **Persistencia**: Client armazena o session ID e o inclui em TODOS os
   requests subsequentes via header `Mcp-Session-Id`
4. **Roteamento**: Server usa o header para localizar o transport correto no map
   de sessoes
5. **Terminacao**: Client envia DELETE com o session ID, ou server pode invalidar

### 4.3 Tratamento de Erros de Sessao

```typescript
// No handler POST /mcp, tratar sessoes invalidas:
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && !transports[sessionId]) {
    // Sessao expirada ou server reiniciou
    // Spec diz: client deve descartar session ID e re-inicializar
    res.status(404).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Session not found. Please re-initialize.",
      },
      id: null,
    });
    return;
  }

  // ... resto do handler
});
```

### 4.4 Sessoes com Persistencia (Event Store)

Para servers distribuidos ou que reiniciam sem perder sessoes, use um event
store externo:

```typescript
import { randomUUID } from "node:crypto";

// Event store externo (Redis, banco de dados, etc.)
const eventStore = createExternalEventStore(); // sua implementacao

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore: eventStore, // Persiste eventos entre reinicializacoes
  onsessioninitialized: (id) => {
    transports[id] = transport;
  },
});
```

Isso permite:
- Multiplas instancias do server compartilhando estado de sessao
- Resumabilidade: client reconecta e recupera eventos perdidos
- Escalabilidade horizontal

---

## 5. Como Claude Desktop/Code se Conecta a um MCP Server HTTP

### 5.1 Claude Code - Configuracao via CLI

```bash
# Adicionar server HTTP (Streamable HTTP - recomendado)
claude mcp add --transport http browser-mcp http://localhost:3000/mcp

# Com autenticacao via header
claude mcp add --transport http browser-mcp http://localhost:3000/mcp \
  --header "Authorization: Bearer meu-token"

# Com escopo especifico
claude mcp add --transport http browser-mcp http://localhost:3000/mcp \
  --scope local    # local (default), project, ou user

# Via JSON direto
claude mcp add-json browser-mcp '{
  "type": "http",
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer meu-token"
  }
}'
```

### 5.2 Claude Code - Configuracao via .mcp.json

Arquivo `.mcp.json` na raiz do projeto:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    },
    "browser-mcp-autenticado": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${BROWSER_MCP_TOKEN}"
      }
    },
    "browser-mcp-com-default": {
      "type": "http",
      "url": "${API_BASE_URL:-http://localhost:3000}/mcp"
    }
  }
}
```

### 5.3 Claude Code - Configuracao via settings.json

Arquivo `.claude/settings.json`:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### 5.4 Claude Desktop - Configuracao

Claude Desktop usa `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

> **Nota importante**: Claude Desktop historicamente teve suporte limitado a
> Streamable HTTP. Alguns usuarios precisaram usar `mcp-remote` como proxy:
>
> ```json
> {
>   "mcpServers": {
>     "browser-mcp": {
>       "command": "npx",
>       "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"]
>     }
>   }
> }
> ```

### 5.5 Tres Tipos de Transporte Suportados pelo Claude Code

| Tipo | Comando | Uso |
|---|---|---|
| `http` | `claude mcp add --transport http name url` | Servers remotos (Streamable HTTP) |
| `sse` | `claude mcp add --transport sse name url` | Servers remotos (legado SSE) |
| `stdio` | `claude mcp add name command args...` | Servers locais |

### 5.6 OAuth para Servers Remotos

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "authServerMetadataUrl": "https://auth.example.com/.well-known/openid-configuration"
      }
    }
  }
}
```

---

## 6. Problemas Conhecidos e Workarounds

### 6.1 Session ID Stale (Claude Code)

**Problema**: Claude Code cacheia o `Mcp-Session-Id` na conexao e nunca o
renova. Se o MCP server reinicia, Claude Code continua enviando o session ID
antigo, recebendo erros.

**Workaround**: Reiniciar Claude Code completamente (`/exit` -> relaunchar).

**Correcao ideal** (spec MCP): Quando server retorna erro de sessao invalida,
client deve descartar o session ID e fazer novo handshake `initialize`.

Referencia: [Issue #27142](https://github.com/anthropics/claude-code/issues/27142)

### 6.2 Header Accept Ausente

**Problema**: Alguns servers requerem `Accept: application/json, text/event-stream`
mas Claude Code pode nao enviar esse header.

**Workaround**: Nao exigir esse header no server, ou aceitar requests sem ele.

Referencia: [Issue #34498](https://github.com/anthropics/claude-code/issues/34498)

### 6.3 mcp-remote Incompatibilidade com FastMCP

**Problema**: `mcp-remote` nao gerencia session IDs corretamente com servers
FastMCP.

**Workaround**: Usar transporte HTTP direto no Claude Code ao inves de
`mcp-remote`.

Referencia: [Issue #113](https://github.com/geelen/mcp-remote/issues/113)

---

## 7. Exemplo Completo: MCP Server de Browser com Screenshots

Exemplo que combina tudo: server stateful, tools com imagens, Express:

```typescript
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// Setup Express
// ============================================================
const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

// Estado por sessao (browser state, paginas, etc.)
const sessionState: Record<string, {
  currentUrl: string;
  history: string[];
}> = {};

// ============================================================
// Cria McpServer com todas as tools
// ============================================================
function createBrowserServer(sessionId: string): McpServer {
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
      // Inicializa estado da sessao se necessario
      if (!sessionState[sessionId]) {
        sessionState[sessionId] = { currentUrl: "", history: [] };
      }
      sessionState[sessionId].currentUrl = url;
      sessionState[sessionId].history.push(url);

      // ... CDP navigate logic ...

      return {
        content: [
          { type: "text", text: `Navigated to ${url}` },
        ],
      };
    }
  );

  // Tool: screenshot (retorna imagem JPEG)
  server.tool(
    "screenshot",
    "Captura screenshot do browser atual como imagem JPEG",
    {
      quality: z.number().min(1).max(100).default(75)
        .describe("Qualidade JPEG (1-100)"),
      fullPage: z.boolean().default(false)
        .describe("Se true, captura pagina inteira (scroll)"),
    },
    async ({ quality, fullPage }) => {
      // Captura via CDP
      const result = await cdpSession.send("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        captureBeyondViewport: fullPage,
      });

      const base64Data: string = result.data;
      const sizeKB = Math.round((base64Data.length * 3) / 4 / 1024);

      return {
        content: [
          {
            type: "text",
            text: `Screenshot captured (${sizeKB}KB, quality=${quality})`,
          },
          {
            type: "image",
            data: base64Data,       // Base64 puro
            mimeType: "image/jpeg",
          },
        ],
      };
    }
  );

  // Tool: click
  server.tool(
    "click",
    "Clica em um elemento na pagina",
    {
      x: z.number().describe("Coordenada X"),
      y: z.number().describe("Coordenada Y"),
    },
    async ({ x, y }) => {
      // ... CDP input dispatch ...
      return {
        content: [
          { type: "text", text: `Clicked at (${x}, ${y})` },
        ],
      };
    }
  );

  // Tool: type_text
  server.tool(
    "type_text",
    "Digita texto no elemento focado",
    {
      text: z.string().describe("Texto a digitar"),
    },
    async ({ text }) => {
      // ... CDP input dispatch ...
      return {
        content: [
          { type: "text", text: `Typed: "${text}"` },
        ],
      };
    }
  );

  return server;
}

// ============================================================
// POST /mcp - Principal endpoint
// ============================================================
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Sessao existente
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  // Sessao expirada
  if (sessionId && !transports[sessionId]) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session expired. Re-initialize." },
      id: null,
    });
    return;
  }

  // Nova sessao
  if (!sessionId && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`[session] New: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessionState[transport.sessionId];
        console.log(`[session] Closed: ${transport.sessionId}`);
      }
    };

    const server = createBrowserServer(newSessionId);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad request" },
    id: null,
  });
});

// ============================================================
// GET /mcp - SSE notifications
// ============================================================
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).send("Invalid session");
  }
});

// ============================================================
// DELETE /mcp - Encerrar sessao
// ============================================================
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.status(400).send("Invalid session");
  }
});

// ============================================================
// Start
// ============================================================
const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remote Browser MCP server on http://0.0.0.0:${PORT}/mcp`);
});
```

---

## 8. Conectando ao Server de Exemplo

### Via Claude Code CLI

```bash
# Adicionar o server
claude mcp add --transport http remote-browser http://localhost:3000/mcp

# Verificar servers configurados
claude mcp list

# Remover
claude mcp remove remote-browser
```

### Via .mcp.json

```json
{
  "mcpServers": {
    "remote-browser": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Testando com curl

```bash
# 1. Initialize (obter session ID)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test-client", "version": "1.0.0" }
    }
  }' -v
# Observe o header Mcp-Session-Id na resposta

# 2. List tools (com session ID)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id-da-resposta-anterior>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'

# 3. Call tool
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "screenshot",
      "arguments": { "quality": 75, "fullPage": false }
    }
  }'

# 4. Encerrar sessao
curl -X DELETE http://localhost:3000/mcp \
  -H "Mcp-Session-Id: <session-id>"
```

---

## 9. Referencia Rapida

### Content Types em Tool Responses

```typescript
// Texto
{ type: "text", text: "Hello" }

// Imagem (base64)
{ type: "image", data: "<base64-string>", mimeType: "image/jpeg" }

// Link para recurso
{ type: "resource_link", uri: "resource://my-resource" }
```

### StreamableHTTPServerTransport Options

```typescript
new StreamableHTTPServerTransport({
  // Gera session ID (undefined = stateless)
  sessionIdGenerator: () => randomUUID(),
  // ou: undefined para stateless

  // Callback quando sessao e inicializada
  onsessioninitialized: (sessionId: string) => { ... },

  // Event store externo para resumabilidade
  eventStore: myExternalEventStore,

  // Habilita respostas JSON puras (sem SSE)
  enableJsonResponse: true,
});
```

### Checklist para Deploy

- [ ] Handler POST /mcp (mensagens client -> server)
- [ ] Handler GET /mcp (SSE stream, pode retornar 405 se nao usado)
- [ ] Handler DELETE /mcp (encerrar sessao)
- [ ] Decidir: stateless (`sessionIdGenerator: undefined`) ou stateful
- [ ] Se stateful: map de sessoes + cleanup
- [ ] Imagens: comprimir para < 1MB, usar JPEG com qualidade adequada
- [ ] Testar com `curl` antes de conectar ao Claude Code
- [ ] Configurar `.mcp.json` ou `claude mcp add`

---

## Fontes

- [MCP TypeScript SDK - GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [@modelcontextprotocol/sdk - npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [SDK Server Docs (server.md)](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [MCP Specification - Transports (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP Specification - Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Connect Claude Code to MCP](https://code.claude.com/docs/en/mcp)
- [MCP Examples (server/)](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/server)
- [Why MCP Deprecated SSE - fka.dev](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [Managing Stateful MCP Server Sessions - CodeSignal](https://codesignal.com/learn/courses/developing-and-integrating-an-mcp-server-in-typescript/lessons/stateful-mcp-server-sessions)
- [Image Content URL Discussion #794](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/794)
- [Claude Code Session ID Bug #27142](https://github.com/anthropics/claude-code/issues/27142)
- [Figma MCP Accept Header Bug #34498](https://github.com/anthropics/claude-code/issues/34498)
