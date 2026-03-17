# MJPEG via WebSocket — Latência, Otimização e Comparações

**Data:** 2026-03-17
**Contexto:** Pesquisa para o projeto remote-browser — avaliação de MJPEG over WebSocket como alternativa ao WebRTC para streaming de tela em browser remoto.

---

## 1. O que é MJPEG over WebSocket

MJPEG (Motion JPEG) é um formato de vídeo onde cada frame é comprimido individualmente como uma imagem JPEG e transmitido em sequência. Ao contrário de codecs interframe (H.264, VP9, AV1), não há compressão temporal — cada frame é completamente independente.

Existem duas formas de entregar MJPEG ao browser:

1. **HTTP Multipart** (`Content-Type: multipart/x-mixed-replace`): o servidor mantém uma conexão HTTP aberta e envia frames separados por um boundary string. Suportado diretamente pela tag `<img>`.
2. **WebSocket**: o servidor abre uma conexão WebSocket full-duplex e envia frames JPEG como mensagens binárias (`ArrayBuffer`/`Blob`). O browser renderiza via `<canvas>` ou `<img>` com Blob URLs.

---

## 2. Latência Real Medida (Valores de Referência)

### 2.1 Latência do protocolo WebSocket em si

| Ambiente | RTT Medido |
|---|---|
| LAN local (ESP8266 / embarcado) | < 1 ms |
| Cloud AWS (WebSocket) | ~87 ms |
| Exigência IEC 61588 (real-time) | < 100 ms |

O WebSocket puro adiciona overhead mínimo sobre TCP — apenas o framing inicial. Após o handshake, cada frame adiciona apenas 2–14 bytes de header WebSocket.

### 2.2 Latência de MJPEG sobre WebSocket (end-to-end, captura → render)

| FPS do encoder | Latência intrínseca (1/FPS) | Latência medida e2e |
|---|---|---|
| 6 FPS | ~167 ms/frame | ~200 ms |
| 30 FPS | ~33 ms/frame | ~50 ms (medido: EMJPEGStreamer) |
| 60 FPS | ~16 ms/frame | ~30–40 ms (estimado) |
| 200 FPS | ~5 ms/frame | ~10 ms (estimado) |

Referência real: o projeto **EMJPEGStreamer** (Java + WebSocket + VLCJ) mediu **~50 ms** de latência a ~27–30 FPS. Isso inclui captura de tela, encoding JPEG, transmissão WebSocket e renderização no browser.

### 2.3 Comparação com outras tecnologias de streaming

| Tecnologia | Latência típica |
|---|---|
| MJPEG WebSocket (30 FPS, LAN) | 50–100 ms |
| MJPEG HTTP Multipart (LAN) | 80–200 ms |
| noVNC (VNC sobre WebSocket) | 100–300 ms (interativo) |
| WebRTC (LAN ideal) | 20–100 ms |
| HLS | 5–30 segundos |
| RTMP | 3–5 segundos |
| RDP nativo (LAN) | 20–50 ms |

**Conclusão:** MJPEG over WebSocket consegue latência comparável ao WebRTC para uso em remote desktop em LAN, especialmente com FPS alto (30+). Em WAN (Internet), o gargalo passa a ser o RTT de rede, não o protocolo.

---

## 3. Vantagens do MJPEG sobre WebSocket

### Vantagens técnicas

- **Decodificação zero-buffer**: cada frame JPEG é decodificado de forma independente. Não requer buffering de frames anteriores (ao contrário de H.264, que precisa de pelo menos 1 frame de referência). Isso elimina uma fonte de latência estrutural.
- **Simplicidade de implementação**: o servidor envia dados binários em um WebSocket; o client converte para Blob URL e atualiza `<img>` ou `<canvas>`. Menos de 20 linhas de JavaScript.
- **Sem dependência de APIs complexas**: não precisa de `WebCodecs API`, `MSE (Media Source Extensions)` ou `RTCPeerConnection`. Funciona em qualquer browser que suporte WebSocket.
- **Baixo CPU no cliente**: decodificação JPEG é hardware-accelerated em todos os browsers modernos via libjpeg. Não há necessidade de decoder de vídeo.
- **Fallback imediato**: se um frame se perder, o próximo frame é completo — sem artefatos de "frame corrompido" como ocorre com I/P/B frames do H.264.
- **Controle granular de qualidade**: o servidor pode ajustar dinamicamente a qualidade JPEG por frame, sem necessidade de renegociação de codec.

### Vantagens operacionais

- **Sem NAT traversal**: diferente do WebRTC, não precisa de STUN/TURN servers para funcionar atrás de firewalls corporativos.
- **Sem sinalização complexa**: não há SDP, ICE candidates, ou estados de conexão como no WebRTC.
- **Proxy/Firewall friendly**: WebSocket sobre porta 443 (WSS) atravessa a maioria dos firewalls sem problemas.
- **Debug simples**: frames individuais podem ser capturados e inspecionados diretamente.

---

## 4. Desvantagens e Limitações

- **Sem compressão temporal**: cada frame é comprimido independentemente. Resultado: ~3–10× mais dados que H.264 para conteúdo com movimento (vídeo). Para telas de desktop com mudanças parciais, a diferença é menor.
- **Sem controle de congestionamento nativo**: WebSocket sobre TCP pode sofrer head-of-line blocking. Se um frame atrasar, todos os frames seguintes ficam na fila — ao contrário de QUIC/WebRTC que usa UDP.
- **Escalabilidade de banda**: 1080p a 30 FPS com qualidade 75 consome ~2–8 Mbps. H.264 consegue qualidade similar com 1–2 Mbps.
- **Sem áudio**: MJPEG é só vídeo. Para remote desktop completo, áudio precisa de canal separado.

---

## 5. Otimização de MJPEG sobre WebSocket

### 5.1 Técnicas de redução de latência

#### "Send only the latest frame" (drop frames velhos)
A técnica mais importante: **nunca enfileirar frames**. Se o cliente está mais lento que o servidor, o servidor deve descartar frames antigos e enviar apenas o mais recente.

```javascript
// Padrão ERRADO — enfileira frames, causa latência crescente
ws.on('open', () => {
  setInterval(() => ws.send(captureFrame()), 33); // 30 FPS
});

// Padrão CORRETO — descarta frame se o anterior ainda está pendente
let sending = false;
setInterval(() => {
  if (!sending) {
    sending = true;
    const frame = captureFrame(); // sempre o frame mais recente
    ws.send(frame, () => { sending = false; });
  }
}, 33);
```

#### Backpressure no cliente
O browser não deve solicitar o próximo frame antes de terminar de renderizar o atual. Isso evita fila de decode jobs acumulados (problema documentado no Firefox com MJPEG):

```javascript
// Cliente com backpressure
const img = new Image();
let frameQueue = null;

ws.onmessage = (event) => {
  frameQueue = event.data; // substitui, não enfileira
};

function renderLoop() {
  if (frameQueue) {
    const blob = new Blob([frameQueue], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      ctx.drawImage(img, 0, 0);
      frameQueue = null;
      requestAnimationFrame(renderLoop);
    };
    img.src = url;
  } else {
    requestAnimationFrame(renderLoop);
  }
}
requestAnimationFrame(renderLoop);
```

#### Skip de frames redundantes no servidor
Não enviar frames quando a tela não mudou. Pode ser implementado com comparação de hash ou checksum do frame raw antes de comprimir:

```python
import hashlib

prev_hash = None
def should_send_frame(raw_pixels):
    global prev_hash
    h = hashlib.md5(raw_pixels).hexdigest()
    if h == prev_hash:
        return False
    prev_hash = h
    return True
```

### 5.2 Buffer size e jitter buffer

O **jitter buffer** é o principal trade-off em streaming real-time:

| Buffer Size | Efeito |
|---|---|
| 0 (nenhum) | Latência mínima, mais stutter/drops em redes instáveis |
| 1 frame | Equilíbrio ideal para desktop remoto interativo |
| 2–5 frames | Reprodução suave, latência +66–166 ms @ 30 FPS |
| > 5 frames | Inaceitável para remote desktop (>166 ms de lag) |

**Recomendação para remote desktop**: buffer de 0–1 frame. Preferir drop de frames a buffering excessivo.

### 5.3 Compressão WebSocket (deflate/permessage-deflate)

**Importante**: NÃO aplicar `permessage-deflate` em frames JPEG. JPEG já é comprimido (DCT-based). Aplicar deflate adicional em dados JPEG tipicamente:
- Aumenta o tamanho do payload em 1–5%
- Adiciona 1–3 ms de CPU overhead por frame
- Não reduz o tamanho (entropia já alta)

Desabilitar permessage-deflate explicitamente no servidor:

```javascript
// Node.js ws library
const wss = new WebSocketServer({
  perMessageDeflate: false // desabilitar para MJPEG
});
```

### 5.4 Qualidade JPEG e FPS — trade-offs

| Qualidade JPEG | Tamanho (1080p, LAN) | Latência adicional | Qualidade visual |
|---|---|---|---|
| 40 | ~30–50 KB | Mínima | Perceptível degrado |
| 60 | ~60–100 KB | Baixa | Boa para texto |
| 75 | ~100–150 KB | Moderada | Excelente para UI |
| 90 | ~200–300 KB | Alta | Quase lossless |
| 100 | ~800 KB–1 MB | Muito alta | Lossless |

Para remote desktop interativo (UI, texto), qualidade 70–80 oferece o melhor custo-benefício.

### 5.5 Adaptive quality e framerate

O projeto EMJPEGStreamer implementa adaptação dinâmica:

- Mede a largura de banda disponível via tempo de round-trip do frame
- Reduz qualidade JPEG quando a banda é saturada
- Reduz FPS quando encoder está sobrecarregado
- Volta para PNG (sem perdas) quando a banda é abundante

Resultado: latência consistentemente baixa (~50 ms) independente da variação de rede.

### 5.6 Resolução e sub-sampling

- Enviar tela em resolução **nativa** raramente é necessário — o browser vai redimensionar para o viewport do cliente de qualquer forma
- Enviar na resolução do viewport reduz tamanho do frame significativamente
- JPEG supports chroma subsampling (4:2:0, 4:2:2, 4:4:4) — para texto/UI, usar 4:4:4 para manter nitidez; para conteúdo visual, 4:2:0 economiza 30–50% de tamanho

---

## 6. HTTP Multipart MJPEG vs. WebSocket MJPEG

### Comparação técnica detalhada

| Aspecto | HTTP Multipart | WebSocket |
|---|---|---|
| **Overhead por frame** | ~200–400 bytes (headers HTTP por parte) | 2–14 bytes (framing WebSocket) |
| **Latência** | Ligeiramente maior (half-duplex) | Menor (full-duplex, menos overhead) |
| **Direção** | Unidirecional (server → client) | Bidirecional |
| **Browser support** | `<img>` nativa, zero JS | Requer JavaScript + Canvas |
| **Firewall/Proxy** | Excelente (HTTP padrão) | Bom (alguns proxies antigos bloqueiam) |
| **Controle do cliente** | Nenhum (server push) | Full (cliente pode pausar, ajustar QoS) |
| **Múltiplos streams** | Uma conexão por stream | Múltiplos streams em uma conexão (multiplexing) |
| **Fallback** | Automático (HTTP já instalado) | Requer fallback manual |
| **CPU server** | Simples | Ligeiramente mais complexo (WS framing) |

### Quando usar cada um

**HTTP Multipart é melhor quando:**
- Integração com sistemas IoT/câmeras IP que já produzem MJPEG
- Necessidade de compatibilidade com navegadores antigos ou sistemas embarcados
- Extrema simplicidade de servidor é prioridade
- Tráfego unidirecional puro (câmera de monitoramento sem interação)

**WebSocket é melhor quando:**
- Remote desktop interativo (necessita canal de retorno para mouse/teclado)
- Latência mínima é crítica (menos overhead por frame)
- Controle dinâmico de qualidade/framerate do cliente ao servidor
- Múltiplos streams na mesma conexão
- Monitoramento de métricas de qualidade bidirecionais

**Para remote desktop: WebSocket é a escolha correta** — a bidirecionalidade é essencial para input (mouse, teclado) e o overhead reduzido por frame importa a 30+ FPS.

---

## 7. Como Projetos Reais Implementam Screen Streaming

### 7.1 Apache Guacamole

**Arquitetura**: Text-based protocol over WebSocket (não é MJPEG)

Guacamole usa um protocolo proprietário baseado em instruções de texto:

```
<length>.<instruction_opcode>,<arg1>,<arg2>,...;
```

- Cada update de tela é enviado como um `png` instruction com dados de imagem em base64
- O cliente JavaScript processa as instruções conforme chegam (streaming parse)
- Imagens podem ser enviadas para "layers" (buffers do canvas) ou exibidas imediatamente
- Suporta **lossless** (PNG por padrão) e **lossy** (heurística no servidor decide)

**Encodings VNC suportados** (default excluindo Tight/JPEG):
```
zrle ultra copyrect hextile zlib corre rre raw
```

**Por que excluir JPEG/Tight**: O Guacamole reencoda tudo como PNG para o browser. Se o VNC server usar JPEG (lossy) e o Guacamole recomprimir como PNG, os artefatos JPEG reduzem a compressibilidade do PNG — pior dos dois mundos.

**Latência Guacamole vs noVNC**:
- Guacamole: menor latência, pois o servidor faz o processamento pesado (libguac) e envia atualizações já otimizadas
- noVNC: latência maior, pois o JavaScript precisa processar dados VNC binários no browser

**Limitações**: Vídeo sobre VNC/Guacamole é ineficiente — cada frame de vídeo é enviado como PNG lossless, sem compressão temporal. Não recomendado para streaming de vídeo.

### 7.2 noVNC

**Arquitetura**: VNC protocol tunneled over WebSocket via `websockify`

- `websockify` é um proxy simples que converte WebSocket ↔ TCP socket
- O browser executa um cliente VNC completo em JavaScript
- Suporta encodings: raw, copyrect, rre, hextile, tight, tightPNG, ZRLE, JPEG, H.264
- Buffer management com compactação automática e resize dinâmico

**Problema de performance em alta latência**:
- Quando servidor não suporta "fence" e "continuous updates", noVNC faz request → aguarda response → request (round-trip obrigatório)
- Solução: enviar `fbupdatereq` a cada 50ms sem esperar resposta anterior

**Framerate**: não é fixo — dinâmico baseado em interação do usuário. Sem interação: ~1 frame/1.5s. Com interação de mouse: ~30 FPS.

**Para maximizar performance noVNC**:
- Usar KasmVNC no servidor (fork otimizado — entrega 60 FPS @ 1080p)
- Configurar `fbu_req_rate` mais agressivo
- Usar encoding Tight com JPEG para menor bandwidth

### 7.3 RustDesk

**Arquitetura**: Protobuf binário over WebSocket (para web client) ou TCP direto (para native clients)

RustDesk usa uma pipeline sofisticada:

1. **Captura**: APIs nativas por plataforma (Desktop Duplication API no Windows, etc.)
2. **Encoding**: VP8, VP9, AV1, H.264, H.265 — negociado automaticamente entre peers
3. **Transport (native)**: TCP com framing protobuf
4. **Transport (web client)**: WebSocket com mesmo protocolo protobuf binário (desde v1.4.0)

O módulo `websock.ts` do web client:
- Envia/recebe `ArrayBuffer`/`Uint8Array` (binário)
- Queue de envio com buffer enquanto conectando/reconectando
- WebSocket neste contexto suporta apenas **relay connections** (não P2P direto)

**Latência RustDesk**:
- LAN com cable: até ~120 ms end-to-end
- Com hardware codec H.264/H.265: pode ter delay de vários segundos (bug com certos drivers GPU)
- Target: 30 FPS

**Codec negotiation**: `get_encoder_config()` seleciona o encoder baseado em capacidades do peer. Se o peer suporta H.264 hardware, usa. Caso contrário, fallback para VP9 software.

### 7.4 Selkies-GStreamer (referência de alta performance)

**Arquitetura**: WebRTC com GStreamer pipeline

- Pipeline GStreamer captura tela → encode H.264/VP8/VP9 (hardware ou software) → WebRTC
- Latência alvo: < 50 ms (TURN server a < 50 ms de ambos os peers)
- WebSocket usado apenas para **signaling** (SDP, ICE candidates)
- H.264 com hardware acceleration (NVENC, VAAPI) é o codec principal

Este projeto demonstra o teto de performance alcançável: WebRTC + H.264 HW encoding é o estado da arte para remote desktop via browser.

### 7.5 Myrtille (HTML4/HTML5 RDP via WebSocket)

**Arquitetura**: RDP client no servidor → WebSocket → browser

- Stream de tela via WebSocket com encoding WebP
- Suporte a fallback HTML4 (para proxies que bloqueiam WebSocket)
- Combina RDP nativo (para controle do Windows) com WebSocket (para browser delivery)

### 7.6 Resumo comparativo de arquiteturas

| Projeto | Transport | Codec tela | Canal input | Latência típica |
|---|---|---|---|---|
| Guacamole | WebSocket (texto) | PNG/JPEG (via guacamole protocol) | Mesmo WebSocket | 100–300 ms |
| noVNC | WebSocket (binário VNC) | Raw/JPEG/Tight/H.264 | Mesmo WebSocket | 100–500 ms |
| RustDesk web | WebSocket (protobuf) | VP9/H.264/AV1 | Mesmo WebSocket | 120–300 ms |
| Selkies | WebRTC | H.264/VP8/VP9 | WebSocket separado | 20–80 ms |
| Myrtille | WebSocket | WebP/JPEG | Mesmo WebSocket | 80–200 ms |
| MJPEG WS | WebSocket (binário) | JPEG | WebSocket separado | 50–150 ms |

---

## 8. Comparação de Codecs/Formatos para Remote Desktop via WebSocket

### 8.1 Matriz de comparação

| Codec | Latência | Banda (1080p@30) | CPU encode | CPU decode | Browser decode | Temporal compress | Complexidade |
|---|---|---|---|---|---|---|---|
| **JPEG** | ⭐⭐⭐⭐ | Alta (3–8 Mbps) | Muito baixo | Muito baixo | Nativo | Não | Mínima |
| **WebP** | ⭐⭐⭐ | Média (2–6 Mbps) | Baixo-médio | Baixo | Nativo | Não | Baixa |
| **PNG** | ⭐⭐⭐⭐ | Muito alta | Baixo | Baixo | Nativo | Não | Mínima |
| **H.264 SW** | ⭐⭐⭐ | Baixa (1–3 Mbps) | Alto | Baixo | WebCodecs/MSE | Sim | Alta |
| **H.264 HW** | ⭐⭐⭐⭐⭐ | Baixa (1–3 Mbps) | Mínimo | Mínimo | WebCodecs/MSE | Sim | Alta |
| **VP9** | ⭐⭐⭐ | Baixa (0.5–2 Mbps) | Muito alto | Médio | WebCodecs | Sim | Alta |
| **AV1** | ⭐⭐ | Muito baixa | Extremamente alto | Médio-alto | WebCodecs | Sim | Muito alta |

### 8.2 JPEG — o caso para remote desktop simples

**Prós:**
- Decodificação em hardware em todos os devices (incluindo mobile)
- Zero dependência de APIs de vídeo (`WebCodecs`, `MSE`)
- Cada frame independente = sem propagação de erro
- Latência previsível e consistente
- `libjpeg-turbo` faz encode de 1080p em ~3–5 ms em CPU moderna
- Qualidade ajustável dinamicamente sem renegociação

**Contras:**
- Sem compressão temporal — regiões estáticas são reenviadas a cada frame
- Chroma subsampling pode deteriorar texto fino (usar 4:4:4 para UI)
- ~3–10× mais banda que H.264 para conteúdo com movimento

**Otimização com jpegli (Google)**: o encoder `jpegli` (drop-in replacement da libjpeg) oferece 20–30% menos tamanho para mesma qualidade visual, usando quantização adaptativa baseada em JPEG XL. Reduz a diferença de banda vs H.264.

### 8.3 WebP — melhor ou pior que JPEG para streaming?

WebP oferece 25–35% menos bytes que JPEG equivalente, mas:

- Encode é 2–4× mais lento que JPEG (relevante para real-time)
- Decode é ligeiramente mais lento que JPEG
- A vantagem de tamanho é parcialmente anulada pelo overhead de tempo de encode
- WebP tem "quality ceiling" baixo — não consegue ser perceptualmente lossless (score < 90 em SSIMULACRA2)
- Para texto/UI (principal caso do remote desktop), JPEG com qualidade 80–85 é geralmente superior

**Conclusão**: WebP não vale a pena para MJPEG streaming em real-time. O overhead de encode cancela o ganho de banda.

### 8.4 H.264 — o padrão ouro com hardware

Com hardware encoding (NVENC, VAAPI, VideoToolbox):
- Encode: < 2 ms latência adicional
- Decode: hardware-accelerated em browsers via WebCodecs API
- Compressão temporal elimina a necessidade de retransmitir regiões estáticas
- Suporte a "zero-latency" mode (sem B-frames, buffer mínimo de referência)

**Configuração para latência mínima (ffmpeg)**:
```
-c:v libx264 -preset ultrafast -tune zerolatency
-x264-params "nal-hrd=cbr:force-cfr=1"
-b:v 2M -minrate 2M -maxrate 2M -bufsize 1M
```

**Desafio**: H.264 via WebSocket requer `WebCodecs API` ou `MSE` para decodificação no browser — significativamente mais complexo que JPEG + canvas.

### 8.5 VP9 — melhor qualidade mas mais CPU

VP9 oferece ~30% melhor compressão que H.264, mas:
- Software encode é 4–8× mais lento que H.264 SW
- Hardware encode (VP9): suportado em Intel (VAAPI), NVIDIA (NVENC ≥ Turing), AMD
- RustDesk usa VP9 como codec primário (com fallback)
- Para remote desktop texto/UI, VP9 não oferece vantagem visual significativa vs H.264

### 8.6 AV1 — futuro mas impraticável hoje

AV1 oferece ~50% melhor compressão que H.264, mas:
- Software encode: 3–5× mais lento que VP9 (proibitivo para real-time)
- Hardware encode: apenas NVIDIA RTX 30+ series, Intel Arc, AMD RX 7000+
- Inclui ferramentas específicas para screen content (`INTRA_EDGE_FILTER`, pallete mode)
- Latência de encode HW: comparável ao H.264 HW
- Ainda em adoção — não recomendado como codec primário sem HW accel garantido

### 8.7 Recomendações práticas por cenário

| Cenário | Codec recomendado | Justificativa |
|---|---|---|
| LAN, implementação simples | JPEG (q=75) via WebSocket | Mínimo código, latência <100ms, sem deps |
| LAN, menor banda | H.264 HW (se disponível) | Melhor compressão, latência comparável |
| WAN/Internet, conexão instável | MJPEG com adaptive quality | Frames independentes = sem cascata de erros |
| Máxima performance (gaming) | WebRTC + H.264 HW ou AV1 HW | Estado da arte; requer infra adicional |
| Compatibilidade máxima | MJPEG (HTTP Multipart ou WebSocket) | Suportado em tudo |
| Conteúdo estático (UI, texto) | JPEG q=85 + skip redundant frames | Melhor qualidade/latência para UI |

---

## 9. Implementação Prática — MJPEG sobre WebSocket

### 9.1 Arquitetura de referência para remote browser

```
[Chromium headless]
      |
      | CDP screencasting / X11 / framebuffer
      v
[Capture + JPEG encode]  <-- libjpeg-turbo ou sharp (Node.js)
      |
      | Binary WebSocket frame (no permessage-deflate)
      v
[Browser client]
      |
      | createImageBitmap() + canvas.drawImage()
      v
[Screen rendered]

[Input events] --> [WebSocket (same or separate)] --> [Server input handler]
```

### 9.2 Configurações recomendadas

**Servidor (Node.js com `ws` library):**
```javascript
const wss = new WebSocketServer({
  port: 8080,
  perMessageDeflate: false,     // JPEG já é comprimido
  maxPayload: 5 * 1024 * 1024,  // 5MB max frame
});

// Captura e encoding
const JPEG_QUALITY = 75;  // 70-80 para UI
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

let lastFrameTime = 0;
let frameInFlight = false;

async function captureAndSend(ws) {
  const now = Date.now();
  if (now - lastFrameTime < FRAME_INTERVAL_MS) return;
  if (frameInFlight) return;  // skip se anterior não enviou ainda
  if (ws.bufferedAmount > 0) return;  // backpressure: skip se buffer não esvaziou

  frameInFlight = true;
  lastFrameTime = now;

  try {
    const jpeg = await captureScreen({ quality: JPEG_QUALITY });
    ws.send(jpeg, { binary: true }, () => { frameInFlight = false; });
  } catch(e) {
    frameInFlight = false;
  }
}
```

**Cliente (browser):**
```javascript
const ws = new WebSocket('wss://server/stream');
ws.binaryType = 'arraybuffer';

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
let latestFrame = null;
let rendering = false;

ws.onmessage = (event) => {
  latestFrame = event.data;  // sempre substitui — nunca enfileira
};

async function renderLoop() {
  if (latestFrame && !rendering) {
    rendering = true;
    const frame = latestFrame;
    latestFrame = null;

    try {
      const blob = new Blob([frame], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);  // mais rápido que <img>
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    } finally {
      rendering = false;
    }
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
```

### 9.3 Medição de latência no cliente

```javascript
// Adicionar timestamp no frame (primeiros 8 bytes = timestamp do servidor)
ws.onmessage = (event) => {
  const data = new DataView(event.data);
  const serverTs = data.getFloat64(0, false);  // big-endian
  const clientTs = performance.now();
  const latency = clientTs - serverTs;         // ms de latência e2e
  console.log(`Frame latency: ${latency.toFixed(1)}ms`);

  // Resto do buffer é o JPEG
  latestFrame = event.data.slice(8);
};
```

---

## 10. Conclusões e Recomendações para o Projeto

### MJPEG over WebSocket é viável para remote browser com:

- **Latência alcançável**: 50–100 ms em LAN, 80–200 ms em WAN (com RTT de rede < 50 ms)
- **FPS recomendado**: 20–30 FPS (ideal para interatividade de UI — acima de 30 FPS, o ganho de percepção é marginal para desktop)
- **Qualidade JPEG**: 70–80 para UI/texto; 60 para menor banda
- **Banda consumida**: ~1–4 Mbps @ 1080p @ 30 FPS com q=75 (variável por complexidade da tela)

### Comparado ao WebRTC atual do projeto:

| Aspecto | MJPEG WebSocket | WebRTC atual |
|---|---|---|
| Latência (LAN) | 50–100 ms | 20–80 ms |
| Complexidade | Muito baixa | Alta |
| Infraestrutura | WebSocket server apenas | STUN/TURN + signaling |
| Manutenção | Simples | Complexa |
| Debug | Fácil | Difícil |
| Fallback | Qualquer browser | Pode falhar com firewalls |
| Banda | 2–4× mais que H.264 | Eficiente |

### Recomendação:

Para o projeto remote-browser, **MJPEG over WebSocket é uma excelente opção de fallback ou solução principal** quando:
1. Latência < 150 ms é aceitável para o uso-case
2. Banda disponível é > 2 Mbps
3. Simplicidade operacional tem prioridade
4. Usuários estão em LAN ou rede de baixa latência

Para casos que exigem < 50 ms ou banda muito restrita, manter WebRTC como solução primária e MJPEG WS como fallback robusto.

---

## Fontes

- [WebRTC Latency: Comparing Low-Latency Streaming Protocols (nanocosmos)](https://www.nanocosmos.net/blog/webrtc-latency/)
- [Low latency streaming - IPCamLive](https://www.ipcamlive.com/low-latency-websocket-streaming)
- [HTTP Streaming vs WebSockets - VideoSDK](https://videosdk.live/developer-hub/websocket/http-streaming-vs-websockets)
- [HLS vs MJPEG Comparison - VideoSDK](https://www.videosdk.live/developer-hub/hls/hls-vs-mjpeg)
- [GitHub - EMJPEGStreamer (Kjos)](https://github.com/Kjos/EMJPEGStreamer)
- [Configuring WebSocket Compression - igvita.com](https://www.igvita.com/2013/11/27/configuring-and-optimizing-websocket-compression/)
- [Adaptive buffering for semi-realtime MJPEG - ffmediaelement](https://github.com/unosquare/ffmediaelement/issues/72)
- [MJPEG and H.264 Comparison - e-con Systems](https://www.e-consystems.com/blog/camera/technology/a-comprehensive-study-mjpeg-and-h-264-compression-in-embedded-vision/)
- [Latency in live network video surveillance - Axis](https://www.axis.com/dam/public/9d/e4/5d/latency-in-live-network-video-surveillance-en-US-190945.pdf)
- [The Guacamole protocol - Apache Guacamole](https://guacamole.apache.org/doc/0.9.6/gug/guacamole-protocol.html)
- [How Does Guacamole compare to noVNC? - SourceForge](https://sourceforge.net/p/guacamole/discussion/1110834/thread/00b95bb2/)
- [Video Capture and Encoding - RustDesk DeepWiki](https://deepwiki.com/rustdesk/rustdesk/5.1-video-capture-and-encoding)
- [Web Client - RustDesk DeepWiki](https://deepwiki.com/rustdesk/rustdesk/4.3-web-client)
- [Low-latency streaming discussion - RustDesk GitHub](https://github.com/rustdesk/rustdesk/discussions/3979)
- [How we built sub-80ms remote desktop - Medium](https://medium.com/@huyhoangdo/how-we-have-built-a-sub-80ms-latency-open-source-remote-desktop-application-part-one-75a20963ed83)
- [Selkies - Open-Source WebRTC Remote Desktop](https://github.com/selkies-project/selkies)
- [WebSocket Communication noVNC - DeepWiki](https://deepwiki.com/larryprice/novnc-core/3.3-websocket-communication)
- [Optimize performance of noVNC - Proxmox Forum](https://forum.proxmox.com/threads/optimize-performance-of-novnc.68070/)
- [Streaming lossless VNC with QOI format - Hacker News](https://news.ycombinator.com/item?id=33839326)
- [Comparison of WebRTC Codecs for Screen Sharing](https://www.webrtc-developers.com/comparison-of-webrtc-codecs-for-video-and-screen-sharing/)
- [Screen Sharing with WebRTC: Finding Best Encoder - gethopp](https://www.gethopp.app/blog/screensharing-encoders-compared)
- [WebRTC video codec generations - bloggeek.me](https://bloggeek.me/webrtc-video-codec-generations/)
- [GitHub - raspivid_mjpeg_server (kig)](https://github.com/kig/raspivid_mjpeg_server)
- [GitHub - websocket-videostream (desaintmartin)](https://github.com/desaintmartin/websocket-videostream)
- [Is WebP really better than JPEG? - siipo.la](https://siipo.la/blog/is-webp-really-better-than-jpeg)
- [Performance evaluation of WebSocket protocol - ResearchGate](https://www.researchgate.net/publication/269031593_Performance_evaluation_of_Websocket_protocol_for_implementation_of_full-duplex_web_streams)
