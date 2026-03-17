# Apache Guacamole - Arquitetura, Protocolo e Comparacao com MJPEG/WebRTC

## 1. Visao Geral

Apache Guacamole e um gateway de remote desktop HTML5 **clientless** -- nao requer plugins nem software no lado do cliente. O usuario acessa desktops remotos (VNC, RDP, SSH, Telnet, Kubernetes) inteiramente pelo browser.

O diferencial do Guacamole nao e simplesmente "VNC no browser". Ele implementa um **protocolo proprio** (o Guacamole Protocol) que funciona como uma camada de abstracao sobre qualquer protocolo de remote desktop. O browser nunca fala VNC ou RDP -- ele so entende Guacamole Protocol.

**Componentes principais:**

```
[Browser]  <--WebSocket/HTTP-->  [guacamole-client (Java/Tomcat)]
                                          |
                                   TCP port 4822
                                          |
                                     [guacd daemon (C)]
                                          |
                                   fork() per connection
                                          |
                              [Plugin RDP/VNC/SSH/Telnet]
                                          |
                                 [Remote Desktop Server]
```

---

## 2. Arquitetura do guacd Daemon

### 2.1 O que e guacd

guacd (Guacamole Daemon) e o coracao do sistema. E um daemon escrito em **C** que escuta conexoes TCP na porta 4822 (por padrao). Ele nao entende VNC, RDP ou SSH diretamente -- apenas entende o suficiente do Guacamole Protocol para determinar qual plugin de protocolo carregar.

### 2.2 Modelo de Processos: fork() per Connection

Quando uma nova conexao chega:

1. guacd aceita a conexao TCP do guacamole-client (Java webapp)
2. Realiza o handshake do Guacamole Protocol para descobrir qual protocolo usar
3. Gera um UUID unico para a conexao
4. Executa `fork()` para criar um **processo filho dedicado**
5. O mapeamento UUID -> processo filho e armazenado num **proc-map** em memoria
6. O processo filho carrega dinamicamente o plugin do protocolo (libguac-client-rdp, libguac-client-vnc, etc.)

Cada processo filho cria **duas threads**:
- **Input thread**: recebe instrucoes do cliente (mouse, teclado)
- **Output thread**: envia instrucoes de desenho para o cliente

### 2.3 libguac - A Biblioteca Core

Toda a comunicacao e abstraida pela **libguac**, uma biblioteca C compartilhada que implementa:

- Parsing e serialization do Guacamole Protocol
- Gerenciamento de streams, layers e buffers
- Abstracoes de `guac_client` (conexao com remote desktop) e `guac_user` (usuario individual)
- Carregamento dinamico de plugins de protocolo

### 2.4 Plugin Architecture

Plugins sao bibliotecas dinamicas (.so) que implementam a interface definida pela libguac:
- `libguac-client-rdp` -- protocolo RDP via FreeRDP
- `libguac-client-vnc` -- protocolo VNC via libvncclient
- `libguac-client-ssh` -- SSH terminal
- `libguac-client-telnet` -- Telnet terminal
- `libguac-client-kubernetes` -- Kubernetes pod exec

Cada plugin traduz entre o protocolo nativo e o Guacamole Protocol. E como escrever um "cliente nativo" do protocolo, exceto que renderiza para um display remoto (o browser) em vez de um display local.

---

## 3. O Guacamole Protocol

### 3.1 Nao e VNC, nao e RDP -- e um protocolo proprio

O Guacamole Protocol e um protocolo de **remote display rendering e event transport**. Ele implementa um **superset** dos protocolos de remote desktop existentes. Nem o browser nem a webapp Java precisam saber qual protocolo esta sendo usado por baixo.

### 3.2 Formato das Instrucoes

Cada instrucao e uma lista delimitada por virgula, terminada por ponto-e-virgula. Cada elemento tem um **prefixo de tamanho** decimal separado do valor por ponto:

```
TAMANHO.OPCODE,TAMANHO.ARG1,TAMANHO.ARG2,...;
```

Exemplo -- redimensionar o display para 1024x768:
```
4.size,1.0,4.1024,3.768;
```

Decodificado: opcode "size", layer "0" (default), largura "1024", altura "768".

**Por que esse formato e nao JSON/XML?**

- Pode ser **parseado enquanto e recebido** (streaming), sem esperar a mensagem completa
- Os prefixos de tamanho permitem ao parser **pular entre instrucoes** sem iterar por cada caractere
- Extremamente eficiente para parsing em JavaScript

### 3.3 Direcao das Instrucoes

| Direcao | Tipo | Exemplos |
|---------|------|----------|
| Cliente -> Servidor | Controle e eventos | `key`, `mouse`, `size`, `disconnect` |
| Servidor -> Cliente | Desenho e streams | `img`, `copy`, `rect`, `cfill`, `sync`, `cursor` |

### 3.4 Handshake

A conexao comeca com um handshake:

1. Cliente envia `select` com o protocolo desejado (ex: `6.select,3.vnc;`)
2. Servidor responde com `args` listando parametros aceitos
3. Cliente envia capacidades: `audio` (codecs), `video`, `image` (formatos suportados em ordem de preferencia), `size` (dimensoes do display), `timezone`, `name`
4. Cliente envia `connect` com valores dos parametros de conexao
5. Servidor responde `ready` com um connection ID unico -- fase interativa comeca

Para **entrar numa sessao existente** (multi-user), o cliente envia o connection ID no `select` em vez de um nome de protocolo.

### 3.5 Versioning do Protocolo

| Versao | Features |
|--------|----------|
| `VERSION_1_5_0` | Instrucao `msg`, instrucao `name` no handshake |
| `VERSION_1_3_0` | Instrucao `require` para parametros adicionais |
| `VERSION_1_1_0` | Negociacao de versao, ordem arbitraria no handshake, timezone |
| `VERSION_1_0_0` | Default/legacy, sem negociacao |

---

## 4. Sistema de Streaming de Tela

### 4.1 Layers e Buffers

Todo o desenho opera sobre **layers**, identificados por indice inteiro:

| Indice | Tipo | Descricao |
|--------|------|-----------|
| 0 | Default Layer | Sempre presente; redimensionar = redimensionar display inteiro |
| Positivo | Layer visivel | Criados automaticamente na primeira referencia |
| Negativo | Buffer (invisivel) | Para cache e operacoes de desenho off-screen |

Layers podem ser **aninhados e movidos** dentro de outros layers, com compositing acelerado por hardware no browser (via HTML5 Canvas).

### 4.2 Streaming de Imagem (instrucao `img`)

A instrucao `img` aloca um novo stream e associa com os metadados de uma atualizacao de imagem para um retangulo especifico em um layer. A imagem e enviada como **PNG, JPEG ou WebP** sobre o stream.

Fluxo:
1. `img` -- aloca stream, especifica layer, coordenadas e formato
2. `blob` -- envia chunks dos dados da imagem
3. `ack` -- confirmacao opcional pelo receptor
4. `end` -- sinaliza fim do stream

### 4.3 Encoding Adaptativo

O guacd **seleciona automaticamente** entre PNG, JPEG e WebP baseado em heuristicas:

| Formato | Quando usar | Caracteristicas |
|---------|-------------|-----------------|
| **PNG** | Areas estaticas, texto, UI | Lossless, suporta alpha, mais lento para comprimir |
| **JPEG** | Areas que mudam rapido, fotos, video | Lossy, rapido, menor tamanho |
| **WebP** | Melhor dos dois mundos | Suporta lossless e lossy, melhor compressao |

O sistema avalia:
- Velocidade de mudanca de cada regiao da tela
- Tipo de conteudo (texto vs. imagem vs. video)
- Formatos suportados pelo browser (negociados no handshake)
- Desempenho da rede

Existe um parametro `force-lossless` que desabilita compressao lossy -- util para trabalho com texto/codigo.

### 4.4 Otimizacao: Copy e Primitivas

Alem de enviar imagens, o protocolo tem:

- **`copy`**: copia retangulos entre layers/buffers -- essencial para scrolling, onde "a maioria do resultado e identico ao estado anterior"
- **Primitivas graficas** (arco, curva, retangulo, fill, stroke): operacoes tipo Cairo/HTML5 Canvas que gastam menos bandwidth que imagens equivalentes
- **Compositing (Channel Masks)**: operacoes Porter/Duff mapeadas diretamente para HTML5 Canvas compositing

**Trade-off importante**: uso excessivo de primitivas aumenta processamento no cliente, o que pode degradar performance em dispositivos moveis.

### 4.5 Nao e Framerate Fixo

Diferente do VNC tradicional (que e sincrono -- so envia updates quando o cliente pede), o Guacamole **envia updates otimisticamente conforme ocorrem**. Nao ha framerate fixo no protocolo -- o guacd envia o mais rapido possivel, e o cliente renderiza conforme recebe.

A instrucao `sync` marca timestamps para que o cliente saiba que todas as operacoes ate aquele ponto foram completadas.

A v1.6.0 introduziu metricas de performance:
- Taxa de frames consumidos pelo cliente (FPS)
- Tempo de renderizacao por frame (ms)
- O servidor ajusta dinamicamente baseado na capacidade do cliente

---

## 5. Transporte: WebSocket e HTTP Tunnel

### 5.1 WebSocket (modo primario)

O Guacamole Protocol e transportado sobre **WebSocket** por padrao. A conexao WebSocket e mantida aberta durante toda a sessao, e as instrucoes fluem bidirecionalmente.

WebSocket e suportado desde Tomcat 7.0.37+, Jetty 8+, e qualquer servlet container com JSR-356.

### 5.2 HTTP Tunnel (fallback)

Se WebSocket nao estiver disponivel, o Guacamole usa um tunnel HTTP baseado em `XMLHttpRequest`. Funciona como um **stream verdadeiro -- nao ha polling**:

- Uma requisicao HTTP inicial e feita pelo JavaScript
- A resposta e mantida aberta com dados fluindo continuamente
- Multiplas requisicoes curtas sao encadeadas para simular um stream continuo

O protocolo transportado e identico -- Guacamole Protocol puro.

---

## 6. Input Handling

### 6.1 Abstracoes JavaScript

A biblioteca `guacamole-common-js` fornece abstracoes cross-browser:

**Mouse (`Guacamole.Mouse`)**:
- Captura eventos nativos do browser (mousedown, mousemove, mouseup)
- Ignora eventos de mouse gerados por touch (para evitar duplicacao)
- Envia estado do mouse via `sendMouseState(mouseState)`
- Formato da instrucao: `5.mouse,X,Y,BUTTON_MASK;`

**Teclado (`Guacamole.Keyboard`)**:
- Traduz eventos de key/input/composition do browser para **X11 keysyms**
- Envia eventos keydown/keyup normalizados
- Formato da instrucao: `3.key,KEYSYM,PRESSED;`
- Para RDP: traduz keysyms para eventos de teclado RDP baseado no layout configurado
- Se a tecla nao existe no layout do servidor, envia como **Unicode event**

**Touch/Mobile (`Guacamole.Touch`)**:
- Suporta touchscreen nativamente
- "Text input mode": infere teclas pressionadas a partir do texto digitado (para teclados on-screen)
- Traduz touch para mouse quando necessario

### 6.2 Fluxo Completo de Input

```
Evento no Browser (keydown/mousemove)
    |
Guacamole.Keyboard / Guacamole.Mouse (normalizacao cross-browser)
    |
X11 Keysyms / Mouse State
    |
Guacamole Protocol Instructions
    |
WebSocket / HTTP Tunnel
    |
guacamole-client (Java) -- repassa para guacd
    |
guacd (C) -- entrega ao plugin do protocolo
    |
Plugin traduz para protocolo nativo (RDP input events via FreeRDP, VNC key events, etc.)
    |
Remote Desktop Server
```

### 6.3 Limitacoes de Input

- O browser e o SO podem interceptar atalhos antes que cheguem ao JavaScript
- Guacamole so pode capturar eventos que o browser permite propagar
- Eventos de teclado sao notoriamente inconsistentes entre browsers (motivo da camada de abstracao)

---

## 7. Multi-User e Sessoes Compartilhadas

### 7.1 Modelo de Compartilhamento

- **`guac_client`**: representa uma conexao com um desktop remoto -- persiste enquanto houver usuarios
- **`guac_user`**: representa um usuario individual conectado a um `guac_client`
- O primeiro usuario a conectar vira **owner** da sessao
- Usuarios adicionais podem entrar na mesma sessao

### 7.2 Sharing Profiles

O compartilhamento e governado por **sharing profiles**:
- Administradores criam sharing profiles para conexoes
- Usuarios com acesso geram **links de compartilhamento** temporarios
- Usuarios convidados podem ser **read-only** ou ter controle de input
- Nao precisam ter conta no Guacamole

### 7.3 Implicacoes de Seguranca

- O atributo "read-only" e setado pelo guacamole-client, e um usuario que entra na sessao pode potencialmente manipular esse bit
- Nao ha indicacao visual obvia de que outro usuario entrou na sessao (apenas um log)

---

## 8. Escalabilidade

### 8.1 Load Balancing Nativo

Guacamole tem **balancing groups** built-in:
- Um grupo de balanceamento age como uma conexao unica
- Distribui carga dinamicamente, escolhendo a conexao com menos usuarios ativos
- **Session affinity** opcional: garante que o usuario volte para a mesma conexao ao reconectar

### 8.2 Deploy em Kubernetes

Arquitetura tipica em K8s:
- **Deployment 1**: guacd (porta 4822)
- **Deployment 2**: guacamole-client (porta 8080)
- **Database**: PostgreSQL ou MySQL (para auth e gerenciamento de conexoes)
- **Ingress**: com TLS termination

Opcoes de deploy:
- Google Cloud GKE Reference Architecture (com IAP e Cloud SQL)
- guacamole-operator (Kubernetes Operator)
- Helm charts da comunidade

### 8.3 Limitacoes de Escala

- Cada conexao gera um `fork()` no guacd, consumindo um processo do sistema
- A compressao de imagem (PNG/JPEG/WebP) e **CPU-bound** no guacd
- Para cargas graficas pesadas, o guacd pode se tornar gargalo
- Nao ha suporte nativo para GPU acceleration no encoding

---

## 9. Latencia Real: Numeros

### 9.1 Overhead do Guacamole

Guacamole adiciona latencia significativa comparado a clientes nativos, principalmente por:

1. **Compressao de imagem**: PNG e o maior culpado. WebP lossless com compressao rapida melhora muito.
2. **Cadeia de proxying**: Browser -> Java webapp -> TCP -> guacd -> Plugin -> Desktop remoto
3. **Re-encoding**: o guacd precisa decodificar o protocolo nativo e re-encodar para Guacamole Protocol

### 9.2 Benchmarks Reais

| Cenario | Guacamole | Nativo |
|---------|-----------|--------|
| **Throughput de rede** | ~100+ Kbps constante | ~10 Kbps (RDP nativo) |
| **FPS com graficos pesados** | 1-2 FPS | 50+ FPS |
| **Tarefa de 40 min (nativo RDP)** | >2 horas via Guacamole | 40 min |
| **Desktop com charts/graficos** | Lag perceptivel | Fluido |
| **Desktop estatico (texto/admin)** | Aceitavel, pouco lag | Fluido |

### 9.3 Otimizacoes que Ajudam

- **WebP lossless rapido** em vez de PNG: melhora dramaticamente scrolling e movimentacao de janelas. CPU ~5x mais rapido que PNG, bandwidth ~2x maior.
- **Resolucao menor**: reduce significativamente a carga de compressao
- **Co-localizar guacd com o desktop**: minimizar latencia de rede entre guacd e o servidor remoto
- **RDP GFX Pipeline** (v1.6.0): extensao que acelera significativamente o display -- habilitada por padrao
- **Habilitar WebSocket**: historicamente o conselho mais comum para melhorar performance

---

## 10. Comparacao: Guacamole vs MJPEG vs WebRTC

### 10.1 Abordagem Fundamental

| Aspecto | Guacamole Protocol | MJPEG | WebRTC |
|---------|-------------------|-------|--------|
| **O que envia** | Instrucoes de desenho + retangulos de imagem | Frames JPEG completos sequenciais | Stream de video encodado (H.264/VP8/VP9) |
| **Transporte** | WebSocket ou HTTP Tunnel | HTTP multipart ou WebSocket | UDP (SRTP) com fallback TCP |
| **Inteligencia** | Server decide formato, tamanho, e regiao a atualizar | Nenhuma -- envia frame inteiro | Codec faz inter-frame compression |
| **Bidirecional** | Sim (input via mesmo canal) | Nao (precisa canal separado para input) | Sim (DataChannel para input) |
| **Estado** | Stateful (layers, buffers, compositing) | Stateless | Stateful (codec state) |

### 10.2 Latencia

| Metrica | Guacamole | MJPEG over HTTP | MJPEG over WebSocket | WebRTC |
|---------|-----------|----------------|---------------------|--------|
| **Latencia tipica** | 100-500ms+ | 60-120ms | ~50ms | 16-50ms |
| **Pior caso** | Segundos (graficos pesados) | Acumulo de frames | Controlavel via pull-model | Estavel (codec adapta) |
| **Adaptacao** | Muda formato por regiao | Nenhuma | Pull-based (cliente pede proximo frame) | Bitrate adaptativo automatico |

### 10.3 Bandwidth

| | Guacamole | MJPEG | WebRTC |
|---|-----------|-------|--------|
| **Idle screen** | ~0 (so envia mudancas) | Continua enviando frames | ~0 (inter-frame = nada) |
| **Tela com muito movimento** | Alto (muitos retangulos JPEG/WebP) | Muito alto (frames completos) | Eficiente (inter-frame compression H.264) |
| **Texto/scrolling** | Otimizado (copy instruction) | Ineficiente (frame completo) | Moderado (codec nao entende scroll) |

### 10.4 Qualidade de Imagem

| | Guacamole | MJPEG | WebRTC |
|---|-----------|-------|--------|
| **Texto** | Excelente (PNG lossless para areas estaticas) | Artefatos JPEG visiveis | Artefatos de video codec |
| **Video/animacao** | Ruim (1-2 FPS em casos pesados) | OK (depende do framerate) | Excelente (e literalmente video) |
| **Screenshots/UI** | Excelente (encoding adaptativo) | Mediocre | Bom (mas com artefatos de codec) |

### 10.5 Input

| | Guacamole | MJPEG | WebRTC |
|---|-----------|-------|--------|
| **Canal** | Mesmo WebSocket (bidirecional) | Precisa canal separado (ex: outro WebSocket) | DataChannel (P2P, baixa latencia) |
| **Normalizacao** | Completa (X11 keysyms, cross-browser) | Implementacao propria necessaria | Implementacao propria necessaria |
| **Mobile/Touch** | Suporte built-in, text input mode | Implementacao propria | Implementacao propria |

### 10.6 Escalabilidade

| | Guacamole | MJPEG | WebRTC |
|---|-----------|-------|--------|
| **CPU por sessao** | Alto (compressao por regiao) | Medio (JPEG encoding) | Alto (video encoding) + GPU possivel |
| **Multi-user na mesma sessao** | Nativo (sharing profiles) | Precisa implementar | Precisa implementar (SFU) |
| **K8s / containerizacao** | Maduro, reference architectures existem | Simples de containerizar | Complexo (TURN/STUN, UDP, NAT traversal) |

### 10.7 Vantagens e Desvantagens de Cada Abordagem

**Guacamole Protocol**:
- (+) Encoding adaptativo por regiao -- texto fica nítido, video fica lossy
- (+) Protocolo agnostico -- suporta RDP, VNC, SSH no mesmo gateway
- (+) Multi-user nativo com sharing profiles
- (+) Zero bandwidth quando tela idle
- (+) Maduro, enterprise-ready, autenticacao robusta
- (-) Latencia alta para conteudo dinamico (1-2 FPS em casos extremos)
- (-) CPU-bound no server (sem GPU acceleration para encoding)
- (-) Complexidade da cadeia de proxying adiciona overhead
- (-) Sem audio nativo com VNC

**MJPEG**:
- (+) Extremamente simples de implementar
- (+) Latencia baixa e previsivel (~50-120ms)
- (+) Funciona em qualquer browser sem JS especial
- (+) Sem estado complexo para gerenciar
- (-) Bandwidth enorme (frames completos sem inter-frame compression)
- (-) Sem canal de input integrado
- (-) Sem adaptacao -- pode acumular frame lag em redes lentas
- (-) Sem suporte a alpha/layers

**WebRTC**:
- (+) Menor latencia possivel (~16-50ms com UDP)
- (+) Inter-frame compression via codec de video (H.264/VP8/VP9)
- (+) GPU acceleration (NVENC, VAAPI, etc.)
- (+) Audio nativo (Opus codec)
- (+) Bitrate adaptativo automatico
- (+) DataChannel para input de baixa latencia
- (-) Complexidade alta (STUN/TURN, ICE, SDP, NAT traversal)
- (-) Sem inteligencia sobre o conteudo (codec nao sabe que e texto vs video)
- (-) Artefatos de codec em texto fino
- (-) P2P pode falhar em redes corporativas, precisa TURN server

---

## 11. Licoes para o Projeto Remote Browser

### 11.1 O que Copiar do Guacamole

1. **Encoding adaptativo**: a ideia de usar PNG/lossless para areas estaticas (texto, UI) e JPEG/lossy para areas que mudam rapido e brilhante. Poderiamos implementar algo similar sobre WebRTC -- usar um canal separado para "overlays" de texto com qualidade alta.

2. **Copy instruction para scrolling**: em vez de re-encodar a tela inteira quando o usuario faz scroll, detectar scrolling e enviar apenas o delta. Isso e algo que video codecs nao fazem bem.

3. **Layer system**: separar cursor, UI chrome, e conteudo da pagina em layers diferentes permite otimizar cada um independentemente.

### 11.2 O que Nao Copiar

1. **Cadeia de proxying longa**: Browser -> Java -> TCP -> C daemon -> Plugin. Para remote browser, o pipeline precisa ser o mais curto possivel.

2. **Compressao CPU-bound sem GPU**: Guacamole faz toda compressao em CPU, o que limita a 1-2 FPS em cenarios pesados. WebRTC com NVENC/VAAPI resolve isso.

3. **Protocolo proprietario sobre WebSocket**: WebSocket + imagens individuais nunca vai competir com UDP + video codec para baixa latencia.

### 11.3 Abordagem Hibrida Ideal

Para um remote browser moderno, a melhor abordagem combina:

| Camada | Tecnologia | Motivo |
|--------|-----------|--------|
| **Streaming de tela** | WebRTC (H.264/VP8) | Latencia minima, inter-frame compression, GPU acceleration |
| **Canal de input** | WebRTC DataChannel | Baixa latencia, P2P quando possivel |
| **Overlay de texto** | Canal separado com PNG/WebP lossless | Texto nitido sem artefatos de codec |
| **Fallback** | WebSocket + JPEG (estilo Guacamole simplificado) | Para ambientes onde WebRTC nao funciona |
| **Deteccao de scroll** | Logica server-side | Enviar offsets em vez de re-encodar tudo |

---

## 12. Fontes

- [Apache Guacamole - Implementation and Architecture (v1.6.0)](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
- [The Guacamole Protocol (v1.6.0)](https://guacamole.apache.org/doc/gug/guacamole-protocol.html)
- [Guacamole Protocol Reference (v1.6.0)](https://guacamole.apache.org/doc/gug/protocol-reference.html)
- [guacamole-common-js Reference](https://guacamole.apache.org/doc/gug/guacamole-common-js.html)
- [Configuring Guacamole (v1.6.0)](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)
- [Guacamole Display Statistics (v1.6.0)](https://guacamole.apache.org/doc/1.6.0/guacamole-common-js/Guacamole.Display.Statistics.html)
- [guacd Architecture - DeepWiki](https://deepwiki.com/apache/guacamole-server/2-architecture)
- [Core Client Library (libguac) - DeepWiki](https://deepwiki.com/apache/guacamole-server/2.2-core-client-library-(libguac))
- [Display and Input Systems - DeepWiki](https://deepwiki.com/apache/guacamole-client/3.1-display-and-input-systems)
- [Force fast WebP compression - PR #322](https://github.com/apache/guacamole-server/pull/322)
- [Guacamole on GKE - Google Cloud Architecture](https://cloud.google.com/architecture/deploy-guacamole-gke)
- [Guacamole Performance Discussion - SourceForge](https://sourceforge.net/p/guacamole/discussion/1110834/thread/037ff13f/)
- [Guacamole vs Game-like Environments - SourceForge](https://sourceforge.net/p/guacamole/discussion/1110834/thread/31ddbd8d/)
- [selkies-gstreamer (WebRTC Remote Desktop)](https://github.com/kronosun/webtop-rtc)
- [n.eko (WebRTC Virtual Browser)](https://github.com/m1k1o/neko)
