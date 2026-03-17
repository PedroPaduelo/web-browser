# Fastify WebSocket Plugin: Guia Completo

*Documentação técnica sobre @fastify/websocket, streaming binário e migração de Express+ws*

---

## Índice

1. [Introdução](#introdução)
2. [Como usar @fastify/websocket corretamente](#como-usar-fastifywebsocket-corretamente)
3. [WebSocket Routes com Parâmetros](#websocket-routes-com-parâmetros)
4. [@fastify/websocket vs ws: Diferenças](#fastifywebsocket-vs-ws-diferenças)
5. [Streaming Binário via WebSocket](#streaming-binário-via-websocket)
6. [Performance: @fastify/websocket vs ws standalone](#performance-comparativa)
7. [Migrando de Express+ws para Fastify](#migrando-de-expressws-para-fastify)
8. [Vantagens do Fastify](#vantagens-do-fastify)
9. [Exemplo Completo: Servidor de Streaming](#exemplo-completo-servidor-de-streaming)

---

## Introdução

O `@fastify/websocket` é o plugin oficial do Fastify para suporte a WebSockets. Ele é construído sobre a biblioteca `ws`, aproveitando sua performance e maturidade, enquanto se integra perfeitamente ao ecossistema Fastify.

### Instalação

```bash
npm install @fastify/websocket ws
npm install -D @types/ws  # Para TypeScript
```

### Nota Importante

A versão `fastify-websocket@4.3.0` foi descontinuada. Use `@fastify/websocket@5.0.0` ou superior.

---

## Como usar @fastify/websocket corretamente

### 1. Registro do Plugin

**⚠️ IMPORTANTE:** O plugin deve ser registrado **antes** de todas as rotas WebSocket:

```typescript
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';

const server = Fastify();

// Registrar primeiro!
await server.register(fastifyWebSocket);

// Depois definir rotas WebSocket
server.get('/ws', { websocket: true }, (connection, request) => {
  // Handler da conexão WebSocket
});
```

### 2. Estrutura Básica de uma Rota WebSocket

```typescript
import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

server.get('/ws', { websocket: true }, (connection: WebSocket, request: FastifyRequest) => {
  console.log('Cliente conectado');

  // Receber mensagens
  connection.on('message', (message: Buffer | string) => {
    console.log('Mensagem recebida:', message.toString());
  });

  // Enviar mensagens
  connection.send(JSON.stringify({ type: 'welcome', message: 'Conectado!' }));

  // Tratar fechamento
  connection.on('close', (code: number, reason: Buffer) => {
    console.log('Cliente desconectado:', code, reason.toString());
  });

  // Tratar erros
  connection.on('error', (error: Error) => {
    console.error('Erro WebSocket:', error);
  });
});
```

### 3. Usando Fastify Hooks com WebSocket

Você pode usar todos os hooks do Fastify (onRequest, preValidation, etc.) em rotas WebSocket:

```typescript
// Autenticação antes da conexão WebSocket
server.get('/ws', {
  websocket: true,
  onRequest: async (request, reply) => {
    const token = request.headers.authorization;
    if (!token) {
      throw new Error('Token não fornecido');
    }
    // Validar token...
  }
}, (connection, request) => {
  // Conexão autenticada
});
```

### 4. Gerenciando Múltiplas Conexões

Para broadcast e gerenciamento de conexões:

```typescript
interface ConnectionData {
  socket: WebSocket;
  userId?: string;
  connectedAt: Date;
}

const connections = new Set<ConnectionData>();

server.get('/ws', { websocket: true }, (connection, request) => {
  const connData: ConnectionData = {
    socket: connection,
    userId: request.query.userId as string,
    connectedAt: new Date()
  };

  connections.add(connData);

  // Broadcast para todos (exceto o remetente)
  const broadcast = (message: string, exclude?: WebSocket) => {
    for (const conn of connections) {
      if (conn.socket !== exclude && conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(message);
      }
    }
  };

  connection.on('message', (message) => {
    broadcast(`Usuário disse: ${message.toString()}`);
  });

  connection.on('close', () => {
    connections.delete(connData);
  });
});
```

---

## WebSocket Routes com Parâmetros

Fastify suporta parâmetros de rota em endpoints WebSocket, assim como em rotas HTTP:

### 1. Parâmetros de URL

```typescript
// Rota com parâmetro dinâmico
server.get('/ws/chat/:roomId', { websocket: true }, (connection, request) => {
  const { roomId } = request.params as { roomId: string };
  console.log('Entrou na sala:', roomId);

  connection.send(JSON.stringify({
    type: 'room-joined',
    roomId,
    message: `Bem-vindo à sala ${roomId}`
  }));
});
```

### 2. Query Parameters

```typescript
// Usando query params
server.get('/ws/stream', { websocket: true }, (connection, request) => {
  const { quality = 'high', fps = 30 } = request.query as {
    quality?: string;
    fps?: number;
  };

  // Configurar streaming baseado nos parâmetros
  startStreaming(connection, { quality, fps });
});
```

### 3. Middleware de Validação de Parâmetros

```typescript
import Ajv from 'ajv';

const ajv = new Ajv();

const roomSchema = {
  type: 'object',
  properties: {
    roomId: { type: 'string', minLength: 1, maxLength: 50 }
  },
  required: ['roomId']
};

const validateRoom = ajv.compile(roomSchema);

server.get('/ws/chat/:roomId', {
  websocket: true,
  preValidation: (request, reply) => {
    const valid = validateRoom({ roomId: request.params.roomId });
    if (!valid) {
      throw new Error('Parâmetros inválidos');
    }
  }
}, (connection, request) => {
  // Parâmetros validados
});
```

---

## @fastify/websocket vs ws: Diferenças

### Comparação Detalhada

| Aspecto | @fastify/websocket | ws (standalone) |
|---------|-------------------|-----------------|
| **Integração** | Plugin nativo do Fastify, usa mesma porta HTTP/WS | Servidor separado ou `noServer` |
| **Roteamento** | Suporte nativo a rotas e parâmetros (`/ws/:id`) | Gerenciamento manual de `upgrade` |
| **Hooks** | Usa hooks do Fastify (onRequest, preValidation, etc.) | Handlers manuais de eventos |
| **Validação** | Integração com Fastify validation (ajv, zod) | Validação manual |
| **Error Handling** | Erros antes da conexão usam fastify error handlers | Erros tratados manualmente |
| **TypeScript** | Tipos completos incluídos | Tipos自独立 |
| **Porta** |单一端口 (HTTP + WS) | 需要单独端口或共享 |
| **Middleware** | Usa todo ecossistema Fastify (plugins, hooks) | Sem middleware integrado |

### Uso Direto do `ws`

```typescript
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

// Handshake manual
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  // ...
});
```

### Uso com `@fastify/websocket`

```typescript
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';

const server = Fastify();

await server.register(fastifyWebSocket);

// Simples: routing automático
server.get('/ws/:room', { websocket: true }, (ws, request) => {
  const { room } = request.params;
  // ...
});

// Ouvir em mesma porta HTTP
await server.listen({ port: 3000 });
```

---

## Streaming Binário via WebSocket

### 1. Configurando para Streaming Binário

O `@fastify/websocket` usa `ws` por baixo, que suporta binary types:

```typescript
// Tipo binário padrão: 'nodebuffer' (Buffer do Node.js)
// Alternativas: 'arraybuffer', 'blob', 'fragments'

server.get('/ws/stream', { websocket: true }, (connection, request) => {
  // Configurar tipo binário (opcional)
  connection.binaryType = 'nodebuffer'; // Padrão
});

// Recebendo dados binários
connection.on('message', (message: Buffer | string, isBinary: boolean) => {
  if (isBinary) {
    // Processar buffer binário
    const buffer = message as Buffer;
    processFrame(buffer); // Ex: frame de vídeo
  }
});
```

### 2. Streaming de Frames (Exemplo: Vídeo/Imagem)

```typescript
import { createInterface } from 'readline';

class FrameStreamer {
  private connections = new Set<WebSocket>();
  private isStreaming = false;
  private frameInterval?: NodeJS.Timeout;

  startBroadcast() {
    this.isStreaming = true;
    this.frameInterval = setInterval(() => {
      this.broadcastFrame();
    }, 33); // ~30 FPS
  }

  stopBroadcast() {
    this.isStreaming = false;
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
    }
  }

  private async broadcastFrame() {
    if (!this.isStreaming) return;

    // Simular captura de frame
    const frame = await this.captureFrame();

    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        // Enviar como buffer binário
        ws.send(frame.buffer, { binary: true });

        // Ou enviar com metadados
        // ws.send(JSON.stringify({
        //   type: 'frame',
        //   timestamp: Date.now(),
        //   width: frame.width,
        //   height: frame.height,
        //   data: frame.buffer
        // }));
      }
    }
  }

  private async captureFrame(): Promise<{ buffer: Buffer; width: number; height: number }> {
    // Implementar captura real (ex: puppeteer screenshot, câmera, etc.)
    return {
      buffer: Buffer.from('fake-frame-data'),
      width: 1920,
      height: 1080
    };
  }
}

const streamer = new FrameStreamer();

server.get('/ws/stream', { websocket: true }, (connection, request) => {
  streamer.addConnection(connection);

  connection.on('close', () => {
    streamer.removeConnection(connection);
  });
});
```

### 3. Usando Streams do Node.js com WebSocket

```typescript
import { pipeline } from 'stream';
import { createWebSocketStream } from 'ws';

server.get('/ws/pipeline', { websocket: true }, (connection, request) => {
  // Criar stream duplex a partir do WebSocket
  const wsStream = createWebSocketStream(connection, {
    // Opções: binary, objectMode, etc.
    binary: true
  });

  // Exemplo: pipeline de processamento
  const source = getReadableStream(); // Readable stream
  const transformer = new TransformStream(); // Transform stream

  pipeline(
    source,
    transformer,
    wsStream,
    (err) => {
      if (err) {
        console.error('Pipeline falhou:', err);
      }
    }
  );

  // Receber dados do cliente como stream
  wsStream.on('data', (chunk: Buffer) => {
    processChunk(chunk);
  });
});
```

### 4. Backpressure e Performance

⚠️ **Importante:** Ao usar streams, evite backpressure:

```typescript
// ❌ RUIM: Não trate backpressure
connection.on('message', (data) => {
  process(data); // Pode travar se processo for lento
});

// ✅ BOM: Use queue/backpressure
const queue: Buffer[] = [];
let isProcessing = false;

connection.on('message', (data: Buffer) => {
  queue.push(data);
  if (!isProcessing) {
    processQueue();
  }
});

async function processQueue() {
  isProcessing = true;
  while (queue.length > 0) {
    const chunk = queue.shift();
    await process(chunk); // Processamento assíncrono
  }
  isProcessing = false;
}
```

### 5. Otimizações de Performance

```typescript
// bufferutil (C++ addon) - máscara/unmáscara rápida
// Instale: npm install bufferutil
// O ws usa automaticamente se disponível

// utf-8-validate - validação UTF-8 eficiente
// Instale: npm install utf-8-validate

// Desabilitar compression para baixa latência:
const wss = new WebSocketServer({
  // No @fastify/websocket, configure no ws global
  // server.register(fastifyWebSocket, { maxPayload: 1024 * 1024 })
});

// Ajustar limites de payload
server.register(fastifyWebSocket, {
  maxPayload: 16 * 1024 * 1024, // 16MB
  verifyClient: (info) => {
    // Validação customizada
    return true;
  }
});
```

---

## Performance Comparativa

### Benchmark: @fastify/websocket vs ws standalone

O `@fastify/websocket` usa `ws` internamente, então a performance é essencialmente a mesma com pequena overhead de routing.

#### Teste de Concorrência (exemplo teórico)

```typescript
// Benchmarks aproximados (baseado em literatura):
// - ws puro: ~100k conexões/s (sem overhead de routing)
// - @fastify/websocket: ~95k conexões/s (overhead ~5%)
// Diferença negligenciável para maioria dos casos

console.log('Recomendação: Use @fastify/websocket');
console.log('- Performance similar (+/- 5%)');
console.log('- Routing automático');
console.log('- Integração com Fastify (plugins, validation, etc.)');
console.log('- Mesma porta HTTP/WS');
console.log('- TypeScript ready');
```

### Teste Prático de Performance

```typescript
import { performance } from 'perf_hooks';

async function benchmarkWebSocket() {
  const iterations = 10000;
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    // Simular handshake WebSocket
    await simulateHandshake();
  }

  const end = performance.now();
  console.log(`Média: ${(end - start) / iterations}ms por conexão`);
}
```

#### Otimizações Recomendadas

1. **Use `bufferutil`** (se disponível) para operações de masking/unmasking
2. **Evite `permessage-deflate`** se low-latency for crítico
3. **Ajuste `maxPayload`** conforme necessidade (default: 100MB no ws)
4. **Gerencie conexões** com Set/Map para O(1) lookup
5. **Cluster mode** (Node.js cluster) para multi-core

---

## Migrando de Express+ws para Fastify

### Estrutura Atual (Express + ws)

```typescript
// ❌ ANTES: Express + ws separado
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  // Lógica WebSocket
});

app.use(express.json());
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok' });
});

server.listen(3000);
```

### Nova Estrutura (Fastify + @fastify/websocket)

```typescript
// ✅ DEPOIS: Fastify integrado
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';

const server = Fastify({
  // Opções Fastify
  logger: true,
  disableRequestLogging: false
});

// Registrar plugin WebSocket (ANTES das rotas)
await server.register(fastifyWebSocket);

// Rotas HTTP normais (mesma porta!)
server.get('/api/status', async (request, reply) => {
  return { status: 'ok' };
});

// Rotas WebSocket (integrado ao routing)
server.get('/ws', { websocket: true }, (connection, request) => {
  // Lógica WebSocket
});

// Validação automática em rotas WS
server.get('/ws/chat/:roomId', {
  websocket: true,
  schema: {
    params: {
      type: 'object',
      properties: {
        roomId: { type: 'string' }
      }
    }
  }
}, (connection, request) => {
  const { roomId } = request.params;
  connection.send(JSON.stringify({ roomId }));
});

await server.listen({ port: 3000 });
```

### Migração Passo a Passo

1. **Instalar dependências**

```bash
npm uninstall express ws
npm install fastify @fastify/websocket
npm install -D @types/ws
```

2. **Converter arquivo principal**

```diff
- import express from 'express';
- import { createServer } from 'http';
- import { WebSocketServer } from 'ws';

+ import Fastify from 'fastify';
+ import fastifyWebSocket from '@fastify/websocket';

- const app = express();
- const server = createServer(app);
- const wss = new WebSocketServer({ noServer: true });

+ const server = Fastify();

- server.on('upgrade', (request, socket, head) => {
-   wss.handleUpgrade(request, socket, head, (ws) => {
-     wss.emit('connection', ws, request);
-   });
- });

+ await server.register(fastifyWebSocket);

- wss.on('connection', (ws, request) => { ... });

+ server.get('/ws', { websocket: true }, (connection, request) => { ... });

- app.use(express.json());
+ // Fastify já parseia JSON automaticamente

- app.get('/api/hello', (req, res) => {
-   res.json({ message: 'Hello' });
- });

+ server.get('/api/hello', async (req, reply) => {
+   return { message: 'Hello' };
+ });

- server.listen(3000);
+ await server.listen({ port: 3000 });
```

3. **Atualizar middlewares**

```typescript
// Express middleware → Fastify hooks/decorators

// Antes (Express):
// app.use(authMiddleware);

// Depois (Fastify):
server.addHook('preHandler', async (request, reply) => {
  // auth logic
  if (!request.headers.authorization) {
    throw new Error('Unauthorized');
  }
});

// Ou por rota:
server.get('/protected', {
  onRequest: [authMiddleware]
}, handler);
```

4. **Atualizar tratamento de erros**

```typescript
// Express: next(err) ou res.status(500)
// Fastify: throw ou reply.code(500)

server.setErrorHandler((error, request, reply) => {
  reply.status(500).send({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});
```

5. **Manter conexões ativas**

```diff
- const connections = new Set<WebSocket>();

+ // Com Fastify, gerenciamento manual ainda necessário
+ const connections = new Set<WebSocket>();

server.get('/ws', { websocket: true }, (connection, request) => {
  connections.add(connection);
  connection.on('close', () => connections.delete(connection));
});
```

---

## Vantagens do Fastify

### 1. Plugin Ecosystem

```typescript
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';

// Todos os plugins funcionam com rotas WebSocket!
await server.register(fastifyCors);
await server.register(fastifyRateLimit, { max: 100, timeWindow: '1 minute' });
await server.register(fastifyJwt, { secret: 'secret' });
```

### 2. Schema Validation (JSON Schema / TypeScript)

```typescript
import Fastify from 'fastify';

const server = Fastify();

// Validação automática de request/response
server.get('/api/users/:id', {
  schema: {
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' }
      },
      required: ['id']
    },
    response: {
      200: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' }
        }
      }
    }
  }
}, async (request, reply) => {
  // request.params já validado!
  return { id: request.params.id, name: 'User' };
});

// Validação em rotas WebSocket (antes da conexão)
server.get('/ws/:roomId', {
  websocket: true,
  schema: {
    params: {
      type: 'object',
      properties: {
        roomId: { type: 'string', minLength: 1 }
      },
      required: ['roomId']
    }
  }
}, (connection, request) => {
  // Parâmetros garantidamente válidos
  const roomId = request.params.roomId; // type: string
});
```

### 3. Swagger/OpenAPI Integration

```typescript
import fastifySwagger from '@fastify/swagger';

await server.register(fastifySwagger, {
  exposeRoute: true,
  swagger: {
    info: {
      title: 'API de Streaming',
      version: '1.0.0'
    },
    schemes: ['ws', 'http', 'https'],
    consumes: ['application/json', 'application/octet-stream'],
    produces: ['application/json', 'application/octet-stream']
  }
});

// Documentação disponível em: http://localhost:3000/documentation
```

### 4. TypeScript First

```typescript
// Tipos completos incluídos no Fastify
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

server.get('/api/data', async (request: FastifyRequest, reply: FastifyReply) => {
  // Autocomplete completo
  request.query // tipado
  request.params // tipado
  request.body // tipado

  reply.send(data); // validação de tipo
});

// Decorators tipados
server.decorate('users', new Map());
server.decorateReply('streamResponse', function (data) {
  this.header('Content-Type', 'application/octet-stream');
  this.send(data);
});
```

### 5. Performance Superior

- **Encapsulamento zero-overhead** (menos abstração)
- **Schema validation fast** (ajv ultra-rápido)
- **Low latency** (menor overhead que Express/Koa)
- **Auto-content-type parsing** (JSON, protobuf, etc.)
- **Reusable schemas** (referências externas)

```typescript
// Fastify processa ~30% mais requests que Express
// Benchmark: https://www.fastify.io/benchmarks/
```

### 6. Request/Reply Lifecycle

```typescript
// Ciclo completo de hooks:
server.addHook('onRequest', async (req, reply) => {
  // Antes de parse do body
  console.log('Recebendo request:', req.method, req.url);
});

server.addHook('preValidation', async (req, reply) => {
  // Antes da validação de schema
});

server.addHook('preHandler', async (req, reply) => {
  // Antes do handler (autenticação, etc.)
  if (!req.headers.authorization) {
    reply.code(401);
    throw new Error('Unauthorized');
  }
});

server.addHook('postHandler', async (req, reply) => {
  // Depois do handler, antes de serialização
});

server.addHook('onResponse', async (req, reply) => {
  // Depois de tudo (logging, etc.)
});
```

### 7. Logging Estruturado

```typescript
const server = Fastify({
  logger: {
    level: 'info',
    prettyPrint: process.env.NODE_ENV !== 'production'
  }
});

// Log automático de requests WebSocket/HTTP
server.get('/api/data', async (req, reply) => {
  server.log.info('Processando request', { userId: req.user?.id });
  return { data: 'ok' };
});
```

### 8. Error Handling Robusto

```typescript
// Error handler customizado
server.setErrorHandler((error, request, reply) => {
  server.log.error(error);

  // Automático para erros de validação
  if (error.validation) {
    reply.status(400).send({
      error: 'Validation Error',
      details: error.validation
    });
    return;
  }

  reply.status(500).send({
    error: 'Internal Server Error'
  });
});

// Erros em WebSocket ainda precisam try/catch manual:
server.get('/ws', { websocket: true }, (connection, request) => {
  connection.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      connection.send(JSON.stringify({ result: process(data) }));
    } catch (err) {
      connection.send(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
});
```

---

## Exemplo Completo: Servidor de Streaming

### Servidor Fastify com WebSocket para Streaming de Frames

```typescript
// server.ts
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { WebSocket } from 'ws';

interface StreamFrame {
  timestamp: number;
  width: number;
  height: number;
  format: string; // 'jpeg', 'png', 'webp', 'raw'
  buffer: Buffer;
  metadata?: {
    fps: number;
    quality: number;
    cameraId: string;
  };
}

interface ClientConnection {
  socket: WebSocket;
  userId?: string;
  streamId: string;
  connectedAt: Date;
  stats: {
    framesReceived: number;
    bytesReceived: number;
    lastFrameAt: Date | null;
  };
}

class BroadcastingStreamer {
  private streams = new Map<string, Set<ClientConnection>>();
  private activeCapture = new Map<string, NodeJS.Timeout>();

  // Registrar cliente em um stream
  joinStream(streamId: string, client: ClientConnection): void {
    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, new Set());
    }
    this.streams.get(streamId)!.add(client);
    this.startCapture(streamId);
  }

  // Remover cliente
  leaveStream(streamId: string, client: ClientConnection): void {
    const clients = this.streams.get(streamId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) {
        this.stopCapture(streamId);
      }
    }
  }

  // Iniciar captura do stream (simulado)
  private startCapture(streamId: string): void {
    if (this.activeCapture.has(streamId)) return;

    const interval = setInterval(async () => {
      const clients = this.streams.get(streamId);
      if (!clients || clients.size === 0) {
        this.stopCapture(streamId);
        return;
      }

      // Simular captura de frame
      const frame = await this.captureFrame(streamId);

      // Broadcast para todos os clientes
      for (const client of clients) {
        if (client.socket.readyState === WebSocket.OPEN) {
          this.sendFrame(client.socket, frame);
          client.stats.framesReceived++;
          client.stats.bytesReceived += frame.buffer.length;
          client.stats.lastFrameAt = new Date();
        }
      }
    }, 33); // ~30 FPS

    this.activeCapture.set(streamId, interval);
  }

  private stopCapture(streamId: string): void {
    const interval = this.activeCapture.get(streamId);
    if (interval) {
      clearInterval(interval);
      this.activeCapture.delete(streamId);
    }
  }

  private async captureFrame(streamId: string): Promise<StreamFrame> {
    // Aqui implementar captura real:
    // - Screenshot (puppeteer, playwright)
    // - Câmera (media devices)
    // - Vídeo file (ffmpeg)
    // - Stream RTSP

    return {
      timestamp: Date.now(),
      width: 1920,
      height: 1080,
      format: 'jpeg',
      buffer: Buffer.from('frame-data-placeholder'),
      metadata: {
        fps: 30,
        quality: 90,
        cameraId: streamId
      }
    };
  }

  private sendFrame(socket: WebSocket, frame: StreamFrame): void {
    // Opção 1: JSON com buffer base64 (mais compatível)
    // socket.send(JSON.stringify({
    //   type: 'frame',
    //   ...frame,
    //   buffer: frame.buffer.toString('base64')
    // }));

    // Opção 2: Buffer binário direto (mais eficiente)
    socket.send(frame.buffer, { binary: true });

    // Opção 3: Header binário + payload
    // const header = Buffer.alloc(16);
    // header.writeUInt32BE(frame.timestamp, 0);
    // header.writeUInt16BE(frame.width, 4);
    // header.writeUInt16BE(frame.height, 6);
    // header.writeUInt8(frame.format.charCodeAt(0), 8);
    // socket.send(Buffer.concat([header, frame.buffer]));
  }
}

const streamer = new BroadcastingStreamer();

// Criar servidor Fastify
const server = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty'
    }
  }
});

// Registrar plugins
await server.register(fastifyCors);
await server.register(fastifyWebSocket, {
  maxPayload: 16 * 1024 * 1024 // 16MB max por frame
});
await server.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'secret-key'
});

// Middleware de autenticação
server.addHook('preHandler', async (request, reply) => {
  if (request.url?.startsWith('/ws')) {
    const token = request.headers.authorization?.split(' ')[1];
    if (!token) {
      throw new Error('Token não fornecido');
    }
    try {
      const decoded = await server.jwt.verify(token);
      request.user = decoded;
    } catch (err) {
      reply.code(401);
      throw new Error('Token inválido');
    }
  }
});

// Schema de validação para query params
const streamSchema = {
  querystring: {
    type: 'object',
    properties: {
      quality: { type: 'string', enum: ['low', 'medium', 'high'] },
      fps: { type: 'number', minimum: 1, maximum: 60 }
    }
  }
};

// Rota principal de streaming
server.get('/ws/stream/:streamId', {
  websocket: true,
  schema: streamSchema
}, (connection, request) => {
  const { streamId } = request.params as { streamId: string };
  const { quality = 'high', fps = 30 } = request.query as {
    quality?: string;
    fps?: number;
  };

  const client: ClientConnection = {
    socket: connection,
    userId: request.user?.id as string,
    streamId,
    connectedAt: new Date(),
    stats: {
      framesReceived: 0,
      bytesReceived: 0,
      lastFrameAt: null
    }
  };

  server.log.info('Cliente conectado ao stream', {
    streamId,
    userId: client.userId,
    quality,
    fps
  });

  // Registrar cliente
  streamer.joinStream(streamId, client);

  // Handshake inicial
  connection.send(JSON.stringify({
    type: 'handshake',
    streamId,
    config: { quality, fps },
    serverTime: Date.now()
  }));

  // Receber comandos do cliente
  connection.on('message', (message: Buffer | string) => {
    try {
      const command = JSON.parse(message.toString());

      switch (command.action) {
        case 'ping':
          connection.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;

        case 'stats':
          connection.send(JSON.stringify({
            type: 'stats',
            data: client.stats
          }));
          break;

        case 'change-quality':
          client.stats; // TODO: mudar qualidade
          break;

        default:
          server.log.warn('Comando desconhecido', { command });
      }
    } catch (err) {
      server.log.error('Erro ao processar mensagem', { err });
    }
  });

  connection.on('close', (code, reason) => {
    server.log.info('Cliente desconectado', {
      streamId,
      userId: client.userId,
      code,
      reason: reason.toString(),
      stats: client.stats
    });
    streamer.leaveStream(streamId, client);
  });

  connection.on('error', (error) => {
    server.log.error('Erro WebSocket', {
      streamId,
      userId: client.userId,
      error: error.message
    });
  });
});

// Health check HTTP
server.get('/health', async (request, reply) => {
  const activeStreams = Array.from(streamer['streams'].keys());

  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeStreams,
    connections: activeStreams.reduce((acc, streamId) => {
      acc[streamId] = streamer['streams'].get(streamId)?.size || 0;
      return acc;
    }, {} as Record<string, number>)
  };
});

// Metrics endpoint
server.get('/metrics', async (request, reply) => {
  // TODO: implementar métricas Prometheus
  return {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: Array.from(streamer['streams'].values())
      .reduce((acc, set) => acc + set.size, 0)
  };
});

// Error handler global
server.setErrorHandler((error, request, reply) => {
  server.log.error(error);
  reply.status(500).send({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// Start server
const start = async () => {
  try {
    await server.listen({ port: 3000, host: '0.0.0.0' });
    server.log.info(`Servidor rodando em http://localhost:3000`);
    server.log.info(`WebSocket disponível em ws://localhost:3000/ws/stream/:streamId`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  server.log.info('SIGTERM recebido, encerrando...');
  await server.close();
  process.exit(0);
});
```

### Cliente Web (TypeScript)

```typescript
// client.ts
class StreamClient {
  private ws: WebSocket | null = null;
  private streamId: string;
  private onFrameCallback?: (frame: Buffer) => void;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

  connect(token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:3000/ws/stream/${this.streamId}?quality=high&fps=30`;
      const headers: Record<string, string> = {};

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      this.ws = new WebSocket(url, undefined, { headers });

      this.ws.onopen = () => {
        console.log('Conectado ao stream');
        resolve();
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          // Browser: Blob binary
          event.data.arrayBuffer().then((buffer) => {
            this.onFrameCallback?.(Buffer.from(buffer));
          });
        } else if (event.data instanceof ArrayBuffer) {
          // Node.js ou browser direct
          this.onFrameCallback?.(Buffer.from(event.data));
        } else {
          // Mensagem de controle (JSON)
          try {
            const msg = JSON.parse(event.data);
            this.handleControlMessage(msg);
          } catch (err) {
            console.error('Mensagem inválida:', event.data);
          }
        }
      };

      this.ws.onerror = (error) => {
        console.error('Erro WebSocket:', error);
        reject(error);
      };

      this.ws.onclose = (code, reason) => {
        console.log('Conexão fechada:', code, reason);
      };
    });
  }

  private handleControlMessage(msg: any) {
    switch (msg.type) {
      case 'handshake':
        console.log('Handshake:', msg);
        break;
      case 'pong':
        console.log('Pong recebido:', msg.timestamp);
        break;
      case 'stats':
        console.log('Stats:', msg.data);
        break;
      default:
        console.log('Mensagem de controle:', msg);
    }
  }

  onFrame(callback: (frame: Buffer) => void) {
    this.onFrameCallback = callback;
  }

  sendCommand(action: string, data?: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, ...data }));
    }
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}

// Uso
const client = new StreamClient('camera-01');
client.connect('jwt-token-here');
client.onFrame((frame) => {
  // Processar frame (ex: exibir em canvas, salvar em arquivo)
  console.log('Frame recebido:', frame.length, 'bytes');
});
```

### Dockerfile para Produção

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

RUN npm install -g pino-pretty

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server.js"]
```

---

## Considerações Finais

### Quando Usar @fastify/websocket

✅ **Use** se:
- Já usa ou planeja usar Fastify
- Precisa de roteamento múltiplo de WebSockets
- Quer validação automática de parâmetros
- Precisa de integração com plugins (CORS, JWT, rate-limit)
- Quer mesma porta para HTTP e WebSocket
- Prefere TypeScript com tipagem completa

### Quando Evitar

❌ **Evite** se:
- Aplicação existente em Express com milhares de rotas já migradas
- Precisa de Socket.IO (rooms, fallback transports, reconnection)
- Aplicação muito simples (um único WebSocket)
- Performance extrema (overhead de routing pode importar)

### Boas Práticas

1. **Sempre registrar `fastifyWebSocket` primeiro** (antes das rotas)
2. **Usar schema validation** para parâmetros de rota WebSocket
3. **Gerenciar conexões** em Set/Map (limpar automaticamente)
4. **Implementar heartbeat/ping-pong** para detectar conexões mortas
5. **Usar binaryType apropriado** (nodebuffer para Node.js, arraybuffer para browser)
6. **Tratar backpressure** em streaming binário
7. **Implementar graceful shutdown** (fechar conexões WS)
8. **Logging estruturado** para debug de conexões
9. **Limitar payload máximo** no servidor
10. **Usar `bufferutil`** se disponível (performance)

### Referências

- [Fastify WebSocket Plugin](https://github.com/fastify/fastify-websocket)
- [Fastify Documentation](https://fastify.dev/)
- [ws Library](https://github.com/websockets/ws)
- [WebSocket RFC 6455](https://tools.ietf.org/html/rfc6455)

---

**Última atualização**: Março 2025
**Fastify Version**: 5.x
**@fastify/websocket**: 5.x
**Node.js**: 18+
