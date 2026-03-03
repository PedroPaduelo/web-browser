# Plano: Serende v2 — Remote Browser no EasyPanel (Sem Docker)

## Contexto

A arquitetura v1 (mediasoup + Docker + GStreamer) não roda no EasyPanel por falta de Docker socket e portas UDP. O objetivo é manter as **mesmas funcionalidades** usando os recursos já disponíveis no container:

- ✅ Google Chrome 145 (já instalado)
- ✅ Xvfb (display virtual :99 já rodando)
- ✅ ffmpeg 4.4.2 com H.264, VP8, MJPEG, Opus
- ✅ Playwright 1.58.2 (global)
- ✅ Node.js 22
- ✅ 12 cores, 33GB RAM livre
- ❌ Docker socket, mediasoup, GStreamer, portas UDP

## Arquitetura v2

```
Browser do Usuário (HTTPS)
       ↕ WebSocket
┌─────────────────────────────────┐
│  Streaming Server (Node.js)     │  ← TUDO roda aqui, 1 processo
│                                 │
│  ┌── ffmpeg x11grab ──────┐    │  Captura Xvfb :100 → MJPEG
│  │   Vídeo: pipe stdout   │    │  → WebSocket binary → cliente
│  │   Áudio: PulseAudio    │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌── xdotool ─────────────┐    │  Mouse/teclado injetados
│  │   Input: child_process  │    │  no display :100
│  └─────────────────────────┘    │
│                                 │
│  ┌── Chrome ──────────────┐    │  Chrome com extensão
│  │   Display :100          │    │  rodando no Xvfb dedicado
│  │   --load-extension      │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌── REST API ────────────┐    │  Start/stop sessão
│  │   Express :4201         │    │  Configurações
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

### Diferenças v1 → v2

| Aspecto | v1 (Docker) | v2 (EasyPanel) |
|---------|-------------|----------------|
| Isolamento | 1 container/usuário | 1 sessão/display no mesmo container |
| Vídeo | GStreamer → mediasoup → WebRTC | ffmpeg x11grab → WebSocket MJPEG |
| Áudio | GStreamer → mediasoup → WebRTC | ffmpeg PulseAudio → WebSocket MP3 |
| Input | xdotool via Session Agent WS | xdotool direto via child_process |
| Signaling | Socket.IO + mediasoup-client | WebSocket nativo (mais simples) |
| Orquestração | Dockerode | child_process (Xvfb, Chrome, ffmpeg) |
| Escala | 100+ usuários | 1-3 sessões (limitado ao container) |
| Latência vídeo | ~100-200ms (WebRTC) | ~150-400ms (MJPEG/WS) |
| Complexidade | XL (10 componentes) | M (1 servidor + 1 frontend) |

### Funcionalidades mantidas

1. ✅ Vídeo do Chrome remoto → browser do usuário
2. ✅ Áudio do Chrome → browser do usuário
3. ✅ Mouse (move, click, scroll, right-click)
4. ✅ Teclado (keydown, keyup, type, atalhos)
5. ✅ Iniciar/encerrar sessão via UI
6. ✅ Resolução configurável (720p, 1080p, 480p)
7. ✅ Extensão Chrome carregada
8. ⚠️ Mic bidirecional (possível mas mais complexo — fase 2)
9. ❌ Escala 100+ (limitação do ambiente, não da arquitetura)

## Estrutura de Arquivos

Reutilizar o máximo do frontend existente. O backend é novo e mais simples.

```
serende/
├── server/                          # NOVO — substitui mediasoup-server + orchestrator
│   ├── package.json
│   ├── index.js                     # Entry: Express + WebSocket server
│   ├── session-manager.js           # Gerencia Xvfb + Chrome + ffmpeg (child_process)
│   ├── stream-manager.js            # ffmpeg capture → WebSocket broadcast
│   └── input-handler.js             # xdotool wrapper
│
├── frontend/                        # EXISTENTE — adaptar hooks e componentes
│   └── src/
│       ├── App.tsx                   # Adaptar: remover mediasoup, usar WS nativo
│       ├── lib/
│       │   ├── ws-client.ts          # NOVO — substitui signaling.ts
│       │   └── input-mapper.ts       # MANTER como está
│       ├── hooks/
│       │   ├── useStream.ts          # NOVO — substitui useMediasoup
│       │   ├── useInputRelay.ts      # ADAPTAR — usar ws-client
│       │   └── useSession.ts         # ADAPTAR — apontar para novo server
│       └── components/
│           ├── BrowserViewer.tsx      # ADAPTAR — canvas em vez de <video>
│           ├── SessionControls.tsx    # MANTER como está
│           ├── AudioManager.tsx       # ADAPTAR
│           └── ConnectionStatus.tsx   # ADAPTAR — WS state
```

## Tarefas de Implementação

### Fase 1: Backend — Streaming Server (5 tarefas)

**TASK-V2-001**: Instalar xdotool + PulseAudio
**TASK-V2-002**: Criar `server/input-handler.js` (reutilizar lógica do session-agent)
**TASK-V2-003**: Criar `server/session-manager.js` (spawn Xvfb + Chrome + ffmpeg)
**TASK-V2-004**: Criar `server/stream-manager.js` (ffmpeg → WS broadcast MJPEG)
**TASK-V2-005**: Criar `server/index.js` (Express + WS + REST API)

### Fase 2: Frontend — Adaptar existente (6 tarefas)

**TASK-V2-006**: Criar `frontend/src/lib/ws-client.ts` (WS nativo)
**TASK-V2-007**: Criar `frontend/src/hooks/useStream.ts` (canvas MJPEG)
**TASK-V2-008**: Adaptar `useInputRelay.ts`
**TASK-V2-009**: Adaptar `useSession.ts`
**TASK-V2-010**: Adaptar `BrowserViewer.tsx` (canvas)
**TASK-V2-011**: Adaptar `App.tsx`

### Fase 3: Build + Teste E2E

**TASK-V2-012**: Build, deploy, teste funcional completo

## Verificação

1. `npm install` no server/ — sem erro
2. `npm run build` no frontend/ — sem erro
3. Iniciar servidor: `node server/index.js`
4. Acessar https://serende-app.ddw1sl.easypanel.host
5. Clicar "Iniciar Sessão" → Chrome remoto aparece na tela
6. Mouse move → cursor move no Chrome remoto
7. Click → clica no Chrome
8. Teclado → digita no Chrome
9. Encerrar sessão → processos param
