# @roamhq/wrtc - Pesquisa Completa

> Fork ativo do node-webrtc. Bindings nativos para libwebrtc (WebRTC M98) em Node.js.

---

## 1. O Que e @roamhq/wrtc

`@roamhq/wrtc` e o fork mantido ativamente do projeto original `node-webrtc` (pacote npm `wrtc`). O repositorio original esta abandonado (parado no WebRTC M87, sem suporte a Node 20+). O fork atualiza os bindings para **WebRTC M98**, suporta **Node 20 e 22**, e fornece prebuilt binaries para as principais plataformas.

- **NPM**: `npm install @roamhq/wrtc`
- **GitHub**: https://github.com/cubicleai/wrtc (cubicleai e a organizacao que mantem)
- **Versao atual**: 0.9.1
- **Downloads semanais**: ~11.400
- **Plano**: Uma vez estavel, sera mergeado de volta no repositorio original `node-webrtc`

### Plataformas suportadas (prebuilt binaries)

| Node | Linux x64 | Linux arm64 | macOS x64 | macOS arm64 | Windows x64 |
|------|-----------|-------------|-----------|-------------|-------------|
| 20   | Sim       | Incerto     | Sim       | Sim         | Sim         |
| 22   | Sim       | Incerto     | Sim       | Sim         | Sim         |

- Node 23+ **nao** tem binaries pre-compilados (erros reportados)
- Usa N-API version 3, entao pode funcionar em outras versoes nao listadas
- Linux arm64 ainda nao esta confirmado oficialmente

### Diferenca do original (node-webrtc)

| Aspecto | node-webrtc (wrtc) | @roamhq/wrtc |
|---------|-------------------|--------------|
| Status | Abandonado | Mantido ativamente |
| WebRTC | M81/M87 | M98 |
| Node.js | Ate Node 16 | Node 20, 22 |
| H264 no build | Nao | cubicleai/wrtc indica builds com H264 habilitado |
| Apple Silicon | Nao | Sim |

---

## 2. RTCVideoSource - Como Funciona

A API principal para injetar video programaticamente e a **RTCVideoSource**, exposta via `nonstandard`:

```js
const { nonstandard } = require('@roamhq/wrtc');
const { RTCVideoSource, RTCVideoSink, i420ToRgba, rgbaToI420 } = nonstandard;
```

### Interface

```
RTCVideoSource
  - readonly isScreencast: boolean
  - readonly needsDenoising: boolean | null
  - createTrack(): MediaStreamTrack
  - onFrame(frame: RTCVideoFrame): void

RTCVideoSourceInit
  - isScreencast: boolean (default: false)
  - needsDenoising: boolean (opcional)

RTCVideoFrame
  - width: number
  - height: number
  - data: Uint8ClampedArray  (I420 format, tamanho = width * height * 1.5)
  - rotation: 0 | 90 | 180 | 270 (opcional)
```

### Fluxo de uso

```js
const source = new RTCVideoSource({ isScreencast: true });
const track = source.createTrack();

// Adicionar ao PeerConnection
pc.addTrack(track);

// Loop de frames
const width = 1280;
const height = 720;
const frameSize = width * height * 1.5; // I420 = Y + U/4 + V/4

setInterval(() => {
  const data = new Uint8ClampedArray(frameSize);
  // ... preencher data com pixels I420 ...
  source.onFrame({ width, height, data });
}, 1000 / 30); // 30 fps
```

**Pontos-chave:**
- `createTrack()` retorna um `MediaStreamTrack` padrao que pode ser adicionado a qualquer `RTCPeerConnection`
- `onFrame()` empurra o frame para **todos** os tracks criados a partir desse source que nao estejam parados
- O frame rate e controlado inteiramente pela frequencia com que voce chama `onFrame()` - nao ha cap interno
- `isScreencast: true` sinaliza ao encoder que e screencast (muda heuristicas de encoding - menos smoothing, mais fidelidade de detalhe)

---

## 3. Formato I420 - Como Injetar Frames Raw

O formato I420 (YUV 4:2:0 planar) organiza os dados assim:

```
[Y plane: width * height bytes]
[U plane: (width/2) * (height/2) bytes]
[V plane: (width/2) * (height/2) bytes]
Total = width * height * 1.5 bytes
```

### Conversao RGBA <-> I420

A biblioteca inclui bindings para libyuv:

```js
const { i420ToRgba, rgbaToI420 } = require('@roamhq/wrtc').nonstandard;

// RGBA -> I420 (para enviar)
const rgbaData = new Uint8ClampedArray(width * height * 4);
const i420Data = new Uint8ClampedArray(width * height * 1.5);
rgbaToI420({
  width, height,
  data: rgbaData     // input RGBA
}, {
  width, height,
  data: i420Data     // output I420
});

// I420 -> RGBA (para processar/exibir)
const outputRgba = new Uint8ClampedArray(width * height * 4);
i420ToRgba({
  width, height,
  data: i420Data     // input I420
}, {
  width, height,
  data: outputRgba   // output RGBA
});
```

### Fontes tipicas de frames I420

1. **FFmpeg via pipe stdout**: Decodifica qualquer formato para raw I420
   ```bash
   ffmpeg -i input.mp4 -f rawvideo -pix_fmt yuv420p pipe:1
   ```
2. **Canvas (node-canvas)**: Gera RGBA, converte via `rgbaToI420()`
3. **CDP screencast**: Recebe JPEG/PNG, decodifica para RGBA, converte para I420
4. **Sharp/jimp**: Processa imagem, extrai RGBA buffer
5. **X11 capture**: `xwd` ou `xdotool` + `convert` para raw pixels

---

## 4. RTCVideoSink - Recebendo Frames

```js
const sink = new RTCVideoSink(remoteTrack);

sink.addEventListener('frame', ({ frame }) => {
  // frame.width, frame.height, frame.data (I420 Uint8ClampedArray)
  console.log(`Received ${frame.width}x${frame.height} frame`);
});

// Quando terminar:
sink.stop();
```

---

## 5. RTCAudioSource e RTCAudioSink

Similar ao video, mas para audio:

```js
const { RTCAudioSource, RTCAudioSink } = require('@roamhq/wrtc').nonstandard;

const audioSource = new RTCAudioSource();
const audioTrack = audioSource.createTrack();

// Enviar audio: 10ms de samples 16-bit
audioSource.onData({
  samples: new Int16Array(480),  // 48000 Hz / 100 = 480 samples por 10ms
  sampleRate: 48000,
  bitsPerSample: 16,
  channelCount: 1,
  numberOfFrames: 480
});
```

---

## 6. Uso com TURN Servers

A configuracao de ICE servers segue a API padrao W3C:

```js
const { RTCPeerConnection } = require('@roamhq/wrtc');

const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:turn.example.com:3478?transport=udp',
        'turn:turn.example.com:3478?transport=tcp',
        'turns:turn.example.com:5349?transport=tcp'
      ],
      username: 'user',
      credential: 'pass'
    }
  ],
  // Forcar uso exclusivo de TURN (util para teste):
  // iceTransportPolicy: 'relay'
});
```

### Configuracao de portRange (API nao-padrao)

```js
const pc = new RTCPeerConnection({
  iceServers: [...],
  portRange: {
    min: 10000,
    max: 10100
  }
});
```

Isso limita as portas usadas pelo ICE transport - util em ambientes com firewall restrito.

---

## 7. Problemas Conhecidos com ICE Gathering

### Problema 1: Ausencia de candidatos srflx

Quando o node-webrtc esta atuando como answerer e ja tem host candidates validos, pode completar o ICE gathering **antes** de obter candidatos server-reflexive (srflx). Resultado: em logs parece que STUN nao funcionou, mas na verdade o ICE terminou cedo.

### Problema 2: TURN relay candidates nao aparecendo

Reportado com simple-peer + wrtc: mesmo com `iceTransportPolicy: 'relay'` e credenciais validas de TURN, relay candidates nao sao gerados. Causas comuns:
- Formato incorreto das URLs do TURN server
- TURN server inacessivel na porta configurada
- Credenciais incorretas ou expiradas
- Firewall bloqueando UDP/TCP na porta do TURN

### Problema 3: Falhas silenciosas

Muitos erros de ICE falham silenciosamente na camada JS. Recomendacao:

```js
pc.addEventListener('icecandidateerror', (event) => {
  console.error(`ICE error: code=${event.errorCode}, url=${event.url}, text=${event.errorText}`);
  // errorCode < 700: problema no STUN/TURN server
  // errorCode >= 700: problema local (browser/runtime)
});

pc.addEventListener('iceconnectionstatechange', () => {
  console.log('ICE state:', pc.iceConnectionState);
});

pc.addEventListener('icegatheringstatechange', () => {
  console.log('ICE gathering:', pc.iceGatheringState);
});
```

### Diagnostico

1. Testar TURN server com Trickle ICE: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
2. Verificar se relay candidates aparecem quando `iceTransportPolicy: 'relay'`
3. Conferir logs do coturn: `journalctl -f -u coturn.service`
4. Em 90% dos cenarios STUN e suficiente; TURN e fallback

---

## 8. Performance de Encoding VP8/VP9

### VP8

- **Codec obrigatorio** na spec WebRTC (RFC 7742) - garantido funcionar com todos os browsers
- **Sem aceleracao de hardware** na maioria dos desktops/laptops (mesmo 12+ anos apos lancamento)
- Performance adequada ate ~600 kbps
- CPU moderada-alta, pode ser problematica em sessoes longas ou multi-participante
- No servidor (node-webrtc), o encoding VP8 e feito pela libwebrtc em software
- Em Raspberry Pi, encoding VP8 via RTCVideoSource consome CPU significativa

### VP9

- ~50% melhor compressao que VP8 para mesma qualidade
- CPU ligeiramente maior que VP8
- Suporte a hardware decoder crescendo, mas ainda nao universal
- Google usa VP9 internamente no Google Meet
- Boa escolha quando bandwidth e limitado

### Comparativo

| Codec | CPU (encoding) | Hardware Accel | Compressao vs VP8 | Royalty-free |
|-------|---------------|----------------|-------------------|--------------|
| VP8   | Moderada-alta | Nao            | Baseline          | Sim          |
| VP9   | ~VP8 + 10%   | Parcial        | ~50% melhor       | Sim          |
| H.264 | Baixa (HW)   | Sim            | Similar VP8       | Licenciado   |

### Impacto de resolucao no encoding server-side

- 320x240 @ 30fps: CPU baixa, viavel em hardware modesto
- 720p @ 30fps: CPU moderada, precisa de servidor dedicado
- 1080p @ 30fps: CPU alta, pode nao manter 30fps em encoding software
- 2800x1752: Reportado cair para ~20fps mesmo com tela vazia

---

## 9. Suporte a H.264

### Estado atual

- H.264 **nao esta habilitado por padrao** nos builds prebuilt de `@roamhq/wrtc` no Linux
- A razao: `proprietary_codecs` defaults to `false` em builds nao-Chrome-branded
- O `cubicleai/wrtc` CHANGELOG menciona "Builds with H.264 enabled" para M95+
- Se o prebuilt nao incluir H264, voce nao vera H264 no SDP offer/answer

### Como habilitar (build from source)

Requer compilar o libwebrtc com flags:
```
gn gen out/Release --args="proprietary_codecs=true rtc_use_h264=true rtc_initialize_ffmpeg=true"
```

- **Encoder**: OpenH264 (Cisco) - software only, apenas Constrained Baseline Profile
- **Decoder**: FFmpeg (precisa de `rtc_initialize_ffmpeg=true`)
- OpenH264 e licenciado mas Cisco paga a licenca, permitindo uso gratuito

### Recomendacao pratica

Para uso com browser clients:
- **VP8** e a escolha mais segura e universal
- **VP9** se precisa de melhor compressao e aceita um pouco mais de CPU
- **H264** so se precisa de compatibilidade com dispositivos especificos (iOS nativo, hardware decoders) e esta disposto a fazer build from source

---

## 10. Media Stream de Fonte Customizada (nao-camera)

Este e o caso de uso principal para remote-browser: capturar tela de um X11 display ou via CDP e enviar como stream WebRTC.

### Abordagem 1: RTCVideoSource direto (recomendado)

```js
const { RTCVideoSource } = require('@roamhq/wrtc').nonstandard;
const { RTCPeerConnection } = require('@roamhq/wrtc');

// 1. Criar source e track
const source = new RTCVideoSource({ isScreencast: true });
const track = source.createTrack();

// 2. Criar PeerConnection e adicionar track
const pc = new RTCPeerConnection({ iceServers: [...] });
pc.addTrack(track);

// 3. Signaling (SDP offer/answer)
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
// ... enviar offer para o browser, receber answer ...
await pc.setRemoteDescription(answer);

// 4. Loop de captura
async function captureLoop() {
  while (running) {
    const screenshot = await captureScreen(); // CDP, X11, etc
    const i420Frame = convertToI420(screenshot, width, height);
    source.onFrame({ width, height, data: i420Frame });
    await sleep(33); // ~30fps
  }
}
```

### Abordagem 2: FFmpeg pipe -> RTCVideoSource

```js
const { spawn } = require('child_process');

// FFmpeg captura X11 display e output raw I420
const ffmpeg = spawn('ffmpeg', [
  '-f', 'x11grab',
  '-video_size', '1280x720',
  '-framerate', '30',
  '-i', ':0',
  '-f', 'rawvideo',
  '-pix_fmt', 'yuv420p',
  'pipe:1'
]);

const frameSize = 1280 * 720 * 1.5;
let buffer = Buffer.alloc(0);

ffmpeg.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= frameSize) {
    const frameData = new Uint8ClampedArray(buffer.slice(0, frameSize));
    source.onFrame({ width: 1280, height: 720, data: frameData });
    buffer = buffer.slice(frameSize);
  }
});
```

### Abordagem 3: CDP Screencast -> RGBA -> I420

```js
const sharp = require('sharp');
const { rgbaToI420 } = require('@roamhq/wrtc').nonstandard;

async function onScreencastFrame(base64Data) {
  const jpegBuffer = Buffer.from(base64Data, 'base64');
  const { data: rgbaBuffer, info } = await sharp(jpegBuffer)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const i420Data = new Uint8ClampedArray(info.width * info.height * 1.5);
  rgbaToI420(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(rgbaBuffer) },
    { width: info.width, height: info.height, data: i420Data }
  );

  source.onFrame({ width: info.width, height: info.height, data: i420Data });
}
```

---

## 11. Limitacoes Conhecidas

### Performance
- **Encoding VP8/VP9 e 100% software** no servidor - consome CPU significativa
- Em 1080p@30fps, pode nao manter framerate em hardware modesto
- Conversao RGBA->I420 adiciona overhead (usar libyuv via `rgbaToI420` e muito mais rapido que JS puro)
- Node.js single-threaded: frame processing compete com o event loop

### Memoria
- **Memory leaks reportados** em versoes anteriores do node-webrtc (v0.4.0) durante streaming longo
- Leak em `createOffer`, `createAnswer`, `addIceCandidate`, `getStats` (corrigido em releases posteriores)
- Frame accumulation: se `onFrame()` e chamado mais rapido que o encoder consome, frames acumulam

### CPU
- **PeerConnectionFactory proliferation**: Historicamente, cada PeerConnection criava uma factory separada, causando CPU escalar linearmente. Corrigido compartilhando uma factory unica.
- Topou em ~84 PeerConnections simultaneas antes do fix
- Encoding e o maior consumidor de CPU

### Binarios
- Node 23+ nao tem prebuilt binary
- Linux arm64 nao confirmado
- WSL2 pode ter problemas para localizar o binary
- Se o binary nao for encontrado: `Error: Could not find wrtc binary on any of the paths`

### ICE/Networking
- Candidatos srflx podem nao ser coletados quando ICE completa cedo
- TURN relay candidates podem nao aparecer com configuracao incorreta
- Falhas de ICE frequentemente silenciosas na camada JS

### Codecs
- H264 provavelmente desabilitado nos prebuilt binaries Linux
- Sem controle direto sobre parametros do encoder (bitrate, keyframe interval) via API JS
- O codec e negociado via SDP, nao pela aplicacao diretamente

---

## 12. Comparacao: @roamhq/wrtc vs node-webrtc vs werift

| Aspecto | node-webrtc (wrtc) | @roamhq/wrtc | werift |
|---------|-------------------|--------------|--------|
| **Status** | Abandonado | Ativo | Ativo (early-stage) |
| **Linguagem** | C++ Native Addon | C++ Native Addon | Pure TypeScript |
| **WebRTC version** | M81/M87 | M98 | Implementacao propria |
| **Node.js** | Ate 16 | 20, 22 | 16+ |
| **Prebuilt binaries** | Sim (desatualizados) | Sim | N/A (sem codigo nativo) |
| **RTCVideoSource** | Sim | Sim (mesma API) | Nao (opera em RTP packets) |
| **Encoding integrado** | VP8, VP9, (H264 build flag) | VP8, VP9, (H264 build flag) | Nenhum - voce faz encoding |
| **Custom video source** | `onFrame()` com I420 | `onFrame()` com I420 | `writeRtp()` com packets codificados |
| **i420/RGBA helpers** | Sim (libyuv bindings) | Sim (libyuv bindings) | Nao |
| **ICE** | Completo | Completo | Completo (exceto ICE restart, TURN TLS) |
| **DTLS** | Completo | Completo | Completo |
| **DataChannel** | Completo | Completo | Completo |
| **getStats** | Sim | Sim | Nao |
| **Simulcast** | Sim | Sim | Nao (send) |
| **Hardware accel** | Nao em server | Nao em server | N/A |
| **Facilidade de uso** | Alta (API browser-like) | Alta (API browser-like) | Baixa (opera em RTP) |
| **Performance encoding** | Alta (libwebrtc C++) | Alta (libwebrtc C++) | Depende do encoder externo |
| **Instalacao** | Pode falhar (Node antigo) | Prebuilt funciona | `npm install` (JS puro) |

### Quando usar cada um

**@roamhq/wrtc** (recomendado para remote-browser):
- Precisa de encoding embutido (VP8/VP9)
- Quer API simples: `onFrame()` com I420 frames
- Precisa de compatibilidade total com browsers
- Aceita dependencia de native addon

**werift**:
- Quer zero dependencias nativas (deploy em qualquer lugar)
- Ja tem pipeline de encoding externo (FFmpeg)
- Precisa de controle total sobre RTP packets
- Aceita complexidade extra no codigo
- Limitacoes: sem ICE restart, sem TURN TLS/TCP, sem getStats, sem simulcast send

**node-webrtc original**:
- Nao recomendado. Abandonado, sem suporte Node 20+.

---

## 13. Dicas Praticas para Nosso Caso (Remote Browser)

### Configuracao otima para screencast

```js
const source = new RTCVideoSource({
  isScreencast: true,    // Otimiza encoder para tela (menos temporal smoothing)
  needsDenoising: false  // Tela nao precisa de denoising
});
```

### Gerenciamento de framerate adaptativo

```js
let targetFps = 30;
let lastFrameTime = 0;

function pushFrame(i420Data, width, height) {
  const now = Date.now();
  const elapsed = now - lastFrameTime;
  const minInterval = 1000 / targetFps;

  if (elapsed < minInterval) return; // Drop frame se muito rapido

  source.onFrame({ width, height, data: i420Data });
  lastFrameTime = now;
}

// Adaptar fps baseado em feedback
pc.addEventListener('connectionstatechange', () => {
  if (pc.connectionState === 'connected') {
    // Poderia ajustar targetFps baseado em stats
  }
});
```

### Cleanup correto (evitar memory leaks)

```js
function cleanup() {
  // 1. Parar tracks
  track.stop();

  // 2. Parar sinks (se houver)
  if (sink) sink.stop();

  // 3. Fechar PeerConnection
  pc.close();

  // 4. Nullificar referencias
  source = null;
  track = null;
  pc = null;
}
```

### Monitoramento de stats

```js
async function logStats() {
  const stats = await pc.getStats();
  stats.forEach(report => {
    if (report.type === 'outbound-rtp' && report.kind === 'video') {
      console.log({
        codec: report.codecId,
        bytesSent: report.bytesSent,
        framesSent: report.framesSent,
        framesEncoded: report.framesEncoded,
        framesPerSecond: report.framesPerSecond,
        qualityLimitationReason: report.qualityLimitationReason
      });
    }
  });
}
setInterval(logStats, 5000);
```

---

## 14. Referencias

- [@roamhq/wrtc npm](https://www.npmjs.com/package/@roamhq/wrtc)
- [cubicleai/wrtc GitHub](https://github.com/cubicleai/wrtc)
- [cubicleai/wrtc CHANGELOG](https://github.com/cubicleai/wrtc/blob/main/CHANGELOG.md)
- [node-webrtc original](https://github.com/node-webrtc/node-webrtc)
- [Nonstandard APIs doc (RTCVideoSource, RTCVideoSink, etc)](https://github.com/node-webrtc/node-webrtc/blob/develop/docs/nonstandard-apis.md)
- [node-webrtc examples (video-compositing, loopback)](https://github.com/node-webrtc/node-webrtc-examples)
- [werift-webrtc GitHub](https://github.com/shinyoshiaki/werift-webrtc)
- [werift docs](https://shinyoshiaki.github.io/werift-webrtc/website/build/docs/)
- [H264 support issue #431](https://github.com/node-webrtc/node-webrtc/issues/431)
- [High CPU issue #758](https://github.com/node-webrtc/node-webrtc/issues/758)
- [Memory leak issue #528](https://github.com/node-webrtc/node-webrtc/issues/528)
- [CPU escalation issue #340](https://github.com/node-webrtc/node-webrtc/issues/340)
- [ICE srflx candidates issue #293](https://github.com/node-webrtc/node-webrtc/issues/293)
- [Hacker News discussion](https://news.ycombinator.com/item?id=37774807)
- [WebRTC codecs comparison](https://www.webrtc-developers.com/comparison-of-webrtc-codecs-for-video-and-screen-sharing/)
- [WebRTC codec performance evaluation](http://www.rtcbits.com/2021/02/webrtc-video-codecs-performance.html)
- [TURN server guide](https://webrtc.org/getting-started/turn-server)
- [Trickle ICE test tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
- [MDN - WebRTC codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)
