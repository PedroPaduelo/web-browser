# Requisitos do Projeto — Serende (Browser Remoto)

## Referência
- Triagem: `01-triagem.md`
- Plano técnico: `PLAN.md`
- Tipo: `new_system`
- Complexidade: XL — 10 componentes distribuídos
- Data: 2026-03-02

---

## User Stories

### US-001: Iniciar sessão de browser remoto
**Como** usuário do sistema
**Quero** clicar em "Iniciar Sessão" e receber um Chrome remoto funcional na minha tela
**Para** navegar na internet usando o browser remoto com minha extensão carregada

**Critérios de Aceite:**
- [ ] Ao clicar "Iniciar", container Docker é criado em até 30 segundos
- [ ] Vídeo do Chrome remoto aparece no browser do usuário via WebRTC
- [ ] Áudio do Chrome remoto é reproduzido no browser do usuário
- [ ] Chrome carrega com a extensão do usuário pré-instalada
- [ ] Health check do container retorna OK antes de conectar o usuário

### US-002: Interagir com o browser remoto via mouse
**Como** usuário com sessão ativa
**Quero** mover, clicar, arrastar e usar scroll no Chrome remoto como se fosse local
**Para** navegar normalmente em sites, preencher formulários e interagir com páginas

**Critérios de Aceite:**
- [ ] Movimentos de mouse são refletidos no Chrome remoto com latência < 300ms
- [ ] Clique esquerdo, direito e do meio funcionam corretamente
- [ ] Scroll vertical funciona com sensibilidade adequada
- [ ] Coordenadas são mapeadas corretamente independente do tamanho da janela do usuário
- [ ] Contexto de clique direito do browser local é suprimido

### US-003: Interagir com o browser remoto via teclado
**Como** usuário com sessão ativa
**Quero** digitar texto e usar atalhos de teclado no Chrome remoto
**Para** preencher formulários, buscar, usar atalhos (Ctrl+C, Ctrl+V, etc.)

**Critérios de Aceite:**
- [ ] Digitação de texto aparece no Chrome remoto com latência < 300ms
- [ ] Teclas modificadoras (Ctrl, Shift, Alt, Meta) funcionam
- [ ] Combinações de teclas (Ctrl+A, Ctrl+C, Ctrl+V) funcionam
- [ ] Teclas especiais (Enter, Backspace, Tab, Escape, setas) funcionam
- [ ] Eventos keydown e keyup são distintos (não geram dupla digitação)

### US-004: Áudio bidirecional (ouvir e falar)
**Como** usuário com sessão ativa
**Quero** ouvir o áudio de sites no Chrome remoto e usar meu microfone
**Para** participar de chamadas de voz/vídeo, assistir vídeos com som e usar aplicações de áudio

**Critérios de Aceite:**
- [ ] Áudio de sites (YouTube, Google Meet, etc.) é reproduzido no browser do usuário
- [ ] Microfone do usuário é capturado e injetado no Chrome remoto como dispositivo de entrada
- [ ] Áudio bidirecional não gera echo perceptível
- [ ] Latência de áudio < 300ms
- [ ] Usuário pode mutar/desmutar o microfone

### US-005: Encerrar sessão
**Como** usuário com sessão ativa
**Quero** encerrar minha sessão de browser remoto
**Para** liberar recursos do sistema

**Critérios de Aceite:**
- [ ] Container Docker é destruído em até 10 segundos
- [ ] Portas e recursos são liberados
- [ ] Sala mediasoup é removida
- [ ] Frontend mostra estado "desconectado"
- [ ] Se o usuário desconectar sem encerrar, sessão é destruída após timeout de 60s

### US-006: Reconectar após queda de conexão
**Como** usuário que perdeu a conexão temporariamente
**Quero** reconectar à minha sessão existente automaticamente
**Para** continuar de onde parei sem perder o estado do Chrome

**Critérios de Aceite:**
- [ ] Container permanece vivo por 60 segundos após desconexão
- [ ] Ao reconectar, vídeo/áudio/input são restaurados
- [ ] WebRTC transport é recriado transparentemente
- [ ] Usuário vê indicador de "reconectando..."

### US-007: Configurar resolução e qualidade
**Como** usuário
**Quero** escolher a resolução e qualidade do stream
**Para** balancear entre qualidade visual e performance/bandwidth

**Critérios de Aceite:**
- [ ] Opções disponíveis: 720p (padrão), 1080p, 480p
- [ ] Mudança de qualidade aplica sem reiniciar a sessão (se viável) ou com restart rápido
- [ ] Bitrate se adapta à conexão do usuário (bandwidth estimator)

### US-008: Monitorar sessões ativas (Admin)
**Como** administrador do sistema
**Quero** ver todas as sessões ativas com métricas de uso
**Para** monitorar a saúde do sistema e identificar problemas

**Critérios de Aceite:**
- [ ] Lista de sessões com: userId, status, uptime, uso de CPU/RAM
- [ ] Capacidade de encerrar sessões forçadamente
- [ ] Métricas: total de sessões, uso de recursos, containers ativos

---

## Requisitos Funcionais

### RF-001: Criação de container Docker por sessão
- **Descrição**: O sistema deve criar um container Docker isolado para cada sessão de usuário, contendo Xvfb, PulseAudio, Chrome, GStreamer, Session Agent e Supervisord
- **Camada**: Backend (Orchestrator)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/Dockerfile` (novo)
  - `container/entrypoint.sh` (novo)
  - `container/supervisord.conf` (novo)
  - `orchestrator/container-manager.js` (novo)
  - `orchestrator/port-allocator.js` (novo)

### RF-002: Display virtual com Xvfb
- **Descrição**: Cada container deve rodar Xvfb criando um display virtual com resolução configurável (720p/1080p). O Chrome renderiza neste display.
- **Camada**: Backend (Container)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/entrypoint.sh` (novo)
  - `container/supervisord.conf` (novo)

### RF-003: Áudio virtual com PulseAudio
- **Descrição**: Cada container deve rodar PulseAudio com virtual speaker (saída do Chrome → captura GStreamer) e virtual mic (áudio do usuário → entrada do Chrome)
- **Camada**: Backend (Container)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/entrypoint.sh` (novo)
  - `container/supervisord.conf` (novo)

### RF-004: Chrome com extensão
- **Descrição**: Chrome deve iniciar automaticamente no display virtual, carregando a extensão do usuário via --load-extension (montada como volume Docker)
- **Camada**: Backend (Container)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/entrypoint.sh` (novo)
  - `container/supervisord.conf` (novo)
  - `orchestrator/container-manager.js` (novo) — monta volume da extensão

### RF-005: Captura e encoding de vídeo com GStreamer
- **Descrição**: GStreamer deve capturar o display Xvfb (ximagesrc), encodar em VP8 (software) ou H264 (GPU se disponível), e transmitir via RTP UDP para o servidor mediasoup
- **Camada**: Backend (Container)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/entrypoint.sh` (novo) — pipeline GStreamer vídeo
  - `container/supervisord.conf` (novo)

### RF-006: Captura e encoding de áudio com GStreamer
- **Descrição**: GStreamer deve capturar o áudio do PulseAudio virtual speaker (pulsesrc), encodar em Opus, e transmitir via RTP UDP para o servidor mediasoup
- **Camada**: Backend (Container)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/entrypoint.sh` (novo) — pipeline GStreamer áudio out

### RF-007: Recepção de áudio do microfone do usuário
- **Descrição**: GStreamer deve receber RTP Opus do mediasoup (áudio do mic do usuário), decodificar e injetar no PulseAudio virtual mic para o Chrome usar como dispositivo de entrada
- **Camada**: Backend (Container)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/entrypoint.sh` (novo) — pipeline GStreamer áudio in

### RF-008: Injeção de input via xdotool
- **Descrição**: Session Agent deve receber eventos de mouse (move, click, scroll) e teclado (keydown, keyup, type) via WebSocket e injetar no display Xvfb via xdotool
- **Camada**: Backend (Session Agent)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/session-agent/input.js` (novo)
  - `container/session-agent/index.js` (novo)
  - `container/session-agent/package.json` (novo)

### RF-009: Session Agent HTTP/WS
- **Descrição**: Processo Node.js dentro de cada container expondo: health check (GET /health), info da sessão (GET /info), e WebSocket para input relay
- **Camada**: Backend (Session Agent)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `container/session-agent/index.js` (novo)
  - `container/session-agent/package.json` (novo)

### RF-010: mediasoup SFU — PlainTransport (Container → SFU)
- **Descrição**: Servidor mediasoup deve criar PlainTransports para receber RTP de vídeo (VP8) e áudio (Opus) de cada container via UDP
- **Camada**: Backend (mediasoup Server)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `mediasoup-server/index.js` (novo)
  - `mediasoup-server/config.js` (novo)
  - `mediasoup-server/room-manager.js` (novo)

### RF-011: mediasoup SFU — WebRtcTransport (SFU → Browser)
- **Descrição**: Servidor mediasoup deve criar WebRtcTransports para entregar vídeo+áudio ao browser do usuário via WebRTC, e receber áudio do microfone do usuário
- **Camada**: Backend (mediasoup Server)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `mediasoup-server/room-manager.js` (novo)
  - `mediasoup-server/signaling.js` (novo)

### RF-012: mediasoup SFU — Áudio bidirecional (Mic → Container)
- **Descrição**: mediasoup deve rotear o Producer de áudio do microfone do usuário para um PlainTransport que envia RTP de volta ao container (para o GStreamer decodificar e injetar no PulseAudio)
- **Camada**: Backend (mediasoup Server)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `mediasoup-server/room-manager.js` (novo)

### RF-013: Signaling WebSocket
- **Descrição**: Comunicação de signaling entre frontend e mediasoup server via Socket.IO, suportando: getRouterCapabilities, createRecvTransport, createSendTransport, connectTransport, consume, produce
- **Camada**: Backend (mediasoup Server)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `mediasoup-server/signaling.js` (novo)

### RF-014: Orchestrator — API REST
- **Descrição**: API REST para gerenciar sessões: criar (POST /sessions), destruir (DELETE /sessions/:userId), listar (GET /sessions), status (GET /sessions/:userId)
- **Camada**: Backend (Orchestrator)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `orchestrator/index.js` (novo)
  - `orchestrator/container-manager.js` (novo)
  - `orchestrator/package.json` (novo)

### RF-015: Orchestrator — Port Allocation
- **Descrição**: Alocação dinâmica de portas para cada container (video RTP, audio out RTP, audio in RTP, session agent HTTP), evitando conflitos
- **Camada**: Backend (Orchestrator)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `orchestrator/port-allocator.js` (novo)

### RF-016: Orchestrator — Health Monitoring
- **Descrição**: Polling do health check de cada container a cada 10 segundos. Se unhealthy por 3 checks consecutivos, destruir container e notificar frontend.
- **Camada**: Backend (Orchestrator)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `orchestrator/container-manager.js` (novo)

### RF-017: Orchestrator — Auto-cleanup
- **Descrição**: Se usuário desconectar, esperar 60 segundos. Se não reconectar, destruir container e liberar recursos.
- **Camada**: Backend (Orchestrator)
- **Prioridade**: Must
- **Arquivos impactados**:
  - `orchestrator/container-manager.js` (novo)

### RF-018: Frontend — BrowserViewer (vídeo WebRTC + input overlay)
- **Descrição**: Componente React que exibe o vídeo WebRTC do Chrome remoto e captura todos os eventos de mouse e teclado, mapeando coordenadas proporcionalmente à resolução do Xvfb
- **Camada**: Frontend
- **Prioridade**: Must
- **Arquivos impactados**:
  - `frontend/src/components/BrowserViewer.tsx` (novo)

### RF-019: Frontend — mediasoup-client integration
- **Descrição**: Hook React que gerencia: Device load, recv transport (vídeo+áudio do Chrome), send transport (mic do usuário), consumers e producers
- **Camada**: Frontend
- **Prioridade**: Must
- **Arquivos impactados**:
  - `frontend/src/hooks/useMediasoup.ts` (novo)
  - `frontend/src/lib/signaling.ts` (novo)

### RF-020: Frontend — Input Relay
- **Descrição**: Hook React que captura eventos DOM (mousemove, click, contextmenu, wheel, keydown, keyup) e os envia para o Session Agent via WebSocket (ou via signaling relayed pelo orchestrator)
- **Camada**: Frontend
- **Prioridade**: Must
- **Arquivos impactados**:
  - `frontend/src/hooks/useInputRelay.ts` (novo)
  - `frontend/src/lib/input-mapper.ts` (novo)

### RF-021: Frontend — Session Controls
- **Descrição**: Componente com botões de: Iniciar Sessão, Encerrar Sessão, Mutar/Desmutar Mic, Configurações de qualidade
- **Camada**: Frontend
- **Prioridade**: Must
- **Arquivos impactados**:
  - `frontend/src/components/SessionControls.tsx` (novo)

### RF-022: Frontend — Audio Manager
- **Descrição**: Componente/hook que gerencia a captura do microfone do usuário (getUserMedia), estado de mute, e produz no send transport do mediasoup
- **Camada**: Frontend
- **Prioridade**: Must
- **Arquivos impactados**:
  - `frontend/src/components/AudioManager.tsx` (novo)

### RF-023: TURN Server (Coturn)
- **Descrição**: Servidor Coturn self-hosted para NAT traversal quando WebRTC direto não é possível. Configurado com credenciais estáticas e suporte a TLS.
- **Camada**: Infraestrutura
- **Prioridade**: Should (Must para produção)
- **Arquivos impactados**:
  - `turn/docker-compose.turn.yml` (novo)
  - `turn/turnserver.conf` (novo)

### RF-024: Persistência de perfil Chrome
- **Descrição**: O diretório /data/chrome-profile do container deve ser um volume Docker persistente vinculado ao userId, permitindo manter cookies, login e dados entre sessões
- **Camada**: Backend (Orchestrator + Container)
- **Prioridade**: Should
- **Arquivos impactados**:
  - `orchestrator/container-manager.js` (novo) — configuração de volumes

### RF-025: Bandwidth Estimator / Adaptive Bitrate
- **Descrição**: mediasoup deve usar BWE (Bandwidth Estimation) para ajustar o bitrate de vídeo dinamicamente conforme a conexão do usuário
- **Camada**: Backend (mediasoup Server)
- **Prioridade**: Should
- **Arquivos impactados**:
  - `mediasoup-server/config.js` (novo)
  - `mediasoup-server/room-manager.js` (novo)

---

## Requisitos Não-Funcionais

### RNF-001: Latência end-to-end (input → visual feedback)
- **Categoria**: Performance
- **Descrição**: A latência entre o usuário realizar uma ação (click, tecla) e ver o resultado no vídeo deve ser inferior a 300ms
- **Métrica**: Medir com timestamp no envio de input e timestamp do frame correspondente no vídeo. Alvo: p95 < 300ms, p50 < 200ms

### RNF-002: Latência de áudio
- **Categoria**: Performance
- **Descrição**: A latência de áudio (Chrome → browser do usuário e vice-versa) deve ser inferior a 300ms
- **Métrica**: Medir round-trip time de áudio com tone generator. Alvo: < 300ms one-way

### RNF-003: Tempo de startup de sessão
- **Categoria**: Performance
- **Descrição**: Do clique do usuário em "Iniciar" até o vídeo aparecer no browser deve ser < 30 segundos
- **Métrica**: Timer no frontend: button click → first video frame rendered. Alvo: < 30s com imagem pré-built, < 15s ideal

### RNF-004: Escalabilidade — 100+ usuários simultâneos
- **Categoria**: Escalabilidade
- **Descrição**: O sistema deve suportar pelo menos 100 sessões simultâneas com recursos adequados de infraestrutura
- **Métrica**: Load test com 100 containers ativos + 100 WebRTC connections. CPU do host < 85%, RAM < 90%

### RNF-005: Isolamento de sessões
- **Categoria**: Segurança
- **Descrição**: Cada sessão roda em container Docker isolado. Um usuário não pode acessar dados ou processos de outro usuário
- **Métrica**: Teste de penetração: de dentro de um container, tentar acessar outro container ou o host

### RNF-006: Qualidade de vídeo
- **Categoria**: Usabilidade
- **Descrição**: O vídeo deve ser legível para texto e navegação web
- **Métrica**: 720p@30fps com VP8 a 2Mbps como baseline. Texto de 12px deve ser legível no stream

### RNF-007: Uso de recursos por container
- **Categoria**: Performance
- **Descrição**: Cada container deve consumir no máximo 1.5GB RAM e 2 CPU cores
- **Métrica**: docker stats por container durante uso ativo

### RNF-008: Disponibilidade do Session Agent
- **Categoria**: Confiabilidade
- **Descrição**: Se algum processo dentro do container crashar (Chrome, GStreamer, Agent), o Supervisord deve reiniciar automaticamente
- **Métrica**: Matar processos individualmente e verificar que reiniciam em < 5 segundos

### RNF-009: Cleanup de recursos
- **Categoria**: Confiabilidade
- **Descrição**: Não deve haver "leak" de containers, portas ou salas mediasoup. Sessões orfanadas devem ser destruídas automaticamente
- **Métrica**: Após 100 sessões criadas e destruídas: containers = 0, portas alocadas = 0, salas mediasoup = 0

### RNF-010: Compatibilidade de browsers
- **Categoria**: Usabilidade
- **Descrição**: O frontend deve funcionar nos browsers modernos: Chrome 90+, Firefox 90+, Safari 15+, Edge 90+
- **Métrica**: Testar WebRTC + mediasoup-client nos 4 browsers

---

## Regras de Negócio

### RN-001: Uma sessão por usuário
- **Descrição**: Cada userId pode ter no máximo 1 container ativo simultaneamente
- **Contexto**: Na criação de sessão — se já existe container para o userId, retornar referência ao existente em vez de criar novo

### RN-002: Limite máximo de sessões
- **Descrição**: O sistema deve ter um limite configurável de sessões simultâneas (ex: 100) para prevenir overload
- **Contexto**: Na criação de sessão — se o limite foi atingido, retornar erro 503 com mensagem "Sistema em capacidade máxima"

### RN-003: Timeout de inatividade
- **Descrição**: Sessão sem WebSocket de input ativo por 60 segundos é considerada abandonada e deve ser destruída
- **Contexto**: No monitoramento de sessões pelo Orchestrator

### RN-004: Extensão obrigatória
- **Descrição**: O Chrome DEVE carregar com a extensão do usuário. Se a extensão não estiver disponível no volume, o container não deve iniciar
- **Contexto**: Na criação do container — validar existência do diretório de extensão antes de criar

### RN-005: Recursos reservados por container
- **Descrição**: Cada container tem limite fixo: 1.5GB RAM, 2 CPU cores, 2GB SHM. Não configurável pelo usuário
- **Contexto**: Na criação do container via Dockerode

### RN-006: Portas dentro de range
- **Descrição**: Portas alocadas para containers devem estar no range 10000-39999 (abaixo do range do mediasoup workers 40000-49999)
- **Contexto**: No port allocator do Orchestrator

### RN-007: Rede Docker interna
- **Descrição**: Containers de sessão se comunicam com mediasoup via rede Docker interna ("browser-network"). Não devem estar expostos diretamente à internet
- **Contexto**: Na configuração de NetworkMode do container

---

## Impacto nas APIs Existentes

Não existem APIs — todas são novas.

### API do Orchestrator (REST)

#### POST /sessions
Cria nova sessão de browser remoto.

**Request:**
```json
{
  "userId": "string (obrigatório)",
  "options": {
    "resolution": "1280x720 | 1920x1080 | 854x480",
    "startUrl": "string (URL inicial, default: about:blank)",
    "extensionPath": "string (caminho da extensão no host)",
    "videoBitrate": "number (default: 2000000)",
    "audioBitrate": "number (default: 128000)"
  }
}
```

**Response (201):**
```json
{
  "sessionId": "string (container ID)",
  "userId": "string",
  "status": "running",
  "agentPort": "number",
  "signalingUrl": "string (WS URL para mediasoup signaling)"
}
```

**Response (409):**
```json
{
  "error": "Session already exists for this user",
  "existingSessionId": "string"
}
```

**Response (503):**
```json
{
  "error": "Maximum session limit reached",
  "currentSessions": "number",
  "maxSessions": "number"
}
```

#### DELETE /sessions/:userId
Destrói sessão do usuário.

**Response (200):**
```json
{
  "message": "Session destroyed",
  "userId": "string"
}
```

**Response (404):**
```json
{
  "error": "No active session for this user"
}
```

#### GET /sessions
Lista todas as sessões ativas.

**Response (200):**
```json
{
  "sessions": [
    {
      "userId": "string",
      "sessionId": "string",
      "status": "running | starting | stopping",
      "createdAt": "ISO 8601",
      "uptime": "number (seconds)"
    }
  ],
  "total": "number",
  "maxSessions": "number"
}
```

#### GET /sessions/:userId
Status detalhado de uma sessão.

**Response (200):**
```json
{
  "userId": "string",
  "sessionId": "string",
  "status": "running",
  "createdAt": "ISO 8601",
  "uptime": "number",
  "resources": {
    "cpuPercent": "number",
    "memoryMB": "number",
    "memoryLimitMB": "number"
  },
  "ports": {
    "agent": "number",
    "videoRtp": "number",
    "audioOutRtp": "number",
    "audioInRtp": "number"
  }
}
```

### API de Signaling (Socket.IO — mediasoup Server)

#### Eventos Client → Server:
| Evento | Payload | Descrição |
|--------|---------|-----------|
| `getRouterCapabilities` | `{ sessionId }` | Retorna RTP capabilities do router |
| `createRecvTransport` | `{ sessionId }` | Cria WebRtcTransport para receber media |
| `createSendTransport` | `{ sessionId }` | Cria WebRtcTransport para enviar mic |
| `connectTransport` | `{ transportId, dtlsParameters }` | Conecta DTLS do transport |
| `consume` | `{ sessionId, transportId, rtpCapabilities, kind }` | Consome vídeo ou áudio |
| `produce` | `{ sessionId, transportId, kind, rtpParameters }` | Produz áudio do mic |
| `resumeConsumer` | `{ consumerId }` | Resume consumer pausado |

#### Eventos Server → Client:
| Evento | Payload | Descrição |
|--------|---------|-----------|
| `routerCapabilities` | `{ rtpCapabilities }` | Capabilities do router |
| `transportCreated` | `{ id, iceParameters, iceCandidates, dtlsParameters }` | Transport criado |
| `transportConnected` | `{}` | DTLS conectado |
| `consumed` | `{ id, producerId, kind, rtpParameters }` | Consumer criado |
| `produced` | `{ id }` | Producer criado |
| `sessionEnded` | `{ reason }` | Sessão foi encerrada |

### API do Session Agent (WebSocket — dentro do container)

#### Mensagens Client → Agent (via WS):
```json
{ "type": "mousemove", "x": 640, "y": 360 }
{ "type": "click", "x": 640, "y": 360, "button": 0 }
{ "type": "scroll", "x": 640, "y": 360, "deltaY": -120 }
{ "type": "keydown", "key": "a", "code": "KeyA" }
{ "type": "keyup", "key": "a", "code": "KeyA" }
{ "type": "type", "text": "hello world" }
```

#### HTTP Endpoints do Session Agent:
| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/health` | `{ status: "ok", uptime: N }` |
| GET | `/info` | Retorna display, resolution, portas RTP |

---

## Definição de Escopo

### Dentro do Escopo
- Container Docker com Xvfb + PulseAudio + Chrome + GStreamer + Supervisord
- Session Agent (Node.js WS + HTTP dentro do container)
- Input injection via xdotool (mouse, teclado, scroll)
- mediasoup SFU centralizado com PlainTransport (container → SFU) e WebRtcTransport (SFU → browser)
- Áudio bidirecional completo (Chrome → usuário e mic → Chrome)
- Orchestrator com Dockerode (criar, destruir, listar, monitorar containers)
- Port allocator para portas dinâmicas
- Frontend React com BrowserViewer, mediasoup-client, input relay, session controls
- Signaling via Socket.IO
- Coturn TURN server (configuração + docker-compose)
- Health monitoring e auto-cleanup de sessões abandonadas
- Persistência de perfil Chrome via Docker volumes
- Configuração de resolução (720p, 1080p, 480p)
- Limite configurável de sessões simultâneas

### Fora do Escopo
- Autenticação/autorização de usuários (JWT, OAuth, etc.) — a definir em fase posterior
- Sistema de billing/cobrança por uso
- Interface admin com dashboard Grafana (fase produção)
- Load balancer (nginx/traefik) — fase cluster
- Kubernetes / Docker Swarm — fase escala
- GPU encoding (VAAPI/NVENC) — otimização futura
- Clipboard sync entre local e remoto — fase polish
- Cursor remoto customizado — fase polish
- Resize dinâmico (mudar resolução sem restart) — fase polish
- Notificações do Chrome → frontend — fase polish
- Chat entre usuários — mencionado no PLAN.md mas não detalhado
- Desenvolvimento da extensão Chrome em si — assumida como existente
- CDN para reduzir latência — fase produção
- Multi-region / geo-distribution — fase escala

---

## Premissas e Restrições

### Premissas
1. **Docker socket disponível**: O servidor de produção terá acesso a `/var/run/docker.sock` para o Orchestrator gerenciar containers
2. **Rede UDP aberta**: Portas UDP 40000-49999 estarão abertas para mediasoup workers, e portas 10000-39999 para containers
3. **Extensão Chrome pré-existente**: O usuário já tem uma extensão Chrome pronta. O sistema apenas a carrega no container
4. **IP público fixo**: O servidor terá IP público fixo para `announcedAddress` do mediasoup
5. **Imagem Docker pré-built**: A imagem `remote-browser:latest` será construída uma vez e usada para todos os containers
6. **Servidor com 128GB+ RAM**: Para suportar 100 sessões (100 × 1.5GB)
7. **Node.js 22**: Disponível tanto no servidor quanto na imagem Docker do container

### Restrições
1. **Container EasyPanel**: O ambiente de DESENVOLVIMENTO atual NÃO suporta Docker-in-Docker, GStreamer com Xvfb, nem portas UDP livres. Código será desenvolvido aqui mas testado em servidor dedicado
2. **VP8 como codec padrão de vídeo**: Universalmente suportado por todos os browsers. H264 como alternativa com GPU
3. **1 sessão por usuário**: Limitação arquitetural — cada userId mapeia para no máximo 1 container
4. **Chrome (não Chromium)**: Google Chrome especificamente, para melhor compatibilidade com extensões
5. **Sem autenticação no MVP**: A primeira versão não terá auth. Qualquer client que conheça a API pode criar sessões
6. **Supervisord como process manager**: Não systemd, não Docker compose dentro do container
7. **Socket.IO para signaling**: Não raw WebSocket, não gRPC — Socket.IO por familiaridade e features built-in (rooms, reconnect)

---

## Matriz de Dependências entre Componentes

```
RF-001 (Container Docker)
  ├── RF-002 (Xvfb) ← depende do container existir
  ├── RF-003 (PulseAudio) ← depende do container existir
  ├── RF-004 (Chrome) ← depende de RF-002 (display) e RF-003 (áudio)
  ├── RF-005 (GStreamer vídeo) ← depende de RF-002 (display)
  ├── RF-006 (GStreamer áudio out) ← depende de RF-003 (PulseAudio)
  ├── RF-007 (GStreamer áudio in) ← depende de RF-003 (PulseAudio)
  └── RF-008/009 (Session Agent) ← depende do container existir

RF-010/011/012 (mediasoup)
  ├── depende de RF-005/006 (recebe RTP do container)
  └── depende de RF-007 (envia RTP pro container)

RF-013 (Signaling) ← depende de RF-010/011/012 (mediasoup)

RF-014/015/016/017 (Orchestrator)
  ├── depende de RF-001 (cria containers)
  └── comunica com RF-010 (notifica mediasoup)

RF-018/019/020/021/022 (Frontend)
  ├── depende de RF-013 (signaling)
  ├── depende de RF-011 (WebRTC transport)
  └── depende de RF-008 (input relay)
```

### Ordem de Desenvolvimento Recomendada (por Fase)

| Fase | Componentes | Dependência |
|------|-------------|-------------|
| 1 | Container Base (RF-001 a RF-009) | Nenhuma |
| 2 | mediasoup SFU (RF-010 a RF-013) | Fase 1 |
| 3 | Frontend + Input (RF-018 a RF-022) | Fase 2 |
| 4 | Orchestrator (RF-014 a RF-017) | Fase 1, 2 |
| 5 | TURN + Produção (RF-023 a RF-025) | Fase 1-4 |
| 6 | Polish (Fora do escopo MVP) | Fase 1-5 |
