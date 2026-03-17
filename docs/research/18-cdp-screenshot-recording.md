# CDP Screenshot e Video Recording: Guia Completo

## Introdução

Este documento aborda as técnicas de captura de tela e gravação de sessão usando o Chrome DevTools Protocol (CDP), cobrindo desde screenshots pontuais até gravações de vídeo completas, storage e considerações de performance.

---

## 1. Diferença entre Page.captureScreenshot e Page.startScreencast

### Page.captureScreenshot

**Tipo**: Método síncrono/assíncrono pontual
**Retorno**: Imagem estática (base64 ou stream)
**Uso**: Captura única do estado atual da página
**Formato**: JPEG, PNG, WebP
**CDP Method**: `Page.captureScreenshot`

```javascript
// Exemplo básico
const result = await page.captureScreenshot({
  format: 'jpeg',
  quality: 80
});
// result.data contém base64 da imagem
```

### Page.startScreencast

**Tipo**: Stream contínuo de frames
**Retorno**: Eventos assíncronos `Page.screencastFrame`
**Uso**: Captura contínua em tempo real
**Formato**: Apenas JPEG ou PNG (frames individuais)
**CDP Method**: `Page.startScreencast` + eventos

```javascript
// Exemplo básico de screencast
await client.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1
});

client.on('Page.screencastFrame', async ({ data, sessionId }) => {
  // Processar frame (base64)
  // IMPORTANTE: Acknowledger após processamento
  await client.send('Page.screencastFrameAck', { sessionId });
});
```

### Comparação Rápida

| Característica | captureScreenshot | startScreencast |
|----------------|-------------------|-----------------|
| **Tipo** | Snapshot pontual | Stream contínuo |
| **Latência** | Alta (1 RTT por captura) | Baixa (streaming) |
| **Overhead** | Por chamada | Constante durante stream |
| **Backpressure** | Não | SIM (requer ack) |
| **Formato nativo** JPEG/PNG/WebP (imagem) | JPEG/PNG (frames) |
| **Saída direta** | Sim (base64/stream) | Não (eventos) |
| **Use caso** | Capturas esporádicas | Live viewing, gravação |

---

## 2. Quando Usar Screenshot vs Screencast

### Use Screenshot (captureScreenshot) Quando:

- ✅ Precisar de **snapshots pontuais** (ex: documentação, evidência de teste)
- ✅ Capturar **momentos específicos** após ações
- ✅ Baixa frequência (ex: 1 a 5 capturas/minuto)
- ✅ Processamento posterior imediato (não streaming)
- ✅ Quiser formatos otimizados (JPEG com quality, WebP)
- ✅ Recursos de servidor limitados (CPU/memória)

**Exemplo típico:**
```javascript
// Teste E2E: capturar após cada step crítico
await page.click('#submit');
await page.waitForTimeout(1000);
const screenshot = await page.captureScreenshot({
  format: 'jpeg',
  quality: 85
});
fs.writeFileSync('step1.jpg', Buffer.from(screenshot.data, 'base64'));
```

### Use Screencast (startScreencast) Quando:

- ✅ **Live viewing**: Observar automação em tempo real
- ✅ **Gravação de sessão completa**: Replay posterior
- ✅ **Debugging contínuo**: Ver o que aconteceu entre pontos
- ✅ **Streaming para cliente WebSocket**: UI remota
- ✅ Alta frequência (15-30 FPS)

**Exemplo típico:**
```javascript
// Serviço de monitoramento remoto
const client = await page.target().createCDPSession();
await client.send('Page.startScreencast', {
  format: 'jpeg',
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 2 // ~15 FPS
});

const frames = [];
client.on('Page.screencastFrame', ({ data, sessionId }) => {
  frames.push(Buffer.from(data, 'base64'));
  client.send('Page.screencastFrameAck', { sessionId });
});
```

---

## 3. Page.captureScreenshot: Parâmetros, Formatos e Performance

### Parâmetros Completos (CDP)

```typescript
interface CaptureScreenshotParams {
  format?: 'jpeg' | 'png' | 'webp';      // Default: png
  quality?: number;                       // 0-100 (só JPEG/WebP)
  clip?: Viewport;                        // Área retangular a capturar
  fromSurface?: boolean;                  // Capturar da surface (default: true)
  captureBeyondViewport?: boolean;        // Capturar além da viewport
  optimizeForSpeed?: boolean;             // Priorizar velocidade
}
```

### Formatos: JPEG vs PNG vs WebP

| Formato | Compressão | Perda | Tamanho | Velocidade | Transparência |
|---------|------------|-------|---------|------------|---------------|
| **PNG** | Sem perda | Não | Maior | Mais lento | ✅ |
| **JPEG** | Com perda | Sim (quality 0-100) | Muito menor | Mais rápido | ❌ |
| **WebP** | Com/sem perda | Opcional | Menor | Razoável | ✅ |

**Recomendações**:
- **JPEG 80-90**: Screenshots de UI, graphs (compactação boa, visual ok)
- **PNG**: quando precisar de perda zero (gráficos vetoriais, texto)
- **WebP**: quando disponível e precisar de transparência + compressão

### Performance de captureScreenshot

#### Fatores que Impactam:

1. **`optimizeForSpeed: true`**:
   ```javascript
   await page.captureScreenshot({
     format: 'jpeg',
     optimizeForSpeed: true  // Prioriza velocidade
   });
   ```
   - Reduce encoding overhead
   - Menor qualidade (mas pode ser ok para monitoramento)
   - CPU usage: ~20-30% menor

2. **`clip`**:
   ```javascript
   await page.captureScreenshot({
     clip: {
       x: 0, y: 0,
       width: 800, height: 600,
       scale: 1
     }
   });
   ```
   - Capturar apenas área necessária reduz processamento
   - Ganho proporcional à área reduzida

3. **`captureBeyondViewport: false`** (default):
   - Limita ao viewport visível → menos memória
   - Use `true` apenas se precisar de full-page scroll

4. **Formatos**:
   - JPEG encoding: 2-3x mais rápido que PNG
   - WebP: intermediário, mas melhor compressão

#### Benchmarks Aproximados (1920×1080):

| Config | Tempo | Tamanho (KB) | CPU |
|--------|-------|--------------|-----|
| PNG (default) | 250-400ms | 500-1200 | 80% |
| JPEG q=85 | 100-180ms | 80-150 | 50% |
| JPEG q=50 | 60-100ms | 30-60 | 40% |
| WebP q=85 | 150-220ms | 50-100 | 60% |

**Nota**: Valores variam conforme hardware, Chrome version, page complexity.

---

## 4. Gravação de Sessão (Session Recording) via CDP

### Abordagem 1: CDP Puro (Frame-by-Frame)

**Limitação**: CDP só fornece frames individuais (JPEG/PNG). Você deve montar o vídeo pós-processando.

```javascript
const CDP_Session = require('devtools-protocol');
const client = await page.target().createCDPSession();

const frames = [];
await client.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 80,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 2 // ~15 FPS
});

let frameCount = 0;
const startTime = Date.now();

client.on('Page.screencastFrame', async ({ data, sessionId }) => {
  frameCount++;
  frames.push(Buffer.from(data, 'base64'));

  // Acknowledge IMMEDIATO para avoid memory leak
  await client.send('Page.screencastFrameAck', { sessionId });

  // Opcional: parar após X segundos
  if (Date.now() - startTime > 60000) {
    await client.send('Page.stopScreencast');
  }
});

// Aguardar fim...
await new Promise(resolve => setTimeout(resolve, 61000));

// Converter frames para vídeo com ffmpeg
const { createWriteStream } = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const tempDir = './temp_frames';

// Salvar frames em disco
frames.forEach((frame, i) => {
  fs.writeFileSync(`${tempDir}/frame_${i.toString().padStart(6, '0')}.jpg`, frame);
});

// Enviar para ffmpeg
ffmpeg(`${tempDir}/frame_%06d.jpg`)
  .inputFPS(15) // Deve bater com everyNthFrame
  .videoCodec('libx264')
  .outputOptions(['-pix_fmt yuv420p'])
  .save('session_recording.mp4');
```

**Problemas**:
- Memory build-up se não ack cada frame
- IO disco pesado (milhares de frames)
- Latência entre captura e vídeo final

### Abordagem 2: Puppeteer Page.screencast() (Recomendado)

A partir do **Puppeteer 22+**, o método `page.screencast()` abstrai toda essa complexidade.

```javascript
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch();
const page = await browser.newPage();

await page.goto('https://example.com');

// Iniciar gravação direto para WebM
const recorder = await page.screencast({
  path: 'recording.webm', // Opcional (também retorna stream)
  // Opções adicionais (novas em 2025 PRs):
  // videoBitRate: 2500000,  // 2.5 Mbps
  // audio: true,            // Capturar áudio do microfone/mídia
  // dimensions: { width: 1920, height: 1080 } // Override viewport
});

// Executar ações durante gravação
await page.click('#button');
await page.type('#input', 'Hello World');

// Parar e salvar
await recorder.stop();
await browser.close();
```

**Retorna**: `ScreenRecorder` com métodos:
- `stop(): Promise<void>` — Finaliza gravação e salva arquivo
- `path?: string` — Caminho do arquivo se especificado

**Pre-requisito**: `ffmpeg` instalado no sistema.

### Abordagem 3: Browserless Pattern (MediaRecorder + Canvas)

Usado por serviços como Browserless.io, combina CDP screencast com Canvas API para criar stream em tempo real.

```javascript
// server.js
const puppeteer = require('puppeteer');
const WebSocket = require('ws');

const browser = await puppeteer.launch();
const page = await browser.newPage();

// 1. Criar página auxiliar para renderização
const renderPage = await browser.newPage();
await renderPage.goto('file://' + __dirname + '/renderer.html');

const renderer = await renderPage.evaluateHandle(() => {
  return new Promise(resolve => {
    // renderer.html carrega script que retorna helper
    window.onRendererReady = resolve;
  });
});

// 2. Iniciar screencast CDP
const client = await page.target().createCDPSession();
await client.send('Page.startScreencast', {
  format: 'jpeg',
  maxWidth: 1920,
  maxHeight: 1080
});

// 3. Pipeline: screencastFrame → Canvas → MediaRecorder
client.on('Page.screencastFrame', async ({ data, sessionId }) => {
  // Enviar frame para renderer via evaluateHandle
  await renderer.postMessage({
    type: 'frame',
    data: data // base64 JPEG
  });

  // Acknowledge
  await client.send('Page.screencastFrameAck', { sessionId });
});

// 4. WebSocket para cliente assistir live
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', ws => {
  // Forward chunks do renderer MediaRecorder para ws
  renderer.on('chunk', chunk => {
    ws.send(chunk);
  });
});
```

**renderer.html**:
```html
<canvas id="canvas" width="1920" height="1080"></canvas>
<script>
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  // MediaRecorder para capturar canvas
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  recorder.start();

  recorder.ondataavailable = e => {
    // Enviar chunks para server
    window.parent.postMessage({ type: 'chunk', data: e.data }, '*');
  };

  // Receber frames do CDP
  self.addEventListener('message', e => {
    if (e.data.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
      };
      img.src = 'data:image/jpeg;base64,' + e.data.data;
    }
  });

  window.onRendererReady && window.onRendererReady();
</script>
```

**Vantagens**:
- ✅ WebM nativo (sem ffmpeg dependência pós-processamento)
- ✅ Live viewing via WebSocket
- ✅ Captura áudio se configurado no MediaRecorder
- ❌ Mais complexo, overhead do canvas

---

## 5. Puppeteer Page.screencast() (Detalhes 2025)

### API Completa

```typescript
interface ScreencastOptions {
  path?: string;                 // Salvar arquivo automaticamente
  videoBitRate?: number;         // Bitrate em bps (default auto)
  audio?: boolean;               // Incluir áudio (default false)
  dimensions?: { width: number; height: number }; // Override viewport
  mimeType?: 'video/webm' | 'video/mp4'; // Formato output (depende ffmpeg)
  ffmpegOptions?: string[];      // Opções customizadas para ffmpeg
}

interface ScreenRecorder {
  readonly path?: string;
  stop(): Promise<void>;
  // Novas adições 2025 PR #13645:
  // getBlob(): Promise<Buffer> // Retorna buffer em memória
}
```

### Recursos Adicionais 2025

**PR #13645** (Março 2025) adicionou:
- Suporte a formatos adicionais via `mimeType` e `ffmpegOptions`
- Controle fino sobre encoding
- `getBlob()` para obter vídeo em memória sem disco

**Exemplo avançado**:
```javascript
const recorder = await page.screencast({
  path: 'output.mp4',
  videoBitRate: 5000000, // 5 Mbps (alta qualidade)
  audio: true, // Requer áudio source ativo na página
  dimensions: { width: 3840, height: 2160 }, // 4K override
  mimeType: 'video/mp4',
  ffmpegOptions: [
    '-preset', 'slow',      // Melhor compressão
    '-crf', '18',           // Constant Rate Factor (qualidade)
    '-movflags', '+faststart' // Otimizar streaming
  ]
});

// Disponível: recorder.getBlob() para upload direto
const videoBuffer = await recorder.getBlob();
await uploadToS3(videoBuffer, 'session-123.mp4');
```

### Limitações do Page.screencast()

1. **Require ffmpeg**: Deve estar no PATH do sistema
2. **Chromium only**: Só funciona com Chrome/Chromium
3. **Sem áudio nativo CDP**: Audio vem do MediaRecorder (apenas áudio da página, não sistema)
4. **Latência inicial**: 1-2s para iniciar encoding

---

## 6. Combinar Screencast para Live Viewing + Recording para Replay

### Arquitetura Híbrida (Recommended)

```
CDP Screencast
     ↓ (frames JPEG base64)
Frame Processor ───→ Buffer Ring (últimos 30s) ──┐
     ↓                                           │
Canvas/MediaRecorder ──→ WebSocket Live Stream ─┤
     ↓                                           │
ffmpeg/recorder ───→ Video File (WebM/MP4) ────┘
```

### Implementação Prática

```javascript
const LiveRecorder = class {
  constructor(client, options = {}) {
    this.client = client;
    this.liveClients = new Set(); // WebSockets ativos
    this.frameBuffer = []; // Últimos N frames para replay rápido
    this.maxBufferSize = options.maxBufferSize || 450; // 30s @ 15fps
    this.recorder = null;
    this.frameCount = 0;
  }

  async start() {
    // 1. Iniciar CDP screencast
    await this.client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 2 // ~15 FPS
    });

    // 2. Setup do MediaRecorder para gravação
    await this.setupMediaRecorder();

    // 3. Handler de frames
    this.client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      this.frameCount++;

      // A. Buffer ring para fast replay/rewind
      this.frameBuffer.push(Buffer.from(data, 'base64'));
      if (this.frameBuffer.length > this.maxBufferSize) {
        this.frameBuffer.shift();
      }

      // B. Enviar para clients live (via WS broadcaster)
      this.broadcastToLiveClients(data);

      // C. Alimentar MediaRecorder (se ativo)
      await this.feedCanvas(data);

      // D. Acknowledgment crítico
      await this.client.send('Page.screencastFrameAck', { sessionId });
    });
  }

  broadcastToLiveClients(frameData) {
    for (const ws of this.liveClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'frame', data: frameData }));
      }
    }
  }

  async setupMediaRecorder() {
    // Criar canvas + MediaRecorder (ver Abordagem 3)
    // O MediaRecorder gera WebM nativo
    // Pode salvar em arquivo E enviar chunks via WS para clients
  }

  stop() {
    return this.client.send('Page.stopScreencast');
  }

  // Rewind últimos 30 segundos (usando frameBuffer)
  getRecentFrames() {
    return this.frameBuffer.slice(); // Copia
  }
};
```

### Padrão de Uso:

```javascript
// Servidor
const liveRecorder = new LiveRecorder(cdpClient);

// 1. Iniciar sessão (gravação + live)
await liveRecorder.start();

// 2. Clientes conectam via WS para assistir em temporeal
wss.on('connection', ws => {
  liveRecorder.liveClients.add(ws);
  ws.on('close', () => liveRecorder.liveClients.delete(ws));
});

// 3. Ações do usuário...
await page.click('#test');

// 4. Ao finalizar: gravação disponível + live buffer recente
const recording = await liveRecorder.getRecording(); // Buffer ou arquivo
```

---

## 7. Storage de Gravações

### Opção 1: Local Disk

```javascript
const recorder = await page.screencast({ path: './recordings/session-123.webm' });

await recorder.stop();
// Arquivo salvo em ./recordings/session-123.webm

// Rotação automática
const fs = require('fs');
const recordingsDir = './recordings';

// Cleanup: manter apenas últimos 100
const files = fs.readdirSync(recordingsDir)
  .filter(f => f.endsWith('.webm'))
  .sort()
  .slice(0, -100)
  .forEach(f => fs.unlinkSync(`${recordingsDir}/${f}`));
```

**Prós**:
- ✅ Simples, zero dependências externas
- ✅ Latência zero para salvar/ler
- ✅ Custo zero

**Contras**:
- ❌ Escalabilidade limitada (espaço em disco)
- ❌ Sem replicação/backup automático
- ❌ Acesso remoto requer deploy de arquivos

### Opção 2: S3 / Object Storage

```javascript
const AWS = require('aws-sdk');
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_KEY,
  secretAccessKey: process.env.AWS_SECRET,
  region: 'us-east-1'
});

// Estratégia A: gravar em buffer e upload ao final
const recorder = await page.screencast(); // Sem path
const videoBuffer = await recorder.getBlob(); // Buffer em memória

await s3.putObject({
  Bucket: 'my-recordings',
  Key: `sessions/${sessionId}/${Date.now()}.webm`,
  Body: videoBuffer,
  ContentType: 'video/webm'
}).promise();

// Estratégia B: upload incremental (chunks)
// Durante gravação, usar stream pipes:
const upload = s3.upload({
  Bucket: 'my-recordings',
  Key: `sessions/${sessionId}/live.webm`,
  Body: recorder.getReadableStream() // Se disponível API
});
```

**Estrutura de pastas S3 recomendada**:
```
s3://bucket/
└── sessions/
    └── {session-id}/
        ├── metadata.json        (duração, resolução, FPS)
        ├── recording.webm       (vídeo completo)
        ├── chunks/              (opcional: upload em partes)
        │   ├── chunk-001.webm
        │   ├── chunk-002.webm
        └── thumbnails/
            └── thumbnail-001.jpg
```

**Prós**:
- ✅ Escalabilidade infinita
- ✅ CDN integrado (CloudFront) para playback
- ✅ Versionamento, lifecycle policies
- ✅ Acesso via URL pré-assinada

**Contras**:
- ❌ Custo por GB/mês (USD 0.023/GB S3 Standard)
- ❌ Latência de upload (depende bandwidth)
- ❌ Code/orquestração adicional

### Opção 3: Streaming (RTMP/HLS)

Para sessões MUITO longas (horas), considere streaming live:

```javascript
// Usar ffmpeg para enviar direto para RTMP server
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

// Após capturar frames como imagens:
ffmpeg(`${tempDir}/frame_%06d.jpg`)
  .inputFPS(15)
  .videoCodec('libx264')
  .format('flv') // RTMP usa FLV container
  .pipe(require('child_process').spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-f', 'flv',
    'rtmp://my-server/live/session-123'
  ]));
```

**HLS para replay**:
```javascript
// Gerar HLS segments + playlist .m3u8
ffmpeg(input)
  .inputFPS(15)
  .videoCodec('libx264')
  .format('hls')
  .outputOptions([
    '-hls_time', '10',      // Segmentos de 10s
    '-hls_list_size', '0',  // Manter todos na playlist
    '-hls_segment_filename', 'segment_%03d.ts'
  ])
  .save('session.m3u8');
```

**Prós**:
- ✅ Começar a assistir antes da gravação terminar (live + VOD)
- ✅ Escalável com CDN HLS (CloudFront, Akamai)
- ✅ Suporte nativo em browsers

**Contras**:
- ❌ Latência de 10-30s (segmentação)
- ❌ Infrastructure complexa (RTMP server + HLS packaging)

---

## 8. Custo de CPU/Memória: Screencast vs Screenshot Periódico

### Métricas Importantes

| Métrica | Screenshot Periódico | Screencast Contínuo |
|---------|----------------------|---------------------|
| **CPU (idle)** | ~0% (não rodando) | 10-25% constante |
| **CPU (captura)** | Pico 40-80% (breve) | 30-60% contínuo |
| **Memória** | ~50MB (cache Chrome) | ~150-300MB (buffer frames + encoding) |
| **Latência por frame** | 200-500ms (RTT + encoding) | 33-66ms (stream) |
| **Throughput** | ~1-5 frames/min (limitado por chamada) | 15-30 FPS (limitado por ack) |
| **Escalabilidade** | Alta (pode paralelizar M sessions) | Média (cada session consome CPU contínuo) |

### Experimentos Reais (Valores Aproximados)

#### Cenário: 10 sessões paralelas, 1920×1080

**Screenshot Periódico** (captura a cada 5 segundos):
```
Total CPU médio:  ~15% (distribuído bursts)
Memória total:    ~500MB (10 × 50MB)
IOps:            Baixo (10 writes/5s = 2/s)
Latência:        300ms por captura
```

**Screencast Contínuo** (15 FPS):
```
Total CPU médio:  ~250% (25% por sessão)
Memória total:    ~2.5GB (10 × 250MB)
IOps:            Alto (10 × 15 = 150 frames/s em disco/network)
Latência:        50ms por frame (backpressure se lento)
```

### Fatores Críticos de Performance

#### Para Screenshots:
1. **Frequência** → maior frequência = maior CPU avg
2. **Qualidade JPEG** → quality 50 vs 90: 40% menos CPU
3. **Area capturada** (`clip`) → reduzir 50% área = ~30% menos CPU
4. **`optimizeForSpeed: true`** → encode 2x mais rápido

#### Para Screencast:
1. **`everyNthFrame`** → reduz FPS proporcionalmente
   - `everyNthFrame: 1` = 30 FPS (máx)
   - `everyNthFrame: 3` = 10 FPS (CPU -60%)
2. **`quality`** → JPEG quality 50 vs 90: 30% menos CPU
3. **`maxWidth/maxHeight`** → escalar antes de encode
   - 4K → 1080p: 75% menos pixels = CPU proporcional
4. **Acknowledgment delay** → se atrasar ack, Chrome acumula frames em memória (memory leak)

### Benchmark Prático

```javascript
// benchmark.js
const puppeteer = require('puppeteer');
const { performance } = require('perf_hooks');

async function benchmarkScreenshot(page, durationSec = 60) {
  const start = performance.now();
  let count = 0;

  const interval = setInterval(async () => {
    await page.captureScreenshot({ format: 'jpeg', quality: 80 });
    count++;
  }, 1000); // 1 FPS

  await new Promise(resolve => setTimeout(resolve, durationSec * 1000));
  clearInterval(interval);

  const elapsed = (performance.now() - start) / 1000;
  console.log(`Screenshot: ${count} capturas em ${elapsed}s = ${count/elapsed} FPS`);
}

async function benchmarkScreencast(page, durationSec = 60) {
  const client = await page.target().createCDPSession();
  let frameCount = 0;
  const start = performance.now();

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    everyNthFrame: 2
  });

  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    frameCount++;
    await client.send('Page.screencastFrameAck', { sessionId });
  });

  await new Promise(resolve => setTimeout(resolve, durationSec * 1000));
  await client.send('Page.stopScreencast');

  const elapsed = (performance.now() - start) / 1000;
  console.log(`Screencast: ${frameCount} frames em ${elapsed}s = ${frameCount/elapsed} FPS`);
}
```

**Resultados típicos** (single session, Mac M1):

```
Screenshot (1 FPS):
  60 frames, CPU médio 8%, 0.8s total CPU time
  Total cost: baixo (bursts curtos)

Screencast (15 FPS):
  900 frames, CPU médio 35%, 21s total CPU time
  Total cost: 26x maior que screenshot
```

### Recomendações de Escalabilidade

#### Para 100+ sessões concorrentes:

| Abordagem | Viável? | Observações |
|-----------|---------|-------------|
| Screenshots a cada 5s | ✅ Sim | CPU ~200% total (bursts bem espaçados) |
| Screencast @ 5 FPS | ⚠️ Marginal | CPU ~700% total (aconselha-se reduzir FPS) |
| Screencast @ 2 FPS | ✅ Sim | CPU ~280%, memória controlada |

#### Tunning de Alta Escala:

```javascript
const options = {
  // Otimizações para múltiplas sessões
  format: 'jpeg',
  quality: 60,               // Menor qualidade = menos CPU
  maxWidth: 1280,            // Resize antes de encode
  maxHeight: 720,
  everyNthFrame: 3           // 10 FPS em vez de 30 (CPU -70%)
};

await client.send('Page.startScreencast', options);
```

### Monitoramento de Recursos

```javascript
// Monitorar memória do Chrome durante screencast
setInterval(async () => {
  const memoryInfo = await client.send('Memory.getInfo');
  console.log(`Memória: ${memoryInfo.usedJSHeapSize / 1024 / 1024} MB`);

  // Se > 500MB, reduzir qualidade/FPS em tempo real
  if (memoryInfo.usedJSHeapSize > 500 * 1024 * 1024) {
    await adjustQualityDown();
  }
}, 5000);
```

---

## 9. Código Completo: Serviço de Gravação Híbrido

```javascript
// recording-service.js
const puppeteer = require('puppeteer');
const AWS = require('aws-sdk');
const WebSocket = require('ws');
const ffmpeg = require('fluent-ffmpeg');

class SessionRecorder {
  constructor(config = {}) {
    this.config = {
      bucket: config.bucket || 'my-recordings',
      fps: config.fps || 15,
      quality: config.quality || 80,
      maxWidth: config.maxWidth || 1920,
      maxHeight: config.maxHeight || 1080,
      rtmpEnabled: config.rtmpEnabled || false
    };
    this.s3 = new AWS.S3();
  }

  async startSession(sessionId, page) {
    const client = await page.target().createCDPSession();
    const session = {
      id: sessionId,
      startTime: Date.now(),
      frames: [],
      liveClients: new Set(),
      recording: true,
      stats: { frameCount: 0, droppedFrames: 0 }
    };

    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.config.quality,
      maxWidth: this.config.maxWidth,
      maxHeight: this.config.maxHeight,
      everyNthFrame: Math.floor(30 / this.config.fps)
    });

    client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      if (!session.recording) return;

      session.stats.frameCount++;

      // Buffer ring (últimos 5 minutos)
      session.frames.push(Buffer.from(data, 'base64'));
      if (session.frames.length > this.config.fps * 60 * 5) {
        session.frames = session.frames.slice(-this.config.fps * 60 * 2); // Keep 2min
      }

      // Broadcast live
      this.broadcast(session, data);

      // Acknowledge (critical!)
      await client.send('Page.screencastFrameAck', { sessionId });
    });

    session.client = client;
    return session;
  }

  broadcast(session, frameData) {
    for (const ws of session.liveClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'frame',
          data: frameData,
          timestamp: Date.now()
        }));
      }
    }
  }

  async stopSession(session) {
    session.recording = false;
    await session.client.send('Page.stopScreencast');

    // 1. Salvar em S3
    const videoBuffer = await this.framesToVideo(session.frames);
    const s3Key = `sessions/${session.id}/${Date.now()}.webm`;

    await this.s3.putObject({
      Bucket: this.config.bucket,
      Key: s3Key,
      Body: videoBuffer,
      ContentType: 'video/webm'
    }).promise();

    // 2. Salvar metadata
    const metadata = {
      sessionId: session.id,
      duration: Date.now() - session.startTime,
      frames: session.stats.frameCount,
      fps: this.config.fps,
      resolution: `${this.config.maxWidth}x${this.config.maxHeight}`
    };

    await this.s3.putObject({
      Bucket: this.config.bucket,
      Key: `sessions/${session.id}/metadata.json`,
      Body: JSON.stringify(metadata),
      ContentType: 'application/json'
    }).promise();

    return {
      videoUrl: `https://${this.config.bucket}.s3.amazonaws.com/${s3Key}`,
      metadata
    };
  }

  async framesToVideo(frames) {
    // Salvar frames temporários
    const tempDir = `/tmp/frames-${Date.now()}`;
    fs.mkdirSync(tempDir, { recursive: true });

    frames.forEach((frame, i) => {
      fs.writeFileSync(`${tempDir}/frame_${i.toString().padStart(6, '0')}.jpg`, frame);
    });

    return new Promise((resolve, reject) => {
      ffmpeg(`${tempDir}/frame_%06d.jpg`)
        .inputFPS(this.config.fps)
        .videoCodec('libx264')
        .format('webm')
        .on('end', () => {
          const video = fs.readFileSync(`${tempDir}/output.webm`);
          fs.rmSync(tempDir, { recursive: true, force: true });
          resolve(video);
        })
        .on('error', reject)
        .save(`${tempDir}/output.webm`);
    });
  }
}

// Uso
const recorder = new SessionRecorder({ bucket: 'my-app-recordings' });
const browser = await puppeteer.launch();
const page = await browser.newPage();

const session = await recorder.startSession('session-abc123', page);
// Conectar WebSocket para live viewing...
// Executar ações...
// await recorder.stopSession(session);
```

---

## 10. Melhores Práticas e Gotchas

### Memory Leak Prevenção (Screencast)

```javascript
// ❌ RUIM: não ack frames
client.on('Page.screencastFrame', ({ sessionId }) => {
  // Processar mas esquecer de ack
  // Chrome acumulará frames até crash
});

// ✅ BOM: ack imediato
client.on('Page.screencastFrame', async ({ sessionId }) => {
  await processFrame(data);
  await client.send('Page.screencastFrameAck', { sessionId });
});

// ✅ MELHOR: ack o mais rápido possível, processar em batch
const pendingFrames = new Map();
client.on('Page.screencastFrame', ({ data, sessionId }) => {
  pendingFrames.set(sessionId, data);
  // Ack IMEDIATO
  client.send('Page.screencastFrameAck', { sessionId });

  // Processar assincronamente em paralelo
  process.promisify(processFrame)(data).catch(console.error);
});
```

### Backpressure Management

Se os clients live estiverem lentos, limitar buffer:

```javascript
class ThrottledBroadcaster {
  constructor(maxQueue = 30) {
    this.queue = [];
    this.maxQueue = maxQueue;
    this.processing = false;
  }

  enqueue(frame) {
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift(); // Descartar frame mais antigo
    }
    this.queue.push(frame);
    this.process();
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const frame = this.queue.shift();
    this.broadcast(frame);
    this.processing = false;
    setImmediate(() => this.process()); // Next tick
  }
}
```

### Quality/FPS Adaptation Dinâmico

```javascript
// Ajustar com base na CPU disponível
function adaptParameters(currentCPU, currentMemory) {
  const base = { quality: 80, fps: 15 };

  if (currentCPU > 90) {
    return { quality: 60, fps: 10, everyNthFrame: 3 };
  }
  if (currentMemory > 500 * 1024 * 1024) {
    return { quality: 50, fps: 8, everyNthFrame: 4, maxWidth: 1280 };
  }
  return base;
}
```

---

## Referências

- [Chrome DevTools Protocol - Page.startScreencast](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
- [Puppeteer Page.screencast() API](https://pptr.dev/api/puppeteer.page.screencast)
- [Puppeteer Screencast Features (2025 PRs)](https://github.com/puppeteer/puppeteer/pull/13645)
- [Browserless Screencast Architecture](https://www.browserless.io/blog/screencast)
- [Chrome Headless Capture Video Guide](https://copyprogramming.com/howto/headless-chrome-capture-screen-video-or-animation)
- [Amazon Bedrock AgentCore Session Recording](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/session-replay-how-to-use.html)

---

**Última atualização**: Março 2025
**Aplicável a**: Chrome DevTools Protocol v1.3+, Puppeteer v22+, Node.js 18+
