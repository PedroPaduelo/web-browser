# 19 - RustDesk: Arquitetura, Protocolo e Comparacao com noVNC

## 1. Visao Geral

RustDesk e um software de desktop remoto open source escrito em Rust, posicionado como alternativa
auto-hospedavel ao TeamViewer/AnyDesk. Possui 82k+ stars no GitHub e suporta Windows, macOS, Linux,
Android, iOS e web.

O diferencial do RustDesk e combinar conexao peer-to-peer com relay server proprio, tudo com
criptografia end-to-end, sem depender de servicos de terceiros.

---

## 2. Arquitetura do Servidor: hbbs + hbbr

O servidor RustDesk consiste em dois processos independentes que separam **control plane** e **data plane**:

### 2.1 hbbs - ID/Rendezvous Server (Control Plane)

- Responsavel por registro de dispositivos, descoberta de peers e sinalizacao
- Portas:
  - TCP 21115 - NAT type test
  - TCP 21116 - Registro/sinalizacao TCP
  - UDP 21116 - Heartbeat e hole punching
  - TCP 21118 - WebSocket (para web client)
  - TCP 21114 - HTTP API (apenas versao Pro)
- Mantem mapa de todos os peers online com seus IPs/portas publicos
- Coordena tentativas de hole punching entre peers
- Detecta tipo de NAT (Cone, Port Restricted, Symmetric)

### 2.2 hbbr - Relay Server (Data Plane)

- Servidor de relay/fallback para quando P2P falha
- Portas:
  - TCP 21117 - Relay TCP
  - TCP 21119 - Relay WebSocket
- Nao requer licenca (mesmo na versao Pro, hbbr e identico ao OSS)
- Suporte a multiplos relay servers com selecao round-robin
- GeoLocation automatica para escolher relay mais proximo
- hbbs verifica saude dos relays a cada poucos segundos

### 2.3 Fluxo de Conexao

```
Peer A                        hbbs                         Peer B
  |---- RegisterPeer -------->|                               |
  |                           |<-------- RegisterPeer --------|
  |                           |                               |
  |---- PunchHole (B) ------->|                               |
  |                           |-------- PunchHole (A) ------->|
  |                           |                               |
  |<--- PunchHoleResponse ----|                               |
  |   (B's addr + signed pk)  |                               |
  |                           |                               |
  |============ UDP Hole Punch (direto P2P) ==================|
  |                           |                               |
  | Se falhar:                |                               |
  |========= Relay via hbbr (TCP/WebSocket) ==================|
```

Na maioria dos casos, o hole punching funciona e o relay nunca e usado. Para NATs simetricos,
o servidor forca modo relay automaticamente.

---

## 3. Protocolo de Transporte

### 3.1 Stream Unificado

RustDesk **NAO usa WebRTC**. Em vez disso, implementa um protocolo customizado com abstracoes
proprias. O tipo `Stream` do modulo `hbb_common` unifica tres transportes:

| Transporte | Uso Principal |
|------------|---------------|
| **TCP** | Conexao direta, relay |
| **KCP** | UDP com confiabilidade (hole-punched P2P) |
| **WebSocket** | Web client, ambientes com firewall restritivo |

Todos usam length-delimited codec: cada unidade transmitida mapeia para exatamente uma fatia
de bytes discreta. O protocolo de mensagens usa **Protocol Buffers** (`message.proto` compartilhado
entre Rust nativo e web client).

### 3.2 Por que nao WebRTC?

Os mantenedores do RustDesk explicam que WebRTC foi projetado para videochat, nao para streaming
de desktop. Diferem em requisitos de:
- Buffering (desktop precisa de menos buffer, mais responsividade)
- Qualidade (precisa de pixel-perfect em texto, nao "bom o suficiente" para rostos)
- Controle fino (WebRTC e "blackbox sem muito tweak-ability")

Mesmo assim, Chrome Remote Desktop usa WebRTC com sucesso, mas com extenso trabalho proprietario
sobre codecs, sinalizacao e controle de congestionamento que depende fortemente do codigo Chromium.

### 3.3 NAT Traversal e Hole Punching

O sistema de NAT traversal implementa tres estrategias em cascata:

1. **UDP Hole Punching direto** - Preferido para menor latencia
2. **IPv6 conexao direta** - Path alternativo quando disponivel
3. **Relay server** - Fallback quando NAT impede conexao direta

Deteccao de NAT via `test_nat_type()`:
- **Cone NAT** - Hole punching funciona normalmente
- **Port Restricted NAT** - Hole punching funciona com ajustes
- **Symmetric NAT** - Forca relay (hole punching inviavel)

Para peers na mesma LAN, usa **UDP broadcast na porta 21117** para descoberta local,
contornando o rendezvous server completamente (via `FetchLocalAddr`).

### 3.4 Criptografia

- **Key exchange**: Curve25519
- **Assinatura**: Ed25519 (servidor assina `IdPk` durante hole punch)
- **Criptografia simetrica**: XSalsa20/Poly1305 (via `sodiumoxide::secretbox`)
- **Ofuscacao de enderecos**: `AddrMangle::encode()` protege topologia interna

---

## 4. Pipeline de Video: Captura e Codecs

### 4.1 Captura de Tela por Plataforma

| Plataforma | API de Captura |
|-----------|---------------|
| Windows | DXGI Desktop Duplication + D3D11 |
| macOS | ScreenCaptureKit / AVFoundation |
| Linux/X11 | X11 SHM / XCB |
| Linux/Wayland | PipeWire via xdg-desktop-portal |
| Android | MediaProjection |
| Windows (Privacy Mode) | Magnification API (blankeia tela local) |

### 4.2 Codecs Suportados

| Codec | Software | HW (RAM) | HW (VRAM) | Chroma |
|-------|----------|----------|-----------|--------|
| **VP8** | libvpx | -- | -- | I420 |
| **VP9** | libvpx | -- | -- | I420, I444 |
| **AV1** | libaom | -- | -- | I420, I444 |
| **H264** | -- | FFmpeg/NvEnc/QSV | D3D11/VA-API | NV12 |
| **H265** | -- | FFmpeg/NvEnc/QSV | D3D11/VA-API | NV12 |

**Negociacao automatica**: O sistema detecta quais codecs ambos os peers suportam e seleciona o
melhor automaticamente. O enum `Encoder` tem 4 variantes: `VpxEncoder`, `AomEncoder`,
`HwRamEncoder`, `VRamEncoder`.

**Nota importante**: H264/H265 so estao disponiveis via hardware encoding. Nao ha H264 software.
Isso significa que PCs sem GPU compativel ficam limitados a VP8/VP9/AV1 (software).

### 4.3 Pipeline de Encoding

```
Captura (BGRA)
    |
    v
Conversao YUV (libyuv)
  - BGRA -> I420 (VP8/VP9/AV1)
  - BGRA -> NV12 (H264/H265 hardware)
  - BGRA -> I444 (VP9/AV1 alta qualidade)
    |
    v
Encoder (software ou hardware)
  - VPX: ate 64 threads
  - AOM: ate 64 threads
  - HWRAM: ate 16 threads
    |
    v
VideoFrame (protobuf)
    |
    v
Stream -> Peer (TCP/KCP/WebSocket)
```

### 4.4 Controle de Qualidade Dinamico

- **Bitrate base**: ~2-4 Mbps para 1080p, ~8-16 Mbps para 4K
- **Quantizer VPX**: Quality 0.0 -> q_min=36/q_max=56; Quality 2.0 -> q_min=0/q_max=37
- **Backpressure**: `VideoFrameController` usa ACKs por cliente; se cliente lento, espera ate 3s
  reduzindo FPS naturalmente
- Frames de audio com >1000ms de queue sao descartados silenciosamente

### 4.5 Latencia do Pipeline de Encoding

Encoders de hardware como MediaCodec (Android) e VideoToolbox (macOS) bufferizam multiplos frames,
introduzindo latencia extra. Quando captura retorna `WouldBlock`, sistema re-codifica o ultimo frame
ate `repeat_encode_max` (default 10) para manter continuidade.

---

## 5. Web Client

### 5.1 Arquitetura

O web client e uma aplicacao TypeScript/JavaScript que roda no browser sem necessidade de
instalacao. A UI usa **Flutter** (Dart compilado para JS/WASM), enquanto a logica de conexao
e codecs e implementada em TypeScript puro.

**Diferenca critica vs. cliente nativo**: O backend Rust NAO e compilado para WASM. Em vez disso,
o web client reimplementa comunicacao e codecs em TypeScript/JavaScript, conectando via WebSocket
ao servidor.

### 5.2 Modulos Principais

| Modulo | Funcao |
|--------|--------|
| `websock.ts` | Framing binario, send queues, reconexao |
| `rendezvous.ts` | Descoberta de peer via handshake com hbbs |
| `connection.ts` | Maquina de estados da sessao, roteamento de mensagens |
| `client.ts` | Camada UI, canvas, binding de eventos |
| `codec.js` | Decodificacao VP8/VP9 para playback |
| `message_pb.js` | Bindings protobuf gerados automaticamente |

### 5.3 Protocolo do Web Client

- Comunica via **WebSocket** usando o **mesmo protocolo protobuf** dos clientes nativos
- **Sempre relay**: Browser nao pode receber conexoes TCP/UDP inbound, entao TODAS as conexoes
  do web client passam pelo relay (hbbr porta 21119)
- Nao ha P2P para o web client

### 5.4 Decodificacao de Video no Browser

O `codec.js` implementa estrategia dual:

1. **Hardware-accelerated (WebCodecs API)**: Usa `VideoDecoder` do browser para VP8, VP9, H.264,
   H.265 -- depende do suporte do browser
2. **Software fallback**: Broadway.js/WASM decoder para VP8 em browsers sem WebCodecs

Fluxo: bytes do `VideoFrame` protobuf -> decoder ativo -> callback com `VideoFrame` ou
`ImageBitmap` -> renderizacao em Canvas.

### 5.5 Web Client V2

Preview lancado em outubro 2024, com melhorias de performance e features. Auto-login via sessao
do admin panel. Deploy via Docker com acesso em porta especifica (ex: 5000).

---

## 6. Latencia Real Reportada

### 6.1 Cenarios Medidos

| Cenario | Latencia Reportada |
|---------|-------------------|
| LAN cabeado (idle) | ~30ms |
| LAN cabeado (uso normal) | ate 120ms screen-to-screen |
| LAN com trafego concorrente | 1500ms+ |
| Audio em LAN 1Gbps | ~2500ms (100x pior que Google Meet) |
| Web client com LAN congestionada | Degradacao significativa |

### 6.2 Problemas Conhecidos

- **FPS cap**: Usuarios com RTX 3090 em LAN gigabit reportam limite de 25 FPS
  (melhorou para 60 FPS apos aumentar buffer limits para 128MB/256MB)
- **Bug de FPS**: Configurar FPS customizado pela metade (60 FPS config = 30 FPS real)
- **CPU alta**: Relatos de 300% de uso em sistema 6-core sem GPU encoding
- **Audio acumula lag**: Apos conexao longa com audio, atraso fica progressivamente pior
- **Display scaling**: Windows display scaling causa lag significativo;
  deixar o app lidar com scaling melhora
- **GPU-PV/Hyper-V**: H264/H265 hardware encoding nao funciona em ambientes GPU-PV
  (apenas VP8/VP9/AV1 software, causando stuttering)
- **Mobile**: Scrolling pode dropar para <5 FPS em dispositivos moveis

### 6.3 Comparacao com Concorrentes (relatos de usuarios)

| Software | Latencia Tipica (relatos) |
|----------|--------------------------|
| NoMachine | Melhor (ranking #1 usuarios) |
| TeamViewer | Muito bom |
| RustDesk | Bom, variavel |
| AnyDesk | Bom |
| ToDesk | ~30ms estavel |
| xrdp | Basico |

---

## 7. Comparacao: RustDesk vs noVNC

### 7.1 Arquitetura Fundamental

| Aspecto | RustDesk | noVNC |
|---------|----------|-------|
| **Escrito em** | Rust + Flutter (Dart) + TypeScript | JavaScript puro |
| **Protocolo** | Customizado (protobuf sobre TCP/KCP/WS) | VNC/RFB sobre WebSocket |
| **Codec de video** | VP8/VP9/AV1/H264/H265 (encoding proprio) | Nenhum (envia rects RFB) |
| **Transporte** | TCP, KCP, WebSocket | WebSocket (requer websockify proxy) |
| **P2P** | Sim (UDP hole punching) | Nao (sempre client->server) |
| **Criptografia** | E2E (XSalsa20/Poly1305 + Curve25519) | Depende do VNC server + TLS no proxy |
| **Browser nativo** | Web client via WebSocket relay | Sim (zero install) |

### 7.2 Performance

| Aspecto | RustDesk | noVNC |
|---------|----------|-------|
| **Latencia LAN** | 30-120ms (P2P nativo), mais via relay/web | Depende do VNC server; pode ser baixa |
| **Latencia WAN** | Boa via P2P; relay adiciona overhead | Alta sem fence/continuous updates |
| **FPS maximo** | 25-60 FPS (limitacoes de pipeline) | Limitado pelo RFB protocol (~30 FPS tipico) |
| **Hardware encoding** | Sim (NvEnc, QSV, VA-API) | Nao (renderiza rects no server side) |
| **Adaptacao de bitrate** | Sim (dinamica, baseada em QoS) | Limitada (depende do VNC server) |

### 7.3 Modelo de Compressao

**RustDesk**: Captura tela inteira -> converte para YUV -> codifica com codec de video (VP9, H264 etc)
-> stream como video comprimido. Modelo similar a streaming de video em tempo real.

**noVNC/VNC**: Server detecta regioes modificadas -> codifica retangulos individuais usando encodings
RFB (Raw, CopyRect, zlib, Tight, ZRLE) -> envia apenas deltas. Modelo de "dirty rectangles" sem
codec de video real.

A abordagem RFB do VNC pode ser mais eficiente para telas estaticas com poucos updates (ex: terminal),
mas a abordagem de codec do RustDesk e superior para conteudo dinamico (video, scrolling, animacoes).

### 7.4 Quando Usar Cada Um

| Caso de Uso | Melhor Opcao | Por que |
|-------------|-------------|---------|
| Desktop remoto completo pela internet | RustDesk | P2P, E2E encryption, menor latencia |
| Console de VM em painel web (Proxmox etc) | noVNC | Zero install, simples, integrado |
| Acesso rapido via browser sem instalar nada | noVNC | So precisa de browser |
| Suporte remoto tipo TeamViewer | RustDesk | UX completa, file transfer, clipboard |
| Ambiente HPC/cluster via portal web | noVNC | Integracao com OpenOnDemand etc |
| Gateway multi-protocolo (RDP+VNC+SSH) | Apache Guacamole | Suporte a multiplos protocolos |

---

## 8. Relevancia para o Projeto Remote-Browser

### 8.1 Licoes da Arquitetura RustDesk

1. **Separacao control plane / data plane** (hbbs/hbbr) e um padrao robusto
   que facilita escalonamento e deploy geografico

2. **Codec de video real > dirty rectangles** para conteudo web dinamico:
   VP9/H264 comprimem melhor cenarios de scrolling/animacao que RFB rects

3. **Backpressure com ACKs** e essencial para evitar memory bloat quando
   cliente e mais lento que server

4. **WebCodecs API no browser** permite decodificacao hardware-accelerated
   de VP9/H264 sem plugins -- relevante para nosso viewer

5. **WebSocket como fallback universal** funciona em qualquer firewall,
   mas adiciona latencia vs P2P direto

### 8.2 Aplicabilidade ao Nosso Caso

Nosso projeto (remote-browser) controla um browser Chrome headless e streama para
um viewer web. Diferencas vs RustDesk:

- **Nao precisamos de P2P/NAT traversal**: Server e viewer estao em infra controlada
- **Temos acesso ao CDP**: Podemos capturar via CDP screencast (alternativa a captura de tela)
- **Nosso viewer e sempre browser**: WebRTC ou WebSocket sao as unicas opcoes

O modelo do **web client do RustDesk** (protobuf sobre WebSocket + decodificacao
via WebCodecs/Broadway.js) e bastante similar ao que podemos implementar, mas
WebRTC continua sendo melhor para nosso caso porque:

- Lidamos com cenario server->browser (nao browser->browser)
- WebRTC tem controle de congestionamento embutido (REMB, NACK, PLI)
- WebRTC suporta hardware decoding nativamente via browser
- Nao precisamos reinventar transport layer

### 8.3 O que noVNC Ensina

noVNC prova que WebSocket + Canvas e viavel para remote desktop no browser,
mas o modelo RFB (dirty rectangles) tem limitacoes claras de FPS e adaptabilidade.
O buffer inteligente do Websock (4MB receive, 10KB send) com pointer tracking
e compaction e uma boa referencia de implementacao.

---

## Fontes

- [RustDesk Self-host Docs](https://rustdesk.com/docs/en/self-host/)
- [RustDesk Server GitHub](https://github.com/rustdesk/rustdesk-server)
- [DeepWiki: RustDesk Web Client](https://deepwiki.com/rustdesk/rustdesk/4.3-web-client)
- [DeepWiki: Video Capture and Encoding](https://deepwiki.com/rustdesk/rustdesk/5.1-video-capture-and-encoding)
- [DeepWiki: NAT Traversal and Relay](https://deepwiki.com/rustdesk/rustdesk/2.3-nat-traversal-and-relay)
- [GitHub Discussion: WebRTC as core protocol](https://github.com/rustdesk/rustdesk/discussions/2347)
- [GitHub Discussion: Low-latency streaming](https://github.com/rustdesk/rustdesk/discussions/3979)
- [GitHub Discussion: WebSockets usage](https://github.com/rustdesk/rustdesk/discussions/12747)
- [RustDesk Web Client V2 Preview](https://rustdesk.com/blog/2024/10/rustdesk-web-client-v2-preview/)
- [noVNC GitHub](https://github.com/novnc/noVNC)
- [DeepWiki: noVNC WebSocket Communication](https://deepwiki.com/novnc/noVNC/5-websocket-communication)
- [InfoQ: HTML5 noVNC Case Study](https://www.infoq.com/news/2010/07/html5-novnc/)
- [GitHub Issue: noVNC high latency optimization](https://github.com/novnc/noVNC/issues/1261)
- [DEV.to: RustDesk vs Guacamole](https://dev.to/selfhostingsh/rustdesk-vs-guacamole-remote-desktop-compared-307k)
- [Open OnDemand: RustDesk as noVNC alternative](https://discourse.openondemand.org/t/rfc-rustdesk-as-novnc-and-vnc-alternative/4676)
- [GitHub Issue: RustDesk audio latency 2500ms](https://github.com/rustdesk/rustdesk/issues/9654)
- [GitHub Discussion: RustDesk performance issues](https://github.com/rustdesk/rustdesk/discussions/6888)
