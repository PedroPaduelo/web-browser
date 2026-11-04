# Análise de Recursos — Serende (browser remoto para agentes de IA)

> Investigação com 3 subagentes (estático, empírico, histórico). Data: 03/11/2026.
> Cenário-alvo do produto: **agentes de IA operando browsers em sessões isoladas, assistidos ao vivo por humanos via WebRTC**.

---

## 1. Arquitetura real de streaming (o que roda hoje)

```
SESSÃO (1 por sessionId)
  Xvfb :100-:199  ── Chrome --kiosk (8 procs, ~840-2027 MB)  ── CDP :9222+
        └── ffmpeg x11grab 30fps → MJPEG q5 → stdout
              └── StreamManager: scan SOI/EOI → frame JPEG (31KB típico)
                    ├── lastFrame (último frame, p/ novos viewers)
                    └── broadcast WS /ws/stream → N viewers (1 send/frame/viewer)
  FALLBACK (se ffmpeg morre): CDP Page.startScreencast q60 (~0.3fps)
  INPUT AGENTE:  MCP :4202 → POST /api/input → CDP Input.dispatch*
  OBS AGENTE:    /api/screenshotWithInfo → novo WS CDP POR chamada
  VIEWER INPUT:  WS /ws/input → mesmo CDP input handler
```

**O "WebRTC" do produto não existe em runtime.** `webrtc-manager.js` (@roamhq/wrtc,
H264/VP8, ICE/STUN) está **morto** — ninguém importa o módulo, e as rotas
`/api/webrtc/*` que o frontend (`useWebRTC.ts`) chama **não existem** no backend.
O frontend ainda tenta (`frontend/src/hooks/useWebRTC.ts:124,186`).

## 2. Números medidos na máquina de dev (4 cores, 7,75 GB RAM)

| Item | Por sessão | 10 sessões |
|---|---|---|
| RSS somado (Chrome 840 + ffmpeg 114 + Xvfb 77) | **~1,03 GB** | ~10,3 GB (OOM > ~7) |
| RAM real incremental (free) | **~235-273 MB** | ~2,4-2,7 GB (apertado) |
| **CPU** | **~1 núcleo (ffmpeg) + ~0,2** | ~10-12 núcleos → satura 4 cores em **3-4 sessões** |
| Backend Node | +20 MB/sessão (devolve só ~50%) | +250 MB |
| Produção de vídeo | 30 fps × 31 KB ≈ 0,94 MB/s (~3,4 GB/h) | 9,4 MB/s |
| Disco | ~10-15 MB perfil/sessão + sockets | ~150 MB |

Pós-delete: 22/22 PIDs morreram corretamente (zero zombies) ✅ — mas ficaram
resíduos: 8 Xvfb órfãos de run anterior (~500 MB — limpos em 03/11), sockets
stale em `/tmp/.X11-unix`, e perfis de sessão morta em
`data/tenants/<tenantId>/sessions/<sessionId>/` sobrevivem a restarts.

**O frame é BYTE-IDÊNTO quando a tela está parada** (31 KB em capturas separadas)
— e o ffmpeg continua pagando ~1 núcleo + 114 MB para descobrir isso 30×/s.

## 3. Lições históricas do repo (o problema já aconteceu)

- **Incidente dos 2.709 MB/sessão** (`session-manager.js:517-529`): Chrome 2027 MB
  em 8 processos + ffmpeg 342 + Xvfb 158 vs teto da sandbox 2048 MB. Mitigado com
  `--renderer-process-limit=1`, `--process-per-site`, `--js-flags=--max-old-space-size=192`.
- **Memguard mata POR GRUPO DE PROCESSO o maior RSS** (kill(-pgid)); antes do fix
  derrubava o backend inteiro quando Chrome herdava PGID (>1,6 GB), hoje mata só
  o produtor (ffmpeg) → **degradação silenciosa 30fps → fallback CDP ~0,3fps**.
- **ffmpeg puro não morre com EOF no stdin** — wrapper com trap EXIT/EOF/PPID +
  SIGKILL +2s (`session-manager.js:156-196`, regressão em `scripts/test-ffmpeg-leak.js`).
- **Rate-limit 429 em cascata**: todo tráfego MCP chegava como 127.0.0.1 — um
  tenant estourava o balde dos outros; e o MCP tratava 429 como "sessão sumida",
  criando sessão nova (tempestade). Fix: chave de limit por tenantId.

## 4. Diagnóstico consolidado — TOP problemas

| # | Problema | Custo | Onde |
|---|---|---|---|
| P0-1 | **ffmpeg 30fps q5 rodando SEM viewer e SEM mudança de tela** | ~350 MB RAM + ~1 core por sessão ociosa | `session-manager.js:198-221` |
| P0-2 | **MJPEG por WS p/ viewer: 3-9 MB/s por espectador** (mesmo JPEG reenviado a 30 fps), broadcast síncrono serial no event loop | banda + CPU linear por viewer; 1 sessão popular trava as outras 99 | `stream-manager.js:123-149` |
| P0-3 | **WebRTC morto** (design pronto, rotas inexistentes no backend) | é o caminho que eliminaria P0-2 | `webrtc-manager.js`, `useWebRTC.ts` |
| P1-4 | Leak: `networkEvents.byRequestId` nunca deletado + `thumbCache` fica vivo p/ sessão morta | 3-6 MB vivos p/ sempre por sessão navegada | `index.js:1177`, `index.js:1699` |
| P1-5 | `/api/screenshotWithInfo`: WS CDP NOVO por chamada + 5 roundtrips; agente chama a cada ação | ~100-300 ms CPU/renderer por call | `index.js:892-978` |
| P1-6 | Admin panel: 2 roundtrips CDP/sessão a cada 5s | com 100 sessões: 200 CDP roundtrips/5s | `index.js:1635-1673` |
| P1-7 | `cdp-input-handler`: `setInterval` 3s de layout不停地 (acorda renderer p/ sempre) | mantém Chrome acordado | `cdp-input-handler.js:291-298` |
| P2-8 | Código morto pesado: `webrtc-manager.js`, `audio-manager.js`, `input-handler.js`+`x11-input.py`, `instance.js` | risco/observabilidade não custo | ver (e) |
| P2-9 | MAX_SESSIONS=1000 vs 100 displays vs 3-4 sessões reais (CPU) | guardas mentem | `session-manager.js:8,12` |
| P2-10 | crop off-by-one (`1279:719`, escala `neighbor`) | artefato/1px | `session-manager.js:206-217` |
| P3-11 | StreamManager: Buffer alocado por frame (30/s de churn de GC) | ~6-9 MB/s de churn por sessão | `stream-manager.js:105` |

## 5. Plano de ação priorizado

### Fase 1 — economizar o óbvio (bag ubiquitous, sem mudar arquitetura)
1. **Captura só com espectador** (`P0-1`): em `StreamManager`, quando
   `clients.size === 0` suspenda o ffmpeg (SIGSTOP/sinal de framerate) ou siga
   o fallback CDP (que é on-repaint). Retome no `addClient`. **Ganho potencial:
   ~350 MB + 1 core por sessão sem ninguém assistindo.**
2. **fps/q adaptativos**: tela estática (últimos 2 frames idênticos) → 5-10 fps
   e q8; movimento → 30 fps. O JPEG idêntico já é a evidência — basta comparar
   hash do `lastFrame`.
3. **Deletar memória de sessão morta** (`P1-4`): `networkEvents.delete` +
   varredura de `thumbCache` no `onSessionDied`/`stopSessionFully` (o caminho do
   tenant não limpa hoje).
4. **Startup reaper**: matar Xvfb/ffmpeg órfãos ao boot (displays de runs
   anteriores) + limpar perfis de sessão morta em `data/tenants/*/sessions/*`
   (episódio dos 500 MB em displays fantasma).

### Fase 2 — custo por espectador e por agente
5. **Decidir o destino do WebRTC** (`P0-2/P0-3`):
   - **Caminho recomendado**: reativar `webrtc-manager.js` (o código já existe:
     1 `RTCVideoSource` por sessão, encoder por peer, H264 baixo bitrate p/ 1
     viewer interativo + simulcast/SVC se necessário) + rotas `/api/webrtc/*`
     que o frontend já espera + TURN configurável. Elimina a multiplicação de
     banda 3-9 MB/s/viewer do MJPEG.
   - Se não agora: **backpressure incremental** (dispatch async por viewer,
     cortar viewers "mudos" >X s, espalhar broadcast em chunks) + métricas
     `dropped/slowClients` expostas em `/api/health`.
6. **Screenshot do agente barato** (`P1-5`): servir do `streamManager.lastFrame`
   (fresco, 0.2-0.4 MB, já existe!) quando streaming ativo; usar os pools CDP
   existentes (`index.js:676-761`) e cache ~250-1500 ms.
7. **Quotas por AGENTE**, não por tenant (connId MCP no header): N agentes não
   devem disputar o mesmo balde de 600 req/min (`mcp/index.js:385-434`).

### Fase 3 — arquitetura (se/ess quando escalar vários agentes browsers)
8. **Isolar plano de dados do event loop global** (worker/cluster por grupo de
   sessões, ou processo dedicado ao streaming com stdout passthrough).
9. **Admin O(N)**: cache de títulos/urls com TTL maior + só roundtrip CDP da
   última sessão interagida.
10. **Limpeza do código morto + docs sincronizadas**: desenhar o que é ativo
    (ffmpeg→WS→canvas, CDP input) e apagar os fantasmas (WebRTC não ativado,
    AudioManager, XTest/Python) — ou marcá-los explicitamente como "planejado".

## 6. Metas realistas pós-fix

| Métrica | Hoje (medido) | Meta Fase 1 | Meta Fase 2 |
|---|---|---|---|
| RAM por sessão ociosa (sem viewer) | ~1,0 GB (RSS) / ~250 MB (real) | ~250-450 MB RSS (Chrome+Xvfb só) | idem |
| CPU por sessão ociosa | ~1,2 core | ~0,05 core | idem |
| Sessões simultâneas (4 cores/8 GB) | 3-4 | 8-12 (ociosas) | 15-25 |
| Banda por viewer | 3-9 MB/s | idem | **0,5-2 MB/s (WebRTC)** |

> Nota: números de RAM do Chrome dominam e são inerentes (~840 MB RSS somando
> libs compartilhadas; ~250 MB reais por sessão). Flags de memória existentes
> (`--renderer-process-limit=1` etc.) já mitigaram o pior caso histórico.
