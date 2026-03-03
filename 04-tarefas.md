# Planejamento de Tarefas

## Referência
- Triagem: `01-triagem.md`
- Requisitos: `02-requisitos.md`
- Arquitetura: `03-arquitetura.md`
- Plano técnico: `PLAN.md`

## Resumo
- **Épicos**: 7
- **Tarefas**: 34
- **Story Points**: 144
- **Fases**: 5 (Container → mediasoup → Frontend → Orchestrator → Integração/TURN)

## Restrição do Ambiente de Dev

O EasyPanel **não tem** Docker socket, portas UDP livres, nem Xvfb. O código é 100% desenvolvido aqui, mas só pode ser testado end-to-end em servidor dedicado. Tarefas marcadas com 🔒 precisam de servidor dedicado para teste real.

---

## Fase 1: Container Base

### Épico 1: Imagem Docker do Browser Remoto
> Container self-contained com Xvfb + PulseAudio + Chrome + GStreamer + Session Agent + Supervisord

#### TASK-001: Criar Dockerfile do container base 🔒
- **Descrição**: Dockerfile Ubuntu 22.04 com todas as dependências: Xvfb, PulseAudio, xdotool, GStreamer (plugins base/good/bad/ugly/pulseaudio/x), Google Chrome stable, Node.js 22, Supervisord, fontes e libs de rendering
- **Story Points**: 5
- **Dependências**: Nenhuma
- **Arquivos**:
  - `container/Dockerfile` — criar imagem completa
- **Definition of Done**:
  - [ ] Dockerfile builda sem erro
  - [ ] Imagem tem Xvfb, PulseAudio, Chrome, GStreamer, xdotool, Node.js, Supervisord
  - [ ] Tamanho da imagem < 3GB
  - [ ] Chrome executa com `--no-sandbox` dentro do container

#### TASK-002: Criar entrypoint.sh com setup de display e áudio
- **Descrição**: Script de entrada do container que: configura Xvfb no DISPLAY_NUM com RESOLUTION, inicia PulseAudio daemon, cria virtual speaker (module-null-sink) e virtual mic (module-null-sink + module-virtual-source), inicia Supervisord
- **Story Points**: 5
- **Dependências**: TASK-001
- **Arquivos**:
  - `container/entrypoint.sh` — script de inicialização
- **Definition of Done**:
  - [ ] Xvfb sobe no DISPLAY_NUM configurado
  - [ ] PulseAudio cria virtual_speaker e virtual_mic_source
  - [ ] Variáveis DISPLAY_NUM e RESOLUTION são configuráveis
  - [ ] Supervisord inicia ao final

#### TASK-003: Criar supervisord.conf para todos os processos
- **Descrição**: Configuração do Supervisord gerenciando 7 processos: Xvfb, PulseAudio, Chrome, GStreamer vídeo, GStreamer áudio out, GStreamer áudio in, Session Agent. Cada um com autorestart, logs e prioridade de start
- **Story Points**: 3
- **Dependências**: TASK-002
- **Arquivos**:
  - `container/supervisord.conf` — configuração de todos os processos
- **Definition of Done**:
  - [ ] 7 programas definidos com [program:nome]
  - [ ] Prioridade: Xvfb(10) → Pulse(20) → Chrome(30) → GStreamer(40,41,42) → Agent(50)
  - [ ] autorestart=true em todos
  - [ ] Logs em /var/log/supervisor/

#### TASK-004: Configurar pipelines GStreamer (vídeo + áudio bidirecional) 🔒
- **Descrição**: 3 pipelines GStreamer como comandos no supervisord.conf: (1) ximagesrc → videoconvert → vp8enc → rtpvp8pay → udpsink para vídeo, (2) pulsesrc virtual_speaker.monitor → opusenc → rtpopuspay → udpsink para áudio saída, (3) udpsrc → rtpopusdepay → opusdec → pulsesink virtual_mic para áudio entrada (mic)
- **Story Points**: 5
- **Dependências**: TASK-002, TASK-003
- **Arquivos**:
  - `container/supervisord.conf` — comandos GStreamer nos [program:] sections
  - `container/entrypoint.sh` — variáveis de porta RTP
- **Definition of Done**:
  - [ ] Pipeline vídeo captura display Xvfb e envia VP8 RTP na VIDEO_RTP_PORT
  - [ ] Pipeline áudio out captura PulseAudio e envia Opus RTP na AUDIO_RTP_PORT
  - [ ] Pipeline áudio in recebe Opus RTP na MIC_RTP_PORT e injeta no PulseAudio
  - [ ] Parâmetros configuráveis: bitrate, porta, framerate
  - [ ] VP8 deadline=1 (realtime), cpu-used=4 (speed over quality)

---

### Épico 2: Session Agent (dentro do container)
> Servidor Node.js HTTP + WS que roda dentro de cada container como bridge para input injection e health monitoring

#### TASK-005: Criar Session Agent — HTTP endpoints (health + info)
- **Descrição**: Servidor Express dentro do container com 2 endpoints: GET /health (status: ok, uptime) e GET /info (display, resolution, portas RTP). CommonJS. Porta configurável via AGENT_PORT
- **Story Points**: 2
- **Dependências**: Nenhuma
- **Arquivos**:
  - `container/session-agent/package.json` — express, ws
  - `container/session-agent/index.js` — servidor HTTP + WS
- **Definition of Done**:
  - [ ] GET /health retorna `{ status: "ok", uptime: N }`
  - [ ] GET /info retorna display, resolution, portas
  - [ ] Servidor escuta em 0.0.0.0:AGENT_PORT

#### TASK-006: Criar módulo de input injection (xdotool wrapper)
- **Descrição**: Módulo CommonJS que wrappa xdotool para: mousemove, click (esquerdo/meio/direito), scroll (up/down), keydown, keyup, type text. Usa child_process.exec com DISPLAY configurado. Mapeamento de teclas JS → X11
- **Story Points**: 3
- **Dependências**: Nenhuma
- **Arquivos**:
  - `container/session-agent/input.js` — todas as funções de input injection
- **Definition of Done**:
  - [ ] injectMouse(x, y) — xdotool mousemove
  - [ ] injectClick(x, y, button) — mapeamento button 0→1, 1→2, 2→3
  - [ ] injectScroll(x, y, deltaY) — xdotool click 4/5 com repeat
  - [ ] injectKeyDown(key) / injectKeyUp(key) — com mapKey JS→X11
  - [ ] injectType(text) — xdotool type
  - [ ] Mapa de teclas: Enter→Return, Backspace→BackSpace, Arrows, Modifiers, Space

#### TASK-007: Integrar WebSocket no Session Agent para input relay
- **Descrição**: Adicionar WebSocket server ao Session Agent (ws library, noServer upgrade). Recebe mensagens JSON com type: mousemove/click/scroll/keydown/keyup/type e despacha para funções do input.js
- **Story Points**: 2
- **Dependências**: TASK-005, TASK-006
- **Arquivos**:
  - `container/session-agent/index.js` — adicionar WS handling
- **Definition of Done**:
  - [ ] WS server aceita conexões via HTTP upgrade
  - [ ] Parseia JSON e despacha por msg.type para funções corretas
  - [ ] Não crasha em mensagens malformadas (try/catch)
  - [ ] Log de conexão/desconexão

---

## Fase 2: mediasoup SFU Server

### Épico 3: Servidor mediasoup (SFU centralizado)
> Serviço Node.js com mediasoup workers, PlainTransports (container→SFU), WebRtcTransports (SFU→browser), signaling Socket.IO e input relay

#### TASK-008: Setup do projeto mediasoup-server (package.json + deps)
- **Descrição**: Inicializar projeto Node.js com dependências: mediasoup, socket.io, express, ws. CommonJS. Scripts: start, dev. Config básica
- **Story Points**: 1
- **Dependências**: Nenhuma
- **Arquivos**:
  - `mediasoup-server/package.json` — dependências e scripts
- **Definition of Done**:
  - [ ] npm install roda sem erro
  - [ ] mediasoup, socket.io, express, ws nas dependências

#### TASK-009: Criar config.js (workers, codecs, transports)
- **Descrição**: Configuração do mediasoup: numWorkers (min cpus, max 8), worker (rtcMinPort 40000, rtcMaxPort 49999), router mediaCodecs (VP8 video, Opus audio), webRtcTransport (listenInfos UDP+TCP com announcedAddress via PUBLIC_IP env var, bitrate configs), plainTransport configs
- **Story Points**: 2
- **Dependências**: TASK-008
- **Arquivos**:
  - `mediasoup-server/config.js` — toda configuração centralizada
- **Definition of Done**:
  - [ ] mediaCodecs: VP8 (90000 clockRate) + Opus (48000, 2ch)
  - [ ] webRtcTransport com listenInfos UDP+TCP, announcedAddress
  - [ ] Worker config com rtcMinPort/rtcMaxPort
  - [ ] PUBLIC_IP lido do env

#### TASK-010: Criar index.js (entry point — workers + HTTP + Socket.IO)
- **Descrição**: Entry point que: cria pool de mediasoup workers (round-robin), inicia Express server na porta 4443, monta Socket.IO sobre o HTTP server, expõe API interna (POST /internal/rooms, DELETE /internal/rooms/:userId), inicia signaling handlers
- **Story Points**: 3
- **Dependências**: TASK-009
- **Arquivos**:
  - `mediasoup-server/index.js` — bootstrap do servidor
- **Definition of Done**:
  - [ ] Workers criados (1 per CPU, max 8)
  - [ ] HTTP server escutando em 0.0.0.0:4443
  - [ ] Socket.IO montado
  - [ ] POST /internal/rooms cria sala (chama room-manager)
  - [ ] DELETE /internal/rooms/:userId destrói sala
  - [ ] Graceful shutdown (fecha workers)

#### TASK-011: Criar room-manager.js (CRUD de rooms + transports + producers)
- **Descrição**: Gerenciador de salas mediasoup. Cada room (1 por userId) contém: Router (round-robin entre workers), 3 PlainTransports (videoIn, audioOut, audioIn), Producers de vídeo e áudio, Map de WebRtcTransports e Consumers. Funções: createRoom, destroyRoom, createWebRtcTransport, createConsumer, createProducer (mic), handleInputRelay (WS para container)
- **Story Points**: 8
- **Dependências**: TASK-009, TASK-010
- **Arquivos**:
  - `mediasoup-server/room-manager.js` — toda lógica de rooms
- **Definition of Done**:
  - [ ] createRoom(userId, containerInfo) — cria router + 3 PlainTransports + producers
  - [ ] PlainTransport vídeo connect(containerIp, videoRtpPort) + produce(VP8)
  - [ ] PlainTransport áudio out connect + produce(Opus)
  - [ ] PlainTransport áudio in (para mic do usuário → container)
  - [ ] destroyRoom(userId) — fecha tudo, limpa Map
  - [ ] createWebRtcTransport() — para clientes browser
  - [ ] createConsumer(transport, producer, rtpCapabilities)
  - [ ] createMicProducer() + roteamento para PlainTransport áudio in
  - [ ] Abre WS connection com Session Agent do container para input relay
  - [ ] Rooms armazenados em Map<userId, Room>

#### TASK-012: Criar signaling.js (Socket.IO event handlers)
- **Descrição**: Handler de eventos Socket.IO entre frontend e mediasoup: joinSession (retorna rtpCapabilities), createRecvTransport, createSendTransport, connectTransport (DTLS), consume (vídeo/áudio), produce (mic), resumeConsumer, inputEvent (relay para container). Usa callback pattern do Socket.IO
- **Story Points**: 5
- **Dependências**: TASK-011
- **Arquivos**:
  - `mediasoup-server/signaling.js` — todos os event handlers
- **Definition of Done**:
  - [ ] joinSession → retorna routerRtpCapabilities
  - [ ] createRecvTransport → retorna id, iceParameters, iceCandidates, dtlsParameters
  - [ ] createSendTransport → idem
  - [ ] connectTransport → chama transport.connect(dtlsParameters)
  - [ ] consume → cria consumer, retorna id, producerId, kind, rtpParameters
  - [ ] produce → cria producer (mic), roteia para container, retorna id
  - [ ] resumeConsumer → consumer.resume()
  - [ ] inputEvent → relay para WS do container (fire-and-forget)
  - [ ] Emite sessionReady, sessionEnded, newProducer

---

## Fase 3: Frontend React

### Épico 4: Setup do Projeto Frontend
> React + TypeScript + Vite + mediasoup-client + Socket.IO client

#### TASK-013: Inicializar projeto React + Vite + TypeScript
- **Descrição**: Criar projeto com Vite (React + TS template). Instalar dependências: mediasoup-client, socket.io-client. Configurar vite.config.ts com host 0.0.0.0, porta 4200, allowedHosts para EasyPanel. Criar index.html e main.tsx
- **Story Points**: 2
- **Dependências**: Nenhuma
- **Arquivos**:
  - `frontend/package.json` — react, mediasoup-client, socket.io-client
  - `frontend/vite.config.ts` — host, port, allowedHosts
  - `frontend/tsconfig.json` — config TS
  - `frontend/index.html` — entry HTML
  - `frontend/src/main.tsx` — mount React
- **Definition of Done**:
  - [ ] `npm run dev` sobe Vite na porta 4200
  - [ ] React renderiza no browser
  - [ ] allowedHosts configurado para EasyPanel

#### TASK-014: Criar lib/signaling.ts (Socket.IO client wrapper)
- **Descrição**: Classe Signaling que wrappa Socket.IO com: connect(url), request(event, data) → Promise (callback pattern), emit(event, data) para fire-and-forget, on(event, handler), disconnect(). Singleton exportado. Auto-reconnect habilitado
- **Story Points**: 3
- **Dependências**: TASK-013
- **Arquivos**:
  - `frontend/src/lib/signaling.ts` — classe Signaling
- **Definition of Done**:
  - [ ] connect() conecta ao Socket.IO server
  - [ ] request() retorna Promise (usa callback do emit)
  - [ ] emit() fire-and-forget
  - [ ] on/off para listeners
  - [ ] reconnect automático
  - [ ] Eventos de conexão/desconexão

#### TASK-015: Criar lib/input-mapper.ts (DOM events → agent format)
- **Descrição**: Funções que convertem eventos DOM para formato do Session Agent: mapMouseMove(e, rect, resolution) → { type, x, y }, mapClick(e, rect, resolution), mapScroll(e, rect, resolution), mapKeyDown(e), mapKeyUp(e). Cálculo de coordenadas proporcional (scale X/Y baseado na resolução do Xvfb vs tamanho do elemento)
- **Story Points**: 2
- **Dependências**: TASK-013
- **Arquivos**:
  - `frontend/src/lib/input-mapper.ts` — todas as funções de mapeamento
- **Definition of Done**:
  - [ ] Coordenadas mapeadas proporcionalmente (rect.width → resolution.width)
  - [ ] Click mapeia button 0/1/2
  - [ ] Scroll mapeia deltaY
  - [ ] Key events preservam key e code
  - [ ] preventDefault em contextmenu

### Épico 5: Componentes e Hooks do Frontend
> Hooks mediasoup, input relay, session management e componentes visuais

#### TASK-016: Criar hook useSession.ts (REST API — create/destroy)
- **Descrição**: Hook React que gerencia ciclo de vida da sessão: createSession(userId, options) → POST /sessions, destroySession(userId) → DELETE /sessions/:userId, getSession(userId) → GET /sessions/:userId. Estados: idle, creating, active, destroying, error. Retorna sessionInfo com signalingUrl e sessionId
- **Story Points**: 3
- **Dependências**: TASK-013
- **Arquivos**:
  - `frontend/src/hooks/useSession.ts` — hook completo
- **Definition of Done**:
  - [ ] createSession chama POST /sessions e retorna sessionInfo
  - [ ] destroySession chama DELETE /sessions/:userId
  - [ ] Estados: idle → creating → active → destroying → idle
  - [ ] Error handling (409, 503, network error)
  - [ ] URL base do Orchestrator configurável via env

#### TASK-017: Criar hook useMediasoup.ts (Device + transports + consumers/producers)
- **Descrição**: Hook principal de media. Fluxo: (1) Device.load com routerCapabilities, (2) cria recvTransport, (3) connectTransport com DTLS, (4) consume vídeo → videoTrack, (5) consume áudio → audioTrack, (6) cria sendTransport, (7) getUserMedia mic, (8) produce micTrack. Cleanup no unmount. Usa signaling.ts para comunicação
- **Story Points**: 8
- **Dependências**: TASK-014
- **Arquivos**:
  - `frontend/src/hooks/useMediasoup.ts` — hook completo
- **Definition of Done**:
  - [ ] Device carrega capabilities do router
  - [ ] recvTransport criado e conectado
  - [ ] Consumer de vídeo (VP8) → track retornado
  - [ ] Consumer de áudio (Opus) → track retornado
  - [ ] sendTransport criado para mic
  - [ ] Producer de mic funcionando
  - [ ] Cleanup fecha transports no unmount
  - [ ] Retorna { videoTrack, audioTrack, isConnected, error }

#### TASK-018: Criar hook useInputRelay.ts (captura e envia mouse/teclado)
- **Descrição**: Hook que recebe ref do container element e sessionId. Registra event listeners: mousemove, mousedown, mouseup, click, contextmenu, wheel, keydown, keyup. Usa input-mapper.ts para converter e signaling.ts para enviar (inputEvent). Throttle no mousemove (max 60/s). Previne defaults (contextmenu, certas teclas)
- **Story Points**: 3
- **Dependências**: TASK-014, TASK-015
- **Arquivos**:
  - `frontend/src/hooks/useInputRelay.ts` — hook completo
- **Definition of Done**:
  - [ ] Mouse move, click, right-click, scroll capturados
  - [ ] Teclado keydown/keyup capturados
  - [ ] Coordenadas mapeadas para resolução do Xvfb
  - [ ] Throttle em mousemove (≤60 eventos/s)
  - [ ] contextmenu preventDefault
  - [ ] Eventos enviados via signaling como inputEvent

#### TASK-019: Criar componente BrowserViewer.tsx (vídeo + input overlay)
- **Descrição**: Componente principal. Renderiza <video> com videoTrack + audioTrack do useMediasoup. Div container captura todos os eventos de mouse/teclado via useInputRelay. cursor: none no container. tabIndex=0 para capturar teclado. Aspect ratio mantido (objectFit: contain). Resolução exibida proporcional
- **Story Points**: 5
- **Dependências**: TASK-017, TASK-018
- **Arquivos**:
  - `frontend/src/components/BrowserViewer.tsx` — componente completo
- **Definition of Done**:
  - [ ] Vídeo WebRTC renderiza em tela cheia do componente
  - [ ] Áudio WebRTC reproduz
  - [ ] Mouse/teclado capturados e enviados
  - [ ] Cursor oculto no hover
  - [ ] Foco automático para capturar teclado
  - [ ] objectFit: contain para manter aspect ratio

#### TASK-020: Criar componente SessionControls.tsx
- **Descrição**: Barra de controles: botão Iniciar Sessão (quando idle), botão Encerrar (quando active), seletor de qualidade (720p/1080p/480p), indicador de status (idle/connecting/active/error). Usa useSession hook
- **Story Points**: 3
- **Dependências**: TASK-016
- **Arquivos**:
  - `frontend/src/components/SessionControls.tsx` — componente completo
- **Definition of Done**:
  - [ ] Botão Iniciar → chama createSession
  - [ ] Botão Encerrar → chama destroySession
  - [ ] Seletor de resolução (720p, 1080p, 480p)
  - [ ] Indicador visual de status
  - [ ] Botões desabilitados durante transições

#### TASK-021: Criar componente AudioManager.tsx (mic mute/unmute)
- **Descrição**: Controle de microfone: botão mute/unmute que habilita/desabilita o mic track do producer. Indicador visual de nível de áudio (opcional). Ícone de mic on/off
- **Story Points**: 2
- **Dependências**: TASK-017
- **Arquivos**:
  - `frontend/src/components/AudioManager.tsx` — componente completo
- **Definition of Done**:
  - [ ] Botão toggle mute/unmute
  - [ ] Mute pausa o producer track (track.enabled = false)
  - [ ] Indicador visual do estado
  - [ ] Funciona sem mic (graceful degradation)

#### TASK-022: Criar componente ConnectionStatus.tsx
- **Descrição**: Indicador de estado da conexão: conectado (verde), reconectando (amarelo pulsante), desconectado (vermelho). Mostra latência estimada se disponível. Usa estado do Socket.IO e WebRTC
- **Story Points**: 2
- **Dependências**: TASK-014
- **Arquivos**:
  - `frontend/src/components/ConnectionStatus.tsx` — componente completo
- **Definition of Done**:
  - [ ] 3 estados visuais: connected, reconnecting, disconnected
  - [ ] Cores: verde, amarelo, vermelho
  - [ ] Reativo ao estado do signaling

#### TASK-023: Criar App.tsx (root — máquina de estados)
- **Descrição**: Componente raiz. Estado da sessão: idle → connecting → active → disconnecting → idle. Quando idle: mostra SessionControls (Iniciar). Quando active: mostra BrowserViewer + SessionControls (Encerrar) + AudioManager + ConnectionStatus. Layout fullscreen para o BrowserViewer
- **Story Points**: 3
- **Dependências**: TASK-019, TASK-020, TASK-021, TASK-022
- **Arquivos**:
  - `frontend/src/App.tsx` — componente root
- **Definition of Done**:
  - [ ] Máquina de estados: idle → connecting → active → disconnecting
  - [ ] Renderização condicional por estado
  - [ ] BrowserViewer ocupa tela principal quando active
  - [ ] Controles posicionados como overlay ou barra
  - [ ] Passa sessionId/signalingUrl para hooks filhos

---

## Fase 4: Orchestrator

### Épico 6: Gerenciador de Containers Docker
> API REST + Dockerode para criar/destruir/monitorar containers de browser remoto

#### TASK-024: Setup do projeto orchestrator (package.json + deps)
- **Descrição**: Inicializar projeto Node.js com dependências: express, dockerode, cors. CommonJS. Scripts: start, dev
- **Story Points**: 1
- **Dependências**: Nenhuma
- **Arquivos**:
  - `orchestrator/package.json` — dependências e scripts
- **Definition of Done**:
  - [ ] npm install roda sem erro
  - [ ] express, dockerode, cors nas dependências

#### TASK-025: Criar port-allocator.js
- **Descrição**: Módulo que gerencia alocação de portas no range 10000-39999. Para cada sessão aloca 4 portas consecutivas (agent, videoRtp, audioOutRtp, audioInRtp). Map de userId → portas. Funções: allocate(userId) → { agent, videoRtp, audioOutRtp, audioInRtp }, release(userId), isAvailable(port)
- **Story Points**: 2
- **Dependências**: TASK-024
- **Arquivos**:
  - `orchestrator/port-allocator.js` — módulo completo
- **Definition of Done**:
  - [ ] allocate() retorna 4 portas livres consecutivas
  - [ ] release() libera portas do userId
  - [ ] Range 10000-39999
  - [ ] Não aloca porta já em uso
  - [ ] Thread-safe (não aloca mesma porta para 2 sessões)

#### TASK-026: Criar container-manager.js (Dockerode CRUD) 🔒
- **Descrição**: Módulo com Dockerode que: createSession(userId, options) — cria container com Image remote-browser:latest, Env vars (DISPLAY_NUM, RESOLUTION, portas, bitrates), HostConfig (Memory 1.5GB, NanoCpus 2e9, ShmSize 2GB, Binds extensão+profile, NetworkMode browser-network), Labels. destroySession(userId) — stop + remove + limpa mediasoup room. listSessions() — lista containers com label app=remote-browser. getSessionStats(userId) — docker stats (CPU, RAM)
- **Story Points**: 5
- **Dependências**: TASK-025
- **Arquivos**:
  - `orchestrator/container-manager.js` — CRUD de containers
- **Definition of Done**:
  - [ ] createSession cria container com todas as configs do PLAN.md
  - [ ] Aguarda health check (poll /health até 30s timeout)
  - [ ] Notifica mediasoup server (POST /internal/rooms)
  - [ ] destroySession para e remove container
  - [ ] listSessions filtra por label
  - [ ] getSessionStats retorna CPU/RAM via docker stats

#### TASK-027: Criar index.js do orchestrator (Express REST API)
- **Descrição**: Express server na porta 4000 com CORS. Rotas: POST /sessions (validação: userId obrigatório, sessão já existe → 409, limite atingido → 503), DELETE /sessions/:userId (404 se não existe), GET /sessions (lista), GET /sessions/:userId (detalhes + resources). Limite máximo configurável (env MAX_SESSIONS, default 100)
- **Story Points**: 3
- **Dependências**: TASK-026
- **Arquivos**:
  - `orchestrator/index.js` — API REST completa
- **Definition of Done**:
  - [ ] POST /sessions → 201 (criado), 409 (já existe), 503 (limite)
  - [ ] DELETE /sessions/:userId → 200 (destruído), 404 (não encontrado)
  - [ ] GET /sessions → lista com total e maxSessions
  - [ ] GET /sessions/:userId → detalhes com resources e ports
  - [ ] CORS habilitado
  - [ ] Servidor em 0.0.0.0:4000

#### TASK-028: Implementar health monitoring + auto-cleanup
- **Descrição**: Polling de health check de cada container ativo a cada 10 segundos (GET /health no Session Agent). Se 3 checks consecutivos falharem → destroySession. Timer de disconnect: quando Socket.IO do usuário desconecta, inicia timer de 60s. Se não reconectar, destrói sessão. Limpeza de containers orfanados no startup
- **Story Points**: 5
- **Dependências**: TASK-026, TASK-027
- **Arquivos**:
  - `orchestrator/container-manager.js` — adicionar health monitoring e cleanup
  - `orchestrator/index.js` — adicionar endpoint de notificação de disconnect
- **Definition of Done**:
  - [ ] Health check a cada 10s para cada container ativo
  - [ ] 3 falhas consecutivas → destroySession automático
  - [ ] Timer de 60s após desconexão do usuário
  - [ ] Reconexão cancela timer
  - [ ] Cleanup de containers orfanados no startup do orchestrator
  - [ ] Log de cada ação de cleanup

---

## Fase 5: Integração e Infraestrutura

### Épico 7: Integração End-to-End + TURN + Deploy

#### TASK-029: Criar docker-compose.yml para desenvolvimento local 🔒
- **Descrição**: docker-compose que sobe: mediasoup-server, orchestrator, frontend (build estático servido por nginx ou dev). Rede browser-network criada. Volumes para extensão e profiles. Environment variables. Depende de Docker Engine estar disponível
- **Story Points**: 3
- **Dependências**: TASK-010, TASK-027
- **Arquivos**:
  - `docker-compose.yml` — compose principal
  - `.env.example` — template de variáveis
- **Definition of Done**:
  - [ ] `docker-compose up` sobe todos os serviços
  - [ ] Rede browser-network criada
  - [ ] Variáveis de ambiente documentadas em .env.example
  - [ ] Volumes para extensão e chrome profiles

#### TASK-030: Configurar Coturn TURN server 🔒
- **Descrição**: Configuração do Coturn: docker-compose.turn.yml com image coturn/coturn, network_mode host. turnserver.conf com listening-port 3478, tls-listening-port 5349, credenciais estáticas, quota, no-multicast-peers. Integrar iceServers no frontend (mediasoup webRtcTransport)
- **Story Points**: 3
- **Dependências**: TASK-017
- **Arquivos**:
  - `turn/docker-compose.turn.yml` — compose do Coturn
  - `turn/turnserver.conf` — configuração do Coturn
- **Definition of Done**:
  - [ ] Coturn sobe via docker-compose
  - [ ] TURN funciona (testado com trickle ICE)
  - [ ] Frontend usa iceServers com credenciais TURN
  - [ ] TLS configurado (porta 5349)

#### TASK-031: Implementar reconnect no frontend
- **Descrição**: Quando Socket.IO desconecta, mostrar "Reconectando..." (ConnectionStatus). Ao reconectar, re-join session, recriar transports e consumers. Se sessão ainda existe no orchestrator (GET /sessions/:userId), reconectar transparentemente. Se sessão morreu (404), voltar para idle
- **Story Points**: 5
- **Dependências**: TASK-017, TASK-022, TASK-023
- **Arquivos**:
  - `frontend/src/hooks/useMediasoup.ts` — adicionar lógica de reconnect
  - `frontend/src/hooks/useSession.ts` — verificar sessão existente
  - `frontend/src/App.tsx` — estado reconnecting
- **Definition of Done**:
  - [ ] Detecção de desconexão Socket.IO
  - [ ] UI mostra "Reconectando..."
  - [ ] Re-join automático ao reconectar
  - [ ] Transports e consumers recriados
  - [ ] Se sessão morreu, volta para idle
  - [ ] Container permanece vivo 60s esperando reconexão

#### TASK-032: Criar .env.example e documentar variáveis
- **Descrição**: Arquivo de exemplo com todas as variáveis de ambiente necessárias: PUBLIC_IP, MAX_SESSIONS, portas, URLs do mediasoup e orchestrator, credenciais TURN, VIDEO_BITRATE default, AUDIO_BITRATE default. Para cada módulo (orchestrator, mediasoup-server, frontend)
- **Story Points**: 1
- **Dependências**: Nenhuma
- **Arquivos**:
  - `.env.example` — template raiz
  - `orchestrator/.env.example` — variáveis do orchestrator
  - `mediasoup-server/.env.example` — variáveis do mediasoup
  - `frontend/.env.example` — variáveis do frontend (VITE_*)
- **Definition of Done**:
  - [ ] Todas as variáveis documentadas com comentários
  - [ ] Valores default onde aplicável
  - [ ] Separado por módulo

#### TASK-033: Build da imagem Docker do container base 🔒
- **Descrição**: Buildar imagem remote-browser:latest a partir do Dockerfile da TASK-001. Testar manualmente: rodar container, verificar que Xvfb sobe, PulseAudio cria sinks, Chrome abre, GStreamer emite RTP, Session Agent responde /health
- **Story Points**: 3
- **Dependências**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007
- **Arquivos**:
  - Nenhum novo — build + teste manual
- **Definition of Done**:
  - [ ] `docker build -t remote-browser:latest .` sem erro
  - [ ] Container roda e Supervisord inicia todos os processos
  - [ ] /health retorna OK
  - [ ] GStreamer pipelines emitem RTP nas portas configuradas
  - [ ] Chrome abre no Xvfb

#### TASK-034: Teste de integração end-to-end 🔒
- **Descrição**: Teste manual completo: (1) Sobe mediasoup server + orchestrator, (2) Abre frontend no browser, (3) Clica "Iniciar Sessão", (4) Container é criado, (5) Vídeo do Chrome remoto aparece, (6) Áudio funciona, (7) Mouse/teclado funcionam, (8) Encerra sessão, (9) Container destruído. Documentar qualquer issue encontrado
- **Story Points**: 5
- **Dependências**: TASK-023, TASK-027, TASK-029, TASK-033
- **Arquivos**:
  - Nenhum novo — teste manual E2E
- **Definition of Done**:
  - [ ] Sessão criada em < 30 segundos
  - [ ] Vídeo VP8 renderiza no browser do usuário
  - [ ] Áudio Opus reproduz no browser do usuário
  - [ ] Mouse move/click/scroll funciona
  - [ ] Teclado funciona (digitar texto, atalhos)
  - [ ] Encerrar sessão destrói container
  - [ ] Latência de input < 300ms (p50)
  - [ ] Sem leak de containers/portas após 5 ciclos create/destroy

---

## Ordem de Execução

```
FASE 1: Container Base (paralelo entre Épico 1 e 2)
  ├── TASK-001 → TASK-002 → TASK-003 → TASK-004 (Dockerfile + entrypoint + supervisord + GStreamer)
  └── TASK-005 → TASK-006 → TASK-007 (Session Agent — pode rodar em paralelo com TASK-001)

FASE 2: mediasoup SFU
  TASK-008 → TASK-009 → TASK-010 → TASK-011 → TASK-012

FASE 3: Frontend (paralelo entre setup e hooks independentes)
  ├── TASK-013 → TASK-014, TASK-015, TASK-016 (setup + libs/hooks independentes em paralelo)
  ├── TASK-017 (depende de TASK-014)
  ├── TASK-018 (depende de TASK-014, TASK-015)
  ├── TASK-019 (depende de TASK-017, TASK-018)
  ├── TASK-020 (depende de TASK-016)
  ├── TASK-021 (depende de TASK-017)
  ├── TASK-022 (depende de TASK-014)
  └── TASK-023 (depende de TASK-019, TASK-020, TASK-021, TASK-022)

FASE 4: Orchestrator
  TASK-024 → TASK-025 → TASK-026 → TASK-027 → TASK-028

FASE 5: Integração
  TASK-032 (pode rodar a qualquer momento)
  TASK-029 (depende de TASK-010, TASK-027)
  TASK-030 (depende de TASK-017)
  TASK-031 (depende de TASK-017, TASK-022, TASK-023)
  TASK-033 🔒 (depende de todo Épico 1 + Épico 2)
  TASK-034 🔒 (depende de TUDO)
```

## Tarefas Paralelizáveis

### Bloco A — Podem rodar 100% em paralelo
| Grupo | Tarefas | SP |
|-------|---------|------|
| Container Dockerfile | TASK-001, TASK-002, TASK-003, TASK-004 | 18 |
| Session Agent | TASK-005, TASK-006, TASK-007 | 7 |
| Frontend Setup | TASK-013 | 2 |
| Orchestrator Setup | TASK-024 | 1 |
| Env docs | TASK-032 | 1 |

### Bloco B — Paralelo após dependências
| Grupo | Tarefas | Depende de |
|-------|---------|------------|
| mediasoup server | TASK-008→012 | Nenhum (código puro, sem dep de container) |
| Frontend libs | TASK-014, TASK-015, TASK-016 | TASK-013 |
| Frontend hooks | TASK-017, TASK-018 | TASK-014 |
| Frontend components | TASK-019→023 | TASK-017, TASK-018 |
| Orchestrator logic | TASK-025→028 | TASK-024 |

### Máximo paralelismo possível (2 devs)
- **Dev 1**: Fase 1 (Container + Agent) → Fase 2 (mediasoup)
- **Dev 2**: Fase 3 (Frontend) → Fase 4 (Orchestrator)
- **Ambos**: Fase 5 (Integração)

---

## Resumo por Fase

| Fase | Épicos | Tarefas | SP | Descrição |
|------|--------|---------|----|----|
| 1 | 1, 2 | 7 | 25 | Container Docker + Session Agent |
| 2 | 3 | 5 | 19 | mediasoup SFU server |
| 3 | 4, 5 | 11 | 36 | Frontend React completo |
| 4 | 6 | 5 | 16 | Orchestrator + API REST |
| 5 | 7 | 6 | 20 | TURN + Integração + Teste E2E |
| **Total** | **7** | **34** | **116** | |

> **Nota**: Nenhuma tarefa individual excede 8 SP. A TASK-011 (room-manager) e TASK-017 (useMediasoup) são as mais complexas com 8 SP cada — elas são o coração do sistema.
