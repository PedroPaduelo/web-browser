# noVNC e o Protocolo RFB sobre WebSocket

**Data:** 2026-03-17
**Categoria:** Pesquisa de Protocolo — Streaming de Desktop Remoto

---

## 1. O Que e noVNC

noVNC e um cliente VNC HTML5 de codigo aberto (licenca MIT) que implementa o protocolo RFB (Remote FrameBuffer) sobre WebSockets. Ele renderiza a tela remota usando Canvas ou WebGL diretamente no navegador, sem necessidade de plugins ou aplicacoes nativas instaladas.

Ao contrario dos clientes VNC tradicionais, o noVNC delega a renderizacao inteiramente ao navegador e usa WebSockets como canal de transporte bidirecional — substituindo o TCP raw do RFB classico.

**Stack minima de producao:**

```
Browser (noVNC) <--[WebSocket/WSS]--> websockify <--[TCP]--> VNC Server
```

---

## 2. O Protocolo RFB

### 2.1 Conceito fundamental

RFB (Remote FrameBuffer) e um protocolo simples para acesso remoto a interfaces graficas. Ele opera no nivel do framebuffer — a regiao de memoria que contem os pixels exibidos na tela. Por isso e aplicavel a qualquer sistema operacional ou aplicacao (X11, Windows, Wayland, macOS) sem precisar entender a semantica da GUI.

O modelo e cliente-servidor invertido em relacao ao usual:
- **Servidor RFB** = a maquina com a tela (onde a GUI roda)
- **Cliente RFB (viewer)** = onde o usuario esta (mouse + teclado + display)

### 2.2 Troca de mensagens basica

O fluxo de operacao do RFB e:

1. **Handshake de versao:** cliente e servidor negociam a versao do protocolo (ex: RFB 3.8).
2. **Negociacao de seguranca:** tipos de autenticacao disponiveis; o cliente escolhe um.
3. **Inicializacao:** servidor envia `ServerInit` com dimensoes da tela e formato de pixel.
4. **Loop de operacao:**
   - Cliente envia `FramebufferUpdateRequest` (incremental ou full)
   - Servidor responde com `FramebufferUpdate` contendo retangulos de pixels alterados
   - Cliente envia eventos de entrada (`KeyEvent`, `PointerEvent`) conforme o usuario interage

O ponto critico: **o cliente deve solicitar atualizacoes explicitamente**. O servidor nao envia frames espontaneamente (na implementacao classica). Isso tem implicacoes profundas para latencia — discutidas na secao 5.

### 2.3 Unidade de transferencia: o retangulo

Toda atualizacao RFB e composta por retangulos. Cada retangulo tem:
- Posicao (x, y)
- Dimensoes (largura, altura)
- Tipo de encoding
- Dados de pixels (comprimidos conforme o encoding)

O servidor envia apenas os retangulos que **mudaram** desde o ultimo update — o que torna o protocolo naturalmente eficiente para conteudo estatico ou com mudancas esparsas.

---

## 3. Encodings de Frame: Como os Pixels Sao Comprimidos

O RFB suporta varios algoritmos de codificacao, negociados durante o handshake. O cliente anuncia quais suporta; o servidor escolhe os que vai usar.

### 3.1 Raw

O encoding mais simples. Pixels enviados em ordem de varredura (esquerda para direita, cima para baixo) sem qualquer compressao. Largura de banda altissima; usado apenas como fallback ou para depuracao.

- **Uso:** linha de base, sem compressao
- **Bandwidth:** muito alto
- **CPU:** minimo

### 3.2 CopyRect

Nao transmite pixels — apenas informa que uma regiao da tela e identica a outra regiao ja conhecida pelo cliente. O payload e apenas as coordenadas de origem (x, y).

- **Uso ideal:** janelas sendo arrastadas, conteudo scrollado
- **Bandwidth:** minimo (4 bytes por retangulo)
- **CPU:** minimo

### 3.3 RRE (Rise-and-Run-length Encoding)

Codifica a imagem como um background color mais subrectangulos coloridos solidos. Util para conteudo com grandes areas de cor uniforme.

### 3.4 Hextile

Divide o retangulo em tiles de 16x16 pixels. Cada tile pode ser codificado como: cor solida, raw, ou background + subrectangulos coloridos. E mais eficiente que Raw ou RRE, mas significativamente pior que os encodings baseados em zlib.

- **Uso:** comum em servidores mais antigos
- **Suportado por noVNC:** sim

### 3.5 ZRLE (Zlib Run-Length Encoding)

Combina quatro tecnicas: compressao zlib, tiling de 64x64 pixels, palettizacao e run-length encoding.

**Estrutura wire:**
```
[4 bytes: tamanho dos dados comprimidos]
[N bytes: dados zlib comprimidos]
```

Os dados descomprimidos representam tiles de 64x64 pixels em ordem left-to-right, top-to-bottom. Cada tile pode ser:
- Solid color (1 byte de tipo + cor)
- Packed palette (paleta de ate 127 cores + bitmap)
- Plain RLE
- Palette RLE

ZRLE usa um **unico objeto zlib por conexao**, o que significa que os retangulos devem ser codificados e decodificados estritamente em ordem — o contexto de compressao e cumulativo entre atualizacoes, o que melhora a razao de compressao ao longo do tempo.

- **Nivel de compressao:** configuravel (0-9)
- **Suportado por noVNC:** sim (adicionado em PR #1283)

### 3.6 Tight

O encoding mais sofisticado do ecossistema VNC. Combina:
- Deteccao de regioes solidas
- Codificacao de paleta para imagens de poucas cores
- Compressao zlib basica
- Compressao JPEG (lossy) para areas com muitas cores

**Compression-control byte:** cada retangulo Tight comeca com um byte de controle que indica:
- Quais dos 4 streams zlib devem ser resetados (bits 0-3)
- Qual sub-encoding usar (bits 4-7): BasicCompression, FillCompression, JpegCompression, etc.

**Restricao de largura:** retangulos Tight nao podem exceder 2048 pixels de largura — retangulos maiores devem ser divididos.

**Tight PNG:** variante onde a compressao basica e substituida por dados PNG ao inves de zlib raw. Significativamente mais rapido no navegador porque o browser tem decodificacao PNG nativa (via `<img>` tag ou ImageDecoder API), eliminando a necessidade de decompressao zlib em JavaScript.

- **Suportado por noVNC:** sim (ambos Tight e TightPNG)
- **Recomendado para noVNC:** TightPNG — muito mais rapido que Hextile e eficiente como Tight standard

### 3.7 ZYWRLE (Zlib Wavelet Run-Length Encoding)

Extensao do ZRLE que adiciona compressao wavelet, especialmente eficiente para conteudo de video ou imagens fotograficas dentro do framebuffer.

- **Suportado por noVNC:** sim (adicionado junto com ZRLE)

### 3.8 H.264 (experimental)

Alguns projetos experimentaram codificar o framebuffer inteiro como stream H.264. Os resultados foram "lackluster" segundo o desenvolvedor do TurboVNC — funciona, mas o overhead de CPU e o requisito de keyframes frequentes prejudicam a eficiencia em cargas de trabalho tipicas de desktop.

### Tabela resumo de encodings

| Encoding    | Compressao    | CPU server | CPU client JS | Ideal para            | noVNC suporta |
|-------------|---------------|------------|---------------|----------------------|---------------|
| Raw         | Nenhuma       | minimo     | minimo        | Debug/fallback        | Sim           |
| CopyRect    | Nenhuma       | minimo     | minimo        | Scroll, drag          | Sim           |
| Hextile     | Baixa/media   | baixo      | baixo         | Compatibilidade       | Sim           |
| ZRLE        | Alta          | medio      | medio (zlib JS)| Uso geral           | Sim           |
| Tight       | Alta + JPEG   | medio      | medio (zlib JS)| Uso geral + video   | Sim           |
| TightPNG    | Alta          | medio      | baixo (PNG nativo) | noVNC browser | Sim      |
| ZYWRLE      | Alta (wavelet)| alto       | medio         | Video/fotos           | Sim           |

---

## 4. noVNC: Arquitetura de Implementacao

### 4.1 Camadas do sistema

noVNC tem uma arquitetura em tres camadas bem definidas:

```
[Aplicacao / UI Layer]
        |
   [Classe RFB]           ← protocolo, state machine, decoders
        |
   [Classe WebSock]       ← buffer de dados binarios, wrapper WebSocket
        |
   [WebSocket nativo]     ← transporte TCP sobre HTTP upgrade
        |
   [websockify proxy]     ← bridge WebSocket <-> TCP
        |
   [Servidor VNC/RFB]     ← TightVNC, TigerVNC, LibVNCServer, QEMU, etc.
```

### 4.2 Classe RFB

E a classe central: gerencia a state machine do protocolo, processa mensagens, decodifica frames, emite eventos para a UI. Ciclo de estados:

1. `SECURITY` — negociacao de tipo de autenticacao
2. `AUTHENTICATION` — troca de credenciais
3. `INITIALIZATION` — `ClientInit` + `ServerInit`
4. `NORMAL` — operacao regular (updates + input)

### 4.3 Classe WebSock

Wrapper de alto desempenho em torno do WebSocket nativo. Adiciona:
- **Buffer de recepcao** com ponteiro `_rQi` (sem copia de dados)
- **Metodos de leitura tipados:** `rQshift8()`, `rQshift16()`, `rQshiftStr()`, etc.
- **Buffer de envio** para mensagens de saida

Usa `Uint8Array` internamente para manipulacao eficiente de dados binarios.

### 4.4 websockify: o proxy

websockify e um proxy Python minimalista (com alternativas em Node.js) que:
- Aceita conexoes WebSocket (protocolo HyBi/IETF 6455)
- Mantem uma conexao TCP para o servidor VNC
- Encaminha dados binarios bidirecionalmente sem transformacao

**Performance do websockify:**
- Overhead de latencia: **~1.84 ms** de RTT mediano com payloads de 2000 bytes (benchmark Chrome nativo)
- Apos o handshake HTTP inicial, opera com overhead minimo sobre TCP
- Desde a versao 0.5.0, usa frames binarios nativos do protocolo WebSocket (eliminou o encoding base64 que existia anteriormente)
- Instalacao com numpy melhora throughput de processamento

**Implementacoes disponeis:**
- `novnc/websockify` (Python) — referencia
- `novnc/websockify-js` (Node.js)
- `maximegris/node-websockify` (Node.js, para uso programatico)

---

## 5. Latencia Real do noVNC

### 5.1 Latencia de renderizacao no browser

O noVNC em si e rapido: em Chrome, um frame inteiro de 1024x768 com encoding Tight pode ser renderizado em **menos de 10ms**. A renderizacao nao e o gargalo.

### 5.2 O problema estrutural: poll-before-push

O protocolo RFB classico exige que o **cliente solicite** atualizacoes:

```
Cliente → FramebufferUpdateRequest
Servidor → FramebufferUpdate
Cliente → FramebufferUpdateRequest  ← so envia apos receber o update anterior
Servidor → FramebufferUpdate
...
```

Isso significa que com latencia de rede de 100ms RTT, o maximo teorico e **10 FPS** — um update por round-trip.

### 5.3 Numeros reais medidos

| Cenario | Resultado |
|---------|-----------|
| Renderizacao de frame (Chrome, Tight, LAN) | < 10ms |
| FPS interativo com 10ms RTT (noVNC) | ~8.4 FPS |
| FPS interativo com 10ms RTT (TightVNC nativo) | ~13.2 FPS |
| Video passivo sem interacao do usuario | ~1 frame a cada 2 segundos |
| Screen quiesce numa LAN de 100 Mbps | ~100ms |
| Refresh com 200ms de latencia de rede | ~1.67 segundos |
| Overhead do websockify (RTT, payload 2KB) | ~1.84ms |

Quando o usuario nao esta interagindo (sem mouse/teclado), o noVNC envia `FramebufferUpdateRequest` apenas a cada **~1.5 segundos** — resultando em aproximadamente 1 frame por 2 segundos para conteudo passivo.

### 5.4 Solucoes para o problema de latencia

#### Continuous Updates (extensao RFB)

A extensao Continuous Updates permite que o cliente instrua o servidor a enviar atualizacoes **continuamente** sem esperar requests. O servidor passa a ter comportamento push ativo. noVNC usa esta extensao quando o servidor a suporta.

#### Fence (extensao RFB)

A extensao Fence fornece sincronizacao de stream: garante que todas as mensagens anteriores ao Fence foram processadas antes que as posteriores comecem. Isso habilita pipelining seguro — o cliente pode ter multiplos requests pendentes sem perder a sincronia do protocolo.

#### Pipelining (workaround)

Quando o servidor nao suporta Continuous Updates nem Fence, o noVNC usa uma estrategia de emulacao: envia `FramebufferUpdateRequest` a cada **50ms** independentemente de ter recebido o update anterior. O servidor aceita multiplos requests e responde quando tiver atualizacoes.

O TurboVNC aperfeicoou isso enviando um novo request **antes de terminar de decodificar** o update anterior — escondendo parte da latencia de rede.

### 5.5 Limitacoes fundamentais

- **Sem adaptacao de qualidade automatica:** o VNC nao ajusta compressao/qualidade conforme a banda disponivel (diferente de WebRTC com bitrate adaptativo)
- **Sem interframe compression global:** cada update e independente (diferente de H.264 que usa predicao temporal entre frames)
- **Sensibilidade a jitter:** perda de pacotes ou jitter impacta diretamente o FPS ja limitado

---

## 6. Input: Mouse e Teclado

### 6.1 PointerEvent

Mensagem do cliente para o servidor, tipo 5 no protocolo RFB.

```
[1 byte: tipo = 5]
[1 byte: button-mask]  ← bits 0-7 = botoes 1-8 (1=pressionado)
[2 bytes: x-position]
[2 bytes: y-position]
```

Enviado a cada movimento do mouse ou mudanca de estado de botao. Botoes 1-3 = esquerdo, meio, direito. Botoes 4-5 = scroll up/down (convencao).

### 6.2 KeyEvent

Mensagem do cliente para o servidor, tipo 4.

```
[1 byte: tipo = 4]
[1 byte: down-flag]    ← 1=pressionado, 0=solto
[2 bytes: padding]
[4 bytes: keysym]      ← X11 keysym value
```

O servidor replica o keysym no desktop remoto como pressionado ou solto. Para a maioria das teclas comuns, o keysym equivale ao valor ASCII.

**Auto-repeat:** deve ser tratado no cliente. Em redes de alta latencia, uma tecla mantida pressionada pode parecer "presa". A convencao e enviar apenas `down` repetido sem `up` para auto-repeat, permitindo ao servidor distinguir.

### 6.3 Pipeline de input no noVNC

```
DOM KeyboardEvent / MouseEvent
        |
   Classe Keyboard / Mouse (noVNC)
        |
   Normalizacao cross-platform
   Conversao DOM key → X11 keysym
        |
   Classe RFB
        |
   WebSock (buffer de saida)
        |
   WebSocket → websockify → VNC Server
```

A classe `Keyboard` do noVNC:
- Captura eventos do DOM no elemento Canvas
- Rastreia estado das teclas pressionadas
- Libera todas as teclas automaticamente quando a janela perde foco (previne teclas "travadas")
- Gerencia o mapeamento de layouts de teclado

### 6.4 QEMU Extended Key Event

O protocolo RFB padrao tem uma limitacao com teclados nao-US: o keysym depende do layout de teclado configurado no cliente. O QEMU, como emulador de hardware, precisa do **keycode fisico** para emular teclas corretamente independente do layout.

A extensao QEMU Extended Key Event adiciona o `KeyboardEvent.code` (disponivel no DOM desde Chrome 48) ao payload, permitindo ao servidor interpretar a tecla com base na posicao fisica do teclado, nao no caractere produzido.

O noVNC implementa esta extensao. Exemplo de problema resolvido: AltGr no Windows gera `CtrlLeft + AltRight` no nivel do SO — o noVNC descarta o `CtrlLeft` espurio neste caso.

---

## 7. noVNC vs MJPEG via WebSocket

### 7.1 Como funciona MJPEG via WebSocket

MJPEG (Motion JPEG) e uma sequencia de frames JPEG independentes. Via WebSocket, cada frame e transmitido como uma mensagem binaria completa. O cliente decodifica cada JPEG e exibe no canvas.

```
Servidor → captura frame completo → comprime como JPEG → envia via WebSocket
Cliente → recebe JPEG → decodifica → exibe no canvas
```

### 7.2 Diferencas fundamentais

| Aspecto | MJPEG via WebSocket | noVNC (RFB via WebSocket) |
|---------|--------------------|-----------------------------|
| **Modelo de frame** | Frame completo a cada vez | Apenas retangulos alterados |
| **Compressao temporal** | Nenhuma (cada frame e independente) | Implicita (via delta de retangulos) |
| **Cenas estaticas** | Envia frame completo mesmo sem mudanca | Envia quase nada (request retorna update vazio) |
| **Cenas com muito movimento** | Eficiente (frame completo ja e necessario) | Potencialmente ineficiente (muitos retangulos) |
| **Bandwidth (UI tipica)** | Alto e constante | Baixo e proporcional a mudanca |
| **Bandwidth (video full-screen)** | Alto mas previsivel | Alto (muitos retangulos alterados) |
| **Latencia de encoding** | Muito baixa (1 JPEG por frame) | Baixa, mas com overhead de analise de regioes |
| **Complexidade de implementacao** | Muito simples | Moderada (state machine, multiplos encodings) |
| **Controle de qualidade** | Parametro de qualidade JPEG global | Por tipo de regiao (Tight usa JPEG so onde e melhor) |
| **Input bidirecional** | Requer canal separado | Integrado no mesmo WebSocket |
| **Scroll/drag** | Frame completo | CopyRect (4 bytes apenas) |

### 7.3 Quando MJPEG ganha

- Conteudo em video full-screen (diferenca entre frames e maxima)
- Implementacao rapida (sem necessidade de estado de protocolo)
- Streaming de camera/webcam (conteudo ja e JPEG nativo)
- Sistemas embarcados com CPU limitada no servidor

### 7.4 Quando VNC/RFB ganha

- UI tipica de desktop (pouca mudanca entre frames)
- Redes com bandwidth limitado
- Quando input integrado e essencial (RFB inclui teclado + mouse no mesmo protocolo)
- Conteudo com texto (encodings como Tight usam heuristica por tipo de conteudo)

### 7.5 O grande problema do MJPEG: sem delta

Para 90%+ dos frames de uma UI tipica, a maior parte da tela nao muda. MJPEG transmite o frame inteiro de qualquer forma. VNC transmite apenas os retangulos modificados — em uma sessao de terminal, isso pode ser uma diferenca de 100x em bandwidth.

---

## 8. VNC vs WebRTC para Desktop Remoto

### 8.1 Por que tantos remote desktops usam VNC

Apesar das limitacoes de latencia, VNC/noVNC domina a categoria de "acesso a console via browser" por razoes estruturais:

**Maturidade do ecossistema:**
- VNC existe ha mais de 25 anos (AT&T Labs, 1998)
- Decenas de implementacoes de servidor (TigerVNC, TightVNC, LibVNCServer, TurboVNC, QEMU VNC, Xvnc)
- Integracao nativa em hypervisors: Proxmox, QEMU/KVM, VMware, VirtualBox, oVirt
- Todos os principais cloud providers oferecem console VNC para VMs

**Simplicidade de integracao:**
- VNC server e frequentemente embutido no proprio hypervisor (QEMU tem VNC built-in)
- Configuracao e trivial: uma porta TCP, eventualmente uma senha
- Sem necessidade de instalacao no guest OS para acesso de emergencia (acesso ao nivel do framebuffer)

**Acesso de recuperacao:**
- VNC funciona mesmo quando o guest OS esta corrompido, sem rede, ou no boot loader
- WebRTC requer um agente rodando no sistema operacional funcional

### 8.2 Por que WebRTC nao dominou (ainda)

**Complexidade do protocolo WebRTC:**

WebRTC e um conjunto de protocolos e APIs:
- ICE (Interactive Connectivity Establishment) para NAT traversal
- STUN/TURN para descoberta e relay de endereco
- DTLS para seguranca do data channel
- SRTP para transporte de midia
- SDP para negociacao de capabilities

Para desktop remoto, WebRTC requer:
1. Servidor de sinalização (para troca de SDP)
2. STUN server (para descoberta de IP publico)
3. TURN server (para relay em NATs simetricos — necessario em ~15-40% dos casos)
4. Agente nativo no sistema remoto que capture frames e encode

> "In every case, the WebRTC protocol stack introduces significant complexity to the streaming component. As an alternative, a solution using MediaSource and WebSockets can be simpler and good enough for an MVP." — grupo de discussao WebRTC

**Limitacoes de WebRTC para desktop:**

| Limitacao | Detalhe |
|-----------|---------|
| Latencia de encoding | H.264/VP8/VP9 tem latencia de encoding maior que Tight ou TightPNG |
| Requisito de agente | Precisa de software rodando no guest OS funcional |
| Sem acesso pre-OS | Nao funciona durante boot, crash, ou quando OS esta corrompido |
| TURN overhead | Conexoes via TURN introduzem latencia adicional |
| Complexidade de deploy | Requer infraestrutura adicional (sinalização, STUN, TURN) |
| Codec negotiation | VP8/VP9/H.264/AV1 — fragmentacao de suporte entre browsers |

### 8.3 Onde WebRTC ganha claramente

- **Alta framerate:** WebRTC com H.264 hardware encoding alcanca 60+ FPS com latencia < 50ms em redes boas
- **Conteudo de video:** compressao interframe e muito mais eficiente que qualquer encoding RFB
- **Audio integrado:** WebRTC inclui audio bidirecional nativo (RFB nao tem audio)
- **NAT traversal:** ICE/TURN funciona atraves de NATs simetricos sem necessidade de port forwarding
- **Adaptive bitrate:** ajusta automaticamente qualidade e resolucao conforme a banda disponivel

### 8.4 Casos de uso e a escolha certa

| Caso de uso | Melhor tecnologia | Razao |
|-------------|------------------|-------|
| Console de VM em cloud (Proxmox, oVirt) | VNC/noVNC | Integracao nativa, acesso pre-OS, sem agente |
| Remote desktop empresarial | RDP ou VNC | Maturidade, GPO, suporte a impressora/clipboard |
| Remote desktop cloud gaming | WebRTC | 60 FPS, audio, adaptive bitrate |
| Remote browser isolado | VNC ou WebRTC | Depende da arquitetura; VNC e mais simples |
| Acesso de emergencia/recuperacao | VNC | Funciona sem OS funcional |
| Streaming de desktop para audiencia | WebRTC | Melhor para multicast/video streaming |

### 8.5 Alternativas hibridas

Varios projetos combinam o melhor dos dois mundos:

- **Selkies-GStreamer:** usa GStreamer para captura e encoding H.264/VP8/VP9 via WebRTC, atingindo 30-60+ FPS com aceleracao de hardware
- **Apache Guacamole:** proxy server-side que traduz RFB/RDP para um protocolo proprio eficiente em WebSocket, melhor para conexoes de alta latencia
- **SPICE:** protocolo desenvolvido pela Red Hat para VMs, com adaptacao de qualidade, suporte a video e USB redirect; mais eficiente que VNC mas menos suportado

---

## 9. Analise Critica para o Projeto remote-browser

### 9.1 O cenario atual do projeto

O projeto `remote-browser` atualmente usa WebRTC para streaming do Chrome via CDP (Chrome DevTools Protocol) + GStreamer. Esta e uma escolha mais complexa mas potencialmente mais performatica.

### 9.2 O que noVNC/VNC ofereceria

**Vantagens de uma abordagem VNC:**
- Implementacao significativamente mais simples: `Xvfb + VNC server + noVNC`
- Sem necessidade de STUN/TURN (sem NAT traversal)
- Input bidirecional integrado no mesmo canal
- Compressao TightPNG funciona muito bem para UI de browser

**Desvantagens:**
- Latencia limitada pelo modelo poll-before-push (sem Continuous Updates: max ~10-20 FPS em LAN)
- Sem audio nativo
- Framerate inferior ao WebRTC para conteudo de video
- Overhead do ciclo request-response em alta latencia

### 9.3 Benchmark comparativo estimado para remote browser

| Metrica | VNC/noVNC | WebRTC (atual) |
|---------|-----------|----------------|
| Latencia de input | 20-50ms (LAN) | 50-150ms |
| FPS UI tipica (LAN) | 15-25 FPS | 25-60 FPS |
| FPS video full-screen | 5-10 FPS | 25-60 FPS |
| Complexidade de setup | Baixa | Alta |
| Bandwidth UI tipica | Baixo (delta encoding) | Medio-alto |
| Audio | Nao | Sim |
| Acesso sem OS funcional | Sim | Nao (irrelevante aqui) |

### 9.4 Recomendacao

Para um remote browser cujo caso de uso principal e **controle interativo de navegador Chrome**, a hierarquia de abordagens e:

1. **CDP + MJPEG leve (solucao atual simplificada):** latencia de encoding minima, simples de implementar
2. **VNC + noVNC:** excelente para controle de desktop, simples, sem TURN, mas FPS limitado
3. **WebRTC + GStreamer (solucao atual):** melhor FPS e audio, mas complexidade maxima e latencia de encoding

Se o objetivo e simplificar sem sacrificar demais a experiencia, **VNC + noVNC** e uma escolha solida e testada em producao por milhares de deployments.

---

## 10. Referencias

- [noVNC — Projeto oficial](https://novnc.com/noVNC/)
- [novnc/noVNC — GitHub](https://github.com/novnc/noVNC)
- [RFC 6143 — The Remote Framebuffer Protocol](https://datatracker.ietf.org/doc/html/rfc6143)
- [rfbproto/rfbproto — Especificacao comunitaria RFB](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst)
- [RFB Protocol Wikipedia](https://en.wikipedia.org/wiki/RFB_protocol)
- [noVNC API Documentation](https://novnc.com/noVNC/docs/API.html)
- [RFB Protocol Implementation — DeepWiki noVNC](https://deepwiki.com/novnc/noVNC/2.2-rfb-protocol-implementation)
- [WebSocket Communication — DeepWiki noVNC](https://deepwiki.com/novnc/noVNC/5-websocket-communication)
- [novnc/websockify — GitHub](https://github.com/novnc/websockify)
- [websockify latency_results.txt](https://github.com/novnc/websockify/blob/master/docs/latency_results.txt)
- [QEMU RFB Keyboard Extension — Daniel Barboza](https://danielhb.github.io/article/2019/05/06/noVNC-QEMU-RFB.html)
- [Keyboard Input Handling — DeepWiki noVNC](https://deepwiki.com/trycua/noVNC/4.1-keyboard-input-handling)
- [Optimize for high latency connection — noVNC Issue #1261](https://github.com/novnc/noVNC/issues/1261)
- [TigerVNC: Development Latency](https://github.com/TigerVNC/tigervnc/wiki/Development:-Latency)
- [TurboVNC — Introduction](https://turbovnc.org/About/Introduction)
- [TurboVNC — H.264 Study](https://turbovnc.org/About/H264)
- [TightVNC Tight Encoder Comparison](https://www.tightvnc.com/archive/compare.html)
- [ZRLE and ZYWRLE support — noVNC PR #1283](https://github.com/novnc/noVNC/pull/1283/files)
- [Consider zlib encodings — noVNC Issue #25](https://github.com/novnc/noVNC/issues/25)
- [noVNC vs SPICE vs xterm.js — BigWriteHook](https://www.bigwritehook.co.uk/blog/general-knowledge-24/novnc-vs-spice-vs-xterm-js-which-remote-access-tool-wins-in-2025-9184)
- [VNC vs RDP — Fanyamin WebRTC Tutorial](https://www.fanyamin.com/webrtc/tutorial/build/html/6.tool/vnc.html)
- [Latency Reduction in Remote Desktop Services — UMA Technology](https://umatechnology.org/latency-reduction-in-remote-desktop-services-compared-across-platforms/)
- [Hacker News: MJPEG vs RFB](https://news.ycombinator.com/item?id=31674403)
- [Selkies-GStreamer / webtop-rtc — GitHub](https://github.com/kronosun/webtop-rtc)
- [Apache Guacamole vs noVNC Discussion](https://sourceforge.net/p/guacamole/discussion/1110834/thread/00b95bb2/)
- [VNCDoTool RFB Protocol Documentation](https://vncdotool.readthedocs.io/en/0.8.0/rfbproto.html)
- [noVNC CloudStack Integration — ShapeBlue](https://www.shapeblue.com/cloudstack-feature-first-look-novnc-console-integration/)
