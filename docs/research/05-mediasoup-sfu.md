# mediasoup como SFU para Remote Browser Streaming

**Data:** 2026-03-17
**Escopo:** Como mediasoup funciona como SFU em Node.js, injeção de vídeo de fonte customizada, uso com x11grab/CDP, latência real, comparação com WebRTC direto, projetos existentes.

---

## 1. O que é mediasoup

mediasoup é uma biblioteca Node.js (e Rust crate) que implementa um **SFU (Selective Forwarding Unit)** WebRTC. Diferente de servidores de mídia monolíticos, mediasoup é uma biblioteca de baixo nível que se integra dentro da aplicação — não é um processo separado como Janus ou Jitsi.

Repositório oficial: https://github.com/versatica/mediasoup
Documentação: https://mediasoup.org/documentation/v3/

### Princípios de design

- **Minimalista**: lida apenas com a camada de mídia. Não dita protocolo de sinalização.
- **API de baixíssimo nível**: sem opiniões sobre como a aplicação deve funcionar.
- **SFU puro**: encaminha pacotes RTP sem transcodificar ou mixar.
- **Agnóstico de sinalização**: WebSocket, HTTP, gRPC — qualquer coisa funciona.
- **Multi-stream**: múltiplos áudios e vídeos sobre um único transporte ICE+DTLS.

---

## 2. Arquitetura Interna

### Hierarquia de objetos

```
Worker (processo C++ separado, 1 por CPU core)
  └── Router (equivalente a uma "sala" SFU)
        ├── WebRtcTransport (conexão com browser)
        │     ├── Producer (stream entrando no router)
        │     └── Consumer (stream saindo do router para cliente)
        ├── PlainTransport (conexão UDP simples, sem ICE/DTLS)
        │     ├── Producer (para injetar RTP de FFmpeg/GStreamer)
        │     └── Consumer (para extrair RTP para gravação)
        ├── PipeTransport (para conectar routers entre Workers)
        └── DirectTransport (comunicação direta Node.js ↔ Worker)
```

### Workers

- São **subprocessos C++** rodando em libuv, um por thread de CPU.
- Toda a lógica de forwarding RTP, RTCP, NACK, congestion control acontece no Worker em C++.
- O Node.js controla via IPC (pipe binário). O overhead de cruzar a fronteira Node.js ↔ C++ é mínimo.

### Fluxo de um pacote RTP

1. Browser envia pacote RTP via UDP para o WebRtcTransport do servidor.
2. O Worker C++ recebe, decodifica o cabeçalho RTP, identifica o Producer.
3. O Worker replica o pacote para cada Consumer ativo naquele Router.
4. Cada Consumer entrega ao seu WebRtcTransport de destino, que envia ao browser cliente.
5. **Nenhuma decodificação ou recodificação de vídeo ocorre.** É forwarding puro.

### Simulcast e SVC

mediasoup suporta simulcast (múltiplas resoluções em paralelo) e SVC (Scalable Video Coding). O servidor seleciona qual camada enviar a cada Consumer com base em condições de rede, via algoritmo de distribuição de camadas espaciais/temporais.

---

## 3. Injeção de Vídeo de Fonte Customizada (não-câmera)

Esta é a funcionalidade central para o caso de remote browser streaming: injetar frames de um processo servidor no router mediasoup.

### Mecanismo: PlainTransport + FFmpeg/GStreamer

A abordagem oficial e documentada é:

1. Criar um `PlainTransport` no router (sem ICE/DTLS, só UDP puro).
2. Definir os `rtpParameters` que o produtor externo vai enviar (codec, SSRC, payload type).
3. Chamar `transport.produce()` com esses parâmetros — mediasoup passa a esperar pacotes RTP nessa porta UDP.
4. Iniciar FFmpeg (ou GStreamer) apontando para a porta UDP do PlainTransport.

Referência oficial: https://mediasoup.org/documentation/v3/communication-between-client-and-server/

### Exemplo de código Node.js

```javascript
// 1. Criar PlainTransport para vídeo
const videoTransport = await router.createPlainTransport({
  listenIp: '127.0.0.1',
  rtcpMux: false,   // FFmpeg não suporta rtcp-mux
  comedia: true,    // auto-detecta IP/porta do FFmpeg no primeiro pacote
});

// 2. Criar Producer com parâmetros que FFmpeg vai usar
const videoProducer = await videoTransport.produce({
  kind: 'video',
  rtpParameters: {
    codecs: [{
      mimeType: 'video/VP8',
      payloadType: 96,
      clockRate: 90000,
    }],
    encodings: [{ ssrc: 22222222 }],
  },
});

// Porta onde FFmpeg deve enviar RTP
const { localPort } = videoTransport.tuple;
```

### Exemplo de comando FFmpeg com x11grab

```bash
ffmpeg \
  -f x11grab -s 1280x720 -r 30 -i :99.0 \
  -vcodec libvpx -b:v 1500k -deadline realtime -cpu-used 4 \
  -f rtp \
  -ssrc 22222222 \
  -payload_type 96 \
  "rtp://127.0.0.1:${localPort}?rtcpport=${rtcpPort}"
```

Referência do script oficial de broadcaster: https://github.com/versatica/mediasoup-demo/blob/v3/broadcasters/ffmpeg.sh

### Considerações técnicas importantes

| Item | Detalhe |
|------|---------|
| `rtcpMux: false` | FFmpeg não suporta RTP+RTCP multiplexados na mesma porta |
| `comedia: true` | mediasoup detecta IP remoto automaticamente do primeiro pacote |
| SSRC fixo | Deve bater exatamente entre FFmpeg e `rtpParameters` |
| Payload type | Deve bater entre FFmpeg e `rtpParameters` |
| Codec | VP8 e H.264 são os mais compatíveis |

Fonte da community confirmando que funciona: https://mediasoup.discourse.group/t/stream-video-instead-of-webcam/2454

### Gist de referência completo

Um gist detalhado mostrando injeção de áudio+vídeo via FFmpeg/GStreamer em mediasoup:
https://gist.github.com/mkhahani/59b9eca043569a9ec3cbec67e4d05811

---

## 4. Uso com Server-Side Browser Rendering

### 4a. Via x11grab (abordagem atual do projeto)

O fluxo completo é:

```
Xvfb (display virtual :99)
  └── Chromium rodando na tela virtual
        └── x11grab captura a tela
              └── FFmpeg codifica VP8/H.264
                    └── RTP para PlainTransport mediasoup
                          └── Router distribui via WebRtcTransport
                                └── Browser cliente recebe e exibe em <video>
```

Discussão relevante na comunidade sobre exatamente este caso de uso (virtual desktop → mediasoup → webapp): https://mediasoup.discourse.group/t/ffmpeg-rtp-live-stream-into-a-web-app/231

**Vantagens do x11grab:**
- Captura tudo que o browser renderiza, incluindo conteúdo DRM (Netflix, YouTube) se o codec correto estiver disponível.
- Funciona com qualquer aplicação gráfica, não só browsers.
- Latência típica: codificação x264 fast preset adiciona ~30-80ms; VP8 deadline=realtime adiciona ~20-50ms.

**Desvantagens:**
- Requer Xvfb ou Xorg real.
- Captura a tela inteira, não há granularidade por aba.
- Framerate estável depende de recursos do servidor.

### 4b. Via CDP Screencast (Chrome DevTools Protocol)

O CDP oferece `Page.startScreencast` que entrega frames JPEG via evento `screencastFrame`. A latência desta abordagem é maior porque:

1. CDP entrega JPEG comprimido (não stream de vídeo nativo).
2. É necessário decodificar JPEG → YUV → recodificar para H.264/VP9.
3. O CDP exige ACK de cada frame antes de enviar o próximo (round-trip por frame).

Pipeline completo:

```
Chrome (headless) via CDP
  └── Page.startScreencast → frames JPEG base64
        └── decode JPEG → I420 (YUV)
              └── encode H.264/VP9
                    └── RTP packetization
                          └── PlainTransport mediasoup
                                └── Router → Consumer → browser
```

Projeto que implementa exatamente este pipeline em Rust (vscreen):
https://github.com/lowjax-com/vscreen

**Desvantagens do CDP vs x11grab:**
- Limitado ao Chrome/Chromium (Firefox/WebKit não suportam).
- Mais latência por causa do loop JPEG → decode → encode.
- Qualidade inferior: compressão JPEG com lossy é inferior ao stream nativo H.264.
- Para 30fps a 1280x720, frames de ~50-100KB cada = ~12-30 Mbps de throughput CDP, mesmo com JPEG quality=80.

**Vantagem do CDP:**
- Não requer display virtual (funciona em headless puro).
- Permite capturar abas específicas.
- Pode combinar com controle programático do browser via Puppeteer/Playwright.

---

## 5. Latência Real: Números Concretos

### SFU (mediasoup) vs P2P WebRTC

O forwarding puro do mediasoup adiciona overhead mínimo:

| Componente | Latência adicionada |
|------------|-------------------|
| Forwarding RTP no Worker C++ | < 1ms (operação em memória) |
| RTT extra via servidor (vs P2P) | 5-30ms dependendo da localização geográfica |
| Congestion control/NACK | 0ms quando rede estável |

A diferença real entre mediasoup SFU e P2P está no **RTT adicional** de passar pelo servidor, não no processamento. Em redes locais, a diferença é imperceptível. Em WAN, o servidor intermediário pode até **reduzir** latência se estiver geograficamente melhor posicionado que o P2P direto.

### Latência glass-to-glass em produção

| Cenário | Latência |
|---------|----------|
| P2P WebRTC direto (LAN) | 50-150ms |
| mediasoup SFU (LAN) | 60-180ms |
| mediasoup + x11grab VP8 realtime | 150-400ms |
| mediasoup + x11grab H.264 fast | 100-300ms |
| mediasoup + CDP JPEG transcode | 300-600ms |
| Neko (x11 + GStreamer + WebRTC) | < 300ms (declarado) |

Fonte: https://webrtchacks.com/sfu-load-testing/
Fonte: https://www.nanocosmos.net/blog/webrtc-latency/

### Comparação SFU vs MCU

O estudo CoSMo/KITE com 1000 streams HD:

| Métrica | SFU (mediasoup) | MCU (transcoding) |
|---------|-----------------|-------------------|
| Latência média | ~120ms | ~280ms |
| CPU usage | ~45% | ~95% |
| Capacidade (1 servidor) | ~5000 usuários | ~300 usuários |

Fonte: https://mediasoup.org/resources/CoSMo_ComparativeStudyOfWebrtcOpenSourceSfusForVideoConferencing.pdf

### Por que SFU não é mais lento que P2P?

Um SFU como mediasoup **não decodifica, não recodifica, não mixa** — ele apenas:
1. Recebe pacotes RTP UDP.
2. Copia o payload para os Consumers relevantes.
3. Reescreve cabeçalhos RTP (SSRC, sequence number) se necessário.
4. Envia via UDP.

A latência de forwarding no Worker C++ é da ordem de **microsegundos**. O overhead real é o RTT extra de rede.

---

## 6. DataChannel para Relay de Input (mouse/teclado)

mediasoup suporta DataChannels (SCTP sobre DTLS sobre UDP). Para remote desktop, isso permite enviar eventos de mouse/teclado do browser para o servidor com latência mínima.

### Modo unreliable para inputs

Para mouse movements, usar SCTP no modo **unreliable + unordered** elimina head-of-line blocking:

```javascript
// No cliente (mediasoup-client)
const dataProducer = await sendTransport.produceData({
  ordered: false,           // sem garantia de ordem
  maxRetransmits: 0,        // sem retransmissão (unreliable)
  label: 'input',
});

// Enviar evento de mouse
dataProducer.send(JSON.stringify({
  type: 'mousemove',
  x: event.clientX,
  y: event.clientY,
}));
```

### No servidor: terminar DataChannel em Node.js

```javascript
// mediasoup v3 suporta DirectTransport para comunicação direta
const directTransport = await router.createDirectTransport();
const dataConsumer = await directTransport.consumeData({
  dataProducerId: dataProducer.id,
});

dataConsumer.on('message', (message) => {
  const input = JSON.parse(message);
  // injetar no Xvfb via xdotool ou X11 protocol diretamente
});
```

Referência: https://github.com/versatica/mediasoup/wiki/DataChannel

---

## 7. Projetos Existentes de Remote Browser com WebRTC

### 7a. Neko (m1k1o/neko) — mais relevante

**GitHub:** https://github.com/m1k1o/neko
**Stack:** Go + GStreamer + Pion WebRTC
**Latência declarada:** < 300ms

Neko é o projeto open-source mais completo e maduro de virtual browser com WebRTC. Arquitetura:

```
X11 (Xvfb) → GStreamer pipeline → Pion WebRTC (Go) → browser cliente
```

- **Não usa mediasoup** — usa Pion (implementação Go de WebRTC) diretamente.
- GStreamer captura X11, codifica VP8/VP9/H.264/AV1.
- Input relay via WebSocket (não DataChannel).
- Multi-usuário: vários clientes podem assistir, um tem controle.
- Suporte a rooms (neko-rooms para gerenciamento).
- Alternativa open-source ao Hyperbeam e Giggl.

**Por que Neko não usa SFU:**
No caso de 1 broadcaster → N viewers, um SFU adiciona complexidade desnecessária. Pion WebRTC direto é suficiente para 1→N se o servidor tiver banda suficiente.

### 7b. Selkies (Google → academic community)

**GitHub:** https://github.com/selkies-project/selkies
**Stack:** Python + GStreamer + WebRTC
**Foco:** Remote desktop GPU-accelerated para HPC/Kubernetes

Selkies usa GStreamer `webrtcbin` para streaming de desktop Linux via WebRTC. Não usa mediasoup. Focado em single-user sessions, não broadcast.

### 7c. vscreen (lowjax-com/vscreen)

**GitHub:** https://github.com/lowjax-com/vscreen
**Stack:** Rust + CDP + WebRTC

Implementação que usa CDP screencast para capturar frames e transmitir via WebRTC. Suporta 63 ferramentas MCP para automação. O pipeline é:
```
CDP frames JPEG → decode → H.264/VP9 → WebRTC RTP
```
Mouse/keyboard via DataChannel bidirecional.

### 7d. Kurento mediasoup-demos (recording)

**GitHub:** https://github.com/Kurento/mediasoup-demos

Demo oficial de como usar PlainTransport para gravar/transmitir streams mediasoup via FFmpeg/GStreamer. Boa referência de código para o pipeline de injeção.

---

## 8. Comparação: mediasoup SFU vs WebRTC Direto para Remote Browser

| Critério | WebRTC Direto (Pion/native) | mediasoup SFU |
|----------|---------------------------|---------------|
| Latência 1→1 | Menor (sem relay) | +5-30ms de RTT |
| Latência 1→N | Escala linear de uplink | Escala melhor (1 upload, N distribui) |
| Complexidade | Menor | Maior |
| Flexibilidade de codec | Depende da implementação | Alta (qualquer codec via PlainTransport) |
| Injeção de fonte customizada | Difícil (requer hack) | Nativo (PlainTransport) |
| DataChannel para input | Suportado | Suportado (SCTP) |
| Simulcast/SVC | Manual | Nativo |
| Escalabilidade N viewers | Gargalo de uplink | Sem gargalo (SFU distribui) |
| Ecosystem Node.js | Pion é Go; wrtc é instável | mediasoup é Node.js nativo |
| Maturidade | Alta | Alta |

**Conclusão:** Para **1 viewer**, WebRTC direto (como Neko faz) é suficiente e mais simples. Para **N viewers concurrent** do mesmo browser session, mediasoup SFU é o caminho correto porque um único PlainTransport producer serve N WebRtcTransport consumers sem multiplicar o uplink do servidor.

---

## 9. Recomendação para o Projeto Remote Browser

### Cenário atual do projeto

O projeto já implementa WebRTC diretamente no `server/webrtc-manager.js` sem SFU. Isso funciona para 1 viewer por sessão.

### Quando adicionar mediasoup faz sentido

1. **Múltiplos viewers na mesma sessão**: mediasoup distribui 1 stream para N clientes sem multiplicar processamento.
2. **Melhor controle de qualidade adaptativa**: simulcast e SVC nativos.
3. **Injeção mais limpa de x11grab**: PlainTransport é o mecanismo ideal para FFmpeg → mediasoup.
4. **Gravação simultânea**: um Consumer PlainTransport pode gravar enquanto outros assistem via WebRtcTransport.

### Pipeline recomendado com mediasoup

```
Xvfb :99
  └── Chromium headless
        └── FFmpeg x11grab :99
              ├── -vcodec libvpx (VP8, realtime)
              └── RTP → PlainTransport (127.0.0.1:XXXXX)
                    └── mediasoup Router
                          ├── WebRtcTransport → viewer 1 (browser)
                          ├── WebRtcTransport → viewer 2 (browser)
                          └── PlainTransport → FFmpeg recording

Input relay:
  browser → WebRTC DataChannel (unreliable) → DirectTransport → Node.js → xdotool inject
```

### Latência esperada com esta arquitetura

- Codificação VP8 x11grab realtime: +30-60ms
- Forwarding mediasoup: < 1ms
- RTT de rede (local): < 10ms
- **Total glass-to-glass estimado: 80-150ms** em rede local

---

## 10. Fontes

- [mediasoup Overview](https://mediasoup.org/documentation/overview/)
- [mediasoup Communication Between Client and Server](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)
- [mediasoup GitHub](https://github.com/versatica/mediasoup)
- [mediasoup-demo ffmpeg.sh broadcaster](https://github.com/versatica/mediasoup-demo/blob/v3/broadcasters/ffmpeg.sh)
- [Injecting audio/video into mediasoup using ffmpeg/gstreamer (gist)](https://gist.github.com/mkhahani/59b9eca043569a9ec3cbec67e4d05811)
- [CoSMo Comparative Study of WebRTC SFUs (PDF)](https://mediasoup.org/resources/CoSMo_ComparativeStudyOfWebrtcOpenSourceSfusForVideoConferencing.pdf)
- [webrtcHacks SFU Load Testing](https://webrtchacks.com/sfu-load-testing/)
- [mediasoup forum: FFMPEG RTP live stream into a web app](https://mediasoup.discourse.group/t/ffmpeg-rtp-live-stream-into-a-web-app/231)
- [mediasoup forum: Stream video instead of webcam](https://mediasoup.discourse.group/t/stream-video-instead-of-webcam/2454)
- [mediasoup forum: Processing video server-side](https://mediasoup.discourse.group/t/processing-video-serverside-and-streaming-via-ffmpeg/5906)
- [mediasoup DataChannel Wiki](https://github.com/versatica/mediasoup/wiki/DataChannel)
- [Neko — self-hosted virtual browser](https://github.com/m1k1o/neko)
- [Selkies — WebRTC remote desktop](https://github.com/selkies-project/selkies)
- [vscreen — CDP + WebRTC](https://github.com/lowjax-com/vscreen)
- [Kurento mediasoup-demos](https://github.com/Kurento/mediasoup-demos/blob/master/mediasoup-recording/README.md)
- [Janus vs. MediaSoup](https://dzone.com/articles/janus-vs-mediasoup-the-ultimate-guide-to-choosing)
- [WebRTC Latency Comparison (nanocosmos)](https://www.nanocosmos.net/blog/webrtc-latency/)
- [Neko HN discussion](https://news.ycombinator.com/item?id=29406112)
