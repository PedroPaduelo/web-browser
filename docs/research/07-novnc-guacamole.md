# Pesquisa: noVNC, Apache Guacamole e Alternativas de Remote Desktop Streaming

**Data:** 17/03/2026
**Escopo:** Arquiteturas de remote desktop, protocolos VNC vs CDP, e implicações para o projeto Serende

---

## 1. Como noVNC Funciona

### Visão Geral da Arquitetura

**noVNC** é um cliente HTML5 para VNC implementado inteiramente em JavaScript. Ele permite acesso a desktops remotos diretamente no navegador sem necessidade de plugins ou software cliente[^1].

### Arquitetura Técnica

```
Browser (noVNC Client)
    ↓ WebSocket
Websockify Proxy (bridge)
    ↓ RFB Protocol (TCP)
VNC Server (X11/Wayland/RDP backend)
```

**Componentes Principais:**

1. **noVNC Client** (JavaScript + HTML5 Canvas)
   - Implementado em JavaScript puro, rodando no navegador
   - Usa Canvas API para renderização dos frames recebidos
   - Gerencia conexão WebSocket e decode de dados VNC
   - Trata eventos de mouse e keyboard e envia via protocolo RFB

2. **Websockify** (WebSocket-to-TCP Proxy)[^1]
   - Ponte entre WebSocket (navegador) e TCP (servidor VNC)
   - Traduz frames WebSocket para conexões TCP padrão
   - Rodar como proxy independente ou integrado ao servidor
   - Suporta SSL/TLS para comunicação segura

3. **VNC Server** (Backend)
   - Implementações comuns: TigerVNC, TightVNC, UltraVNC, x11vnc
   - Captura tela do X11/Wayland/RDP backend
   - Aplica compressão (Raw, RRE, Hextile, Tight, TightPNG, ZRLE)
   - Envia dados via protocolo RFB (Remote Frame Buffer)

### Fluxo de Dados

**Screen Streaming (Server → Client):**
```
1. VNC Server captura framebuffer
2. Aplica encoding/compressão
3. Envia via RFB sobre TCP
4. Websockify recebe e repackeia em WebSocket frames
5. noVNC recebe, decodifica e desenha no Canvas
6. Atualizações parciais (dirty rectangles) otimizam largura de banda
```

**Input Handling (Client → Server):**
```
1. Usuário clica/digita no navegador
2. noVNC captura eventos DOM (mousedown, keydown, etc.)
3. Traduz para eventos RFB (pointer, keyboard)
4. Envia via WebSocket → Websockify → TCP
5. VNC Server simula input no desktop remoto
```

### Características Técnicas

- **Encodings Suportados:** raw, copyrect, rre, hextile, tight, tightPNG, ZRLE[^1]
- **Canvas Rendering:** Uso intensivo do Canvas 2D API (ou WebGL para aceleração)
- **Compressão:** Tight encoding usa zlib, combina com hextile para granularidade
- **SSL/TLS:** Suporte via WSS (WebSocket Secure)
- **Mobile:** Funciona em iOS e Android via navegadores modernos

---

## 2. Como Apache Guacamole Funciona

### Filosofia: "Clientless" Gateway

**Apache Guacamole** é um gateway de remote desktop que suporta VNC, RDP e SSH. A grande inovação: **nenhum cliente específico necessário** — apenas navegador HTML5[^2].

### Arquitetura do Guacamole

```
Browser (HTML5 Client)
    ↓ WebSocket (Guacamole protocol)
Guacamole Server (guacsd)
    ↓ Guacamole Protocol Interno
Driver de Conexão (VNC/RDP/SSH)
    ↓ Protocolo Nativo
Servidor Remoto (VNC/RDP/SSH)
```

### Componentes da Arquitetura

**1. Guacamole Client (HTML5/JavaScript)**
- Interface web renderizada com Canvas, similar ao noVNC
- Implementa o Guacamole protocol sobre WebSocket
- Recebe instruções de desenho (não pixels brutos!)

**2. Guacamole Server (`guacd`)**
- Daemon em C que gerencia conexões
- **Traduz protocolos nativos (VNC/RDP/SSH) para Guacamole Protocol**
- Mantém pool de conexões com servidores remotos
- Arquitetura multi-threaded, escalável

**3. Drivers de Protocolo**
- **VNC Driver:** Conecta via RFB (TCP) e traduz para Guacamole Protocol
- **RDP Driver:** Usa FreeRDP library, suporta RemoteFX, bitmap cache
- **SSH Driver:** Shell remoto via SFTP/SSH

**4. Guacamole Protocol (Proprietário)**

Diferente do VNC que envia **pixels brutos**, Guacamole envia **instruções de desenho** (drawing commands)[^2]:

```javascript
// Exemplo de instruções Guacamole Protocol (simplificado)
{
  "op": "sync",
  "flush": true
}

{
  "op": "png",
  "x": 100,
  "y": 50,
  "data": "base64-encoded-png"
}

{
  "op": "rect",
  "x": 200,
  "y": 100,
  "width": 50,
  "height": 30,
  "color": "#FF0000"
}

{
  "op": "end"
}
```

**Vantagem:** O cliente renderiza localmente, reduzindo processamento no servidor.

### Vantagens Arquiteturais do Guacamole

1. **Abstração de Protocolo:** Mesma interface para VNC, RDP e SSH
2. **Cache Inteligente:** RDP tem cache de bitmaps, SSH tem cache de terminal
3. **Concurrent Connections:** `guacd` gerencia múltiplas sessões simultâneas
4. **Segurança:** Conexões WebSocket criptografadas, autenticação integrada (LDAP, JWT, DB)
5. **Resolução Dinâmica:** Ajuste automático de resolução baseado em janela do navegador
6. **Clipboard Bidirecional:** Compartilhamento de texto entre clientes

---

## 3. Latência Típica: noVNC vs Guacamole vs Alternativas

### Contexto de Latência

**Latência (RTT - Round Trip Time)** é o fator crítico para remote desktop[^3]. VNC opera em 1 frame por RTT devido ao modelo client-pull.

### Análise Comparativa

#### noVNC/VNC Puro

**Latência Típica:**
- LAN (1-5ms RTT): ~30-60 FPS, sensação responsiva
- WAN Regional (30-80ms RTT): 10-15 FPS, perceptível lag
- WAN Intercontinental (150-300ms RTT): 2-5 FPS, **inutilizável**[^3]
- 180ms+ =用户体验 inviável para uso primário[^3]

**Overhead por frame:**
- Screen capture: ~5-15ms (CPU bound)
- Encoding (TightPNG): ~20-50ms (varia com complexity)
- Network RTT + transmission
- Decode + Canvas render: ~10-25ms

**Total por frame:** RTT + 40-100ms overhead

**Throughput Consumo:**
- Desktop estático: 10-50 Kbps
- Navegação web/vídeo: 500 Kbps - 2 Mbps
- Vídeo fullscreen: 5-10 Mbps (inadequado)

#### Apache Guacamole

**Latência Típica:**
- **VNC backend:** Mesma latência do noVNC (protocolo subjacente igual)
- **RDP backend:** ~20-40% melhor que VNC (protocolo mais eficiente)
  - Usa primitivas gráficas (draw commands) vs pixels brutos
  - Cache de bitmaps reduz tráfego
  - Resultado: 20-30 FPS com 80ms RTT vs 10-15 FPS do VNC

**Vantagem chave:** Para RDP, Guacamole aproveita eficiência do protocolo RDP. Para VNC, similar ao noVNC.

#### Alternativas Modernas

**RustDesk:**
- Protocolo próprio (baseado em WebRTC)
- Codec de vídeo (H.264/VP8/VP9) em vez de screen encoding
- **Latência:** 20-40ms em redes boas (superior a VNC)
- Usa hardware acceleration via Video CODEC

**Sunshine + Moonlight (Game Streaming):**
- Protocolo: H.264/HEVC sobre UDP + WebRTC
- **Latência:** 7-15ms em LAN (especialmente otimizado para games)
- Codec de baixa latência, 120+ FPS possível
- NVIDIA Gamestream / AMD streaming technology

---

## 4. Input Handling: Mouse e Keyboard

### noVNC (RFB Protocol)

**Mouse Events:**
```
DOM Events → RFB Pointer Events
- mousedown/mouseup → Button press/release
- mousemove → Position update (absoluto ou relativo)
- wheel → Scroll events (button 4/5 ou scroll normal)
- touch events → Mapeados para pointer events
```

**Keyboard Events:**
```
keydown/keyup → RFB Key Events
- Teclas especiais (Ctrl, Alt, F1-F12) mapeadas via keysym
- Layout de teclado sync no início da sessão
- Suporte a IME limitado (caracteres compostos via string events)
```

**Problemas:**
- **Latência dupla:** Input → cliente → servidor → VNC → aplica��ão
- **Mouse diferencial:** não suportado nativamente (coordenadas absolutas)
- **Scroll smoothing:** depender do VNC server

### Guacamole

**Mouse:**
- Mesmo modelo de eventos DOM → Guacamole Protocol
- Suporte a **mouse relativo** (para jogos/aplicações OpenGL)
- Eventos de clique, movimento, scroll

**Keyboard:**
- Guacamole Protocol envia keycodes (não keysyms)
- Layout sync via `keyboard-layout` instruction
- Melhor suporte a layouts internacionais

**Clipboard:**
- Sincronização bidirecional nativa
- Formato texto (UTF-8) + rastreamento de mudanças
- Buffer async (não bloqueia renderização)

**Vantagem Guacamole:**
- Protocolo mais estruturado
- Menor overhead na representação de eventos
- Clipboard integrado vs solução ad-hoc no VNC

---

## 5. Overhead: VNC vs CDP Direto (Chrome DevTools Protocol)

### VNC Overhead

**Camadas de Overhead:**

1. **Screen Capture (Kernel → Usermode)**
   - X11: `XGetImage` ou `xshm` (shared memory)
   - GPU compositing → framebuffer copy
   - Custo: 5-15ms por capture fullscreen 1080p
   - CPU: ~10-30% de 1 core para compressão

2. **Encoding (Tight/ZRLE)**
   - Algoritmos de compressão lossless/semi-lossless
   - CPU bound (software zlib, JPEG)
   - Depende de mudanças na tela (intra-frame)

3. **Protocolo RFB**
   - Framing overhead (4-12 bytes por update)
   - Mensagens de handshake, capability negotiation
   - Client-pull: wait for request → bloqueante

4. **WebSocket Bridge**
   - Websockify adiciona framing WS extra
   - Latência extra do proxy (1-2ms em LAN)

5. **Canvas Rendering (Cliente)**
   - putImageData → upload de pixels para GPU
   - Software vs WebGL acceleration

**Total Overhead (por frame):**
- Video playback: 100-300ms end-to-end
- Latência efetiva: RTT + overhead
- Throughput: Bitmaps + encoding ~500 Kbps - 5 Mbps

### CDP (Chrome DevTools Protocol) Direto

**Arquitetura:**
```
App/CDP Client → Chrome Debugging Protocol (JSON over WebSocket)
    ↓ Chrome Headless/Instance
DOM/Screen → Serialização via CDP
```

**Como Funciona:**

1. **Controle via DOM** (não pixels!)
   - `Page.screencastFrame` captura frames como PNG/JPEG
   - Input simulado via `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`
   - Click em elementos via DOM tree (`Runtime.evaluate` + JS)

2. **Encoding:**
   - PNG/JPEG via Chrome Skia engine (hardware accelerated)
   - Ou frame buffer raw (RGBA) para cliente renderizar
   - **Codec hardware GPU** (NVIDIA NVENC, Intel QuickSync, AMD VCE)

3. **Protocolo:**
   - JSON-RPC 2.0 sobre WebSocket
   - Bidirecional, baixa overhead (headers JSON leves)
   - Stream assíncrono de frames

4. **Overhead Reduzido:**

| Componente | VNC | CDP Direto |
|------------|-----|------------|
| Captura | X11 framebuffer copy (CPU) | Chrome compositor (GPU) |
| Encoding | Software Tight/zlib | Hardware H.264/VP8/PNG |
| Input Routing | Simulação no X server | DOM events diretos |
| Protocolo | RFB (binário) | JSON-RPC (estruturado) |
| Framing | Custom RFB frames | WebSocket + JSON |

**Vantagens Tangíveis de CDP:**

1. **Sem Camada de Abstração Desktop:** Controle direto no Chrome, não em X11
2. **GPU Acceleration:** Encoding via hardware codec
3. **DOM-level Input:** Não precisa mapear coordenadas absolutas (DOM positioning)
4. **Selective Updates:** CDP pode enviar dirty regions do DOM, não full framebuffer
5. **Performance Predictable:** Chrome otimizado para rendering web

**Desvantagens CDP:**
- Apenas Chrome/Chromium suportado
- Mais acoplado ao browser (menos portável)
- Overhead JSON parsing (mínimo comparado a encoding)

---

## 6. O Que Aprender Para o Projeto Serende

### Lições de noVNC

**✅ O que funciona bem:**
- HTML5 Canvas como render target universal
- WebSocket como transporte bidirecional (baixa latência)
- Client-side rendering, server-side encoding
- Mobile-friendly (iOS Safari, Android Chrome)

**❌ O que evoluir:**
- **Avoid raster-only protocol:** RFB manda pixels → overhead alto
- **Use structured updates:** Diferenças (dirty rects) são boas, mas não suficientes
- **Encoding choices:** TightPNG bom para desktop, ruim para vídeo
- **Proxying desnecessário:** Websockify adiciona camada → simplificar

### Lições de Guacamole

**✅ O que funciona bem:**
- **Drawing commands vs pixels:** Enviar retângulos, texto, imagens comprimidas em vez de framebuffer completo
- **Protocolo estruturado:** Operações de desenho (rect, png, string) permitem client-side caching
- **driver abstraction:** abstrai VNC/RDP/SSH → flexível
- **Autenticação integrada:** Segurança first-class

**❌ O que evoluir:**
- **Demasiado genérico:** Suportar 3 protocolos aumenta complexidade codebase
- **guacd como bottleneck:** Daemon extra para gerenciar pool
- **VNC ainda subjacente:** Para VNC backend, herda limitações

### Lições de RustDesk/Moonlight

**✅ O que funciona bem:**
- **Codec de vídeo real (H.264/HEVC):** Otimizado para motion, não screen captures
- **Hardware acceleration:** GPU encoding via NVENC/AMF
- **UDP + WebRTC:** Menor overhead que TCP para vídeo
- **Low-latency tuning:** Keyframe interval otimizado, B-frames minimizados

**❌ O que evoluir:**
- **Focado em games:** Pode ser overkill para remote browsing
- **Complexidade codec:** Manutenção de pipeline de vídeo completo

### Recomendações para Serende

**1. Escolher Protocolo:**
- **CDP (Chrome DevTools Protocol)** como base, não VNC
- Razão: Controle direto no DOM, GPU acceleration, sem camada X11
- **Alternativa:** CDP + WebRTC DataChannel (não apenas WebSocket)

**2. Encoding Strategy:**
```
Canvas/Video Stream (non-VNC):
- Frames curtos (≤16ms) via Page.screencastFrame (PNG base64)
- Ou usar Video element + captureStream() + WebRTC
- Hogar with hardware H.264 encoder (Chrome MediaRecorder API)
```

**3. Input Routing:**
```
DOM-based (não coordinate-based):
- `Input.dispatchMouseEvent` (click, move)
- `Input.dispatchKeyEvent` (keyboard)
- Touch → mouse mapping overlay
- Input latency target: <20ms local app → Chrome → page
```

**4. Arqutiura Sugerida:**

```
[Browser Frontend] (Canvas + MediaRecorder)
       ↓ WebRTC DataChannel + UDP
[Media Relay] (Selective Forwarding Unit - SFU opcional)
       ↓ WebSocket/Unix Socket
[Chrome Launcher] (Puppeteer/Playwright + CDP)
       ↓ CDP Commands
[Remote Chrome] (Headless/Display)
```

**5. Performance Targets:**
- **Latência E2E:** <50ms (input → render) em LAN
- **LAN (1ms RTT):** 60 FPS target (16ms frame time)
- **WAN (80ms RTT):** 30 FPS achievable (CDP overhead ~10-20ms)
- **Codec:** H.264 baseline profile, 2-4 Mbps para 1080p

**6. Sem Overhead Do VNC:**
- **NO X11 framebuffer copy**
- **NO Tight encoding CPU overhead**
- **NO RFB client-pull per frame**
- **NO Websockify proxy**

**7. Segurança:**
- Autenticação JWT nos WebSocket handshake
- TLS para transporte (wss://)
- CDP connections sandboxed per session
- Isolamento de sessões Chrome (per-user instances)

---

## 7. Alternativas Modernas

### RustDesk

**Arquitetura:**
```
Client (Rust) → Server Relay → Remote Host (Rust)
Protocol: Proprietário, UDP-based, Hole-punching NAT traversal
Codec: H.264/VP8/VP9 + Opus audio
```

**Características:**
- Escrito em Rust (performance, memory safety)
- Auto-relay: encontra caminho direto P2P quando possível
- NAT traversal via STUN/TURN
- **Latência:** ~20-40ms típica (melhor que VNC)
- **Use case:** Remote desktop替代 a TeamViewer/AnyDesk
- **Não focado em browser:** precisa de cliente nativo

**Não recomendado para Serende:** Requer cliente instalado, não web-native.

### Sunshine + Moonlight

**Arquitetura (Game Streaming):**
```
Game PC (Sunshine) → H.264/HEVC over UDP → Moonlight Client (Web/Native)
```

**Tecnologias:**
- **Video:** H.264/HEVC (GPU hardware encoders: NVENC, AMF, QSV)
- **Transporte:** UDP + QUIC ou RakNet custom
- **Audio:** Opus, AAC
- **Input:** Baixa latência, 120Hz mouse polling
- **Target:** 60-120 FPS, <16ms motion-to-photon latency

**Moonlight Web Client:**
- Implementação WebRTC no navegador
- Decode H.264 via WebCodecs API (Chrome)
- Input via Gamepad API + Mouse/Keyboard

**Latência Reportada:**
- LAN (NVIDIA RTX): 7-10ms
- 5GHz WLAN: 20-30ms
- Internet (good routing): 40-60ms

**Aprendizados para Serende:**
- Hardware codec é inestimável para low latency
- UDP melhor que TCP para streaming (menos head-of-line blocking)
- WebRTC transport já otimizado para browsers
- **Desvantagem:** otimizado para games (60+ FPS, motion-heavy), não UI generalista

---

## 8. Por Que CDP Direto é Melhor que VNC para Remote Browser

### Comparação Direta

#### 1. Arquitetura de Controle

| Aspecto | VNC (X11) | CDP (Chrome) |
|---------|-----------|--------------|
| **Abstração** | Framebuffer pixel-level | DOM + rendering pipeline |
| **Input Mapping** | Coordinate-based (absoluto) | DOM event-based (element-level) |
| **Graphics API** | X11 primitives | Chrome compositor + Skia/GrAccel |
| **3D/WebGL** | Não suportado nativamente | Suporte via GPU forwarding (parcial) |

**Vantagem CDP:** Controle no nível da página, não do display. Clicks em elementos são precisos, não dependem de coordenadas.

#### 2. Encoding e Overhead

**VNC Encoding Pipeline:**
```
Framebuffer → XGetImage (RAM copy) → Tight/zlib → Entropy coding → Network
```

**CDP Encoding Pipeline:**
```
Chrome Compositor Output → GPU texture → H.264 NVENC/Software → Network
```

| Métrica | VNC (TightPNG) | CDP (H.264 Hardware) |
|---------|----------------|---------------------|
| CPU Usage | 30-50% core | 5-15% (GPU offload) |
| Bandwidth (1080p @ 30FPS) | 2-5 Mbps | 1.5-3 Mbps |
| Latency (encode) | 30-60ms | 5-15ms (GPU) |
| Video Optimized | ❌ Ruim | ✅ Bom |

#### 3. Input Latency

**VNC Input Path:**
```
Browser mouse event → WebSocket → Websockify → TCP → VNC Server
→ X11 → WM → Application
```
**Multiple copies, context switches.**

**CDP Input Path:**
```
Browser input → WebSocket → CDP → Chrome → Blink/WebKit → Application
```
**Menos camadas, mais direto.**

#### 4. Suporte a Web Features

**VNC (X11 limitation):**
- Sem acesso a DOM, JavaScript
- Apenas pixel rendering → impossível detectar elementos
- CSS animations, transitions renderizadas normal → serializadas como pixels
- WebGL: framebuffer copy overhead, sem acceleration compartilhada

**CDP:**
- DOM inspection via `Runtime.evaluate` → pode injetar JS
- CSS-aware: reflow/repaint knowable
- WebGL: Chrome gerencia contexts, integrations nativas
- Pode controlar abas, navegação, cache específico por sessão

#### 5. Mobile Support

**VNC (noVNC):**
- Funciona em Safari/Chrome mobile
- Touch events mapeados para mouse
- Overhead de canvas scaling em telas high-DPI
- Sem otimização para gestures

**CDP + Mobile Emulation:**
- Chrome DevTools: device metrics override
- Touch events simulados via `Input.dispatchTouchEvent`
- Navegação mobile real (user agent, viewport)
- Orientation events

#### 6. Isolamento e Segurança

**VNC:**
- Sessão X11 única compartilhada
- Foco de janela global
- Acesso a filesystem se X server permitir
- Dificulta multi-tenant isolation

**CDP:**
- **Chrome instances separadas por sessão** (`--user-data-dir`)
- Sandboxed renderer processes
- Site isolation (processo por site)
- Pode rodar em container/seccomp
- Mais fácil isolation multi-tenant

#### 7. Modern Web Compatibility

**VNC Issues:**
- **YouTube 4K/60FPS:** 10-20 FPS visível, alto lag
- **WebGL games:** framerate baixo, artifacts de compression
- **CSS animations:** pixelated/blurry em scroll rápido
- **WebRTC video:** impossível (captura loopback necessária)

**CDP:**
- **YouTube 1080p/60FPS:** transmitível (H.264 hardware)
- **WebGL:** operações GPU forwardadas (quando disponível)
- **WebRTC streams:** pode capturar video element diretamente (menos overhead)
- **Infinite scroll:** updates parciais do DOM vs full framebuffer

### Conclusão Comparativa

**VNC serve para:**
- Desktop tradicional (Windows/Linux) remoto
- Legacy apps sem browser
- Ambientes onde a aplicação é X11-native
- Ferramentas que já rodam sobre VNC

**CDP serve para:**
- **Remote browsing especializado** (caso do Serende)
- Controle preciso no nível DOM
- Web apps complexos (Google Docs, Figma, etc.)
- Baixa latência com hardware acceleration
- Multi-tenant SaaS (isolation por Chrome instance)

**Recomendação Final:**
> Para **projeto Serende** de remote browser streaming, **CDP + WebRTC + hardware codec** é a arquitetura superior a VNC. Latência ~2-3x menor, CPU overhead reduzido, compatibilidade com web moderno assegurada. VNC adequado apenas se precisar rodar apps desktop arbitrariamente; mas foco em navegador → CDP é o caminho.

---

## Referências

[^1]: noVNC - HTML5 VNC Client. Disponível em: https://novnc.com/info.html
[^2]: Apache Guacamole - Architecture. Disponível em: https://guacamole.apache.org/doc/gug/architecture.html
[^3]: VNC in High-Latency Environments and Techniques for Improvement. Disponível em: https://cseweb.ucsd.edu/~pasquale/Research/Papers/globecom10t.pdf
[^4]: Improving Video Performance in VNC Under Latency Conditions. Disponível em: https://cs.oberlin.edu/~ctaylor/pubs/cbtaylor_cts10.pdf
[^5]: Chrome DevTools Protocol Documentation. Disponível em: https://chromedevtools.github.io/devtools-protocol/
[^6]: RustDesk - Remote Desktop. Disponível em: https://rustdesk.com/
[^7]: Sunshine + Moonlight - Game Streaming. Disponível em: https://moonlight-stream.org/

---

**Próximos Passos Sugeridos:**

1. Protótipo CDP + Puppeteer para medir latência real
2. Benchmark contra noVNC com YouTube 1080p60
3. Integrar WebRTC MediaRecorder em vez de PNG sequence
4. Testar hardware codec (Chrome `MediaRecorder` com `video/mp4; codecs="h264"`)
5. Autenticação JWT + per-session Chrome instances isolation
