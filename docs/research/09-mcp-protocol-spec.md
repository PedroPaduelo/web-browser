# 09 - MCP Protocol Spec: Transport, ImageContent e Session Management

Pesquisa sobre a especificacao do Model Context Protocol (MCP), com foco em como expor screenshots como imagem no response de uma tool MCP.

---

## 1. Visao Geral do MCP

O Model Context Protocol (MCP) e um protocolo aberto criado pela Anthropic que padroniza a integracao entre aplicacoes LLM e ferramentas/dados externos. Toda comunicacao usa **JSON-RPC 2.0** sobre UTF-8.

Tres primitivas principais:
- **Tools** -- funcoes que o LLM pode invocar (model-controlled)
- **Resources** -- dados que o cliente pode ler (application-controlled)
- **Prompts** -- templates reutilizaveis (user-controlled)

### 1.1 Lifecycle: Handshake de 3 Passos

```
1. Cliente envia `initialize` request (protocolVersion, capabilities, clientInfo)
2. Servidor responde com suas capabilities (tools, resources, prompts) e serverInfo
3. Cliente confirma com `notifications/initialized`
```

Apos o handshake, o cliente descobre as tools disponiveis via `tools/list`.

---

## 2. Transports

### 2.1 HTTP+SSE (spec 2024-11-05) -- LEGADO

A versao 2024-11-05 da spec define o transport remoto como **HTTP com Server-Sent Events (SSE)**, usando dois endpoints separados:

| Endpoint | Metodo | Funcao |
|----------|--------|--------|
| `/sse` | GET | Estabelece conexao SSE persistente; servidor envia evento `endpoint` com a URI para POST |
| `/messages` | POST | Cliente envia mensagens JSON-RPC |

**Fluxo:**
```
Cliente                     Servidor
  |                            |
  |--- GET /sse -------------->|
  |<-- event: endpoint --------|  (URI: /messages?sessionId=xxx)
  |                            |
  |--- POST /messages -------->|  (initialize request)
  |<-- SSE message event ------|  (initialize response)
  |                            |
  |--- POST /messages -------->|  (notifications/initialized)
  |<-- SSE message events -----|  (tool results, etc.)
```

**Codigo servidor (Express + SDK):**
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

**Codigo cliente (SDK):**
```typescript
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";

const transport = new SSEClientTransport(new URL("http://localhost:3000/sse"));
await client.connect(transport);
```

**Limitacoes:**
- Requer conexao persistente (SSE long-lived) -- nao funciona bem em serverless
- Dois endpoints separados aumentam complexidade
- Dificil escalar (cada cliente = 1 conexao SSE aberta)

### 2.2 Streamable HTTP (spec 2025-03-26) -- ATUAL

Substituiu o HTTP+SSE. Usa um **unico endpoint** (ex: `/mcp`) com tres metodos HTTP:

| Metodo | Funcao |
|--------|--------|
| **POST** | Cliente envia mensagens JSON-RPC; servidor responde com JSON ou SSE stream |
| **GET** | Abre SSE stream para notificacoes server-to-client (opcional) |
| **DELETE** | Encerra a sessao |

**Regras do POST:**
- Header obrigatorio: `Accept: application/json, text/event-stream`
- Body: um unico JSON-RPC request, notification ou response
- Servidor pode responder com:
  - `200` + `application/json` -- resposta direta
  - `200` + `text/event-stream` -- stream SSE com multiplas mensagens
  - `202` -- aceito (para notifications, sem body)

**Regras do GET:**
- Header: `Accept: text/event-stream`
- Abre SSE stream para server -> client (notificacoes, requests do servidor)
- Apenas 1 stream por sessao (segundo GET = 409 Conflict)

**Regras do DELETE:**
- Inclui `Mcp-Session-Id` header
- Encerra a sessao e limpa estado no servidor

**Codigos de status importantes:**

| Codigo | Significado |
|--------|-------------|
| 200 | JSON body ou SSE stream |
| 202 | Notification aceita, sem body |
| 400 | JSON-RPC malformado ou `Mcp-Session-Id` ausente |
| 404 | Sessao desconhecida/expirada |
| 405 | Metodo nao permitido |
| 406 | Accept header incorreto |
| 409 | Segundo SSE stream na mesma sessao |
| 415 | Content-Type deve ser `application/json` |

### 2.3 Compatibilidade entre versoes

Para suportar clientes antigos e novos:
- Servidor pode manter ambos endpoints (`/sse` + `/messages` legado E `/mcp` novo)
- Cliente deve tentar POST em `/mcp` primeiro; se receber 404/405, fallback para GET `/sse` + POST `/messages`

---

## 3. Session Management

### 3.1 Mcp-Session-Id Header

O Streamable HTTP introduz gerenciamento de sessao explicito via header:

```
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Session-Id: abc123-session-id
```

**Ciclo de vida:**
1. Cliente envia `initialize` request SEM `Mcp-Session-Id`
2. Servidor responde com `Mcp-Session-Id` no response header
3. Cliente inclui esse header em TODOS os requests subsequentes
4. Para encerrar: `DELETE /mcp` com o `Mcp-Session-Id`

**Regras:**
- ID deve conter apenas caracteres ASCII visiveis (0x21 a 0x7E)
- Requests sem `Mcp-Session-Id` (exceto initialize) recebem 400
- Sessao expirada/encerrada retorna 404 -- cliente deve reiniciar com novo `initialize`

### 3.2 Resumabilidade

- Cada evento SSE pode conter um `id:` (Event ID)
- Cliente reconecta com header `Last-Event-ID` para replay de eventos perdidos
- Replay se aplica ao stream, nao globalmente

### 3.3 Modelo de Estado em Duas Camadas

1. **Camada de aplicacao (duravel):** `Mcp-Session-Id` vincula requests HTTP independentes em uma conversa coerente
2. **Camada de transporte (efemera):** conexoes HTTP abertas (GET stream ou POST streaming response)

A robustez do protocolo vem da capacidade de reconstruir o estado efemero usando o estado duravel quando uma conexao cai.

---

## 4. Tool Results: ImageContent

### 4.1 Schema do CallToolResult

Quando uma tool e invocada via `tools/call`, o servidor retorna um `CallToolResult`:

```typescript
interface CallToolResult {
  _meta?: { [key: string]: unknown };
  content: ContentBlock[];       // conteudo nao-estruturado
  structuredContent?: object;    // conteudo estruturado (opcional)
  isError?: boolean;             // default: false
}
```

`ContentBlock` e uma union:
```typescript
type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;
```

### 4.2 ImageContent Interface

```typescript
interface ImageContent {
  type: "image";
  data: string;        // base64-encoded image data
  mimeType: string;    // ex: "image/png", "image/jpeg", "image/webp"
  annotations?: {
    audience?: ("user" | "assistant")[];
    priority?: number; // 0.0 a 1.0
  };
  _meta?: { [key: string]: unknown };
}
```

### 4.3 Exemplo: Retornando Screenshot como ImageContent

**Node.js / TypeScript (SDK oficial):**
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server";
import { z } from "zod";

const server = new McpServer({
  name: "remote-browser",
  version: "1.0.0"
});

server.tool(
  "take_screenshot",
  "Captura screenshot do browser remoto",
  {
    format: z.enum(["png", "jpeg"]).default("png").describe("Formato da imagem"),
    quality: z.number().min(1).max(100).default(80).describe("Qualidade JPEG (ignorado para PNG)")
  },
  async ({ format, quality }) => {
    // Capturar screenshot via CDP, Puppeteer, ou X11
    const screenshotBuffer = await captureScreenshot({ format, quality });
    const base64Data = screenshotBuffer.toString("base64");

    return {
      content: [
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

**Python (SDK oficial):**
```python
import base64
from mcp import types

async def handle_take_screenshot(arguments: dict) -> list[types.ImageContent]:
    screenshot_bytes = await capture_screenshot()
    b64 = base64.b64encode(screenshot_bytes).decode("utf-8")

    return [
        types.ImageContent(
            type="image",
            data=b64,
            mimeType="image/png"
        )
    ]
```

### 4.4 Retornando texto + imagem juntos

Uma tool pode retornar multiplos content blocks:

```typescript
return {
  content: [
    {
      type: "text",
      text: `Screenshot capturado: ${width}x${height} pixels, formato ${format}`
    },
    {
      type: "image",
      data: base64Data,
      mimeType: "image/png"
    }
  ]
};
```

### 4.5 Armadilhas conhecidas

1. **Mismatch de MIME type**: declarar `image/jpeg` mas enviar dados PNG causa erro 400 na API do Claude ("Image does not match the provided media type"). Sempre validar que o mimeType corresponde ao formato real dos dados.

2. **Tamanho do payload**: screenshots base64 podem ser grandes (1-5 MB para full HD). Considerar:
   - Reduzir resolucao (ex: 1280x720 ao inves de 1920x1080)
   - Usar JPEG com quality 60-80 ao inves de PNG
   - Comprimir antes de encodar

3. **Suporte inconsistente entre clientes:**
   - **Claude Desktop / Claude Code**: suporte completo a ImageContent
   - **Cursor**: suporte completo, injeta imagem no chat
   - **Cline**: historicamente nao reconhecia ImageContent (mostrava "Empty Response") -- fix em andamento
   - **Gemini CLI**: issue aberta para suporte a ImageContent
   - **OpenAI Agents SDK**: limitacoes reportadas com image responses de MCP

---

## 5. Como Clientes se Conectam ao MCP

### 5.1 Claude Desktop (stdio)

Claude Desktop so conecta via **stdio** nativamente. Para servidores remotos, usa `mcp-remote` como bridge:

```json
{
  "mcpServers": {
    "remote-browser": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://meu-servidor.com/mcp",
        "--header",
        "Authorization: Bearer ${API_KEY}"
      ],
      "env": {
        "API_KEY": "minha-chave"
      }
    }
  }
}
```

**Arquivo de config:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### 5.2 Claude Code (.mcp.json)

Claude Code suporta HTTP diretamente:

```json
{
  "mcpServers": {
    "remote-browser": {
      "type": "http",
      "url": "https://meu-servidor.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

Tambem suporta stdio:
```json
{
  "mcpServers": {
    "remote-browser": {
      "command": "node",
      "args": ["/caminho/para/server/index.js"]
    }
  }
}
```

### 5.3 Cursor IDE

Cursor suporta MCP com image injection no chat. Configuracao similar ao Claude Desktop, usando `mcpServers` em settings. Quando o modelo suporta visao, a imagem e analisada automaticamente.

### 5.4 Outros Clientes (Roo Code, Windsurf, etc.)

A maioria dos clientes MCP modernos suporta pelo menos stdio e esta adicionando suporte a Streamable HTTP. O padrao de conexao e o mesmo: configuracao de `mcpServers` com command+args (stdio) ou URL (HTTP).

---

## 6. Arquitetura Recomendada para o Remote Browser

Para expor screenshots do browser remoto via MCP:

```
                    MCP Client (Claude/Cursor)
                           |
                    JSON-RPC 2.0 via HTTP
                           |
                    +------v-------+
                    |  MCP Server  |  (Express + @modelcontextprotocol/sdk)
                    |  /mcp        |  Streamable HTTP transport
                    +------+-------+
                           |
                    +------v-------+
                    | Browser Mgr  |  (CDP / Puppeteer / X11)
                    +------+-------+
                           |
                    +------v-------+
                    |   Chrome     |  (headless ou com display virtual)
                    +--------------+
```

### 6.1 Tools a Expor

| Tool | Descricao | Retorno |
|------|-----------|---------|
| `take_screenshot` | Captura screenshot do browser | `ImageContent` (base64 PNG/JPEG) |
| `navigate` | Navega para URL | `TextContent` (confirmacao) |
| `click` | Clica em coordenada x,y | `TextContent` + `ImageContent` (screenshot pos-clique) |
| `type_text` | Digita texto | `TextContent` (confirmacao) |
| `scroll` | Scroll up/down | `ImageContent` (screenshot pos-scroll) |
| `get_page_info` | Retorna titulo, URL, DOM info | `TextContent` (JSON) |

### 6.2 Implementacao Minima do Transport

Para suportar o maximo de clientes possivel, implementar ambos os transports:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamablehttp";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse";
import express from "express";

const app = express();
const server = new McpServer({ name: "remote-browser", version: "1.0.0" });

// Registrar tools...
server.tool("take_screenshot", /* ... */);

// --- Streamable HTTP (recomendado, spec 2025-03-26) ---
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// --- Legado SSE (spec 2024-11-05, para clientes antigos) ---
let sseTransport: SSEServerTransport;
app.get("/sse", (req, res) => {
  sseTransport = new SSEServerTransport("/messages", res);
  server.connect(sseTransport);
});
app.post("/messages", (req, res) => {
  sseTransport?.handlePostMessage(req, res);
});

app.listen(3000);
```

### 6.3 Otimizacao de Screenshots

Para manter o payload razoavel:

```typescript
async function captureOptimizedScreenshot(): Promise<{ data: string; mimeType: string }> {
  // Via CDP (Chrome DevTools Protocol)
  const { data } = await cdpSession.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 70,
    clip: {
      x: 0, y: 0,
      width: 1280, height: 720,
      scale: 1
    }
  });

  // CDP retorna base64 diretamente
  return {
    data: data,  // ja e base64
    mimeType: "image/jpeg"
  };
}
```

---

## 7. Resumo Decisoes para o Projeto

| Decisao | Escolha | Motivo |
|---------|---------|--------|
| Transport principal | Streamable HTTP (`/mcp`) | Padrao atual, compativel com Claude Code |
| Transport legado | HTTP+SSE (`/sse` + `/messages`) | Compatibilidade com Claude Desktop via mcp-remote |
| Formato screenshot | JPEG quality 70 | Balanco tamanho/qualidade (~100-300KB) |
| Resolucao | 1280x720 (configuravel) | Suficiente para LLM analisar, payload razoavel |
| Content type | `ImageContent` com base64 | Unico formato suportado pela spec MCP |
| Metadata | `annotations.audience: ["user","assistant"]` | Permite que tanto usuario quanto modelo vejam a imagem |
| Session management | `Mcp-Session-Id` header | Necessario para Streamable HTTP stateful |
| SDK | `@modelcontextprotocol/sdk` + `zod` | SDK oficial TypeScript |

---

## Fontes

- [MCP Specification 2024-11-05](https://modelcontextprotocol.info/specification/2024-11-05/)
- [MCP Transports (Legacy)](https://modelcontextprotocol.io/legacy/concepts/transports)
- [Streamable HTTP Spec (2025-03-26)](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/)
- [MCP Schema Reference](https://modelcontextprotocol.io/specification/2025-06-18/schema)
- [MCP Tools Spec](https://modelcontextprotocol.info/docs/concepts/tools/)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [How MCP Uses Streamable HTTP (The New Stack)](https://thenewstack.io/how-mcp-uses-streamable-http-for-real-time-ai-tool-interaction/)
- [MCP Streamable HTTP Spec (Loosely Connected)](https://looselyconnected.wordpress.com/2025/05/26/mcp-streamable-http-spec/)
- [Auth0: MCP Streamable HTTP Security](https://auth0.com/blog/mcp-streamable-http/)
- [Claude Code MCP Servers](https://www.builder.io/blog/claude-code-mcp-servers)
- [Claude Desktop MCP Setup](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Cursor MCP Docs](https://docs.cursor.com/context/model-context-protocol)
- [Cline ImageContent Issue #1865](https://github.com/cline/cline/issues/1865)
- [Gemini CLI ImageContent Issue #2136](https://github.com/google-gemini/gemini-cli/issues/2136)
- [Playwright MCP Screenshot Bug #1211](https://github.com/microsoft/playwright-mcp/issues/1211)
- [MCP Screenshot Server (sethbang)](https://github.com/sethbang/mcp-screenshot-server)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Schema 2024-11-05 (GitHub)](https://github.com/modelcontextprotocol/specification/blob/main/schema/2024-11-05/schema.json)
- [JSON-RPC Protocol in MCP (mcpcat.io)](https://mcpcat.io/guides/understanding-json-rpc-protocol-mcp/)
- [MCP Message Types (Portkey)](https://portkey.ai/blog/mcp-message-types-complete-json-rpc-reference-guide/)
