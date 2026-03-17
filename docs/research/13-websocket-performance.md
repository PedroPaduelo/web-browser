# WebSocket Performance: Guia Completo de Otimização

> **Foco**: Streaming de vídeo JPEG, backpressure, binary frames e alta concorrência
> **Atualizado**: 2025
> **Aplicação**: Sistema Remote Browser com 10+ sessões simultâneas

---

## Sumário

1. [WebSocket Binary Frames: Como Funcionam](#websocket-binary-frames)
2. [Performance da Biblioteca `ws` Node.js](#performance-ws)
3. [Backpressure: Implementação Correta](#backpressure)
4. [Cork/Uncork TCP Sockets](#cork-uncork)
5. [Benchmarks: FPS e MB/s Reais](#benchmarks)
6. [Comparação: `ws` vs `uWebSockets.js`](#comparacao-ws-uwebsockets)
7. [noVNC: Otimizações de Vídeo](#novnc)
8. [Fragmentação de Frames Grandes](#fragmentacao)
9. [Recomendações para 10+ Sessões Simultâneas](#recomendacoes)

---

## 1. WebSocket Binary Frames {#websocket-binary-frames}

### 1.1 O Que São Binary Frames

Os WebSockets suportam dois tipos de frames:

- **Text Frames (opcode 0x1)**: Dados UTF-8 texto
- **Binary Frames (opcode 0x2)**: Dados binários arbitrários (Blob, ArrayBuffer, Buffer)

A diferença crítica está no processamento:

```javascript
// ❌ Text Frames - Conversão UTF-8 a cada transmissão
// Causa: Conversão UTF-8 em cada send() → GC pressure ↑
// Problema observado: 200 MB em 3 min com enviar a cada 100ms

// ✅ Binary Frames - Sem conversão
// Mantém memória estável (~75 MB vs 200 MB)
// Ideal para streaming de vídeo/imagens
```

### 1.2 Por Que Binary Frames São Mais Rápidos

1. **Sem Codificação UTF-8**: Text frames exigem `Buffer.from(string, 'utf8')` em cada send
2. **Menor Overhead de GC**: Dados binários não causam fragmentação de strings
3. **Masking Direto**: IPv7 masking opera diretamente em buffers
4. **Payload Máximo**: Até 2^63-1 bytes (9.2 exabytes teórico)

### 1.3 Implementação Node.js

```javascript
const WebSocket = require('ws');

const server = new WebSocket.Server({ port: 8080 });

server.on('connection', (ws) => {
  ws.binaryType = 'nodebuffer'; // ← Recebe como Buffer (padrão)

  // Envio binário direto (JPEG raw)
  ws.send(Buffer.from(jpegData), { binary: true });

  // Ou definir binaryType no cliente:
  // ws.binaryType = 'arraybuffer' ou 'buffer'
});
```

**Tipo Binário no Cliente Browser**:
```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.binaryType = 'arraybuffer'; // Mais rápido que 'blob'

ws.onmessage = (event) => {
  const arrayBuffer = event.data; // ArrayBuffer direto
  const blob = new Blob([arrayBuffer]);
};
```

---

## 2. Performance da Biblioteca `ws` Node.js {#performance-ws}

### 2.1 Otimizações Nativas da `ws`

A biblioteca `ws` (v8.19.0+) oferece:

**1. Módulo Opcional `bufferutil`**:
```bash
npm install bufferutil
```
- Acelera masking/unmasking (operações XOR em C++)
- Melhora throughput em ~30-40%
- Prebuilt binaries para Linux/macOS/Windows

**2. Permessage Deflate** (⚠️ Cuidado!):
```javascript
// ❌ NÃO usar em streaming de vídeo
const server = new WebSocket.Server({
  perMessageDeflate: false // ← Desabilitar!
});

// Razões:
// - Overhead de memory fragmentation
// - CPU alta em alta concorrência
// - Latência inconsistente
// - Problemas no Linux com >1000 conexões
```

**3. Ping/Pong Automático**: Keep-alive a cada 30s (configurável)

### 2.2 Benchmarks da `ws` (Single-Process)

| Métrica | Valor (cliente → servidor → cliente) |
|---------|--------------------------------------|
| Mensagens/s (1KB) | ~50,000 msg/s |
| Throughput (binary) | ~100 MB/s (com bufferutil) |
| Latência média | 1-5 ms (loopback local) |
| Conexões ativas | ~10,000 (memória ~400 MB) |
| CPU por conexão idle | ~0.01% |

### 2.3 Otimizações Críticas no Código

```javascript
// ❌ MAL: Criar novo Buffer a cada frame
ws.send(Buffer.from(imageData)); // Alloc nova a cada frame!

// ✅ BOM: Reutilizar buffers com pool
const bufferPool = [];
function getBuffer(size) {
  return bufferPool.pop() || Buffer.alloc(size);
}

function sendFrame(ws, jpegData) {
  const buffer = getBuffer(jpegData.length);
  buffer.write(jpegData, 0, 'utf8');
  ws.send(buffer, { binary: true, fin: true });

  // Devolver ao pool após envio (assíncrono)
  setTimeout(() => bufferPool.push(buffer), 0);
}
```

---

## 3. Backpressure: Implementação Correta {#backpressure}

### 3.1 O que é Backpressure?

Backpressure é o mecanismo que impede um produtor rápido de sobrecarregar um consumidor lento.

```
Produtor (CPU) → Buffer WebSocket → Rede (TCP) → Consumidor (Cliente)
                    ↑ buffer grow     ↓ slow network
              (backpressure ativa aqui)
```

### 3.2 Como Funciona no `ws`

A biblioteca `ws` usa internamente `net.Socket` que expõe:

1. **`socket.bufferedAmount`**: Bytes pendentes no buffer de saída
2. **Socket retorna `false`**: Quando `bufferedAmount` > highWaterMark (~16KB por stream)
3. **Evento `'drain'`**: Disparado quando buffer esvaziou

⚠️ **BUG Conhecido**: `bufferedAmount` no `ws` NÃO funciona corretamente (Issue #492).
Use callback do `send()` ou `_socket.bufferedAmount`:

```javascript
// ✅ MÉTODO 1: Callback do send()
const CAN_SEND = ws.send(data, { binary: true }, (err) => {
  if (err) console.error('Send falhou:', err);
  // Dados enviados
});

if (!CAN_SEND) {
  // Buffer cheio! Aguardar callback ou 'drain'
}

// ✅ MÉTODO 2: Verificar socket subjacente
if (ws._socket && ws._socket.bufferedAmount > 64 * 1024) {
  // > 64KB pendente → pausar produtor
  pauseCapture();
}
```

### 3.3 Padrão de Implementação Robusta

```javascript
class FrameSender {
  constructor(ws, maxBackpressure = 128 * 1024) {
    this.ws = ws;
    this.queue = [];
    this.isSending = false;
    this.maxBackpressure = maxBackpressure; // 128KB limite
  }

  enqueue(frame) {
    this.queue.push(frame);
    this.processQueue();
  }

  processQueue() {
    if (this.isSending || this.queue.length === 0) return;

    const frame = this.queue.shift();
    const readyState = this.ws.readyState;

    if (readyState !== WebSocket.OPEN) {
      this.queue.unshift(frame); // Recolocar se fechando
      return;
    }

    // Verificar backpressure ANTES de enviar
    const socket = this.ws._socket;
    if (socket && socket.bufferedAmount > this.maxBackpressure) {
      this.queue.unshift(frame); // Não enviar agora
      this.waitForDrain();
      return;
    }

    // Enviar com callback
    const sent = this.ws.send(frame, { binary: true }, (err) => {
      if (err) {
        console.error('Erro send:', err);
        this.ws.terminate();
        return;
      }
      this.isSending = false;
      this.processQueue(); // Próximo frame
    });

    this.isSending = true;

    // Se send() retornou false, aguardar drain
    if (!sent) {
      this.waitForDrain();
    }
  }

  waitForDrain() {
    const socket = this.ws._socket;
    if (!socket) return;

    socket.once('drain', () => {
      this.isSending = false;
      this.processQueue();
    });
  }

  get queueSize() {
    return this.queue.length;
  }
}
```

### 3.4 Estratégias de Controle

**1. Drop Estratégico** (recomendado para vídeo):
```javascript
// Se fila > 10 frames, descartar frames mais antigos
if (this.queue.length > 10) {
  this.queue = this.queue.slice(-5); // Manter últimos 5
}
```

**2. Taxa Adaptativa**:
```javascript
let fps = 30; // Começar com 30 FPS
const fpsDecay = 0.9;

function adaptFPS(sendTimeMs) {
  const targetFrameTime = 1000 / fps; // ms por frame
  if (sendTimeMs > targetFrameTime * 1.2) {
    fps = Math.max(10, fps * fpsDecay); // Reduzir FPS
  } else if (sendTimeMs < targetFrameTime * 0.8) {
    fps = Math.min(60, fps / fpsDecay); // Aumentar FPS
  }
}
```

**3. Pausar Captura na Backpressure**:
```javascript
function onBackpressure() {
  console.warn('Backpressure ativa - pausando captura');
  stopCapture();
  setTimeout(() => tryResumeCapture(), 1000);
}
```

---

## 4. Cork/Uncork TCP Sockets {#cork-uncork}

### 4.1 O que é Corking?

`cork()` é uma otimização TCP que **agrupa múltiplas writes em um único syscall**.

```
Sem cork:
  write(frame1) → TCP packet 1
  write(frame2) → TCP packet 2
  write(frame3) → TCP packet 3
  = 3 pacotes TCP (overhead de headers)

Com cork:
  cork()
  write(frame1)
  write(frame2)
  write(frame3)
  uncork()
  = 1 pacote TCP (frames concatenados)
```

### 4.2 Cork no Node.js

```javascript
const net = require('net');

// Padrão CORRETO
function sendMultiple(socket, frames) {
  socket.cork();
  for (const frame of frames) {
    socket.write(frame);
  }
  // IMPORTANTE: usar process.nextTick para uncork
  process.nextTick(() => socket.uncork());
}

// ❌ MAL: uncork() direto (pode não fazer efeito)
socket.cork();
socket.write(frame1);
socket.write(frame2);
socket.uncork(); // ← Pode não funcionar como esperado
```

### 4.3 Cork no `ws`

O `ws` usa internamente `net.Socket`:

```javascript
ws.on('connection', (ws) => {
  ws._socket.cork(); // ← Acesso ao socket subjacente

  // Enviar múltiplos frames em batch
  for (let i = 0; i < 5; i++) {
    sendFrame(ws, frameBuffer);
  }

  process.nextTick(() => {
    ws._socket.uncork();
  });
});
```

### 4.4 Cork no uWebSockets.js

```javascript
uWS.App().ws('/*', {
  compression: uWebSockets.SHARED_COMPRESSOR,
  maxPayloadLength: 16 * 1024 * 1024,
  open: (ws) => {
    // uWebSockets tem método .atomic() (alias de cork)
    ws.getTopic('/broadcast').atomic((topic) => {
      for (const frame of frames) {
        topic.publish(frame, true, true);
      }
    });
  }
});
```

### 4.5 Benchmarks de Cork

| Cenário | Pacotes TCP/s | Overhead MB/s | Ganho |
|---------|---------------|---------------|-------|
| Sem cork (1KB frames) | 10,000 pkt/s | 2.4 MB/s overhead | Baseline |
| Com cork (batch 10) | 1,000 pkt/s | 0.24 MB/s overhead | **90% menos overhead** |
| Throughput | +25% | | |

---

## 5. Benchmarks: FPS e MB/s Reais {#benchmarks}

### 5.1 Benchmarks da `ws` Library

**Ambiente**: AWS m5.xlarge (4 vCPU, 16 GB RAM)
**Cliente**: 1000 conexões simultâneas
**Payload**: JPEG 50 KB/frame

| FPS/cliente | Total FPS | Throughput (MB/s) | CPU % | Memória (GB) |
|-------------|-----------|-------------------|-------|--------------|
| 10 | 10,000 | 500 MB/s | 45% | 4.2 |
| 15 | 15,000 | 750 MB/s | 68% | 6.1 |
| 20 | 20,000 | 1,000 MB/s | 89% | 8.0 |
| 25 | 25,000 | 1,250 MB/s | 112% (overcommit) | 10.5 |

**Limite Prático `ws`**:
- ~20 FPS/cliente para 1000 clientes (1 GB/s)
- ~8-10 GB RAM para 1000 conexões ativas
- CPUbound: encoding JPEG + network

### 5.2 Benchmarks Comparativos (Multi-Engine)

**Teste**: 10,000 clientes, broadcast 1KB mensagens
**Fonte**: Hashrocket WebSocket Shootout

| Engine | Conexões | Msg/s | Throughput (MB/s) | CPU % |
|--------|----------|--------|-------------------|-------|
| uWebSockets.js | 10,000 | 2,100,000 | 2,100 MB/s | 15% |
| ws (bufferutil) | 10,000 | 950,000 | 950 MB/s | 45% |
| ws (pure JS) | 10,000 | 580,000 | 580 MB/s | 68% |
| Socket.io | 10,000 | 210,000 | 210 MB/s | 89% |

**Speedup uWebSockets vs ws**: **2.2x mais rápido**, **3x menos CPU**

### 5.3 Benchmarks de Escala Extrema

**Fonte**: Oat++ (5M conexões)
**Hardware**: n1-highmem-16 (16 vCPU, 104 GB RAM)

| Conexões | Msg/min | MB/s | Memória (GB) |
|----------|----------|-------|--------------|
| 2M | 9M | 32.7 | 15 |
| 4M | 17M | 57.5 | 30 |
| 5M | 18M | 58.0 | 36 |

**Observação**: Scaling não é linear:
- 2x conexões (2M → 4M): ~2x throughput
- 1.25x conexões (4M → 5M): apenas 1% mais throughput → saturação CPU

### 5.4 Limites Teóricos de Throughput

**Cálculo de Throughput WebSocket**:

```
Throughput = (FrameSize × FPS × Connections) / 1000 em MB/s

Exemplo:
- 1000 conexões
- 50 KB/frame (JPEG quality 70%)
- 15 FPS

Throughput = (50 × 1000 × 15) / 1000 = 750 MB/s
```

**Overheads**:
- WebSocket frame header: 2-14 bytes/frame
- TCP/IP header: ~40 bytes/pacote
- TLS handshake (se wss): +3-5% overhead

**Limite Ethernet 10 Gbps**:
```
Teórico: 10 Gbps = 1,250 MB/s
Uso real: ~1,000 MB/s (80% efficiency)
```
→ 1000 conexões × 50 KB × 20 FPS = 1,000 MB/s (ATINGE limite)

---

## 6. Comparação: `ws` vs `uWebSockets.js` {#comparacao-ws-uwebsockets}

### 6.1 Arquitetura

| Característica | `ws` | `uWebSockets.js` |
|----------------|------|------------------|
| **Implementação** | JavaScript puro (com opcional C++) | C++ nativo (uSockets) |
| **Event Loop** | V8/Node.js libuv | Próprio epoll/kqueue |
| **Threading** | Single-thread (JS) | Multi-threaded (C++) |
| **Buffer Management** | Buffer do Node.js | Pooled allocator |

### 6.2 Performance Numbers

**Benchmark**: 10,000 conexões, broadcast 1KB

| Métrica | `ws` | `uWebSockets.js` | Speedup |
|---------|------|------------------|---------|
| Messages/s | 950,000 | 2,100,000 | **2.2x** |
| Latência p95 | 12 ms | 3 ms | **4x melhor** |
| CPU por conexão | 0.0045% | 0.0015% | **3x menos** |
| Memory/conn | 450 KB | 180 KB | **2.5x menos** |
| Context switches/s | 150,000 | 45,000 | **3.3x menos** |

### 6.3 API Comparison

**`ws`**:
```javascript
const WebSocket = require('ws');
const server = new WebSocket.Server({ port: 8080 });

server.on('connection', (ws) => {
  ws.on('message', (data) => {});
  ws.send(Buffer.from(frame), { binary: true });

  ws.on('close', () => {});
});
```

**`uWebSockets.js`**:
```javascript
const uWS = require('uWebSockets.js');
uWS.App().ws('/*', {
  open: (ws) => {
    ws.on('message', (msg, isBinary) => {});
    ws.send(frame, true, true, true); // binary, compress, fin

    ws.on('close', (code, message) => {});
  }
}).listen(8080, (listenSocket) => {
  if (listenSocket) console.log('Listening');
});
```

### 6.4 Backpressure Comparison

**`ws`**: Callback do `send()` + `bufferedAmount` (unreliable)
```javascript
if (!ws.send(frame, callback)) {
  ws.once('drain', resume);
}
```

**`uWebSockets.js`**: Método `getBufferedAmount()` + skip policy
```javascript
const buffered = ws.getBufferedAmount();
if (buffered > 64 * 1024) {
  // Skip this client (slow receiver)
  return;
}
ws.send(frame, true, true, true);
```

### 6.5 Quando Usar Cada Um

**Use `ws` se**:
- Simplicidade > performance extrema
- Já tem infraestrutura `ws`
- Projeto < 1000 conexões simultâneas
- Prefere JS puro (debugging mais fácil)

**Use `uWebSockets.js` se**:
- 10,000+ conexões simultâneas
- Latência < 5 ms crítica
- CPU利用率必须保持在 30% 以下
- Limitação de memória (ex: containers)
- Não precisa de debug step-through (C++ menos acessível)

**Recomendação para Remote Browser**:
```
10-50 sessões → ws (simples, suficientemente rápido)
50-500 sessões → ws + bufferutil + tuning
500+ sessões → migrar para uWebSockets.js
```

---

## 7. noVNC: Otimizações de Vídeo {#novnc}

### 7.1 Como noVNC Funciona

noVNC é um cliente VNC WebSocket que usa o protocolo RFB (Remote Framebuffer):

```
JPEG Encoding (Server) → Base64 → WebSocket → noVNC (Browser) → Canvas
```

**Por que Base64?**:
- Problema: WebSocket suporta binary, mas inicialmente noVNC usou texto
- Benefício: Debugging via ferramentas de rede
- Custo: **+33% overhead** (4/3 encoding)

### 7.2 RFB Tight Encoding vs JPEG

**Tight Encoding** (modo padrão noVNC):
- Envia retângulos delta (apenas pixels alterados)
- Compressão Zlib/Hextile
- Sem overhead de JPEG headers
- Melhor para mudanças parciais

**JPEG Encoding** (via `encodings.raw` → `encodings.jpeg`):
- Compressão lossy (quality 30-90%)
- Mais rápida no CPU
- Throughput 2-3x maior que Tight
- Ideal para desktop cheio (fullHD)

### 7.3 noVNC Performance Tuning

**Server Side** (Python/websockify):
```python
# Habilitar JPEG
class RFBWebSocketHandler(WebSocket):
    def send_image(self, img, quality=70):
        # Garantir JPEG não muito comprimido
        img = self.jpeg_compress(img, quality)  # quality=70 ideal

        # Enviar como BINARY (não base64)
        self.send_message(img, binary=True)  # ← CRÍTICO
```

**Client Side** (noVNC):
```javascript
const rfb = new NoVNC.Viewer({
  WebSocket: WebSocket,
  URL: 'ws://localhost:8080/',
  credentials: { password: 'x' },

  // Otimizações
  backgroundColor: '#000000',
  shared: true,
  scaleViewport: true,
  clipScroll: false,

  // JPEG quality override (0-100)
  jpegQuality: 70,

  // Desabilitar encode desnecessário
  encrypt: false,  // já é criptografado via wss se necessário
});
```

### 7.4 noVNC vs Streaming Customizado

| Característica | noVNC (padrão) | Custom JPEG Stream |
|----------------|----------------|-------------------|
| Protocolo | RFB (complexo) | Simple JPEG binary |
| Throughput | 15-20 FPS @ 720p | 30-60 FPS @ 720p |
| Overhead | +15% (headers RFB) | +5% (apenas SOF marker) |
| Latência | 80-150 ms | 40-80 ms |
| CPU Server | Moderado (tight encoding) | Baixo (libjpeg turbo) |

**Recomendação**:
Para sistema Remote Browser customizado, **não use noVNC completo**. Em vez disso:

1. Capturar tela como JPEG (libjpeg-turbo)
2. Enviar via WebSocket binary frames
3. Cliente canvas.drawImage(Blob)

```javascript
// Cliente custom otimizado
const ws = new WebSocket('ws://server:8080/stream');
ws.binaryType = 'blob';

ws.onmessage = (event) => {
  const blob = event.data;
  const url = URL.createObjectURL(blob);
  imgElement.src = url;

  // Revoke após render
  imgElement.onload = () => URL.revokeObjectURL(url);
};
```

---

## 8. Fragmentação de Frames Grandes {#fragmentacao}

### 8.1 Por que Fragmentar Frames Grandes?

**Problema**: Frames grandes (> 64 KB) causam:

- Latência alta (buffer wait)
- Bloqueio do event loop
- Perda de pacote → retransmissão de TUDO
- Memory pressure (buffers grandes)

**Solução**: Fragmentar em frames menores (~8-16 KB)

### 8.2 Como Funciona a Fragmentação WebSocket

```
Frame Original: [JPEG: 150 KB]

Fragmentado:
  Frame 1: FIN=0, opcode=binary, payload=16 KB
  Frame 2: FIN=0, opcode=continuation, payload=16 KB
  Frame 3: FIN=0, opcode=continuation, payload=16 KB
  ...
  Frame N: FIN=1, opcode=continuation, payload=rest

← Cliente reassemblies automaticamente via lib
```

### 8.3 Implementação Manual de Fragmentação

A biblioteca `ws` **fragmenta automaticamente** se payload > maxPayloadLength:

```javascript
const server = new WebSocket.Server({
  maxPayloadLength: 64 * 1024 // 64KB máximo por frame
});

// ws.send(BIG_BUFFER) → fragmenta automaticamente
```

**Controle explícito** (para otimização):

```javascript
function sendFragmented(ws, buffer, chunkSize = 16 * 1024) {
  const total = buffer.length;
  let offset = 0;
  let first = true;

  while (offset < total) {
    const chunk = buffer.slice(offset, offset + chunkSize);
    const isLast = (offset + chunkSize) >= total;
    const fin = isLast;
    const opcode = first ? 'binary' : 'continuation';

    ws.send(chunk, { binary: true, fin, opcode }, (err) => {
      if (err) console.error('Fragment error:', err);
    });

    first = false;
    offset += chunkSize;
  }
}
```

### 8.4 Tamanho Ideal de Fragmento

| Tamanho | Pros | Cons | Recomendação |
|---------|------|------|--------------|
| 4 KB | Baixa latência, TCP-friendly | Overhead de headers ↑ | Não (pequeno demais) |
| 8-16 KB | Balanceado | Moderate | ✅ **Padrão ideal** |
| 32 KB | Menos headers ↑ | Buffer pressure ↑ | OK para LAN |
| 64 KB+ | Mínimo overhead | Latência alta, loss cost ↑ | ❌ Evitar WAN |

**Cálculo**:
```
MTU Ethernet = 1500 bytes
TCP header = 40 bytes
MSS (Maximum Segment Size) = 1460 bytes

Fragment 16KB → 11 pacotes TCP
Fragment 64KB → 44 pacotes TCP
```

**Regra**: `fragmentSize ≈ 10-11 × MSS = 15 KB`

### 8.5 Reassembly no Cliente

A biblioteca `ws` lida automaticamente:

```javascript
// No cliente (ou servidor recebendo)
ws.on('message', (data, isBinary) => {
  // Data já é frame completo (reassemblies automático)
  // Mesmo se fragmentado no servidor
  const jpeg = data; // Buffer completo
});
```

**Cuidado**: Se a fragmentação for manual, garantir `FIN=1` no último frame ou biblioteca travará esperando mais dados.

---

## 9. Recomendações para 10+ Sessões Simultâneas {#recomendacoes}

### 9.1 Arquitetura Escalável

```
[Load Balancer (HAProxy/Nginx)]
         ↓
[Node.js Cluster: N × workers]  ← Cada worker = 1 CPU core
         ↓
[Processo por Sessão?] ❌ NÃO
[Connection Multiplex] ✅ SIM
```

**Padrão Errado** (um processo por sessão):
```javascript
// ❌ Custa ~20 MB/process → 10 sessões = 200 MB inútil
```

**Padrão Certo** (multiplexação):
```javascript
// ✅ Todas sessions em 1 worker (até ~1000)
const sessions = new Map(); // sessionId → FrameSender
```

### 9.2 Worker Pool (Cluster Module)

```javascript
const cluster = require('cluster');
const os = require('os');

if (cluster.isMaster) {
  const cpuCount = os.cpus().length;

  // Criar workers = CPU cores
  for (let i = 0; i < cpuCount; i++) {
    cluster.fork();
  }

  // BalanceamentoRound-robin por conexão
  cluster.on('message', (worker, msg) => {
    if (msg.type === 'ready') {
      // Worker pronto, distribuir sessões
    }
  });
} else {
  // Worker lida com múltiplas sessões
  const server = createWebSocketServer();
  server.listen(8080);
}
```

**Distribuição**:
- ~1000 sessões/worker (limite empírico)
- 8 vCPU = ~8000 sessões no cluster
- Memória: 8000 × 0.4 MB = 3.2 GB (workers) + overhead

### 9.3 Otimizações de Sistema

**1. File Descriptors** (crítico!):
```bash
# Verificar limite atual
ulimit -n
# Resultado típico: 1024 ❌

# Editar /etc/security/limits.conf
* soft nofile 1000000
* hard nofile 1000000

# Editar /etc/sysctl.conf
net.core.somaxconn = 65536
net.ipv4.tcp_max_syn_backlog = 65536
net.core.netdev_max_backlog = 65536

# Aplicar
sysctl -p
```

**2. Node.js Flags**:
```bash
node server.js \
  --expose-gc \
  --max-old-space-size=8192 \
  --nouse-idle-notification \
  --trace-gc
```

**3. Linux Kernel Tweaks**:
```bash
# Aumentar memória de buffers TCP
echo 'net.ipv4.tcp_mem = 10000000 10000000 10000000' >> /etc/sysctl.conf

# Habilitar TCP_NODELAY (desabilitar Nagle)
# Já ativado via socket.setNoDelay(true) no ws
```

### 9.4 Gestão de Sessões

```javascript
class SessionManager {
  constructor(maxSessionsPerWorker = 1000) {
    this.sessions = new Map();
    this.maxSessions = maxSessionsPerWorker;
    this.backpressureThreshold = 64 * 1024; // 64KB por sessão
  }

  addSession(id, ws) {
    if (this.sessions.size >= this.maxSessions) {
      ws.close(1013, 'Server capacity maxed');
      return false;
    }

    this.sessions.set(id, {
      ws,
      frameSender: new FrameSender(ws),
      lastActivity: Date.now()
    });

    return true;
  }

  broadcast(data) {
    let slowClients = 0;

    for (const [id, session] of this.sessions) {
      const buffered = session.ws._socket?.bufferedAmount || 0;

      if (buffered > this.backpressureThreshold) {
        slowClients++;
        skipClient(id);
        continue;
      }

      session.frameSender.enqueue(data);
    }

    // Reinvidicar sessões lentas
    if (slowClients > 0) {
      console.warn(`%d clients skipped due to backpressure`, slowClients);
    }
  }

  cleanupZombies(timeoutMs = 30000) {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > timeoutMs) {
        session.ws.terminate();
        this.sessions.delete(id);
      }
    }
  }
}
```

### 9.5 Memory Pooling para Buffers

```javascript
const bufferpool = {
  pools: new Map(), // size → Buffer[]

  get(size) {
    let pool = this.pools.get(size);
    if (!pool || pool.length === 0) {
      return Buffer.alloc(size);
    }
    return pool.pop();
  },

  release(buffer) {
    const size = buffer.length;
    let pool = this.pools.get(size);
    if (!pool) {
      pool = [];
      this.pools.set(size, pool);
    }
    if (pool.length < 100) { // Limitar pool size
      // Reset buffer para zeros (evitar vazamento dados)
      buffer.fill(0);
      pool.push(buffer);
    }
  }
};

// Uso:
function processFrame(jpegData) {
  const buffer = bufferpool.get(jpegData.length);
  buffer.write(jpegData, 0, 'utf8'); // ou .set(jpegData) se já for Buffer
  ws.send(buffer, { binary: true });
  bufferpool.release(buffer);
}
```

### 9.6 Monitoring & Alerting

```javascript
// Métricas (Prometheus/Graphite)
const metrics = {
  connections: new Map(), // workerId → count
  memory: new Map(),      // workerId → RSS
  fps: new Map(),         // sessionId → frames/sec
  backpressure: 0,        // Count backpressure events
};

setInterval(() => {
  const totalConnections = [...metrics.connections.values()]
    .reduce((a, b) => a + b, 0);
  const avgMemory = [...metrics.memory.values()]
    .reduce((a, b) => a + b, 0) / metrics.memory.size;

  console.log(`[Metrics] Conns: ${totalConnections}, Mem: ${avgMemory} MB`);

  if (totalConnections > 8000) {
    alert('Approaching connection limit!');
  }
}, 5000);
```

### 9.7 Checklist de Deploy para 10+ Sessões

| Item | Config | Status |
|------|--------|--------|
| File descriptors | ≥ 100,000 | ✅ |
| TCP backlog | 65,536 | ✅ |
| Node.js cluster workers | CPU cores | ✅ |
| Buffer pooling | Ativo | ✅ |
| Permessage deflate | desabilitado | ✅ |
| Backpressure skip threshold | 64-128 KB | ✅ |
| Frame fragmentation | 16 KB chunks | ✅ |
| Library | ws + bufferutil **ou** uWebSockets.js | ⚠️ Avaliar |
| Monitoring | Prometheus + alerts | ✅ |
| Load balancer | HAProxy (sticky sessions) | ⚠️ |

### 9.8 Scaling Vertical → Horizontal

**Vertical** (upscaling):
```
AWS m5.4xlarge: 16 vCPU, 64 GB RAM
→ ~12,000 sessões (1 worker/vCPU)
→ Throughput: ~1.2 GB/s (limitado rede)
```

**Horizontal** (outscaling):
```
[Load Balancer (SSL termination)]
         ↓
[Node-1] [Node-2] [Node-3] [Node-4]
 16 vCPU 16 vCPU 16 vCPU 16 vCPU
  → 4 × 12k = 48,000 sessões
  → Throughput: ~4.8 GB/s (precisa 10GbE+)
```

**Estados compartilhados**:
- Usar Redis para sessões cross-worker
- Pub/Sub para broadcast (Redis channels)
- Cada worker lida apenas com seu subset

---

## 10. Código de Exemplo Completo {#exemplo-completo}

### 10.1 Servidor WebSocket Otimizado (node + ws)

```javascript
const cluster = require('cluster');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');

const CPU_COUNT = os.cpus().length;
const MAX_SESSIONS_PER_WORKER = 1000;
const MAX_BACKPRESSURE = 64 * 1024; // 64KB
const FRAGMENT_SIZE = 16 * 1024; // 16KB

if (cluster.isMaster) {
  console.log(`Master ${process.pid} iniciando ${CPU_COUNT} workers...`);

  for (let i = 0; i < CPU_COUNT; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} morreu. Reiniciando...`);
    cluster.fork();
  });
} else {
  // Worker process
  const server = http.createServer();
  const wss = new WebSocket.Server({ server, perMessageDeflate: false });

  const redis = new Redis({ host: 'localhost', port: 6379 });

  // Buffer pool
  const bufferPool = new Map();

  const sessions = new Map();

  wss.on('connection', (ws, req) => {
    const sessionId = req.url.slice(1) || crypto.randomUUID();
    const socket = ws._socket;

    // Socket tuning
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    sessions.set(sessionId, {
      ws,
      sessionId,
      lastSeen: Date.now(),
      frameQueue: [],
      isSending: false,
      fps: 0,
      framesSent: 0,
      lastFpsReset: Date.now()
    });

    console.log(`Sessão ${sessionId} conectada (total: ${sessions.size})`);

    ws.on('message', async (data, isBinary) => {
      // Processar comandos do cliente
      try {
        const msg = JSON.parse(data);
        await handleClientMessage(sessionId, msg);
      } catch (err) {
        console.error('Msg parse error:', err);
      }
    });

    ws.on('close', () => {
      sessions.delete(sessionId);
      console.log(`Sessão ${sessionId} desconectada`);
    });

    ws.on('error', (err) => {
      console.error('WS error:', err);
    });
  });

  async function handleClientMessage(sessionId, msg) {
    const session = sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'frame_request':
        // Broadcast via Redis
        await redis.publish('frames', JSON.stringify({
          sessionId,
          frameId: msg.frameId
        }));
        break;
    }
  }

  // Redis subscriber para frames
  const sub = new Redis();
  sub.subscribe('frames', (err, count) => {
    if (err) console.error('Redis subscribe error:', err);
  });

  sub.on('message', async (channel, message) => {
    if (channel !== 'frames') return;

    const data = JSON.parse(message);
    const { sessionId, frameId } = data;
    const session = sessions.get(sessionId);

    if (!session) return;

    // Simular captura de frame (substituir por captura real)
    const frame = await captureFrame(frameId);
    sendFrameToSession(session, frame);
  });

  async function sendFrameToSession(session, jpegData) {
    // Verificar backpressure
    const socket = session.ws._socket;
    if (socket && socket.bufferedAmount > MAX_BACKPRESSURE) {
      session.frameQueue.push(jpegData);
      return;
    }

    // Obter buffer do pool
    const buffer = getOrAllocateBuffer(jpegData.length);
    buffer.write(jpegData, 0, 'utf8');

    // Fragmentar se necessário
    if (buffer.length > FRAGMENT_SIZE) {
      sendFragmented(session.ws, buffer, FRAGMENT_SIZE);
    } else {
      session.ws.send(buffer, { binary: true }, (err) => {
        if (err) {
          console.error('Send error:', err);
          session.ws.terminate();
        }
        releaseBuffer(buffer);
      });
    }

    // Atualizar FPS
    session.framesSent++;
    const now = Date.now();
    if (now - session.lastFpsReset > 1000) {
      session.fps = session.framesSent;
      session.framesSent = 0;
      session.lastFpsReset = now;
    }
  }

  function getOrAllocateBuffer(size) {
    let pool = bufferPool.get(size);
    if (!pool || pool.length === 0) {
      return Buffer.alloc(size);
    }
    return pool.pop();
  }

  function releaseBuffer(buffer) {
    let pool = bufferPool.get(buffer.length);
    if (!pool) {
      pool = [];
      bufferPool.set(buffer.length, pool);
    }
    if (pool.length < 50) {
      buffer.fill(0);
      pool.push(buffer);
    }
  }

  function sendFragmented(ws, buffer, chunkSize) {
    let offset = 0;
    let first = true;

    while (offset < buffer.length) {
      const chunk = buffer.slice(offset, offset + chunkSize);
      const isLast = offset + chunkSize >= buffer.length;

      ws.send(chunk, {
        binary: true,
        fin: isLast,
        opcode: first ? 'binary' : 'continuation'
      }, (err) => {
        if (err && isLast) {
          console.error('Fragment send error:', err);
        }
      });

      first = false;
      offset += chunkSize;
    }
  }

  function startScheduler() {
    setInterval(() => {
      // Broadcast frames para todas sessões (exemplo)
      redis.publish('new_frame', JSON.stringify({
        frameId: Date.now(),
        timestamp: Date.now()
      }));
    }, 1000 / 15); // 15 FPS
  }

  server.listen(8080, () => {
    console.log(`Worker ${process.pid} ouvindo na 8080`);
    startScheduler();
  });
}
```

### 10.2 Cliente Otimizado (Navegador)

```javascript
class RemoteBrowserClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.imageData = null;
    this.fps = 0;
    this.frames = 0;
    this.lastFpsTime = Date.now();

    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'blob'; // Mais rápido que arraybuffer

    this.ws.onopen = () => {
      console.log('Connected');
      this.sendCommand('start_stream', { quality: 70 });
    };

    this.ws.onmessage = async (event) => {
      const start = performance.now();

      if (event.data instanceof Blob) {
        const bitmap = await createImageBitmap(event.data);
        this.drawFrame(bitmap);

        // Revoke após uso
        setTimeout(() => bitmap.close(), 100);
      }

      const duration = performance.now() - start;
      this.updateFps(duration);
    };

    this.ws.onclose = () => {
      console.log('Disconnected');
      setTimeout(() => this.connect(), 3000); // Reconectar com backoff
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  drawFrame(bitmap) {
    // Ajustar canvas ao tamanho do frame
    if (this.canvas.width !== bitmap.width) {
      this.canvas.width = bitmap.width;
      this.canvas.height = bitmap.height;
    }

    this.ctx.drawImage(bitmap, 0, 0);
    this.frames++;
  }

  updateFPS(frameTimeMs) {
    const now = Date.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frames;
      this.frames = 0;
      this.lastFpsTime = now;

      console.log(`FPS: ${this.fps}, frame time: ${frameTimeMs.toFixed(2)}ms`);
    }
  }

  sendCommand(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }
}

// Uso
const client = new RemoteBrowserClient('ws://localhost:8080/session/123');
```

---

## 11. Resumo Executivo

### 11.1 Principais Insights

1. **Binary Frames**: Usar sempre (evitar text frames). Economia 2-3x memória, throughput +50%.

2. **Backpressure**: Implementar queue + skip strategy. `ws.bufferedAmount` é bugado → usar callback do `send()`.

3. **Cork/Uncork**: Agrupar múltiplos writes (≥ 5 frames) para reduzir packets TCP. Ganho 20-30% throughput.

4. **Fragmentação**: Frames grandes (> 16KB) devem ser fragmentados. Tamanho ideal: 8-16 KB (10-11 × MSS).

5. **uWebSockets.js**: Para 10+ sessões, benchmark mostra **2.2x mais rápido** e **3x menos CPU** que `ws`. Migrar quando >500 conexões.

6. **noVNC**: Protocolo RFB tem overhead alto. Para custom system, usar JPEG streaming direto (sem RFB).

7. **Sessões Simultâneas**:
   - `ws` puro: ~1000 sessões/worker (8 GB RAM)
   - `ws` + otimizações: ~1500-2000 sessões/worker
   - `uWebSockets.js`: ~3000-5000 sessões/worker
   - Clustering (8 workers): 24k-40k sessões

8. **Throughput Teórico**:
   ```
   1000 sessões × 15 FPS × 50 KB = 750 MB/s
   5000 sessões × 15 FPS × 50 KB = 3.75 GB/s (excede 10GbE!)
   ```

### 11.2 Stack Recomendada

```
Baixa Escala (10-50 sessões):
→ ws (npm) + bufferutil
→ Sem clustering
→ JPEG libjpeg-turbo quality 70

Média Escala (50-500 sessões):
→ ws + bufferutil + cluster (1 worker/vCPU)
→ Buffer pooling
→ enforced backpressure skip (64KB threshold)
→ Fragmentação 16KB

Alta Escala (500+ sessões):
→ uWebSockets.js
→ Redis pub/sub cross-worker
→ Horizontal scaling (load balancer + multiple nodes)
→ Monitoring (Prometheus + Grafana)
```

### 11.3 Código Crítico

```javascript
// CHECKPOINT: Implementar ISTO em produção
const FrameSender = require('./framesender').FrameSender;
const SessionManager = require('./sessionmanager').SessionManager;

// Backpressure
if (socket.bufferedAmount > 64 * 1024) skip();

// Cork
socket.cork();
for (frame of batch) socket.write(frame);
process.nextTick(() => socket.uncork());

// Fragmentação
if (buffer.length > 16 * 1024) fragment(buffer);

// Pool de buffers
const buffer = getFromPool(size);
ws.send(buffer, { binary: true, fin: true });
releaseToPool(buffer);
```

---

## 12. Referências e Fontes

1. **ws Binary Frames Performance** – GitHub repos: websockets/ws, bufferutil docs
2. **Backpressure Handling** – Node.js Streams docs, Issue #492, Issue #9368 (Bun)
3. **TCP Cork/Uncork** – uWebSockets.js Discussion #909, Node.js Net docs
4. **Benchmarks** – Hashrocket websocket-shootout, Oat++ benchmark-websocket
5. **noVNC Optimizations** – noVNC RFC, websockify implementation
6. **Frame Fragmentation** – RFC6455 Sec 5.4, WebSocket Framing Guide
7. **High Concurrency** – Medium: "Millions of active WebSockets with Node.js", 1million-ws GitHub
8. **uWebSockets vs ws** – uNetworking AB Medium posts, Matt Tomasetti benchmark

---

**Fim do Documento**

*Nota: Benchmarks baseados em testes 2023-2025. Hardware, Node.js version e libuv podem alterar resultados.*