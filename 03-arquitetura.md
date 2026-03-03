# Arquitetura & Design Técnico

## Referência
- Triagem: `01-triagem.md`
- Requisitos: `02-requisitos.md`
- Plano técnico: `PLAN.md`

## Visão Geral

Sistema de browser remoto distribuído com 4 camadas: **Container** (Chrome isolado + captura + injeção), **Media** (mediasoup SFU + signaling), **Orquestração** (lifecycle de containers Docker), **Frontend** (React + WebRTC + input relay). Projeto completamente novo — do zero.

O sistema opera em ciclo:
1. Usuário solicita sessão → Orchestrator cria container Docker
2. Container sobe Xvfb + PulseAudio + Chrome + GStreamer + Session Agent
3. GStreamer captura display/áudio → envia RTP → mediasoup
4. mediasoup converte RTP → WebRTC → browser do usuário
5. Usuário interage (mouse/teclado) → WebSocket → Session Agent → xdotool → Xvfb
6. Áudio bidirecional: mic do usuário → WebRTC → mediasoup → RTP → GStreamer → PulseAudio → Chrome

---

## Stack Tecnológico

Projeto novo — stack completo definido aqui.

| Camada | Tecnologia | Versão | Justificativa |
|--------|-----------|--------|---------------|
| Container OS | Ubuntu 22.04 | LTS | Estável, LTS, melhor suporte GStreamer/PulseAudio |
| Display Virtual | Xvfb | 1.20+ | Leve, estável, padrão da indústria para headless display |
| Áudio Virtual | PulseAudio | 15+ | Única opção madura para virtual audio sinks/sources no Linux |
| Browser | Google Chrome | stable | Melhor compatibilidade com extensões (vs Chromium) |
| Captura/Encoding | GStreamer | 1.20+ | ximagesrc captura display, suporte VP8/H264/VAAPI, pipelines composáveis |
| Codec Vídeo | VP8 (software) | - | Universalmente suportado por todos browsers, sem royalties |
| Codec Áudio | Opus | - | Padrão WebRTC, melhor qualidade/latência para voz e áudio geral |
| WebRTC SFU | mediasoup | 3.x | Nativo Node.js, SFU escalável, PlainTransport para RTP |
| Input Injection | xdotool | 3.x | Simples, funcional com Xvfb, latência ~5-20ms |
| Session Agent | Node.js + Express + ws | Node 22 | Mesmo runtime do mediasoup, bridge HTTP/WS dentro do container |
| Orchestrator | Node.js + Express + Dockerode | Node 22 | API Docker nativa para Node.js, async/await |
| Frontend | React + TypeScript | React 18+ | Stack do desenvolvedor, mediasoup-client tem binding JS |
| Signaling | Socket.IO | 4.x | Reconnect automático, rooms, ack-based RPC |
| Media Client | mediasoup-client | 3.x | Binding JS oficial do mediasoup para browsers |
| TURN Server | Coturn | latest | Self-hosted, production-ready, gratuito |
| Process Manager | Supervisord | 4.x | Multi-process dentro de container Docker, restart automático |
| Build Tool (Frontend) | Vite | 6.x | HMR rápido, TypeScript nativo, tree-shaking |

---

## Topologia da Arquitetura

```
                         INTERNET (HTTPS/WSS)
                               │
                        ┌──────┴──────┐
                        │ Reverse     │
                        │ Proxy/LB    │  (nginx/traefik — fase produção)
                        └──────┬──────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────┴──────┐ ┌──────┴───────┐ ┌──────┴──────┐
    │  Orchestrator   │ │  mediasoup   │ │   Coturn    │
    │  (REST API)     │ │  SFU Server  │ │   (TURN)    │
    │  :4000          │ │  :4443       │ │   :3478     │
    │                 │ │  Socket.IO   │ │   :5349     │
    │  Dockerode      │ │  +Workers    │ │             │
    └────────┬────────┘ └──────┬───────┘ └─────────────┘
             │                 │
             │    Docker       │   RTP (UDP)
             │    API          │
    ┌────────┴─────────────────┴───────────────────┐
    │              Docker Network                   │
    │              "browser-network"                │
    │                                               │
    │  ┌────────┐  ┌────────┐  ┌────────┐         │
    │  │  C1    │  │  C2    │  │  C3    │  ...Cn  │
    │  │        │  │        │  │        │         │
    │  │ Xvfb   │  │ Xvfb   │  │ Xvfb   │         │
    │  │ Pulse  │  │ Pulse  │  │ Pulse  │         │
    │  │ Chrome │  │ Chrome │  │ Chrome │         │
    │  │ GStr   │  │ GStr   │  │ GStr   │         │
    │  │ Agent  │  │ Agent  │  │ Agent  │         │
    │  └────────┘  └────────┘  └────────┘         │
    └──────────────────────────────────────────────┘
```

### Comunicação entre Componentes

| De | Para | Protocolo | Porta | Descrição |
|----|------|-----------|-------|-----------|
| Frontend | Orchestrator | HTTPS REST | 4000 | Criar/destruir/listar sessões |
| Frontend | mediasoup Server | WSS (Socket.IO) | 4443 | Signaling WebRTC |
| Frontend | mediasoup Server | WebRTC (DTLS/SRTP) | 40000-49999 UDP | Vídeo + áudio bidirecional |
| Orchestrator | Docker Engine | Unix Socket | /var/run/docker.sock | Gerenciar containers |
| Orchestrator | mediasoup Server | HTTP interno | 4443 | Notificar novo container / destruir sala |
| Container (GStreamer) | mediasoup Server | RTP (UDP) | Dinâmica | Vídeo VP8 + Áudio Opus saída |
| mediasoup Server | Container (GStreamer) | RTP (UDP) | Dinâmica | Áudio Opus entrada (mic) |
| Orchestrator | Container (Agent) | HTTP | Dinâmica (10000-39999) | Health check, info |
| Frontend → Orchestrator → Agent | WS relay | WebSocket | Via Orchestrator | Input relay (mouse/teclado) |
| Frontend | Coturn | TURN | 3478/5349 UDP+TCP | NAT traversal fallback |

---

## Modelo de Dados

### Nota sobre Persistência
Não há banco de dados relacional. Todo estado é gerenciado **em memória** no runtime dos serviços. Persistência futura via Redis (fase produção) para sobreviver a restarts.

### Entidades

#### Session (Orchestrator — in-memory Map)
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| userId | string | Sim | Identificador único do usuário |
| sessionId | string | Sim | ID do container Docker |
| containerId | string | Sim | ID longo do container Docker |
| containerIp | string | Sim | IP do container na rede Docker |
| status | enum | Sim | `starting`, `running`, `stopping`, `error` |
| createdAt | Date | Sim | Timestamp de criação |
| resolution | string | Sim | Ex: `1280x720` |
| ports | PortAllocation | Sim | Portas alocadas (ver abaixo) |
| lastActivity | Date | Sim | Último input/heartbeat do usuário |
| disconnectTimer | Timer \| null | Não | Timer de 60s para auto-cleanup |

#### PortAllocation (Orchestrator — parte de Session)
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| agent | number | Sim | Porta HTTP/WS do Session Agent (10000-39999) |
| videoRtp | number | Sim | Porta RTP vídeo GStreamer → mediasoup |
| audioOutRtp | number | Sim | Porta RTP áudio saída GStreamer → mediasoup |
| audioInRtp | number | Sim | Porta RTP áudio entrada mediasoup → GStreamer |

#### Room (mediasoup Server — in-memory Map)
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| userId | string | Sim | Identificador do usuário (= chave do Map) |
| router | mediasoup.Router | Sim | Router mediasoup para esta sessão |
| videoPlainTransport | mediasoup.PlainTransport | Sim | Recebe RTP vídeo do container |
| audioOutPlainTransport | mediasoup.PlainTransport | Sim | Recebe RTP áudio do container |
| audioInPlainTransport | mediasoup.PlainTransport | Sim | Envia RTP áudio para container (mic) |
| videoProducer | mediasoup.Producer | Sim | Producer de vídeo (VP8) |
| audioProducer | mediasoup.Producer | Sim | Producer de áudio (Opus) |
| webRtcTransports | Map<string, Transport> | Não | Transports WebRTC dos clientes conectados |
| consumers | Map<string, Consumer> | Não | Consumers ativos |
| micProducer | mediasoup.Producer \| null | Não | Producer do microfone do usuário |

#### WorkerPool (mediasoup Server — array)
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| workers | mediasoup.Worker[] | Sim | Pool de workers (1 per CPU core, max 8) |
| nextWorkerIdx | number | Sim | Round-robin index para distribuir routers |

### Relacionamentos
- **Session** → **PortAllocation**: 1:1 (composição — portas pertencem à sessão)
- **Session** → **Room**: 1:1 (userId é chave comum — Orchestrator notifica mediasoup)
- **Room** → **Router**: 1:1 (cada sessão tem seu próprio router)
- **Room** → **PlainTransport**: 1:3 (vídeo in, áudio out, áudio in)
- **Room** → **WebRtcTransport**: 1:N (1-2 por cliente conectado: recv + send)
- **Room** → **Consumer**: 1:N (vídeo + áudio por cliente)
- **WorkerPool** → **Router**: 1:N (round-robin de routers entre workers)

---

## Endpoints / API

### Orchestrator — REST API (porta 4000)

| Método | Rota | Descrição | Request Body | Response |
|--------|------|-----------|-------------|----------|
| POST | /sessions | Criar sessão | `{ userId, options? }` | 201: Session, 409: já existe, 503: limite |
| DELETE | /sessions/:userId | Destruir sessão | — | 200: ok, 404: não encontrada |
| GET | /sessions | Listar sessões | — | 200: `{ sessions[], total, maxSessions }` |
| GET | /sessions/:userId | Status de sessão | — | 200: Session detalhada, 404 |

#### POST /sessions — Request
```json
{
  "userId": "string",
  "options": {
    "resolution": "1280x720 | 1920x1080 | 854x480",
    "startUrl": "string",
    "extensionPath": "string",
    "videoBitrate": 2000000,
    "audioBitrate": 128000
  }
}
```

#### POST /sessions — Response 201
```json
{
  "sessionId": "string",
  "userId": "string",
  "status": "running",
  "agentPort": 10001,
  "signalingUrl": "wss://server:4443"
}
```

#### POST /sessions — Response 409
```json
{
  "error": "Session already exists for this user",
  "existingSessionId": "string"
}
```

#### POST /sessions — Response 503
```json
{
  "error": "Maximum session limit reached",
  "currentSessions": 95,
  "maxSessions": 100
}
```

#### GET /sessions — Response 200
```json
{
  "sessions": [
    {
      "userId": "string",
      "sessionId": "string",
      "status": "running | starting | stopping",
      "createdAt": "2026-03-02T10:00:00Z",
      "uptime": 3600
    }
  ],
  "total": 5,
  "maxSessions": 100
}
```

#### GET /sessions/:userId — Response 200
```json
{
  "userId": "string",
  "sessionId": "string",
  "status": "running",
  "createdAt": "2026-03-02T10:00:00Z",
  "uptime": 3600,
  "resources": {
    "cpuPercent": 45.2,
    "memoryMB": 890,
    "memoryLimitMB": 1536
  },
  "ports": {
    "agent": 10001,
    "videoRtp": 10002,
    "audioOutRtp": 10003,
    "audioInRtp": 10004
  }
}
```

### mediasoup Server — Signaling (Socket.IO, porta 4443)

#### Client → Server

| Evento | Payload | Callback Response | Descrição |
|--------|---------|-------------------|-----------|
| `joinSession` | `{ sessionId }` | `{ routerRtpCapabilities }` | Entra na sessão, retorna capabilities |
| `createRecvTransport` | `{ sessionId }` | `{ id, iceParameters, iceCandidates, dtlsParameters }` | Cria transport para receber vídeo+áudio |
| `createSendTransport` | `{ sessionId }` | `{ id, iceParameters, iceCandidates, dtlsParameters }` | Cria transport para enviar mic |
| `connectTransport` | `{ transportId, dtlsParameters }` | `{}` | Conecta DTLS |
| `consume` | `{ sessionId, transportId, rtpCapabilities, kind }` | `{ id, producerId, kind, rtpParameters }` | Cria consumer de vídeo ou áudio |
| `produce` | `{ sessionId, transportId, kind, rtpParameters }` | `{ id }` | Cria producer (mic do usuário) |
| `resumeConsumer` | `{ consumerId }` | `{}` | Resume consumer pausado |
| `inputEvent` | `{ sessionId, event }` | — | Input relay (fire-and-forget) |

#### Server → Client

| Evento | Payload | Descrição |
|--------|---------|-----------|
| `sessionReady` | `{ sessionId }` | Sessão pronta para consumir |
| `sessionEnded` | `{ sessionId, reason }` | Sessão foi encerrada |
| `newProducer` | `{ producerId, kind }` | Novo producer disponível para consumir |

### mediasoup Server — API Interna (HTTP, porta 4443)

Usado pelo Orchestrator para notificar eventos de container.

| Método | Rota | Descrição | Request Body |
|--------|------|-----------|-------------|
| POST | /internal/rooms | Criar sala para container | `{ userId, containerIp, videoRtpPort, audioOutRtpPort, audioInRtpPort }` |
| DELETE | /internal/rooms/:userId | Destruir sala | — |

### Session Agent — HTTP + WS (porta dinâmica, dentro do container)

#### HTTP

| Método | Rota | Response |
|--------|------|----------|
| GET | /health | `{ status: "ok", uptime: N }` |
| GET | /info | `{ display, resolution, videoRtpPort, audioRtpPort, micRtpPort }` |

#### WebSocket Messages (Client → Agent)

```json
{ "type": "mousemove", "x": 640, "y": 360 }
{ "type": "click", "x": 640, "y": 360, "button": 0 }
{ "type": "scroll", "x": 640, "y": 360, "deltaY": -120 }
{ "type": "keydown", "key": "a", "code": "KeyA" }
{ "type": "keyup", "key": "a", "code": "KeyA" }
{ "type": "type", "text": "hello world" }
```

---

## Componentes Frontend

### Novos (tudo é novo — projeto do zero)

| Componente | Localização | Descrição |
|------------|-------------|-----------|
| App | `frontend/src/App.tsx` | Root — gerencia estado da sessão (idle/connecting/active) |
| BrowserViewer | `frontend/src/components/BrowserViewer.tsx` | Exibe vídeo WebRTC, captura eventos de mouse/teclado, mapeia coordenadas |
| SessionControls | `frontend/src/components/SessionControls.tsx` | Botões: Iniciar, Encerrar, Qualidade, indicadores de status |
| AudioManager | `frontend/src/components/AudioManager.tsx` | Controle de microfone: mute/unmute, indicador de nível |
| ConnectionStatus | `frontend/src/components/ConnectionStatus.tsx` | Indicador de estado: conectado/reconectando/desconectado |
| useMediasoup | `frontend/src/hooks/useMediasoup.ts` | Hook: Device load, transports, consumers, producers |
| useInputRelay | `frontend/src/hooks/useInputRelay.ts` | Hook: captura DOM events, envia via signaling |
| useSession | `frontend/src/hooks/useSession.ts` | Hook: create/destroy sessão via REST API |
| signaling | `frontend/src/lib/signaling.ts` | Classe Socket.IO com request/response pattern |
| inputMapper | `frontend/src/lib/input-mapper.ts` | Mapeia eventos DOM (MouseEvent, KeyboardEvent) para formato do Agent |

---

## Estrutura de Diretórios

```
serende/
├── container/                       # Imagem Docker do browser remoto
│   ├── Dockerfile                   # Ubuntu 22.04 + Xvfb + Pulse + Chrome + GStreamer
│   ├── entrypoint.sh                # Setup display, audio, pipelines GStreamer
│   ├── supervisord.conf             # Gerencia: Xvfb, Pulse, Chrome, GStreamer(3), Agent
│   └── session-agent/               # Node.js agent dentro do container
│       ├── package.json
│       ├── index.js                 # HTTP server (health, info) + WS server (input)
│       └── input.js                 # xdotool wrapper — mouse, teclado, scroll
│
├── mediasoup-server/                # SFU centralizado
│   ├── package.json
│   ├── index.js                     # Entry: inicia workers, HTTP server, Socket.IO
│   ├── config.js                    # Workers, codecs, transport configs
│   ├── room-manager.js              # CRUD de rooms, PlainTransport, WebRtcTransport
│   └── signaling.js                 # Socket.IO event handlers (signaling WebRTC)
│
├── orchestrator/                    # Gerenciador de containers
│   ├── package.json
│   ├── index.js                     # Express REST API
│   ├── container-manager.js         # Dockerode: create, destroy, list, stats
│   └── port-allocator.js            # Alocação/liberação de portas (10000-39999)
│
├── frontend/                        # React SPA
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                   # Root — máquina de estados da sessão
│       ├── components/
│       │   ├── BrowserViewer.tsx     # Vídeo WebRTC + overlay de input
│       │   ├── SessionControls.tsx   # Start/Stop/Qualidade
│       │   ├── AudioManager.tsx      # Mic mute/unmute
│       │   └── ConnectionStatus.tsx  # Indicador de conexão
│       ├── hooks/
│       │   ├── useMediasoup.ts       # mediasoup-client integration
│       │   ├── useInputRelay.ts      # Captura e envia mouse/teclado
│       │   └── useSession.ts         # REST API — create/destroy sessão
│       └── lib/
│           ├── signaling.ts          # Socket.IO client wrapper
│           └── input-mapper.ts       # DOM event → agent message format
│
├── turn/                            # Coturn TURN server
│   ├── docker-compose.turn.yml
│   └── turnserver.conf
│
├── PLAN.md
├── 01-triagem.md
├── 02-requisitos.md
└── 03-arquitetura.md                # Este documento
```

---

## Decisões Arquiteturais

### ADR-001: Container-per-User (Isolamento Total)
- **Contexto**: Precisamos rodar 1 Chrome por usuário com extensão custom, display virtual e áudio virtual. Alternativas: multi-tab num Chrome compartilhado, VMs, remote desktop.
- **Decisão**: 1 container Docker por sessão de usuário. Cada container é self-contained com Xvfb, PulseAudio, Chrome, GStreamer, Session Agent.
- **Consequências**:
  - (+) Isolamento total — crash de um não afeta outros
  - (+) Extensões independentes por usuário
  - (+) Recursos limitáveis por container (cgroups)
  - (+) Cleanup simples — docker rm
  - (-) Overhead de ~800MB-1.5GB RAM por sessão
  - (-) Startup time ~10-30s
  - (-) Requer servidor com muita RAM para escalar

### ADR-002: mediasoup como SFU (não MCU, não P2P)
- **Contexto**: Precisamos rotear streams de vídeo/áudio de containers para browsers. Alternativas: Janus, Jitsi, raw WebRTC P2P.
- **Decisão**: mediasoup como SFU centralizado com PlainTransports para receber RTP dos containers e WebRtcTransports para entregar aos browsers.
- **Consequências**:
  - (+) Nativo Node.js — mesmo stack
  - (+) PlainTransport permite receber RTP direto do GStreamer sem transponder
  - (+) SFU não transcodifica — CPU mínima
  - (+) API programática poderosa
  - (-) Requer portas UDP abertas (40000-49999)
  - (-) Requer IP público fixo (announcedAddress)
  - (-) Complexidade de signaling WebRTC

### ADR-003: GStreamer para captura e encoding (não FFmpeg)
- **Contexto**: Precisamos capturar o display Xvfb e áudio PulseAudio, encodar e enviar via RTP. Alternativas: FFmpeg, pipewire capture, screen recording APIs.
- **Decisão**: GStreamer com pipelines: ximagesrc → VP8 → RTP para vídeo; pulsesrc → Opus → RTP para áudio; udpsrc → Opus decode → pulsesink para mic.
- **Consequências**:
  - (+) ximagesrc captura display Xvfb nativamente
  - (+) Suporte VAAPI/NVENC para GPU encoding futuro
  - (+) Pipeline composável — fácil ajustar parâmetros
  - (+) pulsesrc/pulsesink para integração direta com PulseAudio
  - (-) Configuração de pipeline pode ser frágil
  - (-) Debug difícil quando algo não funciona
  - (-) CPU-intensive sem GPU (VP8 software ~0.5-1.5 cores)

### ADR-004: Socket.IO para signaling (não raw WebSocket)
- **Contexto**: Precisamos de canal de signaling entre frontend e mediasoup para negociação WebRTC. Alternativas: raw WebSocket, gRPC-web, SSE + REST.
- **Decisão**: Socket.IO para signaling e input relay.
- **Consequências**:
  - (+) Reconnect automático com backoff
  - (+) Request/response pattern com callbacks
  - (+) Rooms para isolar sessões
  - (+) Fallback para long-polling se WS falhar
  - (-) Overhead vs raw WS (~5-10%)
  - (-) Dependência adicional (socket.io + socket.io-client)

### ADR-005: Input relay via signaling (não WS direto ao container)
- **Contexto**: O frontend precisa enviar eventos de mouse/teclado para o Session Agent dentro do container. Alternativas: WS direto ao agent (porta exposta), relay via Orchestrator, relay via signaling.
- **Decisão**: Input events são enviados via Socket.IO signaling (mesmo canal do WebRTC). O mediasoup server recebe e faz relay via WS interno para o Session Agent do container.
- **Consequências**:
  - (+) Uma única conexão WebSocket do frontend (signaling + input)
  - (+) Não precisa expor porta do Agent ao mundo exterior
  - (+) Firewall mais simples — só mediasoup precisa de porta pública
  - (-) +1 hop de latência (frontend → mediasoup → container)
  - (-) mediasoup server precisa manter WS connection com cada container
  - **Alternativa considerada**: Se latência for problema, migrar para WS direto ao agent (expondo porta).

### ADR-006: Estado em memória (não banco de dados)
- **Contexto**: Precisamos rastrear sessões ativas, portas alocadas, rooms mediasoup. Alternativas: PostgreSQL, Redis, SQLite.
- **Decisão**: Maps em memória no Orchestrator e mediasoup server. Sem banco no MVP.
- **Consequências**:
  - (+) Zero dependência externa
  - (+) Latência zero para lookups
  - (+) Simplicidade máxima
  - (-) Perda de estado no restart do serviço
  - (-) Não sobrevive a crashes
  - **Mitigação futura**: Redis para estado compartilhado (fase produção)

### ADR-007: Supervisord como process manager (não systemd, não s6-overlay)
- **Contexto**: Cada container roda 6+ processos (Xvfb, PulseAudio, Chrome, GStreamer×3, Session Agent). Precisamos gerenciar lifecycle.
- **Decisão**: Supervisord gerencia todos os processos, com restart automático.
- **Consequências**:
  - (+) Maduro, amplamente usado em containers multi-process
  - (+) Restart automático por processo
  - (+) Log management integrado
  - (+) Configuração simples (INI)
  - (-) Não é o pattern ideal de Docker (1 process per container)
  - (-) Health check precisa ser custom (via Session Agent)

---

## Fluxos de Dados Detalhados

### Fluxo 1: Criação de Sessão

```
Frontend                  Orchestrator              mediasoup Server         Docker            Container
   │                          │                          │                    │                   │
   │ POST /sessions           │                          │                    │                   │
   │ { userId, options }      │                          │                    │                   │
   │─────────────────────────>│                          │                    │                   │
   │                          │                          │                    │                   │
   │                          │ 1. Valida (existe? limite?)                   │                   │
   │                          │ 2. Aloca 4 portas                            │                   │
   │                          │ 3. docker.createContainer │                   │                   │
   │                          │──────────────────────────────────────────────>│                   │
   │                          │                          │                    │ 4. Sobe container │
   │                          │                          │                    │──────────────────>│
   │                          │                          │                    │                   │
   │                          │                          │                    │  Supervisord inicia:
   │                          │                          │                    │  - Xvfb
   │                          │                          │                    │  - PulseAudio
   │                          │                          │                    │  - Chrome
   │                          │                          │                    │  - GStreamer (×3)
   │                          │                          │                    │  - Session Agent
   │                          │                          │                    │                   │
   │                          │ 5. Poll /health até OK   │                    │                   │
   │                          │<─────────────────────────────────────────────────────────────────│
   │                          │                          │                    │                   │
   │                          │ 6. POST /internal/rooms  │                    │                   │
   │                          │ { userId, containerIp,   │                    │                   │
   │                          │   videoRtpPort, ... }    │                    │                   │
   │                          │─────────────────────────>│                    │                   │
   │                          │                          │                    │                   │
   │                          │                          │ 7. Cria Router     │                   │
   │                          │                          │ 8. Cria PlainTransports (×3)           │
   │                          │                          │ 9. Cria Producers (video, audio)       │
   │                          │                          │ 10. connect() PlainTransports          │
   │                          │                          │──────────────────────────────────────>│
   │                          │                          │    (RTP começa a fluir)                │
   │                          │                          │                    │                   │
   │  201 { sessionId,       │                          │                    │                   │
   │    signalingUrl, ... }   │                          │                    │                   │
   │<─────────────────────────│                          │                    │                   │
```

### Fluxo 2: Conexão WebRTC (após sessão criada)

```
Frontend                         mediasoup Server
   │                                   │
   │ Socket.IO connect                 │
   │──────────────────────────────────>│
   │                                   │
   │ emit: joinSession { sessionId }   │
   │──────────────────────────────────>│
   │                                   │ Busca room do userId
   │ callback: { rtpCapabilities }     │
   │<──────────────────────────────────│
   │                                   │
   │ Device.load(rtpCapabilities)      │
   │                                   │
   │ emit: createRecvTransport         │
   │──────────────────────────────────>│
   │                                   │ Cria WebRtcTransport
   │ callback: { id, ice, dtls }       │
   │<──────────────────────────────────│
   │                                   │
   │ device.createRecvTransport(...)   │
   │                                   │
   │ transport.on('connect')           │
   │ emit: connectTransport            │
   │──────────────────────────────────>│ transport.connect(dtls)
   │ callback: {}                      │
   │<──────────────────────────────────│
   │                                   │
   │ emit: consume { kind: 'video' }   │
   │──────────────────────────────────>│ transport.consume(...)
   │ callback: { consumerId, rtp }     │
   │<──────────────────────────────────│
   │                                   │
   │ recvTransport.consume(...)        │
   │ → videoTrack                      │
   │                                   │
   │ (repete para kind: 'audio')       │
   │                                   │
   │ emit: createSendTransport         │
   │──────────────────────────────────>│ (para mic)
   │ callback: { id, ice, dtls }       │
   │<──────────────────────────────────│
   │                                   │
   │ getUserMedia({ audio: true })     │
   │ sendTransport.produce(micTrack)   │
   │──────────────────────────────────>│
   │                                   │ Roteia mic → PlainTransport → container
   │                                   │
   │ 🎬 Vídeo + Áudio funcionando     │
```

### Fluxo 3: Input Relay

```
Frontend                    mediasoup Server              Container (Session Agent)
   │                             │                              │
   │ mousemove no <video>        │                              │
   │ ↓ getCoords(e)              │                              │
   │ ↓ scaleX, scaleY            │                              │
   │                             │                              │
   │ emit: inputEvent            │                              │
   │ { sessionId,                │                              │
   │   event: { type: 'mousemove', x: 640, y: 360 } }          │
   │────────────────────────────>│                              │
   │                             │ Busca WS do container        │
   │                             │ ws.send(event)               │
   │                             │─────────────────────────────>│
   │                             │                              │
   │                             │                              │ xdotool mousemove 640 360
   │                             │                              │ → Xvfb atualiza cursor
   │                             │                              │ → Chrome re-renderiza
   │                             │                              │ → GStreamer captura frame
   │                             │                              │ → RTP → mediasoup
   │                             │                              │
   │ <──── WebRTC video frame ────────────────────────────────  │
   │ 🖱️ Cursor moveu no vídeo    │                              │
```

---

## Plano de Exposição (URLs / Portas)

### Ambiente de Desenvolvimento (EasyPanel)

Apenas o código é desenvolvido no EasyPanel. Containers Docker, GStreamer e mediasoup workers **não podem rodar aqui** (sem Docker socket, sem portas UDP).

| Serviço | Porta | Subdomínio EasyPanel | URL | Nota |
|---------|-------|---------------------|-----|------|
| Frontend (dev) | 4200 | serende-app | https://serende-app.ddw1sl.easypanel.host | Vite dev server |

### Ambiente de Produção (servidor dedicado)

| Serviço | Porta | Bind | Protocolo | Nota |
|---------|-------|------|-----------|------|
| Frontend (build estático) | 80/443 | 0.0.0.0 | HTTPS | Servido por nginx ou pelo Orchestrator |
| Orchestrator REST | 4000 | 0.0.0.0 | HTTPS | Reverse proxy via nginx |
| mediasoup Server | 4443 | 0.0.0.0 | WSS (Socket.IO) + HTTPS | Signaling + API interna |
| mediasoup Workers | 40000-49999 | 0.0.0.0 | UDP | RTC ports (WebRTC media) |
| Coturn | 3478 | 0.0.0.0 | UDP+TCP | TURN |
| Coturn TLS | 5349 | 0.0.0.0 | TCP | TURNS |
| Session Agent (por container) | 10000-39999 | 0.0.0.0 (rede Docker) | HTTP+WS | Não exposto à internet |
| Container RTP (vídeo) | Dinâmica | 127.0.0.1 (interno) | UDP | GStreamer → mediasoup |
| Container RTP (áudio out) | Dinâmica | 127.0.0.1 (interno) | UDP | GStreamer → mediasoup |
| Container RTP (áudio in) | Dinâmica | 127.0.0.1 (interno) | UDP | mediasoup → GStreamer |

---

## Segurança

### MVP (Sem Auth)
- Sem autenticação — qualquer client que conheça a API pode criar sessões
- Limite de sessões (maxSessions) como proteção contra abuso
- Containers isolados via Docker — um usuário não acessa dados de outro

### Medidas Implementadas no MVP
1. **Isolamento de container**: Cada sessão roda em container Docker com resource limits (cgroups)
2. **Rede Docker interna**: Containers não têm acesso direto à internet — comunicam apenas via rede `browser-network`
3. **Port binding restrito**: Agent ports (10000-39999) são internos ao host, não expostos via reverse proxy
4. **Chrome --no-sandbox**: Necessário dentro de Docker, mas mitigado pelo isolamento do próprio container
5. **Auto-cleanup**: Sessões abandonadas são destruídas em 60s
6. **Resource limits**: RAM 1.5GB, CPU 2 cores, SHM 2GB por container — previne DoS

### Futuro (Fase Produção)
- JWT para autenticação de usuários
- Rate limiting no Orchestrator
- TURN com credenciais temporárias (TURN REST API)
- TLS em todos os endpoints
- Firewall: apenas portas 443, 3478, 5349, 40000-49999 expostas

---

## Checklist de Compatibilidade

- [x] Não quebra funcionalidades existentes (projeto novo — não há funcionalidades para quebrar)
- [x] Mantém padrões do projeto (Node.js 22, ES modules ou CommonJS conforme PLAN.md usa require)
- [x] Funciona no Docker (0.0.0.0 para todos os serviços)
- [x] Frontend acessível via EasyPanel (dev) e nginx (produção)
- [x] mediasoup precisa de IP público e portas UDP (não funciona no EasyPanel — apenas código dev)
- [x] Orchestrator precisa de Docker socket (não funciona no EasyPanel — apenas código dev)
- [x] Padrão CommonJS (require/module.exports) para backend, conforme exemplos do PLAN.md
- [x] TypeScript para frontend (React + Vite)
- [x] Sem banco de dados no MVP (estado in-memory)
