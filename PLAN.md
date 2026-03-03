# PLANO: Servidor de Browser Remoto — Do Zero

## Visao Geral

Sistema que roda 1 Chrome REAL por usuario dentro de containers Docker isolados,
transmite video+audio via WebRTC (mediasoup), recebe input do usuario (mouse/teclado)
e audio bidirecional (microfone). O Chrome carrega uma extensao custom do usuario.

Escala alvo: 100+ usuarios simultaneos.

---

## ARQUITETURA GERAL

```
                         INTERNET
                            |
                     [ Load Balancer ]
                       (nginx/traefik)
                            |
              +-------------+-------------+
              |                           |
      [ API Gateway ]            [ TURN Server ]
      (Node.js + Express)          (Coturn)
              |
    +---------+---------+
    |                   |
[ Orchestrator ]  [ mediasoup SFU ]
(gerencia containers)  (media routing)
    |                   |
    +---Docker API------+
    |
+---+---+---+---+---+---+---+
| C1  | C2  | C3  | ... | Cn |   <-- 1 container por usuario
+---+---+---+---+---+---+---+
Cada container:
  - Xvfb (display virtual)
  - PulseAudio (audio virtual)
  - Chrome + Extensao
  - GStreamer (captura+encoding)
  - Input Agent (xdotool)
  - Session Agent (WebSocket local)
```

---

## COMPONENTES (10 pecas)

### PECA 1: Container Base (Docker Image)
**O que:** Imagem Docker com tudo que uma sessao precisa.
**Conteudo:**
- Ubuntu 22.04 base
- Xvfb (display virtual)
- PulseAudio (audio virtual)
- Google Chrome (nao Chromium — pra extensoes funcionarem melhor)
- GStreamer + plugins (gst-plugins-base, good, bad, ugly)
- xdotool (input injection)
- Node.js 22 (session agent)
- Supervisord (gerencia processos dentro do container)

**Dockerfile simplificado:**
```dockerfile
FROM ubuntu:22.04

# Deps base
RUN apt-get update && apt-get install -y \
    xvfb \
    pulseaudio \
    xdotool \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-pulseaudio \
    gstreamer1.0-x \
    supervisor \
    wget \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    nodejs \
    npm

# Google Chrome
RUN wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && dpkg -i google-chrome-stable_current_amd64.deb || apt-get -f install -y \
    && rm google-chrome-stable_current_amd64.deb

# Session agent
COPY session-agent/ /app/session-agent/
WORKDIR /app/session-agent
RUN npm install

# Extensao do usuario (montada via volume)
# Chrome policies (montada via volume)

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

**Estimativa de tamanho da imagem:** ~1.5-2GB
**RAM por container:** 800MB-1.5GB
**CPU por container:** 1-2 cores

---

### PECA 2: Xvfb + PulseAudio (Display e Audio Virtual)

**Xvfb** cria uma tela fake. O Chrome renderiza nela como se fosse um monitor real.

```bash
# entrypoint.sh
Xvfb :${DISPLAY_NUM} -screen 0 ${RESOLUTION}x24 -ac &
export DISPLAY=:${DISPLAY_NUM}
```

Variaveis configuradas pelo orchestrator:
- DISPLAY_NUM: numero unico por container (99, 100, 101...)
- RESOLUTION: "1280x720" ou "1920x1080"

**PulseAudio** cria dispositivos de audio virtuais:

```bash
# Inicia PulseAudio no container
pulseaudio --start --exit-idle-time=-1 --daemon

# Cria speaker virtual (output do Chrome → capturado pelo GStreamer)
pactl load-module module-null-sink sink_name=virtual_speaker \
    sink_properties=device.description="VirtualSpeaker"

# Cria mic virtual (audio do usuario → input do Chrome)
pactl load-module module-null-sink sink_name=virtual_mic \
    sink_properties=device.description="VirtualMic"
pactl load-module module-virtual-source \
    source_name=virtual_mic_source \
    master=virtual_mic.monitor
```

**Audio bidirecional - como funciona:**
```
Browser do usuario (mic)
    → WebRTC audio track
    → mediasoup Consumer
    → PlainTransport RTP
    → GStreamer no container (recebe RTP, decodifica Opus)
    → PulseAudio virtual_mic
    → Chrome pega como microfone

Chrome toca audio (site com som, video, meet)
    → PulseAudio virtual_speaker
    → GStreamer captura (pulsesrc device=virtual_speaker.monitor)
    → Encoda Opus
    → RTP para mediasoup PlainTransport
    → mediasoup Producer
    → WebRTC audio track
    → Browser do usuario (ouve)
```

---

### PECA 3: Chrome com Extensao

O Chrome roda COM GUI dentro do Xvfb. Nao e headless.

```bash
google-chrome \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --disable-translate \
    --disable-background-networking \
    --window-size=1280,720 \
    --window-position=0,0 \
    --user-data-dir=/data/chrome-profile \
    --load-extension=/data/extension \
    --use-fake-device-for-media-stream \
    --use-fake-ui-for-media-stream \
    --autoplay-policy=no-user-gesture-required \
    --enable-features=WebRTCPipeWireCapturer \
    --start-maximized \
    --display=:${DISPLAY_NUM} \
    "${START_URL:-about:blank}"
```

**Flags importantes:**
- `--load-extension=/data/extension` → carrega a extensao do usuario
- `--use-fake-device-for-media-stream` → faz o Chrome aceitar mic/cam virtual
- `--user-data-dir=/data/chrome-profile` → persistencia de cookies/login entre sessoes
- `--autoplay-policy=no-user-gesture-required` → audio toca sem interacao

**A extensao** e montada via Docker volume. O orchestrator copia pra dentro do container.

**Persistencia:** Se quiser manter cookies/login entre sessoes, o `/data/chrome-profile`
pode ser um volume Docker persistente vinculado ao userId.

---

### PECA 4: GStreamer (Captura + Encoding + Streaming)

Duas pipelines GStreamer rodam por container:

**Pipeline VIDEO (display → RTP):**
```bash
gst-launch-1.0 \
    ximagesrc display-name=:${DISPLAY_NUM} use-damage=false show-pointer=true \
    ! video/x-raw,framerate=30/1 \
    ! videoconvert \
    ! vp8enc deadline=1 target-bitrate=${VIDEO_BITRATE} cpu-used=4 \
      threads=2 keyframe-max-dist=60 \
    ! rtpvp8pay pt=96 ssrc=1111 \
    ! udpsink host=127.0.0.1 port=${VIDEO_RTP_PORT}
```

**Pipeline AUDIO OUT (PulseAudio → RTP):**
```bash
gst-launch-1.0 \
    pulsesrc device=virtual_speaker.monitor \
    ! audioconvert \
    ! audioresample \
    ! opusenc bitrate=${AUDIO_BITRATE} \
    ! rtpopuspay pt=101 ssrc=2222 \
    ! udpsink host=127.0.0.1 port=${AUDIO_RTP_PORT}
```

**Pipeline AUDIO IN (RTP do usuario → PulseAudio mic):**
```bash
gst-launch-1.0 \
    udpsrc port=${MIC_RTP_PORT} \
      caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=101" \
    ! rtpopusdepay \
    ! opusdec \
    ! audioconvert \
    ! audioresample \
    ! pulsesink device=virtual_mic
```

**Parametros (configuraveis pelo orchestrator):**
- VIDEO_BITRATE: 2000000 (2Mbps) a 4000000 (4Mbps)
- AUDIO_BITRATE: 64000 a 128000
- VIDEO_RTP_PORT: porta local pra video (ex: 5004)
- AUDIO_RTP_PORT: porta local pra audio (ex: 5006)
- MIC_RTP_PORT: porta pra receber mic do usuario (ex: 5008)

**CPU encoding sem GPU:** ~0.5-1.5 cores por sessao (VP8 software)
**CPU encoding com GPU (VAAPI):** ~0.1 cores por sessao
→ Pra 100+ usuarios, GPU e quase obrigatorio

---

### PECA 5: Input Agent (xdotool — mouse/teclado do usuario)

Recebe eventos de mouse e teclado do usuario via WebSocket e injeta no Xvfb.

```js
// session-agent/input.js
const { exec } = require('child_process');

function injectMouse(x, y) {
    exec(`DISPLAY=:${displayNum} xdotool mousemove ${x} ${y}`);
}

function injectClick(x, y, button) {
    const btn = button === 0 ? 1 : button === 1 ? 2 : 3;
    exec(`DISPLAY=:${displayNum} xdotool mousemove ${x} ${y} click ${btn}`);
}

function injectScroll(x, y, deltaY) {
    const dir = deltaY > 0 ? 5 : 4; // 5=down, 4=up
    const clicks = Math.min(Math.ceil(Math.abs(deltaY) / 120), 5);
    exec(`DISPLAY=:${displayNum} xdotool mousemove ${x} ${y}`);
    for (let i = 0; i < clicks; i++) {
        exec(`DISPLAY=:${displayNum} xdotool click ${dir}`);
    }
}

function injectKeyDown(key) {
    exec(`DISPLAY=:${displayNum} xdotool keydown ${mapKey(key)}`);
}

function injectKeyUp(key) {
    exec(`DISPLAY=:${displayNum} xdotool keyup ${mapKey(key)}`);
}

function injectType(text) {
    exec(`DISPLAY=:${displayNum} xdotool type --delay 0 "${text}"`);
}

// Mapeamento de teclas JS → X11
function mapKey(jsKey) {
    const map = {
        'Enter': 'Return', 'Backspace': 'BackSpace',
        'Tab': 'Tab', 'Escape': 'Escape', 'Delete': 'Delete',
        'ArrowUp': 'Up', 'ArrowDown': 'Down',
        'ArrowLeft': 'Left', 'ArrowRight': 'Right',
        'Control': 'Control_L', 'Shift': 'Shift_L',
        'Alt': 'Alt_L', 'Meta': 'Super_L',
        ' ': 'space'
    };
    return map[jsKey] || jsKey;
}

module.exports = { injectMouse, injectClick, injectScroll, injectKeyDown, injectKeyUp, injectType };
```

**Latencia do input:** ~5-20ms local (xdotool e rapido)
**Latencia total (usuario → acao no browser):** 150-400ms (rede + processing)

---

### PECA 6: Session Agent (processo Node dentro do container)

Pequeno servidor que roda DENTRO de cada container. Faz ponte entre o mundo
externo e o Chrome/GStreamer/xdotool.

```js
// session-agent/index.js
const express = require('express');
const { WebSocketServer } = require('ws');
const { injectMouse, injectClick, injectScroll, injectKeyDown, injectKeyUp, injectType } = require('./input');

const app = express();
const PORT = process.env.AGENT_PORT || 9222;

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Info da sessao
app.get('/info', (req, res) => {
    res.json({
        display: process.env.DISPLAY_NUM,
        resolution: process.env.RESOLUTION,
        videoRtpPort: process.env.VIDEO_RTP_PORT,
        audioRtpPort: process.env.AUDIO_RTP_PORT,
        micRtpPort: process.env.MIC_RTP_PORT
    });
});

// WebSocket pra input
const wss = new WebSocketServer({ noServer: true });
app.server = app.listen(PORT);
app.server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        switch (msg.type) {
            case 'mousemove':
                injectMouse(msg.x, msg.y);
                break;
            case 'click':
                injectClick(msg.x, msg.y, msg.button);
                break;
            case 'scroll':
                injectScroll(msg.x, msg.y, msg.deltaY);
                break;
            case 'keydown':
                injectKeyDown(msg.key);
                break;
            case 'keyup':
                injectKeyUp(msg.key);
                break;
            case 'type':
                injectType(msg.text);
                break;
        }
    });
});
```

---

### PECA 7: mediasoup SFU (servidor centralizado)

Servico Node.js separado que gerencia TODOS os streams WebRTC.
Nao roda dentro dos containers — e centralizado.

**Responsabilidades:**
- Recebe RTP dos containers via PlainTransport
- Entrega video+audio pros browsers dos usuarios via WebRtcTransport
- Recebe audio do microfone dos usuarios
- Roteia audio do mic de volta pro container via PlainTransport
- Gerencia bandwidth (estimator)

**Estrutura:**
```
mediasoup-server/
  index.js          # Servidor principal
  config.js         # Configuracao mediasoup
  room-manager.js   # Gerencia salas (1 sala = 1 usuario = 1 container)
  signaling.js      # WebSocket signaling com o frontend
```

**Fluxo de criacao de sessao:**

```
1. Orchestrator cria container Docker
   → Container sobe, GStreamer comeca a emitir RTP nas portas locais

2. Orchestrator notifica mediasoup: "novo container, portas X, Y, Z"

3. mediasoup cria:
   - Router (1 por sessao)
   - PlainTransport video (recebe RTP do container)
   - PlainTransport audio-out (recebe RTP do container)
   - PlainTransport audio-in (envia RTP pro container — mic do usuario)
   - Producer video (VP8)
   - Producer audio (Opus)

4. Quando usuario conecta no frontend:
   - mediasoup cria WebRtcTransport (send+recv)
   - Consumer video (entrega VP8 pro browser)
   - Consumer audio (entrega Opus pro browser)
   - Producer audio do mic (recebe Opus do browser)
   - Roteia mic producer → PlainTransport audio-in → container
```

**Escalabilidade mediasoup:**
- 1 Worker = 1 CPU core
- 1 Worker suporta ~50-100 consumers (video) ou ~200+ (audio)
- Pra 100 usuarios: 4-8 workers (4-8 CPU cores)
- Pipe transports pra conectar routers entre workers

**Config mediasoup:**
```js
const config = {
    mediasoup: {
        numWorkers: Math.min(require('os').cpus().length, 8),
        worker: {
            rtcMinPort: 40000,
            rtcMaxPort: 49999,
            logLevel: 'warn',
        },
        router: {
            mediaCodecs: [
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                },
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
            ],
        },
        webRtcTransport: {
            listenInfos: [
                { protocol: 'udp', ip: '0.0.0.0', announcedAddress: process.env.PUBLIC_IP },
                { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: process.env.PUBLIC_IP },
            ],
            maxIncomingBitrate: 5000000,
            initialAvailableOutgoingBitrate: 3000000,
        },
    },
};
```

---

### PECA 8: Orchestrator (gerencia containers)

Servico Node.js que cria/destroi/monitora containers Docker.

**Usa:** Dockerode (npm) — API Docker nativa pra Node.

```js
// orchestrator/container-manager.js
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function createSession(userId, options = {}) {
    const {
        resolution = '1280x720',
        extensionPath = '/shared/extensions/default',
        startUrl = 'about:blank',
        videoBitrate = 2000000,
        audioBitrate = 128000,
    } = options;

    const displayNum = await getNextDisplayNum();
    const ports = await allocatePorts(); // video, audio-out, audio-in, agent

    const container = await docker.createContainer({
        Image: 'remote-browser:latest',
        name: `session-${userId}`,
        Env: [
            `DISPLAY_NUM=${displayNum}`,
            `RESOLUTION=${resolution}`,
            `VIDEO_RTP_PORT=${ports.video}`,
            `AUDIO_RTP_PORT=${ports.audioOut}`,
            `MIC_RTP_PORT=${ports.audioIn}`,
            `AGENT_PORT=${ports.agent}`,
            `VIDEO_BITRATE=${videoBitrate}`,
            `AUDIO_BITRATE=${audioBitrate}`,
            `START_URL=${startUrl}`,
        ],
        HostConfig: {
            Memory: 1.5 * 1024 * 1024 * 1024, // 1.5GB
            NanoCpus: 2 * 1e9,                 // 2 CPU cores
            ShmSize: 2 * 1024 * 1024 * 1024,   // 2GB /dev/shm (Chrome precisa)
            Binds: [
                `${extensionPath}:/data/extension:ro`,
                `chrome-profiles-${userId}:/data/chrome-profile`,
            ],
            NetworkMode: 'browser-network', // rede Docker interna
            PortBindings: {
                [`${ports.agent}/tcp`]: [{ HostPort: `${ports.agent}` }],
            },
        },
        Labels: {
            'app': 'remote-browser',
            'userId': userId,
            'createdAt': new Date().toISOString(),
        },
    });

    await container.start();

    // Espera health check
    await waitForHealthy(`http://container-ip:${ports.agent}/health`, 30000);

    // Notifica mediasoup pra conectar
    await mediasoupManager.createRoom(userId, {
        containerIp: await getContainerIp(container),
        videoRtpPort: ports.video,
        audioOutRtpPort: ports.audioOut,
        audioInRtpPort: ports.audioIn,
    });

    return {
        sessionId: container.id,
        userId,
        agentPort: ports.agent,
        status: 'running',
    };
}

async function destroySession(userId) {
    const container = docker.getContainer(`session-${userId}`);
    await container.stop({ t: 5 });
    await container.remove();
    await mediasoupManager.destroyRoom(userId);
    await releasePorts(userId);
}

async function listSessions() {
    const containers = await docker.listContainers({
        filters: { label: ['app=remote-browser'] }
    });
    return containers.map(c => ({
        userId: c.Labels.userId,
        status: c.State,
        created: c.Labels.createdAt,
    }));
}
```

**Monitoramento:**
- Health check a cada 10s (session agent /health)
- Se container morrer → limpa mediasoup room → notifica frontend
- Se usuario desconectar → timer de 60s → destroi container
- Limite maximo de containers (previne overload)

---

### PECA 9: Frontend React

```
frontend/
  src/
    components/
      BrowserViewer.tsx    # Video WebRTC + overlay de input
      ChatPanel.tsx        # Chat (Socket.IO)
      AudioManager.tsx     # Gerencia mic do usuario
      SessionControls.tsx  # Start/stop sessao, settings
    hooks/
      useMediasoup.ts      # Conexao mediasoup-client
      useInputRelay.ts     # Captura e envia mouse/teclado
      useSession.ts        # Gerencia sessao (create/destroy)
    lib/
      signaling.ts         # WebSocket signaling
      input-mapper.ts      # Mapeia eventos DOM → formato do server
```

**BrowserViewer.tsx (componente principal):**
```tsx
function BrowserViewer({ sessionId }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { videoTrack, audioTrack } = useMediasoup(sessionId);
    const { sendInput } = useInputRelay(sessionId);

    // Renderiza video+audio
    useEffect(() => {
        if (videoTrack && audioTrack && videoRef.current) {
            const stream = new MediaStream([videoTrack, audioTrack]);
            videoRef.current.srcObject = stream;
        }
    }, [videoTrack, audioTrack]);

    // Calcula coordenadas relativas
    const getCoords = (e: React.MouseEvent) => {
        const rect = containerRef.current.getBoundingClientRect();
        const scaleX = 1280 / rect.width;  // resolucao do Xvfb
        const scaleY = 720 / rect.height;
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY),
        };
    };

    return (
        <div
            ref={containerRef}
            style={{ position: 'relative', cursor: 'none' }}
            onMouseMove={(e) => {
                const { x, y } = getCoords(e);
                sendInput({ type: 'mousemove', x, y });
            }}
            onClick={(e) => {
                const { x, y } = getCoords(e);
                sendInput({ type: 'click', x, y, button: e.button });
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                sendInput({ type: 'click', x, y, button: 2 });
            }}
            onWheel={(e) => {
                const { x, y } = getCoords(e);
                sendInput({ type: 'scroll', x, y, deltaY: e.deltaY });
            }}
            onKeyDown={(e) => {
                e.preventDefault();
                sendInput({ type: 'keydown', key: e.key, code: e.code });
            }}
            onKeyUp={(e) => {
                sendInput({ type: 'keyup', key: e.key, code: e.code });
            }}
            tabIndex={0}
        >
            <video
                ref={videoRef}
                autoPlay
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
        </div>
    );
}
```

**useMediasoup.ts (hook principal):**
```tsx
function useMediasoup(sessionId: string) {
    const [videoTrack, setVideoTrack] = useState<MediaStreamTrack | null>(null);
    const [audioTrack, setAudioTrack] = useState<MediaStreamTrack | null>(null);

    useEffect(() => {
        const device = new mediasoupClient.Device();
        let recvTransport, sendTransport;

        async function connect() {
            const socket = io(SIGNALING_URL);

            // 1. Capabilities do router
            const routerCaps = await request(socket, 'getRouterCapabilities', { sessionId });
            await device.load({ routerRtpCapabilities: routerCaps });

            // 2. Recv transport (recebe video+audio do browser remoto)
            const recvInfo = await request(socket, 'createRecvTransport', { sessionId });
            recvTransport = device.createRecvTransport(recvInfo);

            recvTransport.on('connect', ({ dtlsParameters }, cb) => {
                socket.emit('connectTransport', {
                    transportId: recvTransport.id,
                    dtlsParameters
                });
                socket.once('transportConnected', cb);
            });

            // 3. Consome video
            const videoCInfo = await request(socket, 'consume', {
                sessionId, transportId: recvTransport.id,
                rtpCapabilities: device.rtpCapabilities, kind: 'video'
            });
            const videoConsumer = await recvTransport.consume(videoCInfo);
            setVideoTrack(videoConsumer.track);

            // 4. Consome audio
            const audioCInfo = await request(socket, 'consume', {
                sessionId, transportId: recvTransport.id,
                rtpCapabilities: device.rtpCapabilities, kind: 'audio'
            });
            const audioConsumer = await recvTransport.consume(audioCInfo);
            setAudioTrack(audioConsumer.track);

            // 5. Send transport (envia mic do usuario)
            const sendInfo = await request(socket, 'createSendTransport', { sessionId });
            sendTransport = device.createSendTransport(sendInfo);

            sendTransport.on('connect', ({ dtlsParameters }, cb) => {
                socket.emit('connectTransport', {
                    transportId: sendTransport.id,
                    dtlsParameters
                });
                socket.once('transportConnected', cb);
            });

            sendTransport.on('produce', ({ kind, rtpParameters }, cb) => {
                socket.emit('produce', {
                    sessionId, transportId: sendTransport.id,
                    kind, rtpParameters
                });
                socket.once('produced', ({ id }) => cb({ id }));
            });

            // 6. Captura mic e envia
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const micTrack = micStream.getAudioTracks()[0];
            await sendTransport.produce({ track: micTrack });
        }

        connect();
        return () => {
            recvTransport?.close();
            sendTransport?.close();
        };
    }, [sessionId]);

    return { videoTrack, audioTrack };
}
```

---

### PECA 10: TURN Server (Coturn)

Self-hosted, roda como container separado.

```yaml
# docker-compose.turn.yml
coturn:
    image: coturn/coturn:latest
    network_mode: host
    volumes:
        - ./turnserver.conf:/etc/coturn/turnserver.conf
    restart: always
```

```ini
# turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=yourdomain.com
server-name=yourdomain.com
lt-cred-mech
user=turnuser:turnpassword
total-quota=100
stale-nonce=600
cert=/etc/ssl/certs/turn.pem
pkey=/etc/ssl/private/turn.key
no-multicast-peers
cli-password=clipassword
```

---

## INFRAESTRUTURA PRA 100+ USUARIOS

### Opcao A: Servidor Dedicado Unico (ate ~80-120 usuarios)

| Componente | Specs |
|---|---|
| CPU | 64 cores (AMD EPYC ou Intel Xeon) |
| RAM | 128GB |
| Disco | 1TB NVMe |
| GPU | 1-2x NVIDIA T4 ou AMD (pra encoding VAAPI) |
| Rede | 1Gbps+ (cada usuario consome ~2-4Mbps) |

**Custo (Hetzner Dedicated):** ~€200-400/mes

**Conta:**
- 100 usuarios × 1.5GB RAM = 150GB (precisa 128GB + swap ou 256GB)
- 100 usuarios × 1.5 CPU = 150 cores sem GPU
- 100 usuarios × 0.3 CPU = 30 cores COM GPU encoding
- 100 usuarios × 3Mbps = 300Mbps bandwidth

### Opcao B: Cluster (100+ com elasticidade)

```
[ Load Balancer (nginx) ]
        |
   [ API + Orchestrator ] (1 instancia)
   [ mediasoup SFU ]      (1-2 instancias, 8 cores cada)
   [ Coturn ]              (1 instancia)
   [ Redis ]               (1 instancia)
        |
   [ Worker Node 1 ] ← 20-30 containers de browser
   [ Worker Node 2 ] ← 20-30 containers de browser
   [ Worker Node 3 ] ← 20-30 containers de browser
   [ Worker Node N ] ← auto-scale conforme demanda
```

**Orquestracao:** Docker Swarm (simples) ou Kubernetes (robusto)

**Custo estimado (Hetzner Cloud):**
- API + Orchestrator: €15/mes (4 vCPU, 8GB)
- mediasoup SFU: €30/mes (8 vCPU, 16GB)
- Coturn: €10/mes (2 vCPU, 4GB)
- Redis: €5/mes
- Worker nodes: €60/mes cada (16 vCPU, 32GB) × 3-5 = €180-300/mes
- GPU nodes (se usar): €120/mes cada × 2 = €240/mes
- Bandwidth: ~€50-100/mes

**Total cluster:** €400-700/mes pra 100 usuarios
**Total dedicado:** €200-400/mes pra 100 usuarios (mais barato, menos elastico)

### Bandwidth

| Qualidade | Bitrate video | Bitrate audio | Total/usuario | 100 usuarios |
|---|---|---|---|---|
| 720p@30fps | 2 Mbps | 128 Kbps | ~2.2 Mbps | 220 Mbps |
| 720p@24fps | 1.5 Mbps | 128 Kbps | ~1.7 Mbps | 170 Mbps |
| 480p@30fps | 1 Mbps | 64 Kbps | ~1.1 Mbps | 110 Mbps |

TURN relay (10-15% dos usuarios): +20-30% de bandwidth no TURN server

---

## CRONOGRAMA DE DESENVOLVIMENTO

### Fase 1: Container Base (Semana 1-2)
- [ ] Dockerfile com Xvfb + PulseAudio + Chrome + GStreamer
- [ ] Script de entrypoint + supervisord
- [ ] Testar Chrome com extensao rodando no Xvfb
- [ ] Testar GStreamer capturando video + audio
- [ ] Session Agent basico (health check + info)

### Fase 2: mediasoup SFU (Semana 3-5)
- [ ] Setup mediasoup server
- [ ] PlainTransport recebendo RTP do container
- [ ] WebRtcTransport entregando video+audio pro browser
- [ ] Testar latencia end-to-end
- [ ] Audio bidirecional (mic → container → Chrome)

### Fase 3: Input + Frontend (Semana 5-7)
- [ ] Input agent (xdotool) no container
- [ ] Frontend React com BrowserViewer
- [ ] mediasoup-client integration
- [ ] Mouse/teclado/scroll funcionando
- [ ] Audio bidirecional no frontend

### Fase 4: Orchestrator (Semana 7-9)
- [ ] Container manager (Dockerode)
- [ ] API REST: criar/destruir/listar sessoes
- [ ] Cleanup automatico (timeout, disconnect)
- [ ] Port allocation
- [ ] Health monitoring

### Fase 5: Producao (Semana 9-12)
- [ ] TURN server (Coturn)
- [ ] Persistencia de perfil Chrome (volumes)
- [ ] Monitoramento (Prometheus + Grafana)
- [ ] Rate limiting + autenticacao
- [ ] Load testing 100 usuarios
- [ ] Otimizacao: GPU encoding, bandwidth estimator
- [ ] Docker Swarm ou K8s setup

### Fase 6: Polish (Semana 12-14)
- [ ] Cursor remoto (mostrar cursor do browser no frontend)
- [ ] Clipboard sync (copiar/colar entre local e remoto)
- [ ] Resize dinamico (usuario muda tamanho da janela)
- [ ] Reconnect automatico (queda de conexao)
- [ ] Notificacoes do browser → chat

---

## CUSTOS RESUMO

### Desenvolvimento
| Se... | Tempo | Custo dev |
|---|---|---|
| Dev senior solo (com AI) | 12-16 semanas | R$ 0 (seu tempo) |
| Contratar 1 dev senior | 12-16 semanas | R$ 60.000-120.000 |
| Squad (2 devs + 1 devops) | 8-10 semanas | R$ 120.000-200.000 |

### Infra mensal (100 usuarios)
| Item | Custo/mes |
|---|---|
| Servidor(es) | €200-700 |
| TURN server | €0 (self-hosted) ou $99 (Metered) |
| Dominio + SSL | €10 |
| Monitoramento | €0 (self-hosted Grafana) |
| **TOTAL** | **€210-710/mes (~R$1.200-4.000)** |

### Custo por usuario
| Metrica | Valor |
|---|---|
| Custo infra / 100 usuarios | ~R$12-40/usuario/mes |
| Break-even se cobrar R$50/mes | ~3 meses apos lancamento |

---

## RISCOS E DIFICULDADES

| Risco | Impacto | Mitigacao |
|---|---|---|
| Latencia alta (>500ms) | Experiencia ruim | GPU encoding + CDN + servidor proximo |
| Chrome crash/memory leak | Sessao morre | Supervisord reinicia + health check |
| GStreamer→mediasoup RTP mismatch | Sem video/audio | Testar exaustivamente na Fase 2 |
| Escala de containers | Servidor sobrecarrega | Auto-scaling com K8s |
| Audio bidirecional sync | Echo/delay | Echo cancellation no GStreamer |
| xdotool input lag | Cliques imprecisos | Otimizar batching, usar libxdo direto |
| Custo de bandwidth | Conta alta | Bitrate adaptativo, bandwidth estimator |
| Extensao Chrome incompativel | Nao funciona | Testar na Fase 1 antes de tudo |

---

## DECISOES TECNICAS (RESUMO)

| Decisao | Escolha | Motivo |
|---|---|---|
| Display virtual | Xvfb | Leve, estavel, padrao |
| Audio virtual | PulseAudio | Unica opcao real no Linux |
| Browser | Google Chrome (nao Chromium) | Melhor suporte a extensoes |
| Captura video | GStreamer (ximagesrc) | Captura display inteiro, suporte GPU |
| Encoding video | VP8 (software) ou H264 (GPU) | VP8 universal, H264 se tiver GPU |
| Encoding audio | Opus | Padrao WebRTC, melhor qualidade |
| WebRTC Server | mediasoup (Node.js) | Nativo Node, melhor docs, SFU escalavel |
| Input injection | xdotool | Simples, funciona com Xvfb |
| Signaling | Socket.IO | Voce ja conhece, bidirecional |
| Frontend | React + mediasoup-client | Sua stack |
| Orquestracao | Dockerode (Node.js) | API Docker nativa |
| TURN | Coturn (self-hosted) | Gratuito, production-ready |
| Monitoramento | Prometheus + Grafana | Padrao da industria |
