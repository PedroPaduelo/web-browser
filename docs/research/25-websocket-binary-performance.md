# WebSocket Binary Performance para Streaming de JPEG Frames

Pesquisa sobre otimizacao de throughput, backpressure, compressao e tecnicas de frame dropping
para streaming de video via WebSocket com frames binarios JPEG.

---

## 1. Fundamentos: Binary Frames vs Text Frames

O protocolo WebSocket define dois tipos de mensagem via opcodes distintos no header do frame:
- **Text Frames** (opcode `0x1`) -- UTF-8 encoded
- **Binary Frames** (opcode `0x2`) -- sequencia arbitraria de bytes

Para streaming de JPEG, binary frames sao obrigatorios. Enviar JPEG como base64 em text frames
adiciona ~33% de overhead no payload e custo de encode/decode em ambos os lados.

No client-side, `ws.binaryType` deve ser setado para `'arraybuffer'` (nao `'blob'`):
- `arraybuffer` permite acesso sincrono via `DataView`/`Uint8Array`, ideal para processamento
  imediato de frames
- `blob` e preferivel apenas para payloads muito grandes que nao precisam de acesso byte-a-byte

### Throughput pratico

Cada frame JPEG de 1280x720 a qualidade 60 tem ~30-80KB. A 30fps, o throughput necessario e
de ~1-2.4 MB/s (8-19 Mbps). WebSocket sobre TCP local (loopback ou LAN) suporta esse throughput
sem problemas. O gargalo aparece na WAN com packet loss.

---

## 2. Backpressure e `bufferedAmount`

### O problema

`ws.send()` e non-blocking -- enfileira dados no buffer do TCP e retorna imediatamente.
Se o client consome mais devagar que o server produz, o buffer cresce indefinidamente.
Com milhares de conexoes, mesmo uma pequena porcentagem de clients lentos pode causar
consumo de memoria em gigabytes, levando a OOM (Out of Memory) e crash do processo.

### Tres camadas de buffer

1. **Application buffer** -- dados enfileirados pela lib WebSocket (ex: `ws`) antes de
   escrever no socket
2. **OS TCP send buffer** -- buffer do kernel que armazena dados escritos pela aplicacao
   ate serem transmitidos e ACK'd pelo peer
3. **OS TCP receive buffer (peer)** -- buffer do kernel no lado receptor, que armazena
   dados ate a aplicacao fazer read

Se o client e lento para consumir, o receive buffer enche -> TCP flow control para de ACK'ar
-> send buffer do server enche -> a lib comeca a acumular no application buffer -> memoria sobe.

### `bufferedAmount` (client-side)

A propriedade read-only `WebSocket.bufferedAmount` retorna o numero de bytes enfileirados por
chamadas a `send()` que ainda nao foram transmitidos para a rede. Util para o browser monitorar
se esta enviando rapido demais para o server.

**Limitacao**: so pode ser verificado via polling, nao ha evento nativo de "drain" no browser API.

### `ws` (Node.js) -- server-side backpressure

A lib `ws` nao expoe `bufferedAmount` diretamente no nivel do WebSocket, mas fornece mecanismos
via o socket TCP subjacente:

```js
// Callback de send() -- chamado quando o frame foi entregue ao kernel
ws.send(jpegBuffer, { binary: true }, (err) => {
  if (err) {
    // Conexao falhou, limpar resources
  }
  // Frame entregue ao TCP send buffer
});

// Verificar se o socket interno precisa de drain
const needsDrain = ws._socket.writableNeedDrain;

// Escutar drain event no socket TCP subjacente
ws._socket.on('drain', () => {
  // Buffer drenado, seguro enviar mais frames
  resumeSending();
});
```

**Alternativa recomendada**: usar `createWebSocketStream()` do `ws` para wrappear o WebSocket
em um Duplex stream com backpressure nativa do Node.js streams API:

```js
const WebSocket = require('ws');
const duplex = WebSocket.createWebSocketStream(ws, { encoding: null });
// Agora .write() respeita backpressure automaticamente
```

### uWebSockets.js -- backpressure explicita

`uWebSockets.js` fornece controle granular:

```js
const app = uWS.App().ws('/*', {
  maxBackpressure: 64 * 1024,  // Limite de backpressure por socket

  drain: (ws) => {
    // Buffer drenado, pode enviar mais
    const remaining = ws.getBufferedAmount();
  },

  dropped: (ws, message, isBinary) => {
    // Frame descartado por backpressure excessiva
    // Bom para logging/metricas
  }
});
```

`maxBackpressure` define o limite maximo do buffer por socket. Quando excedido, mensagens
subsequentes sao descartadas automaticamente ate o client consumir. Ideal para streaming
de video onde frames antigos sao descartaveis.

---

## 3. `perMessageDeflate` e JPEG -- Por que desabilitar

### O que e perMessageDeflate

RFC 7692 define a extensao `permessage-deflate` que comprime o payload de cada mensagem
WebSocket usando o algoritmo DEFLATE (RFC 1951). Cada frame recebe o bit RSV1 no header
indicando se foi comprimido.

### Impacto em JPEG (dados ja comprimidos)

JPEG ja utiliza compressao com perdas (DCT + Huffman/Arithmetic coding). Aplicar DEFLATE
sobre JPEG:
- **Ratio de compressao**: praticamente zero -- JPEG ja tem alta entropia, DEFLATE nao
  consegue encontrar padroes redundantes
- **Custo de CPU**: significativo em ambos os lados (compress no server, decompress no client)
- **Custo de memoria**: cada conexao com perMessageDeflate aloca centenas de KB para o
  contexto de compressao (sliding window do zlib)
- **Resultado liquido**: overhead puro sem beneficio

### Recomendacao

```js
// ws (Node.js) -- desabilitar no server
const wss = new WebSocket.Server({
  port: 8080,
  perMessageDeflate: false  // DESABILITAR para JPEG streaming
});
```

Se a aplicacao tambem envia mensagens de texto/JSON (sinalizacao, metadados), a opcao ideal
seria compressao seletiva -- comprimir text frames mas nao binary frames. O protocolo suporta
isso (RSV1 bit per-message), mas:
- **Browsers**: uma vez negociado perMessageDeflate, comprimem TODOS os frames (Chrome, Firefox,
  Safari, Edge todos setam RSV1 em cada frame enviado)
- **Server-side**: libs como `ws` permitem configurar `threshold` (tamanho minimo para comprimir),
  mas nao oferecem filtragem por opcode (text vs binary)
- **Bun**: permite controle per-message via segundo parametro de `ws.send(data, compress)`

**Conclusao**: para aplicacoes de streaming JPEG, desabilitar `perMessageDeflate` completamente
e a abordagem mais segura e performatica.

### Numeros de referencia (Node.js + zlib)

Node.js tem problemas conhecidos com compressao high-throughput onde "increased concurrency,
especially on Linux, can lead to catastrophic memory fragmentation and slow performance".
Em producao, `perMessageDeflate` com muitas conexoes simultaneas pode degradar severamente
a performance do processo Node.js.

---

## 4. TCP (WebSocket) vs UDP (WebRTC) -- Latencia para Video Streaming

### Head-of-Line (HoL) Blocking -- o problema central do TCP

WebSocket roda sobre TCP, que garante entrega ordenada e confiavel. Para video em tempo real,
isso cria HoL blocking:

1. Server envia pacotes #100, #101, #102, #103
2. Pacote #100 e perdido na rede
3. TCP segura #101, #102, #103 no buffer ate #100 ser retransmitido
4. A aplicacao nao ve nenhum dado ate #100 chegar
5. Com RTT de 100ms, um unico pacote perdido adiciona no minimo 100ms de delay
6. Sob congestionamento, TCP retransmission backoff pode estender isso para **segundos**

### Impacto mensuravel

- Taxa de packet loss de 1% (comum em redes moveis) causa spikes de **100-200ms**
- O efeito e um padrao "sawtooth" de latencia -- o stream congela e depois dispara
  varios frames de uma vez
- Para remote desktop/screen sharing, isso e perceptivel e prejudica a interatividade

### WebRTC (UDP) -- trade-off diferente

WebRTC usa UDP como transporte primario:
- **Sem HoL blocking** -- pacotes posteriores nao esperam por anteriores
- Pacotes perdidos sao simplesmente descartados (melhor perder um frame que congelar)
- Jitter buffer introduz ~50-100ms de latencia intencional para suavizar a reproducao
- ICE/STUN/TURN adicionam complexidade de setup e overhead de infraestrutura

### Medicoes comparativas reais

| Cenario | WebSocket (TCP) | WebRTC (UDP) | WebTransport (QUIC) |
|---------|----------------|--------------|---------------------|
| Sem packet loss | ~20-30ms | ~50-100ms (jitter buffer) | ~49ms |
| 1% packet loss | 100-200ms spikes | ~60ms (frame drop) | ~55ms |
| 5% packet loss | 300-500ms+ spikes | ~80ms (quality degrada) | ~70ms |
| 15% packet loss | Segundos de freeze | Degradacao visivel | Melhor que WebRTC |

**Observacao importante**: sem jitter buffer e sem TURN relay, WebSocket pode ter latencia
base MENOR que WebRTC (~20-30ms vs ~50-100ms). O problema so aparece quando ha packet loss.

### Quando WebSocket vence

Para arquiteturas **client-server** em redes de boa qualidade (LAN, datacenter, fibra),
WebSocket pode ser a melhor escolha:
- Conexao estabelecida em 1 round-trip (HTTP upgrade) vs ICE negotiation do WebRTC
- Sem overhead de TURN/STUN
- Sem jitter buffer -- frames renderizam imediatamente
- Infraestrutura simples -- funciona atras de qualquer proxy/CDN/load balancer
- Toda a web stack (CloudFlare, nginx, Kubernetes ingress) suporta nativamente

### Quando WebRTC vence

- Redes com packet loss significativo (mobile, WiFi instavel)
- Peer-to-peer (sem server relay)
- Quando sincronizacao audio/video nativa e necessaria (RTCP clock mapping)
- Screen sharing em video-conferencia

### WebTransport -- o futuro

WebTransport (HTTP/3 + QUIC) resolve o HoL blocking do WebSocket sem a complexidade do WebRTC:
- **Datagrams**: pacotes unreliable, ordem nao garantida -- ideal para video frames
- **Streams**: multiplexados e independentes -- perda em um stream nao bloqueia outros
- Client-server (nao P2P)
- Firewall-friendly (porta 443)
- W3C lista explicitamente "Cloud Gaming & Remote Desktop" como caso de uso primario
- Medido com **35% menos latencia** que WebSocket em cenarios de game state updates

**Status em 2025**: Chrome suporta, Firefox em implementacao, Safari parcial. Suporte no
server-side ainda limitado (Cloudflare Workers, Caddy). Nao ha lib madura para Node.js ainda.

---

## 5. `ws` (Node.js) -- Otimizacao para High-Throughput Binary

### Instalar `bufferutil`

```bash
npm install bufferutil utf-8-validate
```

`bufferutil` e um addon nativo (C++) que acelera operacoes de masking/unmasking do frame
WebSocket. Automaticamente usado pelo `ws` quando disponivel. Para forcar desabilitar
(debug): `WS_NO_BUFFER_UTIL=1`.

### Enviar como Buffer (nao string)

```js
// BOM - binary frame, sem encoding overhead
ws.send(jpegBuffer, { binary: true });

// RUIM - text frame, base64 encoding necessario
ws.send(jpegBuffer.toString('base64'));
```

### Desabilitar perMessageDeflate (ja discutido acima)

```js
const wss = new WebSocket.Server({
  perMessageDeflate: false
});
```

### Evitar sends excessivamente frequentes

Cada chamada a `ws.send()` tem overhead: construcao do frame header, write no socket,
await do buffer drain. Para 30fps, isso sao 30 chamadas/segundo por client. Com 100 clients,
sao 3000 chamadas/segundo.

**Nao** batchar JPEG frames (nao faz sentido juntar 2 JPEGs em 1 mensagem), mas sim
garantir que o loop de captura nao produza frames mais rapido que o necessario.

### Considerar uWebSockets.js para throughput extremo

`uWebSockets.js` e 8-12x mais rapido que `ws` devido ao core C++:
- Binary support nativo e otimizado
- Backpressure explicita com `maxBackpressure` e `drain`/`dropped` handlers
- Publicacao broadcast otimizada (uma unica serializacao para N clients)
- Memory overhead minimo por conexao

Trade-off: API menos convencional, documentacao mais tecnica, menos ecossistema.

### Metricas para monitorar

| Metrica | O que indica | Threshold de alerta |
|---------|-------------|---------------------|
| `ws._socket.bytesWritten` | Total de bytes enviados | Tracking de throughput |
| `ws._socket.writableLength` | Bytes pendentes no buffer | > 256KB = client lento |
| `ws._socket.writableNeedDrain` | Buffer cheio | `true` = parar de enviar |
| Send callback latencia | Tempo entre send() e callback | > 100ms = gargalo |
| Frames/segundo efetivo | FPS real entregue ao client | Queda subita = problema |

---

## 6. Tecnicas de Frame Dropping/Skipping

### 6.1 Server-Side Frame Drop baseado em bufferedAmount

A tecnica mais eficaz para MJPEG/JPEG streaming: verificar o estado do buffer antes de
enviar cada frame e descartar se o client esta atrasado.

```js
function sendFrame(ws, jpegBuffer) {
  // Se o buffer do socket ja tem muitos dados pendentes, skip este frame
  if (ws._socket && ws._socket.writableLength > MAX_BUFFER_SIZE) {
    framesDropped++;
    return; // Frame descartado -- client vai ver o proximo
  }

  ws.send(jpegBuffer, { binary: true });
}
```

Variacao com callback tracking:

```js
let sendInProgress = false;

function sendFrame(ws, jpegBuffer) {
  if (sendInProgress) {
    framesDropped++;
    return; // Ainda nao terminou de enviar o frame anterior
  }

  sendInProgress = true;
  ws.send(jpegBuffer, { binary: true }, (err) => {
    sendInProgress = false;
    if (err) handleDisconnect(ws);
  });
}
```

### 6.2 Pull-Based Model (client solicita proximo frame)

Em vez de push continuo, o client pede o proximo frame somente apos processar o atual:

```
Client: { type: "next_frame" }
Server: [binary JPEG data]
Client: [renderiza]
Client: { type: "next_frame" }
...
```

**Vantagens**:
- Framerate se adapta automaticamente a capacidade do client
- Zero acumulo de buffer
- Simplicidade

**Desvantagens**:
- RTT adicionado a cada frame (1 round-trip de latencia extra)
- Em LAN (~1ms RTT) e negligivel; em WAN (~50-100ms) pode reduzir FPS significativamente
- Nao funciona se o server precisa manter fps fixo (ex: animacoes)

### 6.3 Frame Skipping com Motion Estimation

Para reduzir bandwidth, detectar frames redundantes antes de enviar:

```js
function shouldSendFrame(currentFrame, previousFrame) {
  // Comparar hash/checksum rapido dos buffers
  // Se diferenca < threshold, o frame e "parado" - nao precisa enviar
  if (frameDifference(currentFrame, previousFrame) < MOTION_THRESHOLD) {
    return false;
  }
  return true;
}
```

Tecnicas de comparacao rapida:
- **Buffer hash** (xxhash/murmur) -- detecta frames identicos (custo: ~1ms para 50KB)
- **Pixel sampling** -- comparar uma amostra de pixels do raw frame antes do JPEG encode
- **CDP-level** -- se usando Chrome DevTools Protocol, comparar `metadata.

### 6.4 Adaptive Quality

Ajustar a qualidade do JPEG dinamicamente baseado no estado do buffer:

```js
function getJpegQuality(ws) {
  const bufferSize = ws._socket ? ws._socket.writableLength : 0;

  if (bufferSize > HIGH_THRESHOLD)   return 30;  // Qualidade baixa, frame menor
  if (bufferSize > MEDIUM_THRESHOLD) return 50;  // Qualidade media
  return 70;                                       // Qualidade normal
}
```

### 6.5 Adaptive Framerate

Reduzir o FPS quando o client esta atrasado:

```js
let currentFps = 30;
const MIN_FPS = 5;
const MAX_FPS = 30;

function adjustFps(ws) {
  const bufferSize = ws._socket ? ws._socket.writableLength : 0;

  if (bufferSize > HIGH_THRESHOLD && currentFps > MIN_FPS) {
    currentFps = Math.max(MIN_FPS, currentFps - 5);
  } else if (bufferSize < LOW_THRESHOLD && currentFps < MAX_FPS) {
    currentFps = Math.min(MAX_FPS, currentFps + 5);
  }

  return currentFps;
}
```

### 6.6 Combinacao Recomendada para MJPEG Streaming

A abordagem mais robusta combina varias tecnicas em camadas:

```
Layer 1: Motion detection    -- nao capturar/enviar se tela nao mudou
Layer 2: Adaptive quality    -- reduzir qualidade JPEG se buffer crescendo
Layer 3: Adaptive framerate  -- reduzir FPS se buffer crescendo mais
Layer 4: Frame drop          -- descartar frame se send anterior ainda pendente
Layer 5: Client disconnect   -- desconectar client se buffer > limite critico
```

---

## 7. Resumo de Recomendacoes para o Projeto

### Configuracao otima do WebSocket server (`ws`)

```js
const WebSocket = require('ws');

const wss = new WebSocket.Server({
  port: 8080,
  perMessageDeflate: false,       // JPEG ja e comprimido
  maxPayload: 512 * 1024,         // 512KB max por frame
  backlog: 100,                    // Fila de conexoes pendentes
});
```

### Checklist de otimizacao

| Item | Status recomendado |
|------|-------------------|
| `perMessageDeflate` | Desabilitado |
| `bufferutil` instalado | Sim |
| `binaryType` no client | `'arraybuffer'` |
| Frames enviados como Buffer | Sim (nao base64) |
| Backpressure monitorada | Sim (`writableLength` / callback) |
| Frame dropping implementado | Sim (buffer threshold) |
| Adaptive quality | Sim (JPEG quality variavel) |
| Adaptive framerate | Sim (5-30 FPS range) |
| Motion detection | Opcional (reduz bandwidth idle) |

### Quando considerar migrar de WebSocket

| Cenario | Recomendacao |
|---------|-------------|
| LAN / rede confiavel | WebSocket e suficiente |
| WAN com baixo packet loss (<1%) | WebSocket e suficiente |
| WAN com packet loss moderado (1-5%) | Considerar WebRTC ou WebTransport |
| Mobile / WiFi instavel | WebRTC ou WebTransport |
| Multiplos streams simultaneos | WebTransport (sem HoL cross-stream) |
| Maximo de simplicidade | WebSocket |

---

## Fontes

- [High Performance Browser Networking - WebSocket (O'Reilly)](https://hpbn.co/websocket/)
- [WebSocket Streaming in 2025 - VideoSDK](https://www.videosdk.live/developer-hub/websocket/websocket-streaming)
- [Backpressure in WebSocket Streams - SkylineCodes](https://skylinecodes.substack.com/p/backpressure-in-websocket-streams)
- [Understanding Backpressure in WebSocket - DEV Community](https://dev.to/safal_bhandari/understanding-backpressure-in-web-socket-471m)
- [WebSocketStream API - Chrome Developers](https://developer.chrome.com/docs/capabilities/web-apis/websocketstream)
- [ws library - GitHub](https://github.com/websockets/ws)
- [ws issue #1218 - Detection of TCP backpressure](https://github.com/websockets/ws/issues/1218)
- [ws issue #2263 - Allow back-pressure on writable side](https://github.com/websockets/ws/issues/2263)
- [ws issue #1950 - perMessageDeflate threshold](https://github.com/websockets/ws/issues/1950)
- [Configuring WebSocket Compression - Ilya Grigorik](https://www.igvita.com/2013/11/27/configuring-and-optimizing-websocket-compression/)
- [Compression - websockets Python docs](https://websockets.readthedocs.io/en/stable/topics/compression.html)
- [RFC 7692 - Compression Extensions for WebSocket](https://datatracker.ietf.org/doc/html/rfc7692)
- [WebRTC vs WebSocket - Ably](https://ably.com/topic/webrtc-vs-websocket)
- [WebRTC vs WebSockets 2025 Guide - Velt](https://velt.dev/blog/websockets-vs-webrtc-full-guide)
- [WebRTC vs WebSocket AV Sync - GetStream](https://getstream.io/blog/webrtc-websocket-av-sync/)
- [We Killed WebRTC (And Nobody Noticed) - Helix](https://blog.helix.ml/p/we-killed-webrtc-and-nobody-noticed)
- [WebTransport Explainer - W3C](https://github.com/w3c/webtransport/blob/main/explainer.md)
- [Beyond WebSockets: WebTransport 35% Latency Cut](https://www.vroble.com/2025/11/beyond-websockets-mastering.html)
- [Comparing WebSocket, WebRTC, WebTransport under packet loss](https://github.com/Sh3b0/realtime-web)
- [WebRTC Latency Protocols Comparison 2026 - nanocosmos](https://www.nanocosmos.net/blog/webrtc-latency/)
- [uWebSockets.js - GitHub](https://github.com/uNetworking/uWebSockets.js)
- [uWebSockets vs ws - StackShare](https://stackshare.io/stackups/uwebsockets-vs-ws)
- [WebSocket Performance Comparison - Matt Tomasetti](https://matttomasetti.medium.com/websocket-performance-comparison-10dc89367055)
- [Frame Skipping for UHD Real-time Communication](https://zilimeng.com/papers/frameskipping-hotedgevideo21.pdf)
- [High Efficiency Live Video Streaming With Frame Dropping - IEEE](https://ieeexplore.ieee.org/document/9190683/)
- [Intelligent Frame Skipping for Video Streaming](https://www.diva-portal.org/smash/get/diva2:830783/FULLTEXT01.pdf)
- [PyImageStream - Pull-based adaptive framerate](https://github.com/Bronkoknorb/PyImageStream)
- [Axis Camera buffering issue #74](https://github.com/AxisCommunications/media-stream-library-js/issues/74)
- [MDN - WebSocket.bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount)
- [Node.js Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams)
