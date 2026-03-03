# Triagem & Classificação

## Resumo Executivo
Sistema de Chrome remoto que roda 1 instância Chrome REAL por usuário dentro de containers Docker isolados, transmite vídeo+áudio via WebRTC (mediasoup SFU), recebe input do usuário (mouse/teclado/mic) e carrega extensão Chrome custom. Escala alvo: 100+ usuários simultâneos. Projeto completamente novo — do zero.

## Dados da Triagem

| Campo | Valor |
|-------|-------|
| **Tipo** | 🆕 `new_system` |
| **Prioridade** | P1 (alta) - Sistema core do produto, sem ele nada funciona |
| **Complexidade** | XL - 10 componentes distribuídos, Docker-in-Docker, WebRTC, GStreamer, mediasoup, audio bidirecional, orquestração de containers |
| **Data** | 2026-03-02 |

## Descrição Original
Sistema que roda 1 Chrome REAL por usuário dentro de containers Docker isolados, transmite video+audio via WebRTC (mediasoup), recebe input do usuário (mouse/teclado) e audio bidirecional (microfone). O Chrome carrega uma extensão custom do usuário. Escala alvo: 100+ usuários simultâneos. O plano contempla 10 peças: Container Base, Xvfb+PulseAudio, Chrome+Extensão, GStreamer, Input Agent, Session Agent, mediasoup SFU, Orchestrator, Frontend React, Coturn.

## Reconhecimento do Projeto

### Stack Planejado
| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| Container Base | Ubuntu 22.04 + Docker | - |
| Display Virtual | Xvfb | - |
| Áudio Virtual | PulseAudio | - |
| Browser | Google Chrome (não Chromium) | stable |
| Captura/Encoding | GStreamer + plugins (base, good, bad, ugly) | 1.x |
| Encoding Vídeo | VP8 (software) / H264 (GPU) | - |
| Encoding Áudio | Opus | - |
| WebRTC SFU | mediasoup (Node.js) | latest |
| Input Injection | xdotool | - |
| Session Agent | Node.js + Express + ws | 22 |
| Orchestrator | Node.js + Dockerode | 22 |
| Frontend | React + mediasoup-client + Socket.IO | - |
| Signaling | Socket.IO | - |
| TURN Server | Coturn | latest |
| Process Manager | Supervisord | - |
| Monitoramento | Prometheus + Grafana | - |

### Estrutura do Projeto (Atual)
```
serende/
  .claude/          # Config do agente
  .mcp.json         # Config MCP servers
  PLAN.md           # Plano arquitetural completo (10 peças)
  01-triagem.md     # Este documento
```

### Estrutura Planejada (Conforme PLAN.md)
```
serende/
  container/
    Dockerfile
    entrypoint.sh
    supervisord.conf
    session-agent/
      index.js         # Servidor WS + HTTP dentro do container
      input.js          # xdotool - injeção de mouse/teclado
      package.json
  mediasoup-server/
    index.js            # Servidor mediasoup SFU centralizado
    config.js           # Config workers, codecs, transports
    room-manager.js     # 1 room = 1 usuário = 1 container
    signaling.js        # WS signaling com frontend
    package.json
  orchestrator/
    container-manager.js  # Dockerode - cria/destrói containers
    port-allocator.js     # Alocação de portas
    index.js              # API REST
    package.json
  frontend/
    src/
      components/
        BrowserViewer.tsx    # Vídeo WebRTC + overlay input
        AudioManager.tsx     # Mic do usuário
        SessionControls.tsx  # Start/stop sessão
      hooks/
        useMediasoup.ts      # mediasoup-client
        useInputRelay.ts     # Mouse/teclado relay
        useSession.ts        # Gerencia sessão
      lib/
        signaling.ts         # WS signaling
        input-mapper.ts      # Mapeamento eventos DOM → server
    package.json
  turn/
    docker-compose.turn.yml
    turnserver.conf
```

### Portas & Serviços (Planejados)
| Serviço | Porta | Host | Notas |
|---------|-------|------|-------|
| Session Agent | 9222/tcp | Dentro do container | 1 por container |
| mediasoup Workers | 40000-49999/udp | Servidor mediasoup | RTC ports |
| Video RTP | 5004/udp | Dentro do container | GStreamer → mediasoup |
| Audio Out RTP | 5006/udp | Dentro do container | GStreamer → mediasoup |
| Audio In RTP | 5008/udp | Dentro do container | mediasoup → GStreamer |
| Coturn TURN | 3478/udp+tcp | Servidor TURN | NAT traversal |
| Coturn TLS | 5349/tcp | Servidor TURN | TURN over TLS |
| API Gateway | TBD | Servidor central | Express REST |
| Signaling WS | TBD | Servidor central | Socket.IO |
| Frontend | TBD | Servidor central | React SPA |

### Banco de Dados
Nenhum banco de dados mencionado no plano. Estado gerenciado em memória (containers, sessions). Possível necessidade de Redis para:
- Estado de sessões entre restarts
- Pub/Sub entre serviços
- Rate limiting

### Padrões de Projeto em Uso
- **Container-per-user**: Isolamento total — 1 container Docker por sessão
- **SFU (Selective Forwarding Unit)**: mediasoup roteia media sem transcodar
- **PlainTransport + WebRtcTransport**: RTP entre containers e mediasoup, WebRTC entre mediasoup e browsers
- **Agent Pattern**: Session Agent dentro do container como ponte
- **Supervisord**: Multi-process no container (Xvfb, PulseAudio, Chrome, GStreamer, Agent)

### Variáveis de Ambiente Relevantes
- `DISPLAY_NUM` — Número do display Xvfb (único por container)
- `RESOLUTION` — Resolução do display (ex: 1280x720)
- `VIDEO_RTP_PORT` — Porta RTP vídeo
- `AUDIO_RTP_PORT` — Porta RTP áudio saída
- `MIC_RTP_PORT` — Porta RTP áudio entrada (mic)
- `AGENT_PORT` — Porta do Session Agent
- `VIDEO_BITRATE` — Bitrate do encoding vídeo
- `AUDIO_BITRATE` — Bitrate do encoding áudio
- `START_URL` — URL inicial do Chrome
- `PUBLIC_IP` — IP público do servidor (mediasoup announced address)

## Áreas Impactadas
- [x] Frontend (React + mediasoup-client + input relay)
- [x] Backend (Orchestrator + mediasoup SFU + Session Agent)
- [ ] Banco de Dados (não especificado — pode precisar de Redis)
- [x] APIs / MCP / Integrações (Docker API, WebRTC signaling, REST API)
- [x] Infraestrutura / Docker / Deploy (Container base, Coturn, rede Docker, K8s/Swarm)
- [ ] Documentação

## Riscos Identificados

### Críticos
1. **Latência end-to-end > 500ms** — UX inaceitável pra input interativo. Mitigação: GPU encoding, servidor próximo do usuário, bandwidth estimator.
2. **GStreamer → mediasoup RTP mismatch** — Se o formato/payload RTP não bater, sem vídeo/áudio. Precisa ser testado exaustivamente na Fase 2.
3. **Escala: RAM** — 100 × 1.5GB = 150GB. Precisa de servidor com 128GB+ (com swap) ou cluster.
4. **Escala: CPU sem GPU** — 100 × 1.5 cores = 150 cores. Inviável sem GPU encoding.

### Altos
5. **Docker-in-Docker** — O ambiente atual é um container EasyPanel. Criar containers Docker DENTRO dele exige Docker socket mount ou DinD, que tem implicações de segurança e performance.
6. **Áudio bidirecional — echo/delay** — PulseAudio loopback + encoding + network = potencial echo. Precisa de echo cancellation.
7. **Chrome memory leak** — Chrome é famoso por consumir RAM crescente. Sessões longas podem OOM. Supervisord reinicia, mas perde estado.
8. **xdotool input lag** — Em uso intenso (gaming, scroll rápido), pode acumular delay. Otimização com libxdo direta ou uinput.

### Médios
9. **Custo de bandwidth** — 100 usuários × 3Mbps = 300Mbps constante. Pode ficar caro dependendo do provider.
10. **Extensão Chrome incompatível** — Extensões que usam APIs restritas podem não funcionar no ambiente. Testar cedo.
11. **Coturn config** — NAT traversal é notoriamente difícil de debugar. TURN precisa de certs SSL e portas UDP abertas.

## Dependências Conhecidas
- **Docker Engine** com acesso ao socket (`/var/run/docker.sock`)
- **Acesso a rede UDP** — mediasoup e Coturn precisam de range de portas UDP
- **IP público fixo** — mediasoup precisa de `announcedAddress`
- **GPU (opcional mas recomendado)** — VAAPI/NVENC para encoding em escala
- **Servidor(es) dedicado(s)** — Container EasyPanel atual NÃO suporta rodar 100 containers Chrome. Infra dedicada necessária.

## Perguntas Pendentes
1. **O desenvolvimento vai acontecer NESTE container EasyPanel ou num servidor dedicado?** O ambiente atual não tem Docker socket nem GPU — ideal pra dev do código, mas não pra rodar containers Docker filhos.
2. **A extensão Chrome já existe?** Precisa ser testada no Fase 1.
3. **Qual o servidor/cloud alvo pra produção?** Hetzner Dedicated, Hetzner Cloud, AWS, OVH?
4. **Precisa de autenticação de usuários?** JWT, OAuth, sessions?
5. **Precisa de persistência de sessão?** (Chrome profile entre reconexões)
6. **Qual a resolução alvo?** 720p (mais leve) ou 1080p (melhor UX)?
7. **Precisa de chat entre usuários?** O PLAN.md menciona ChatPanel mas não detalha.
8. **Qual o MVP?** Todas as 10 peças, ou pode começar com um subconjunto pra validar?

## Recomendação Inicial

### Abordagem
Este é um projeto XL de infraestrutura pesada. Recomendo:

1. **Fase de validação técnica primeiro** — Antes de construir os 10 componentes, validar os 3 maiores riscos:
   - GStreamer → mediasoup RTP funciona? (Peça 4 + 7)
   - Latência é aceitável? (< 300ms)
   - Chrome + extensão funciona dentro de container? (Peça 1 + 3)

2. **Desenvolvimento incremental** — Seguir o cronograma do PLAN.md (Fases 1-6), mas com gates de validação entre fases.

3. **Ambiente de dev vs produção** — Desenvolver o código (Orchestrator, mediasoup server, frontend, session agent) aqui no EasyPanel. Testar o container base num ambiente com Docker (VPS dedicado ou local).

4. **MVP mínimo** — Container + GStreamer + mediasoup + Frontend simples (sem Orchestrator, sem TURN, 1 sessão). Se isso funcionar, o resto é "engenharia conhecida".

### O que pode ser feito AQUI no EasyPanel
- ✅ Frontend React (dev + preview)
- ✅ mediasoup server (código — precisa de servidor real pra workers)
- ✅ Orchestrator (código — precisa de Docker socket pra testar)
- ✅ Session Agent (código)
- ✅ Dockerfile + configs
- ❌ Rodar containers Chrome (precisa de Docker-in-Docker)
- ❌ GStreamer pipelines (precisa de Xvfb)
- ❌ Coturn (precisa de portas UDP)
- ❌ mediasoup workers (precisa de portas UDP 40000-49999)
