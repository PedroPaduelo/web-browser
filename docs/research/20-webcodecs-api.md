# WebCodecs API: Alternativa ao WebRTC para Stream de Baixa Latência

**Data da Pesquisa:** Março 2026
**Foco:** WebCodecs API (VideoDecoder/VideoEncoder) para streaming de vídeo sem WebRTC via WebSocket, comparação de latência com createImageBitmap(JPEG), benchmarks de performance real e viabilidade técnica.

---

## 1. Visão Geral da WebCodecs API

A **WebCodecs API** é uma especificação W3C que oferece acesso de baixo nível a codificadores e decodificadores de mídia já presentes nos navegadores. Diferente de APIs de alto nível como HTMLVideoElement, a WebCodecs dá controle total sobre os quadros individuais de vídeo e áudio.

### 1.1. Componentes Principais

- **VideoDecoder / AudioDecoder**: Decodificam dados compactados (EncodedVideoChunk / EncodedAudioData) em quadros brutos (VideoFrame / AudioData)
- **VideoEncoder / AudioEncoder**: Codificam quadros brutos em dados compactados
- **VideoFrame**: Representa um quadro de vídeo decodificado (ou capturado), contendo pixels YUV/RGB
- **EncodedVideoChunk**: Pacote de dados codificados (NAL units para H.264/VP9, etc.)

### 1.2. Por que WebCodecs em vez de WebAssembly?

- **Hardware acceleration**: Aproveita decodificadores/ codificadores nativos da GPU/CPU
- **Performance**: Codificadores WebAssembly precisam perder otimizações específicas de CPU e não usam aceleração de hardware
- **Latência**: Processamento assíncrono fora da thread principal

---

## 2. Arquitetura: Recepção de Stream via WebSocket + VideoDecoder

### 2.1. Pipeline Completo

```
Servidor (Encoding)                             Cliente (Decoding)
───────────────                                ───────────────
Canvas/GPU → VideoFrame → VideoEncoder → EncodedVideoChunk → [WebSocket/WebTransport]
                                                                     ↓
                                                            EncodedVideoChunk → VideoDecoder → VideoFrame
                                                                                                    ↓
                                                                                             Canvas.drawImage()
```

### 2.2. Implementação do Lado do Cliente (Exemplo)

```javascript
// receiver.js - Decodificador WebSocket + VideoDecoder

const canvas = document.getElementById('video-canvas');
const ctx = canvas.getContext('2d');

// 1. Configurar VideoDecoder
const decoder = new VideoDecoder({
  output: (videoFrame) => {
    // Renderizar quadro decodificado
    canvas.width = videoFrame.displayWidth;
    canvas.height = videoFrame.displayHeight;

    // Opção A: Canvas 2D (mais simples, performance moderada)
    ctx.drawImage(videoFrame, 0, 0);

    // Opção B: BitmapRenderer (melhor performance)
    // const bitmap = createImageBitmap(videoFrame);
    // const bmCtx = canvas.getContext('bitmaprenderer');
    // bmCtx.transferFromImageBitmap(bitmap);

    // Opção C: WebGPU (melhor performance total)
    // Usar GPUExternalTexture.importExternalTexture(videoFrame)

    videoFrame.close(); // ⚠️ SEMPRE liberar recursos!
  },
  error: (e) => console.error('Decoder error:', e)
});

// 2. Verificar suporte ao codec antes de configurar
const config = {
  codec: 'avc1.42001f', // H.264 Baseline (ver seção 3 para codec strings)
  codedWidth: 1280,
  codedHeight: 720,
  hardwareAcceleration: 'prefer-hardware' // ou 'prefer-software' se houver bugs
};

VideoDecoder.isConfigSupported(config).then(supported => {
  if (supported) {
    decoder.configure(config);
  } else {
    console.error('Codec não suportado:', config.codec);
    return;
  }
});

// 3. Receber chunks via WebSocket
const ws = new WebSocket('wss://servidor/stream');
ws.binaryType = 'arraybuffer';

// ⚠️ Backpressure: gerenciar decodeQueueSize
let pendingChunks = [];
let isProcessing = false;

ws.onmessage = (event) => {
  // O servidor deve enviar: { type: 'key'|'delta', timestamp: number, data: ArrayBuffer }

  // Em produção, o payload precisa ser deserializado
  const chunk = new EncodedVideoChunk({
    type: event.data.type || 'delta',
    timestamp: performance.now() * 1000, // microssegundos
    data: new Uint8Array(event.data.buffer) // ArrayBuffer contendo NAL units
  });

  // Controle de backpressure (ver seção 6)
  if (decoder.decodeQueueSize > 20) {
    pendingChunks.push(chunk);
    return; // Drop frame se fila muito cheia
  }

  decoder.decode(chunk);
};
```

---

## 3. Codecs Suportados: VP8, VP9, H.264

### 3.1. String de Codec (Codec Strings)

O parâmetro `codec` em `configure()` deve ser uma string RFC 6381 codec-string:

| Codec | Exemplo (Codec String) | Observações |
|-------|-----------------------|-------------|
| **VP8** | `"vp8"` | Mais simples, amplamente suportado |
| **VP9** | `"vp09.00.50.08"` | Formato: `vp09.<profile>.<level>.<bitDepth>` |
| **H.264 (AVC)** | `"avc1.42E01E"` | Baseline profile |
| **H.264 High** | `"avc1.4d0032"` | Main profile (usado por Helix ML) |
| **AV1** | `"av01.0.01M.08"` | Suporte ainda limitado (Chrome 90+) |

**Fonte**: [MDN - VideoDecoder.configure()](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure)

### 3.2. Verificação de Suporte (Obrigatório)

```javascript
// Sempre verifique antes de configurar!
const { supported } = await VideoDecoder.isConfigSupported({
  codec: 'avc1.42001f',
  codedWidth: 1920,
  codedHeight: 1080
});

if (!supported) {
  // Fallback: H.264 Baseline ou VP8
  const fallback = { codec: 'vp8', codedWidth: 1280, codedHeight: 720 };
  decoder.configure(fallback);
}
```

### 3.3. Formatos de Dados (H.264)

Para decodificação H.264, a especificação define dois formatos:
- **Annex B**: NAL units concatenados com start codes (0x000001 ou 0x00000001)
- **AVCC**: Formato MP4 com comprimento prefixado (4 bytes little-endian por NAL unit)

A maioria dos exemplos usa Annex B (simples concatenation). Para AVCC, pode ser necessário configurar `description` no `config`.

---

## 4. Latência: WebCodecs vs WebRTC vs createImageBitmap(JPEG)

### 4.1. Comparação Direta: WebCodecs + WebTransport vs. WebRTC

| Métrica | WebRTC (RTCPeerConnection) | WebCodecs + WebTransport/WS | Fontes |
|---------|----------------------------|----------------------------|--------|
| **Latência total (glass-to-glass)** | 140–380ms (varia com RTT) | 110–350ms (20–30ms melhor) | [webrtchacks.com](https://webrtchacks.com/webcodecs-webtransport-and-webrtc/) |
| **Relação Kbps/latência** | ~400ms para 1080p a 2Mbps | ~380ms para 1080p a 2Mbps | [webrtchacks.com](https://webrtchacks.com/webcodecs-webtransport-and-webrtc/) |
| **Overhead de rede** | DTLS + SRTP (12–20% overhead) | QUIC/HTTP3 ou TCP puro (~5–10%) | [Helix ML blog](https://blog.helix.ml/p/we-killed-webrtc-and-nobody-noticed) |
| **TURN relay** | Obrigatório em 20% dos casos (+50–100ms) | Eliminado | [Helix ML blog](https://blog.helix.ml/p/we-killed-webrtc-and-nobody-noticed) |
| **ICE negotiation** | 500ms–30s (timeout) | 1 RTT (handshake WebSocket existente) | [Helix ML blog](https://blog.helix.ml/p/we-killed-webrtc-and-nobody-noticed) |
| **Jitter buffer** | Sim (10–50ms) | Aplicação controla (pode ser zero) | [webrtchacks.com](https://webrtchacks.com/webcodecs-webtransport-and-webrtc/) |
| **Rewind/replay** | ❌ Não suportado | ✅ Suportado (cache por frame) | [webrtchacks.com](https://webrtchacks.com/webcodecs-webtransport-and-webrtc/) |

**Conclusão**: WebCodecs + WebTransport pode reduzir **20–30ms** de latência ao eliminar TURN, jitter buffer e overhead de pacotes.

### 4.2. WebCodecs vs createImageBitmap(JPEG Blob)

| Métrica | createImageBitmap(JPEG) | WebCodecs (H.264/VP9) | Benchmark Insights |
|---------|------------------------|----------------------|-------------------|
| **Decoding latency single frame** | 5–15ms (CPU, libjpeg) | 1–5ms (GPU/CPU hw accel) | [webcodecsfundamentals.org/rendering](https://webcodecsfundamentals.org/basics/rendering/) |
| **Tamanho por frame (1080p)** | 100–150KB (qualidade 70%) | 5–50KB (keyframe); 0.5–5KB (P-frame) | [Helix ML blog](https://blog.helix.ml/p/we-mass-deployed-15-year-old-screen) |
| **Complexidade de pipeline** | Simples (raw bytes → Bitmap) | Complexa (packetização, timestamps, keyframe deps) | [GitHub w3c/webcodecs#13](https://github.com/w3c/webcodecs/issues/13) |
| **Efeito de packet loss** | Total recovery por frame | Catastrófico se keyframe perdida | [Helix ML blog](https://blog.helix.ml/p/we-mass-deployed-15-year-old-screen) |
| **Latência burst recovery** | Imediato (novo JPEG completo) | Dependente de próximo keyframe (0.5–2s) | [Helix ML blog](https://blog.helix.ml/p/we-mass-deployed-15-year-old-screen) |

**Caso de Estudo Real — Helix ML**:
Engenheiros testaram pipeline H.264 WebCodecs a 60fps/40Mbps e **substituíram por polling JPEG a 10fps** porque:

> "Um screenshot JPEG é auto-contido. Ele ou chega completo, ou não chega. Não há 'decode parcial', não há 'esperando próximo keyframe', não há 'corrupção de estado do decoder'." — [Helix ML blog](https://blog.helix.ml/p/we-mass-deployed-15-year-old-screen)

Em redes empresariais instáveis (WiFi ruim), a latência de H.264 subiu para **30–45 segundos** devido a buffering TCP, enquanto JPEG manteve ~100ms. **Simplicidade venceu performance bruta.**

### 4.3. Latência End-to-End: Quebra-Detalhada

```
Capture (GPU)           : 30–50ms
Encode (hw accelerated) : 5–30ms (H.264); 1–5ms (JPEG via libjpeg)
Network (RTT local)     : 1–50ms
Jitter buffer           : 0–50ms (WebCodecs controla; WebRTC fixo 10–50ms)
Decode (hw accelerated) : 1–15ms
Render to canvas        : 8–16ms (refresh rate 60Hz = 16ms/frame)
─────────────────────────────────────────────────
TOTAL                   : 50–200ms (WebCodecs ideal)
                         : 140–400ms (WebRTC padrão)
```

**Nota**: [webrtchacks.com](https://webrtchacks.com/real-time-video-processing-with-webcodecs-and-streams-processing-pipelines-part-1/) e [webrtchacks.com/webcodecs-webtransport-and-webrtc/](https://webrtchacks.com/webcodecs-webtransport-and-webrtc/) documentam medições reais.

---

## 5. Benchmarks de Performance Reais (2025–2026)

### 5.1. Taxa de Frames: Métodos de Renderização de VideoFrame

Testes no MacBook Pro M4, Big Buck Bunny 1080p:

| Método de Renderização | Firefox | Chrome | Safari | Observações |
|-----------------------|---------|--------|--------|-------------|
| **Canvas 2D** | 70 fps | 960 fps | 230 fps | Mais lento, CPU-bound |
| **BitmapRenderer** (`createImageBitmap`) | 230 fps | 1120 fps | 220 fps | GPU→GPU copy + zero-copy `transferFromImageBitmap` |
| **WebGPU** (`importExternalTexture`) | 430 fps | 1230 fps | 610 fps | **Zero-copy**, melhor across browsers |

**Fonte**: [webcodecsfundamentals.org/basics/rendering](https://webcodecsfundamentals.org/basics/rendering/)

**Código Recomendado**:

```javascript
// BitmapRenderer (meio-termo performance/simplicidade)
const bmCtx = canvas.getContext('bitmaprenderer');
const bitmap = await createImageBitmap(videoFrame);
bmCtx.transferFromImageBitmap(bitmap);

// WebGPU (máxima performance)
// Requires WebGPU context and GPUExternalTexture
```

### 5.2. Dados de Suporte Real de Codecs (224.360 sessões)

Dataset: [upscaler.video Codec Support Dataset](https://webcodecsfundamentals.org/datasets/codec-support/)

| Codec | Decoders (Chrome/Firefox/Safari) | Encoders | Notas |
|-------|----------------------------------|----------|-------|
| **VP9** | 85%+ dos navegadores modernos | 75%+ | Precisa fallback H.264 para dispositivos antigos |
| **AV1** | 65–70% (Chrome 90+, Firefox 113+, Safari 17+) | 40–50% | Hw acceleration limitada |
| **H.264 (AVC)** | 99%+ | 95%+ | Sempre funciona como fallback |
| **VP8** | 95%+ | 90%+ | Opção segura |

**Conclusão**: Para deployment amplo, **suporte H.264 é obrigatório**; VP9 como primary; AV1 como otimização futura.

### 5.3. Comparação de Latência (Loops Locais)

Método: Medir `performance.now()` desde `decoder.decode(chunk)` até callback `output(videoFrame)`.

| Codec | Canvas 2D (ms) | BitmapRenderer (ms) | WebGPU (ms) |
|-------|----------------|---------------------|-------------|
| H.264 (iPhone 13) | 12–18ms | 6–10ms | 3–6ms |
| VP9 (MacBook M1) | 8–14ms | 4–8ms | 2–4ms |
| AV1 (Desktop Chrome) | 15–25ms | 10–15ms | 5–8ms |

**Fonte**: [webrtchacks.com](https://webrtchacks.com/real-time-video-processing-with-webcodecs-and-streams-processing-pipelines-part-1/) (dados empíricos de pipelines reais).

---

## 6. Backpressure e Controle de Fila

### 6.1. O Problema de Queue Interna

O `VideoDecoder` mantém uma fila assíncrona interna. Se `decode()` for chamado muitas vezes sem esperar, o decoder fica **saturado** e pode:

- Consumir memóriaGPU excessivamente (cada VideoFrame ≈ 8MB para 1080p)
- Introduzir latência (frames acumulam na fila)
- Causar stalls por falta de memória

### 6.2. Propriedades de Monitoramento

```javascript
decoder.decodeQueueSize       // Chunks pendentes na fila de decodificação
decoder.decodeProcessingCount // Chunks sendo processados agora
```

**Regra prática**: Se `decodeQueueSize > 10`, **pare** de enviar chunks até `dequeue` event disparar.

### 6.3. Padrão de Controle

```javascript
const MAX_QUEUE_SIZE = 10;

ws.onmessage = (event) => {
  if (decoder.decodeQueueSize >= MAX_QUEUE_SIZE) {
    // Drop frame (real-time app) ou pausar leitura do WebSocket
    return;
  }

  const chunk = new EncodedVideoChunk({
    timestamp: event.timestamp,
    type: event.keyframe ? 'key' : 'delta',
    data: event.data
  });

  decoder.decode(chunk);
};
```

### 6.4. TransformStream para Backpressure Automático

```javascript
// Converter WebSocket.message → TransformStream com backpressure
const chunkStream = new TransformStream({
  transform(event, controller) {
    if (decoder.decodeQueueSize > 15) {
      controller.desiredSize < 0 && controller.ready.then(() => {
        // Deferred: aplicar backpressure na origem
      });
      return;
    }
    decoder.decode(event);
  }
});

ws.readable.pipeThrough(chunkStream);
```

**Atenção**: [issue w3c/webcodecs#864](https://github.com/w3c/webcodecs/issues/864) — comportamento de `decodeQueueSize` varia entre browsers. Chrome usa max 1–8; pode ser ∞. Não confie cegamente.

---

## 7. Problemas, Pitfalls e Soluções

### 7.1. Bugs Conhecidos em 2026

| Problema | Sintoma | Solução |
|----------|---------|---------|
| **`createImageBitmap(videoFrame)` retorna resolução errada** | VideoFrame 640×360 vira 640×368 (crop丢失) | Usar `drawImage()` direto ou WebGPU |
| **Memory leak** | GPU memória cresce até crash | **SEMPRE** `videoFrame.close()` após usar |
| **AudioData não é transferable** | Copiar AudioData entre workers é lento | Usar AudioWorklet (SharedArrayBuffer) ou processar na thread do AudioContext |
| **`flush()` quebra pipeline** | Chamar `decoder.flush()` requer próximo keyframe | **Nunca** chamar `flush()` em streams variáveis |
| **Hardware decoder picking** | Decoder "misterioso" lento ou trava | `hardwareAcceleration: 'prefer-software'` como fallback |
| **Mobile zero-copy issue** | `videoFrame.copyTo()` retorna zeros após 20 frames (Pixel 7 Pro) | Render via `OffscreenCanvas` ao invés de copy |

**Fontes**: [GitHub w3c/webcodecs#119](https://github.com/w3c/webcodecs/issues/119), [Helix ML blog](https://blog.helix.ml/p/we-killed-webrtc-and-nobody-noticed), [webrtchacks.com](https://webrtchacks.com/real-time-video-processing-with-webcodecs-and-streams-processing-pipelines-part-1/).

### 7.2. Latência Adversa: O Mistério dos 80ms

Alguns relatos ([groups.google.com](https://groups.google.com/g/discuss-webrtc/c/glPKevi1jok)) mostram latência inesperada:

```
Capture → Encode → Transport → Decode → OnFrameBufferUpdated  :  17ms
OnFrameBufferUpdated → Canvas Paint (misterioso)           : +80ms (!!)
───────────────────────────────────────────────────────────
TOTAL                                                      :  97ms
```

Causas possíveis:
- **Compositor thread vs main thread**: `drawImage()` ocorre no main thread; compositor espera VSync
- **GPU stalling**: Se decoder escreve em textura ainda não liberada
- **WebCodecs Queue interna**: Chrome default max queue = 8 chunks; pode滞留

**Solução**:
- Usar `requestVideoFrameCallback` para medir corretamente a latência de render
- Reduzir `decodeQueueSize` alvo para < 3
- Testar `hardwareAcceleration: 'prefer-software'` para ver se latency melhora (pode indicar GPU stall)

### 7.3. Problemas de Sincronização A/V

- **Timestamps de áudio não sobrevivem encode/decode cycle** (diferente de vídeo)
- **AudioData não é transferable** → cópias caríssimas a cada frame (~21ms de áudio)
- **Lip sync drift**: Sem PTS preservados, A/V drift acumula

**Workaround**: Incluir PTS no pacote custom (ex: primeiro byte do payload) e agendar `AudioBufferSourceNode.start(when)` manualmente em `AudioContext.currentTime + pts`.

---

## 8. WebSocket vs WebTransport vs WebRTC DataChannel

| Transport | Latência | Confiabilidade | Cache/CDN | Firewall | Complexidade |
|-----------|----------|----------------|-----------|----------|--------------|
| **WebSocket (TCP)** | 1–100ms RTT + HOL blocking | Ordenado, confiável | ❌ Não | ✅ Port 443 | Baixa |
| **WebTransport (QUIC)** | 1 RTT + sem HOL blocking | Datagramas unordered | ✅ Possível (frame cache key) | ⚠️ Often bloqueado | Média |
| **RTCDataChannel (SCTP over UDP)** | 1 RTT + NACK retransm | Ordenado opcional | ❌ Não | ⚠️ UDP bloqueado | Alta |

### 8.1. Caso Real: Helix ML Escolheu WebSocket

Motivos:
1. **Empresas só abrem port 443** — WebRTC precisa UDP 3478 (STUN) + 49152–65535 (media) + TURN
2. **WebRTC ICE failure rate 20%** sem logs úteis
3. **TURN adiciona 50–100ms** e quebra em redes corporativas
4. **WebTransport ainda bloqueado** por firewalls L7
5. **Simplicidade**: 1 byte header + payload → conexão única full-duplex

**Código do protocolo Helix**:

```rust
// Servidor: binary frame no WebSocket
// [0x01] - Video frame (H.264 NAL units, Annex B)
// [0x02] - Audio frame (Opus)
// [0x10–0x13] - Input events (keyboard/mouse)
// Data after header: raw bytes
```

---

## 9. Exemplo Completo: Remote Desktop WebSocket + WebCodecs

### 9.1. Cliente (Receiver)

```javascript
// client.js
class RemoteDesktopClient {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pendingFrames = [];
    this.setupDecoder();
  }

  setupDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame) => this.renderFrame(frame),
      error: (e) => console.error('Decoder error:', e)
    });

    this.decoder.configure({
      codec: 'avc1.4d0032', // H.264 Main
      codedWidth: 1920,
      codedHeight: 1080,
      hardwareAcceleration: 'prefer-hardware'
    });
  }

  renderFrame(frame) {
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
  }

  connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = async (event) => {
      const header = new Uint8Array(event.data)[0];

      if (header === 0x01) {
        // Video frame (skip header byte)
        const payload = event.data.slice(1);
        await this.decodeChunk(payload, /* isKeyframe */ false);
      }
      // ... handle other message types
    };
  }

  async decodeChunk(data, isKeyframe) {
    const chunk = new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      timestamp: performance.now() * 1000,
      data: new Uint8Array(data)
    });

    // Backpressure
    if (this.decoder.decodeQueueSize > 15) {
      console.warn('Decoder saturated, dropping frame');
      return;
    }

    this.decoder.decode(chunk);
  }
}
```

### 9.2. Servidor (Sender) — Ex conceitual

```python
# server.py (Python + PyAV ou GStreamer)
# Encode frames → H.264 Annex B → WebSocket binary prefix + payload

import asyncio, websockets
import av

async def stream(websocket):
    container = av.open('screen-capture')  # ou pipe de desktop capture
    stream = container.streams.video[0]

    async for packet in container.demux(stream):
        if packet.dts is None:
            continue

        # packet.buffer contém NAL units Annex B
        payload = packet.buffer
        message = bytes([0x01]) + payload  # 0x01 = video frame
        await websocket.send(message)
```

---

## 10. Recomendações de Produção

### 10.1. Antes de Usar WebCodecs

1. **Verifique suporte**:
   ```javascript
   if (!('VideoDecoder' in window)) {
     // Fallback: WebRTC ou JPEG polling
   }
   ```

2. **Teste hardware acceleration**:
   ```javascript
   const cfg = { codec: 'avc1.42001f', hardwareAcceleration: 'prefer-hardware' };
   const { supported } = await VideoDecoder.isConfigSupported(cfg);
   if (!supported) cfg.hardwareAcceleration = 'prefer-software';
   ```

3. **Worker obrigatório**: Decodificação pesada não deve bloquear main thread
   ```javascript
   // decoder.worker.js
   const decoder = new VideoDecoder({ output: postMessage.bind(null, /* transfer */) });
   ```

### 10.2. Deploy

- **WebSocket seguro (WSS)**: Todos os navegadores exigem Secure Context para WebCodecs
- **Packetização**: Implementar parser de NAL units (H.264 start codes) ou usar library (mp4box.js)
- **Fallback cascata**:
  1. WebCodecs + WebSocket (latência alvo <150ms)
  2. WebRTC (latência <500ms; mais compatível)
  3. JPEG polling (latência ~100ms; funciona em anything)

### 10.3. Monitoramento

- **Latência**: timestamp do frame capturado → `performance.now()` no callback output
- **Queue pressure**: `decoder.decodeQueueSize` métrica (alerta se > 20 por mais de 100ms)
- **Hardware acceleration**: Chrome DevTools → `chrome://gpu` / `chrome://media-internals`

### 10.4. Escalabilidade

WebCodecs + CDN é **mais escalável** que WebRTC SFU:
- Cada frame tem cache key única (stream ID + seq num) → CDN cache hit
- Sem TURN/SFU stateful por cliente
-夢 Broadcast 1-to-milhões com edge caching (MoQ — Media over QUIC)

---

## 11. Conclusão: Vale a Pena Substituir WebRTC?

### Quando WebCodecs + WebSocket É Melhor

✅ **Controle total sobre codec, bitrate, latency**
✅ **Sem TURN/STUN** (sóHTTPS/WebSocket port 443)
✅ **Cacheability & rewind** (QUIC/CDN friendly)
✅ **20–30ms menos latência** vs WebRTC com TURN
✅ **Worker support** completo (WebRTC DataChannel não tem worker implementation)

### Quando WebRTC É Insubstituível

❌ **Browser coverage**: WebRTC funciona em IE11? (with polyfill); WebCodecs exige Chrome 94+/Safari 16.4+/Firefox 130+
❌ **NAT traversal automático**: ICE+STUN/TURN works out-of-the-box
❌ **Congestion control**: WebRTC tem GCC embutido; WebCodecs você implementa (ou ignora)
❌ **Adaptive bitrate**: WebRTC drops frames suavemente; WebCodecs você gerencia
❌ **One-liner API**: `new RTCPeerConnection()` vs implementar toda pipeline de encode→packetize→transport→depacketize→decode

### Recomendação Final

Para **Remote Desktop / screen sharing empresarial** onde:
- Controle de rede é total (datacenter, VPN)
- Latência < 150ms é crítico
- Navegadores modernos (Chrome/Edge) são alvo

**Escolha WebCodecs + WebSocket/WebTransport**. Simplifique infraestrutura, ganhe 20–30ms, use CDN edge.

Para **Consumer video chat / multi-party** onde:
- Suporte iOS Safari antigo é necessário
- NAT traversal é caótico
- Congestion control é essencial

**Fique com WebRTC** (ou use insertable streams para hacks pontuais).

---

## 12. Fontes

1. [W3C WebCodecs Spec](https://www.w3.org/TR/webcodecs/)
2. [MDN — VideoDecoder.configure()](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure)
3. [Chrome for Developers — Video processing with WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)
4. [webrtcHacks — WebCodecs, WebTransport, and the Future of WebRTC](https://webrtchacks.com/webcodecs-webtransport-and-webrtc/)
5. [Helix ML — We Killed WebRTC (And Nobody Noticed)](https://blog.helix.ml/p/we-killed-webrtc-and-nobody-noticed)
6. [Helix ML — We Mass-Deployed 15-Year-Old Screen Sharing Technology](https://blog.helix.ml/p/we-mass-deployed-15-year-old-screen)
7. [webcodecsfundamentals.org — Rendering](https://webcodecsfundamentals.org/basics/rendering/)
8. [upscaler.video Codec Support Dataset (224k sessões)](https://webcodecsfundamentals.org/datasets/codec-support/)
9. [GitHub w3c/webcodecs — Issues #119, #159, #864](https://github.com/w3c/webcodecs/issues)
10. [Real-Time Video Processing with WebCodecs and Streams (Part 1)](https://webrtchacks.com/real-time-video-processing-with-webcodecs-and-streams-processing-pipelines-part-1/)

---

**Status da Pesquisa**: Concluída
**Próximos Passos Recomendados**: Protótipo de PoC com H.264 + WebSocket + BitmapRenderer, medir latência em rede local vs WebRTC baseline.
