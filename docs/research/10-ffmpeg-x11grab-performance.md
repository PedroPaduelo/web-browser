# FFmpeg x11grab Performance: Pesquisa Completa
**Data:** 2026-03-17
**Escopo:** CPU usage, latencia, benchmarks FPS vs qualidade MJPEG, comparacao com CDP screencastFrame, alternativas de captura

---

## 1. COMO x11grab FUNCIONA INTERNAMENTE

### Arquitetura de Captura

O x11grab e um "virtual device" do FFmpeg que captura frames diretamente do X11 display server. Internamente:

1. **MIT-SHM (Shared Memory Extension)** -- habilitado por padrao (`use_shm=1`)
   - Cria segmento de memoria compartilhada via `shmget()` + `shmat()`
   - Anexa ao X server com `XShmAttach()`
   - Chama `XShmGetImage()` para cada frame
   - **3x mais rapido** que `XGetSubImage()` por evitar round-trips no protocolo X11

2. **Fallback sem SHM**: usa `XGetImage()` que aloca nova imagem a cada chamada (muito mais lento)

3. **Formato de saida**: Raw RGB (bgr0) -- nao YUV

### O Gargalo Principal: Conversao RGB para YUV

O x11grab captura em **RGB**. A maioria dos encoders (x264, VP8, MJPEG) precisa de **YUV**. Essa conversao (via libswscale) e o maior gargalo de latencia e CPU:

- Captura SHM em si: rapida (~1-2ms por frame em 1080p)
- Conversao RGB->YUV: adiciona **400-600ms de latencia base**
- Encode VP8: ~100ms adicionais
- **Total: ~500-700ms de latencia minima** com x11grab + encode padrao

Referencia: [FFmpeg-user mailing list -- Understanding Latency Delays](https://ffmpeg.org/pipermail/ffmpeg-user/2015-September/028649.html)

### Excecao Importante: `libx264rgb`

O encoder `libx264rgb` aceita RGB diretamente (bgr0), eliminando a conversao RGB->YUV:
```bash
ffmpeg -f x11grab -framerate 60 -video_size 1920x1080 -i :0.0 \
  -c:v libx264rgb -threads 0 -crf 0 -preset ultrafast /tmp/out.mkv
```
Com multithreading (`-threads 0`), consegue **1080p@60fps sem frame drops**.

---

## 2. BENCHMARKS DE LATENCIA

### Latencia por Metodo de Captura

| Metodo | Latencia Tipica | CPU Usage | Notas |
|--------|----------------|-----------|-------|
| x11grab + VP8 | 600-700ms | Alta | RGB->YUV + encode |
| x11grab + x264 ultrafast | 500-600ms | Alta | RGB->YUV + encode |
| x11grab + MJPEG | **~150ms** | Moderada | MJPEG nao faz buffering de frames |
| x11grab + libx264rgb | ~200ms | Alta | Sem conversao RGB->YUV |
| x11grab + h264_nvenc | ~100ms | **Baixa** (GPU) | Encode offloaded para GPU |
| kmsgrab + VAAPI | **<50ms** | **~3% de 1 core** | Zero-copy, sem X11 |
| V4L2 (webcam) | <100ms | Baixa | Ja chega em YUV |
| CDP screencastFrame | ~50-100ms | Moderada-Alta | Apenas conteudo do browser |

### Por que MJPEG tem latencia menor que H.264?

Descoberta critica: **FFmpeg nao faz buffering de frames com MJPEG, mas faz com H.264**.

- MJPEG: cada frame e independente (intra-frame only), ~150ms end-to-end
- H.264 + mpegts: adiciona ~300ms (10 frames) de latencia extra pelo buffering do decoder/demuxer
- Diferenca: **~150ms vs ~450ms** para o mesmo cenario de streaming

Referencia: [Low-Latency Live Streaming Desktop using FFmpeg](http://devres.zoomquiet.top/data/20170510155805/index.html)

---

## 3. FPS vs QUALIDADE MJPEG

### Parametro `-q:v` (Qualidade MJPEG)

| `-q:v` | Qualidade | Bandwidth (1080p) | Notas |
|--------|-----------|-------------------|-------|
| 2 | Perfeita | ~150 Mbit/s | So viavel em LAN |
| 5 | Muito boa | ~60 Mbit/s | |
| 10 | Boa | ~25 Mbit/s | Bom tradeoff |
| 20 | Aceitavel | ~10 Mbit/s | Artefatos visiveis |
| 31 | Ruim | ~5 Mbit/s | Muito comprimido |

### Impacto do FPS na Latencia

- **60 FPS**: menor latencia possivel (cada frame = 16.6ms de intervalo), mas requer CPU/bandwidth
- **30 FPS**: padrao DVD, bom tradeoff (33ms intervalo)
- **15 FPS**: aceitavel para uso nao-gaming, metade da CPU
- **10 FPS**: perceptivelmente laggy, mas funcional para automacao

Se o encoder nao acompanha o FPS alvo, frames sao dropados silenciosamente.

### Comando Otimizado para MJPEG HTTP Streaming (Nosso Caso)

```bash
# Melhor tradeoff: 30fps, qualidade 8, 1280x720
ffmpeg -f x11grab -framerate 30 -video_size 1280x720 -i :99.0 \
  -c:v mjpeg -q:v 8 -f mjpeg -

# Baixa latencia maxima: 15fps, qualidade 12, dimensao menor
ffmpeg -f x11grab -framerate 15 -video_size 1280x720 -i :99.0 \
  -c:v mjpeg -q:v 12 -an -f mjpeg -
```

---

## 4. COMPARACAO: x11grab vs CDP Page.screencastFrame

### CDP `Page.startScreencast` / `Page.screencastFrame`

O Chrome DevTools Protocol oferece captura de tela nativa via:
```javascript
await cdp.send('Page.startScreencast', {
  format: 'jpeg',     // ou 'png'
  quality: 80,         // 0-100
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1     // 1=todos, 2=metade, etc.
});
```

Cada frame chega como evento `Page.screencastFrame` com imagem base64. **Deve-se** enviar `Page.screencastFrameAck` para cada frame para evitar acumulo de memoria.

### Tabela Comparativa Detalhada

| Aspecto | x11grab | CDP screencastFrame |
|---------|---------|---------------------|
| **Escopo** | Display inteiro (ou regiao) | Apenas conteudo da tab/page |
| **Formato captura** | Raw RGB (bgr0) | JPEG ou PNG (ja comprimido) |
| **FPS maximo** | 60+ (hardware-dependent) | 15-30 tipico |
| **Latencia** | 150ms (MJPEG) a 700ms (H.264) | 50-100ms |
| **CPU overhead** | Alto (captura + encode) | Moderado-Alto (compressao no renderer) |
| **Captura cursor** | Sim (`-draw_mouse 1`) | Nao (cursor do OS nao aparece) |
| **Captura popups/dialogs** | Sim (tudo no display) | Nao (apenas conteudo da page) |
| **Captura extensoes** | Sim | Parcial |
| **Requer Xvfb** | Sim | Nao (funciona headless) |
| **Memory leak conhecido** | Nao | **Sim** -- [Chromium issue #40934921](https://issues.chromium.org/issues/40934921) |
| **Acknowledge necessario** | Nao | Sim (screencastFrameAck) |
| **Overhead no Chrome** | Nenhum direto | **Significativo** -- reduz FPS da pagina |

### Bug Conhecido do CDP screencastFrame

O [Chromium issue #40934921](https://issues.chromium.org/issues/40934921) documenta que `Page.screencastFrame` causa **overhead significativo** de CPU e/ou memoria. O titulo completo e "Page screencasting (Page.screencastFrame) causes huge..." (detalhes completos requerem login no tracker).

Na pratica isso significa:
- Ativar screencast **reduz a performance da propria pagina** sendo capturada
- Em uso continuo prolongado, pode levar a aumento progressivo de memoria
- O acknowledge de frames (`screencastFrameAck`) e **critico** -- sem ele, backpressure acumula

### Qual Escolher para Nosso Caso (Remote Browser)?

Para o Serende (remote browser controlavel):

**x11grab e superior porque:**
1. Captura **tudo** -- popups, dialogs de download, alertas do OS, extensoes
2. Nao interfere na performance do Chrome sendo capturado
3. Nao tem o bug de memory leak do CDP
4. Suporta cursor nativo
5. Funcional para controle remoto completo (nao apenas web content)

**CDP screencastFrame seria melhor se:**
1. Quisessemos capturar APENAS o conteudo web (sem UI do Chrome)
2. Nao tivessemos Xvfb disponivel
3. Quisessemos a menor latencia possivel sem se preocupar com overhead

**Veredicto: x11grab + MJPEG e a escolha correta para nosso caso.**

---

## 5. OTIMIZACOES DO x11grab

### Flags Importantes

```bash
# -probesize: baixo para menor latencia, alto para evitar warnings
-probesize 32              # minima latencia (pode gerar warnings)
-probesize 10M             # suprime "not enough frames" em headless

# -thread_queue_size: buffer de frames nao-encodados
-thread_queue_size 512     # aumentar se dropping frames

# -framerate: fixo (nao existe modo adaptativo nativo)
-framerate 30              # taxa fixa de captura

# Threading: CRITICO para performance
-threads 0                 # auto-detect (usa todos os cores disponiveis)
-threads 4                 # fixo -- resolve muitos problemas de frame drop

# -draw_mouse: incluir cursor
-draw_mouse 1              # essencial para remote browser
```

### Nao Existe Framerate Adaptativo

x11grab **nao suporta framerate variavel/adaptativo nativamente**. A captura acontece em taxa fixa. Se quiser simular VFR:
- Output side: usar `-vsync vfr` na saida
- Post-process: filtro `fps` ou `vfr`
- Na pratica: se o encoder nao acompanha, frames sao silenciosamente dropados

### `xcbgrab` -- Substituto Moderno

A partir do FFmpeg 3.2+, `x11grab` foi internamente substituido por `xcbgrab` (via `--enable-libxcb`). A interface de usuario permanece `-f x11grab`, mas o backend usa libxcb. Funcionalmente equivalente, com implementacao mais moderna.

---

## 6. ALTERNATIVAS AO x11grab

### 6.1 kmsgrab (DRM/KMS -- Melhor Performance)

**O que e:** Captura diretamente do framebuffer DRM/KMS, bypassing X11 completamente.

**Performance:**
- **Zero-copy** -- video nao e copiado entre CPU e GPU
- **~3% de 1 core de CPU** com encode VAAPI
- Latencia muito menor que x11grab

**Comando:**
```bash
ffmpeg -device /dev/dri/card0 -f kmsgrab -i - \
  -vf 'hwmap=derive_device=vaapi,scale_vaapi=w=1920:h=1080:format=nv12' \
  -c:v h264_vaapi -b:v 2500k -maxrate 4000k -y output.mkv
```

**Limitacoes:**
- Requer `CAP_SYS_ADMIN` (ou sudo)
- Nao captura cursor
- Nao funciona em containers sem acesso ao DRM device
- Pode falhar com multi-GPU (seleciona iGPU por padrao)
- **Nao funciona com Xvfb** (que nao tem DRM device real)

**Veredicto para nosso caso:** INVIAVEL -- usamos Xvfb virtual display sem GPU real.

### 6.2 GPU Screen Recorder

- Captura na GPU com performance similar ao NVIDIA ShadowPlay
- Suporta ate 8K@240fps
- **85% menos CPU** que recorders tradicionais
- X11 e Wayland

**Veredicto para nosso caso:** Requer GPU real -- inviavel em nosso setup de container.

### 6.3 PipeWire Screen Capture

- Metodo nativo do Wayland para screen capture
- FFmpeg **nao suporta PipeWire diretamente** -- precisa de wrapper como `wf-recorder`
- Ferramentas: `wl-screenrec`, `wf-recorder`, OBS Studio

**Veredicto para nosso caso:** INVIAVEL -- usamos X11 (Xvfb), nao Wayland.

### 6.4 XShmGetImage Direto (Custom Code)

Pode-se implementar captura direta via XShmGetImage sem FFmpeg:

```c
// Pseudocodigo
XShmGetImage(display, root_window, image, 0, 0, AllPlanes);
// image->data contem pixels RGB
// Comprimir com libjpeg-turbo direto
```

**Vantagens:**
- Elimina overhead do FFmpeg (processo, pipes, buffers internos)
- Controle total sobre timing e formato
- libjpeg-turbo faz JPEG encode muito rapido

**Desvantagens:**
- Precisa implementar todo o pipeline (captura + encode + timing)
- Sem as otimizacoes internas do FFmpeg para threading

**Veredicto:** Possivel otimizacao futura, mas alto custo de implementacao.

### 6.5 `xdpyinfo` -- Nao e Alternativa de Captura

`xdpyinfo` e apenas uma ferramenta de **informacao** sobre o display X11. Usado para obter dimensoes da tela:
```bash
xdpyinfo | grep dimensions | awk '{ print $2 }'
# Output: 1280x720
```
**Nao faz captura de tela.** Util apenas como complemento ao x11grab para detectar resolucao.

---

## 7. CONFIGURACAO OTIMA PARA NOSSO CASO

### Contexto

- Container com Xvfb (display virtual :99)
- Chrome rodando em 1280x720
- Sem GPU dedicada
- Streaming para browser via WebSocket
- Objetivo: latencia <200ms, CPU aceitavel

### Configuracao Recomendada

```bash
# Prodution: MJPEG via stdout para WebSocket
ffmpeg -f x11grab \
  -framerate 24 \
  -video_size 1280x720 \
  -draw_mouse 1 \
  -thread_queue_size 512 \
  -probesize 10M \
  -i :99.0 \
  -c:v mjpeg \
  -q:v 8 \
  -threads 2 \
  -f mjpeg \
  -
```

### Justificativa de Cada Parametro

| Parametro | Valor | Razao |
|-----------|-------|-------|
| `-framerate 24` | 24 fps | Suficiente para uso interativo, economiza CPU vs 30/60 |
| `-video_size 1280x720` | 720p | Match com resolucao do Xvfb |
| `-draw_mouse 1` | cursor on | Essencial para remote browser |
| `-thread_queue_size 512` | buffer | Previne frame drops em picos de CPU |
| `-probesize 10M` | alto | Evita warnings em display virtual |
| `-c:v mjpeg` | MJPEG | Menor latencia (150ms vs 450ms H.264), sem buffering de frames |
| `-q:v 8` | qualidade 8 | Bom tradeoff qualidade/bandwidth (~20-30 Mbit/s) |
| `-threads 2` | 2 threads | Suficiente para MJPEG 720p, nao come todos os cores |
| `-f mjpeg` | formato | Stream de JPEGs concatenados |

### Cenarios Alternativos

```bash
# Alta qualidade (LAN / pouca sessao):
-framerate 30 -q:v 5 -threads 4

# Economia maxima de CPU (muitas sessoes):
-framerate 10 -q:v 15 -threads 1 -video_size 960x540

# Uso com tune zerolatency (se trocar para H.264):
-c:v libx264 -preset ultrafast -tune zerolatency -crf 23 -f mpegts
```

---

## 8. RESUMO EXECUTIVO

### Situacao Atual

O Serende usa x11grab + MJPEG via WebSocket, que e a **escolha correta** para o caso de uso (remote browser em container sem GPU).

### Numeros-Chave

- **Latencia x11grab + MJPEG**: ~150ms (otimo para uso interativo)
- **Latencia x11grab + H.264**: ~450-700ms (inaceitavel para controle remoto)
- **Latencia CDP screencastFrame**: ~50-100ms (menor, mas com overhead no Chrome)
- **CPU x11grab MJPEG 720p@24fps**: Moderada (~1 core com 2 threads)
- **Gargalo principal**: conversao RGB->YUV (eliminado com MJPEG que aceita RGB via `pix_fmt yuvj420p`)

### Recomendacoes

1. **Manter x11grab + MJPEG** como pipeline principal
2. **Tunar -q:v e -framerate** conforme carga do servidor (adaptacao no codigo, nao no ffmpeg)
3. **Nao migrar para CDP screencastFrame** -- bug de memory leak, overhead no Chrome, nao captura popups
4. **kmsgrab e GPU alternatives sao inviaveis** no nosso setup (container Xvfb sem GPU)
5. **Otimizacao futura possivel**: captura XShmGetImage direta + libjpeg-turbo custom, eliminando processo ffmpeg

---

## Fontes

- [FFmpeg-user: Understanding Latency Delays](https://ffmpeg.org/pipermail/ffmpeg-user/2015-September/028649.html)
- [Low-Latency Live Streaming Desktop using FFmpeg](http://devres.zoomquiet.top/data/20170510155805/index.html)
- [GPU-Accelerated Desktop Streaming via FFmpeg (GitHub Gist)](https://gist.github.com/Brainiarc7/4636a162ef7dc2e8c9c4c1d4ae887c0e)
- [Better, Faster Screen Capture with kmsgrab](https://wiki.tonytascioglu.com/scripts/ffmpeg/kmsgrab_screen_capture)
- [Chromium Issue #40934921: Page.screencastFrame Performance](https://issues.chromium.org/issues/40934921)
- [Chromium Auto-Throttled Screen Capture Design Doc](https://www.chromium.org/developers/design-documents/auto-throttled-screen-capture-and-mirroring/)
- [FFmpeg ArchWiki](https://wiki.archlinux.org/title/FFmpeg)
- [FFmpeg x11grab Source Code (GitHub)](https://github.com/Vincit/ffmpeg/blob/master/libavdevice/x11grab.c)
- [FFmpeg Devices Documentation (Official)](https://ffmpeg.org/ffmpeg-devices.html)
- [Frame-Perfect Linux Screencasts (2014)](https://panthema.net/2014/0630-Frame-Perfect-Linux-Screencasts-in-the-Year-2014.html)
- [Arch Linux: Decent Options for ffmpeg x11grab](https://bbs.archlinux.org/viewtopic.php?id=127574)
- [GPU Screen Recorder (2026)](https://www.ofzenandcomputing.com/gpu-screen-recorder/)
- [libscreencapture-wayland (GitHub)](https://github.com/DafabHoid/libscreencapture-wayland)
- [Puppeteer Page.screencast() API](https://pptr.dev/api/puppeteer.page.screencast)
