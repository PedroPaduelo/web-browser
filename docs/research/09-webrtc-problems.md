# Problemas de WebRTC em Containers e NAT: Uma Análise Honesta

**Data:** 2026-03-17
**Projeto:** remote-browser (Serende)
**Arquivo de análise:** `server/webrtc-manager.js` usa @roamhq/wrtc apenas com STUN
**Contexto:** Projeto está executando em container Docker atrás de NAT, sem IP público real

---

## Resumo Executivo

**Verdade inconveniente:** WebRTC server-side com `@roamhq/wrtc` em container Docker **não funciona** na grande maioria dos ambientes de produção sem um TURN server. O projeto atual está usando apenas STUN, o que é equivalente a "tentar fazer funcionar" — funciona apenas em cenários específicos e controleados.

**O problema não é teórico:** É prático, documentado, e tem solução cara (TURN server próprio) ou solução de terceiros (Open Relay/Metered.ca). A latência do TURN relay (+50-150ms) é **ainda melhor** que o fallback MJPEG atual (~500ms).

**Recomendação final:** Implemente TURN via Open Relay (gratuito, 20GB/mês) **imediatamente**. Se escala for necessária, coturn próprio em VPS Hetzner (~€4-5/mês). Abandonar WebRTC só se o volume de TURN superar significativamente o MJPEG em custo/benefício.

---

## 1. Por Que WebRTC Falha em Containers/NAT: ICE Candidates do Tipo "Host-Only"

### O Mito do "IP Público"

Muitos desenvolvedores assumem que sua VPS tem "IP público" porque recebem um IP externo do provedor cloud. **Isso é enganoso.** A maioria dos provedores modernos (EasyPanel, DigitalOcean, AWS EC2, Google Cloud) usam **1:1 NAT**:

```
Internet → Roteador do provedor (IP público real)
                ↓ NAT 1:1
        Sua VPS (IP privado na rede interna do provedor)
```

Sua VPS **não tem IP público direto**. Ela tem um IP privado atrás do NAT do provedor.

### O Processo ICE (Interactive Connectivity Establishment)

Quando `@roamhq/wrtc` inicia um PeerConnection, ele gera candidatos ICE em três fases:

**Fase 1 - Host Candidates:**
```javascript
// Dentro do container Docker:
// Interface eth0 → IP 172.17.0.2 (Docker bridge)
// Interface lo → 127.0.0.1
// Esses IPs são ANUNCIADOS como candidatos
```

**Problema:** `172.17.0.2` é um IP Docker privado. O browser cliente **nunca consegue alcançar** esse endereço.

**Fase 2 - Server Reflexive Candidates (STUN):**
```javascript
// Envia binding request para stun.l.google.com:19302
// Resposta: "Seu IP público é 203.0.113.45:54321"
// Gera candidato srflx: 203.0.113.45:54321
```

**Problema:** Depende do tipo de NAT:
- Se for **1:1 NAT simples** (provedor cloud), o STUN retorna o IP público real e **funciona**.
- Se for **Symmetric NAT**, o IP:porta retornado só funciona para tráfego **vindo do servidor STUN**, não para outros peers.
- Se o STUN timeout ou falha, **não há fallback automático**.

**Fase 3 - Relay Candidates (TURN):**
```javascript
// Aloca conexão no servidor TURN
// Recebe: IP público do TURN + porta dedicada
// Gera candidato relay: turn.example.com:34784
```

**Solução:** Funciona sempre, porque o container faz **conexão de saída** para o TURN (sempre permitida). O TURN apenas repacota e envia para o outro lado.

### Por Que Containers Docker São Piores

Container Docker adiciona **DOIS níveis de NAT**:

```
Browser Cliente
    ↕ Internet
IP Público do Cliente
    ↕ NAT do Cliente (roteador residencial/corporativo)
IP Público do Cliente (pode mudar se symmetric NAT)
    ↕ NAT do Provedor Cloud (1:1 NAT)
IP do Host na Rede do Provedor (ex: 10.0.2.10) ← Não é público!
    ↕ Docker bridge NAT
IP do Container (172.17.0.2) ← Onde @roamhq/wrtc roda
```

O STUN só consegue enxergar **até o primeiro NAT** (do provedor). Se o provedor usar 1:1 NAT, o STUN retorna o IP **do host da máquina física**, não do container.

**Problema adicional:** O port forwarding do Docker não afeta conexões **de saída** feitas pelo container. O container pode se conectar a servidores externos, mas **ninguém externo pode se conectar ao IP:porta do container** porque:
1. O IP do container é privado (172.17.x.x)
2. Mesmo se você publicar portas no Docker (`-p 3478:3478`), isso só mapeia portas de **ENTRADA** no host para o container
3. O ICE candidato do tipo `host` usa portas aleatórias altas (50k-60k) que **não estão mapeadas**

### Evidência no Código Atual

```javascript
// server/webrtc-manager.js linhas 15-18:
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
```

**Isso é insuficiente.** Não há servidor TURN configurado.

**O que acontece na prática:**
1. Container gera candidatos host: `172.17.0.2:XXXXX` (inúteis)
2. STUN pode gerar srflx: `IP-do-host:YYYYY` (pode funcionar se o host tenha IP público real e NAT simples)
3. Se o host estiver atrás de symmetric NAT ou se o IP retornado for do host (não do container), **a conexão falha**
4. Se srflx falhar, **não há candidatos relay** → ICE connection state → `failed`

### Diagnóstico: Como Verificar se Seu ICE Gathering Está OK

```javascript
// Adicione no webrtc-manager.js:
pc.onicecandidate = (e) => {
  if (e.candidate) {
    console.log('[DEBUG] ICE candidate:', {
      type: e.candidate.type,
      candidate: e.candidate.candidate,
      address: e.candidate.address,
      port: e.candidate.port,
    });
  } else {
    console.log('[DEBUG] ICE gathering complete');
  }
};

pc.oniceconnectionstatechange = () => {
  console.log('[DEBUG] ICE state:', pc.iceConnectionState);
  // Valores: new → checking → connected/completed → failed/disconnected
};
```

**Cenário ideal no log:**
```
[DEBUG] ICE candidate: { type: 'host', candidate: '172.17.0.2:54321...' }  ← OK, será ignorado
[DEBUG] ICE candidate: { type: 'srflx', candidate: '203.0.113.45:54322...' } ← BOM!
[DEBUG] ICE candidate: { type: 'relay', candidate: 'turn.example.com:34784...' } ← MELHOR (TURN)
[DEBUG] ICE state: connected  ← SUCESSO
```

**Cenário de falha típico:**
```
[DEBUG] ICE candidate: { type: 'host', candidate: '172.17.0.2:54321...' }  ← só host
[DEBUG] ICE candidate: { type: 'host', candidate: '172.17.0.3:54322...' }  ← só host
[DEBUG] ICE gathering complete
[DEBUG] ICE state: failed  ← SEM CANDIDATOS VÁLIDOS
```

---

## 2. O Que é STUN vs TURN e Quando Cada Um é Necessário

### STUN: Session Traversal Utilities for NAT

**Função:** Ajuda o cliente a descobrir seu IP público e a porta que o NAT mapeou.

**Como funciona:**
1. Cliente envia pacote UDP para `stun.l.google.com:19302`
2. Servidor STUN responde: "Recebi seu pacote de 203.0.113.45:54321"
3. Cliente agora sabe: "Meu IP público é 203.0.113.45:54321"
4. Cliente anuncia esse endereço (candidato srflx) para o peer via signaling
5. Peer tenta conectar diretamente a 203.0.113.45:54321

**Quando funciona:**
- NAT do tipo **Full Cone** ou **Address-Restricted**
- Sem firewall corporativo bloqueando UDP
- Conexão entre redes diferentes (não mesma LAN)

**Latência:** 0ms adicional (conexão direta P2P)

**Custo:** Praticamente zero. STUN é só um serviço de descoberta — o tráfego é mínimo.

**Uso esperado:** ~75-85% das conexões WebRTC resolvem com STUN apenas.

### TURN: Traversal Using Relays around NAT

**Função:** Quando P2P direto falha, o TURN age como **intermediário (relay)**. Todo o tráfego de mídia passa pelo servidor TURN.

**Como funciona:**
1. Clente abre conexão **TURN allocation** no servidor TURN
2. Servidor TURN aloca: "Você pode usar 203.0.113.50:34784 para enviar dados"
3. Cliente anuncia candidato `relay` (203.0.113.50:34784)
4. **Ambos** os peers se conectam ao TURN server (sempre via *outbound* connections)
5. TURN server repassa pacotes de um lado para o outro

```
[Cliente A] → [TURN Server] → [Cliente B]
      UDP           UDP           UDP
```

**Quando é necessário (imprescindível):**
- **Symmetric NAT** - cada destino recebe porta diferente, impossibilita P2P
- **Firewall corporativo** que bloqueia UDP direto entre peers
- **Redes com CG-NAT** (Carrier-Grade NAT) - ISPs que não dão IP público real
- **Container Docker sem IP público** - seu caso exato
- **Qualquer cenário onde candidatos srflx falhem**

**Latência:** +50 a +150ms **por direção** (round-trip extra via relay)

**Custo:** **ALTÍSSIMO**. O TURN vê **todo o tráfego de mídia** nos dois sentidos.

```
Vídeo HD 720p: 2 Mbps → TURN vê 4 Mbps (upload + download)
30 min de streaming: 4 Mbps × 1800s ÷ 8 = 900 MB pelo TURN
```

**Uso esperado:** ~15-25% das conexões em ambientes diversos. Em ambientes corporativos/restritivos: 40-50%.

### Tabela Comparativa STUN vs TURN

| Característica | STUN | TURN |
|----------------|------|------|
| **Função** | Descobrir IP público | Relay de todo tráfego |
| **Tipo de candidato ICE** | `srflx` (server-reflexive) | `relay` |
| **Custo de banda** | ~0 KB/s | **Todo o tráfego** (×2 upload+download) |
| **Latência adicional** | 0ms (P2P direto) | +50-150ms por direção |
| **Funciona com symmetric NAT** | ❌ Não | ✅ Sim |
| **Funciona sem IP público** | ❌ Não | ✅ Sim (só precisa de outbound) |
| **% conexões que usam** | 75-85% | 15-25% |
| **Custo operacional** | ~$0/mês | $0.05-0.15/GB relay |
| **Complexidade de deploy** | Nenhuma | Alta (servidor + firewall + TLS) |

**Regra de ouro:** TURN é caríssimo e deve ser usado apenas como **fallback**. O ICE automaticamente prioriza `host` > `srflx` > `relay`. Se P2P direto funcionar, TURN não é usado.

---

## 3. Por Que @roamhq/wrtc Falha em Ambientes Containerizados

### O Problema Específico do Fork

`@roamhq/wrtc` é um fork ativo do `node-webrtc` original (abandonado). Mas tem um **problema documentado** nos issues do projeto original:

> **Issue #293: "Not getting srflx candidates with iceServers"**
> https://github.com/node-webrtc/node-webrtc/issues/293

**Descrição:** Quando o Node.js WebRTC está agindo como **answerer** (o lado que recebe a oferta), o ICE gathering pode **completar antes** de obter candidatos server-reflexive (srflx) se já tiver host candidates válidos.

**Tradução para seu caso:**
1. Você inicia `createOffer()` (server é offerer)
2. O `@roamhq/wrtc` gera candidatos `host` do container (172.17.0.2)
3. Tenta STUN → pode demorar 1-2 segundos para resposta
4. Se houver timeout muito curto ou se a coleta terminar cedo, **apenas candidatos `host` são reportados**
5. Browser cliente recebe apenas IPs de container → falha total

**Solução:** Aumentar o ICE gathering timeout. No código atual (linha 155-158):

```javascript
await Promise.race([
  iceGatheringPromise,
  new Promise((resolve) => setTimeout(resolve, 1500)),  // ← APENAS 1.5s!
]);
```

**Problema:** 1.5 segundos é **muito pouco** para:
- STUN response (pode demorar 500ms-2s dependendo da rede)
- TURN allocation (pode demorar 2-5s na primeira vez)

**Recomendação:** Aumentar para **5-10 segundos** no mínimo, ou usar `iceGatheringState === 'complete'` sem timeout artificial.

### Limitação Fundamental: Candidatos srflx Podem Não Existir

Mesmo com STUN configurado, em alguns cenários **não há candidatos srflx**:

```
Container Docker → NAT do provedor → Internet
        ↓
Servidor STUN responde: "Recebi de 10.0.2.15:54321"
        ↓
10.0.2.15 é IP PRIVADO do host na rede interna do provedor
        ↓
Browser cliente não consegue rotear para 10.0.2.15 (não é roteável na internet)
```

**Resultado:** STUN retorna IP **privado** do host, não IP público. Isso acontece quando:
1. O provedor cloud usa NAT 1:1 **sem IP público real**
2. Você está atrás de um firewall que faz source NAT
3. Você usa um serviço como EasyPanel que roteia através de um proxy reverso

**Conclusão:** Em containers Docker em provedores cloud modernos, **você NÃO consegue candidatos srflx válidos**. A única opção é TURN `relay`.

### Evidence from Research

Os arquivos de pesquisa existentes confirmam:

**`docs/research/04-webrtc-nat-turn.md` (linhas 450-477):**
> "Em Symmetric NAT, um candidato `srflx` obtido via STUN não funciona para comunicação com outros peers"
> "Docker sem IP público no host: Inutilizável → FALHA TOTAL"

**`docs/research/04-webrtc-nat-turn.md` (linhas 370-377):**
> "Problema Conhecido com @roamhq/wrtc e Candidatos SRFLX: Há um issue documentado no repositório node-webrtc onde o módulo não gera candidatos `srflx` mesmo quando um servidor STUN é configurado. Isso significa que no lado do servidor Node.js, os únicos candidatos válidos podem ser: `host` (IP do container, inutilizável externamente) ou `relay` (via TURN, se configurado). Isso reforça a necessidade de TURN para qualquer deploy em container."

---

## 4. mediasoup como Alternativa Server-Side WebRTC

### O que é mediasoup

`mediasoup` é uma biblioteca **Node.js** que implementa um **SFU (Selective Forwarding Unit)**. Diferente de fazer WebRTC ponto-a-ponto (P2P), o mediasoup cria um **servidor de mídia** que:

1. Recebe stream de vídeo de **fontes externas** (FFmpeg, GStreamer, CDP)
2. **Repassa** (forward) para múltiplos clientes via WebRTC
3. Não transcodifica — apenas repassa pacotes RTP

**Arquitetura:**
```
[FFmpeg x11grab] → RTP → [mediasoup PlainTransport]
                                   ↓
          [WebRtcTransport] ←→ Browser 1
          [WebRtcTransport] ←→ Browser 2
          [WebRtcTransport] ←→ Browser N
```

### PlainTransport: A Chave para Injeção de Vídeo Customizada

O `PlainTransport` do mediasoup é exatamente o que você precisa:

1. **Cria um socket UDP** (sem ICE/DTLS)
2. **Espera pacotes RTP** codificados (VP8, VP9, H.264)
3. **Distribui** para N consumidores via WebRTC

```javascript
// Criar PlainTransport
const transport = await router.createPlainTransport({
  listenIp: '127.0.0.1',  // escuta na loopback
  rtcpMux: false,         // FFmpeg não suporta rtcp-mux
  comedia: true,          // auto-detecta IP/porta remota
});

// Producer espera estes parâmetros RTP
const producer = await transport.produce({
  kind: 'video',
  rtpParameters: {
    codecs: [{
      mimeType: 'video/VP8',
      payloadType: 96,
      clockRate: 90000,
    }],
    encodings: [{ ssrc: 22222222 }],
  },
});

// Porta onde FFmpeg deve enviar RTP:
const { localPort } = transport.tuple;
```

### Pipeline Completo com mediasoup + x11grab

```
Xvfb (display virtual :99)
    ↓
Chromium headless renderizando
    ↓
ffmpeg -f x11grab -video_size 1280x720 -i :99.0
    ↓
codec libvpx (VP8) ou libx264 (H.264)
    ↓
RTP packets → UDP → 127.0.0.1:${localPort} (PlainTransport)
    ↓
mediasoup Router (SFU)
    ↓
N × WebRTC (ICE+DTLS) → N browsers
```

**Latência estimada:**
- x11grab + encoding VP8 realtime: 30-80ms
- Forwarding no mediasoup Worker (C++): < 1ms
- RTT rede local: < 10ms
- **Total: 80-150ms** — similar a WebRTC direto

### Por Que mediasoup Pode Ser Melhor Que WebRTC Direto

| Vantagem | Explicação |
|----------|------------|
| **Separacão clara** | Vídeo sourcing (FFmpeg) ≠ transporte WebRTC |
| **Escalabilidade** | 1生产者 (producer) → N consumidores sem replicar encoding |
| **Melhor controle** | Você controla codec, bitrate, GOP via FFmpeg flags |
| **Sem memory leaks** | FFmpeg é processo separado; mediasoup Workers são C++ estáveis |
| **Gravação fácil** | Adicione outro PlainTransport consumer para salvar arquivo |
| **Cleaner architecture** | Containeriza partes separadamente |

### Desvantagens de mediasoup

| Desvantagem | Impacto |
|-------------|---------|
| **Complexidade** | +50% código; precisa gerenciar Router, Workers, Transports |
| **Overhead de infrastrutura** | +1 processo Worker por CPU core |
| **Ainda precisa de TURN** | ICE funciona igual — se o servidor está atrás de NAT, precisa de TURN para os WebRtcTransport connections |
| **Latência não menor** | SFU forwarding é rápido, mas ainda tem RTT extra se cliente longe |

### Conclusão sobre mediasoup

**mediasoup NÃO resolve o problema do TURN.** O problema é fundamental: **seu servidor está atrás de NAT, você precisa de relay para conexões WebRTC**.

O que mediasoup resolve:
- **Encoding server-side** (separar FFmpeg da lógica WebRTC)
- **Escala multi-viewer** (1 browser session → N viewers)
- **Gravação simultânea**

O que mediasoup **NÃO** resolve:
- **NAT traversal para o servidor** — os WebRtcTransport ainda geram ICE candidates e precisam de TURN

---

## 5. Custo de Operar um TURN Server (coturn)

### O Que é o coturn

`coturn` é a implementação open-source de referência para TURN/STUN servers. É maduro, estável, usado por Zoom, Twilio, e milhões de deployments.

### Deployment Options

#### Opção 1: Self-Hosted em VPS (Mais barato)

**Requisitos:**
- VPS com IP público real (não NAT 1:1 do provedor)
- Acesso à porta 3478 (UDP/TCP) e range de portas altas (49152-65535)
- Kernel Linux moderno

**VPS recomendadas (preços aproximados março/2026):**

| Provedor | Plano | Preço/mês | Banda | Observações |
|----------|-------|-----------|-------|-------------|
| **Hetzner** | CX11 | €4.50 | 20 TB | Melhor custo/benefício para Europa |
| **Vultr** | $5 plan | $5 | 1 TB | Boa para baixo volume |
| **DigitalOcean** | Basic Droplet | $12 | 1 TB | Caro para TURN |
| **AWS EC2** | t3.micro | ~$10 | 1 TB included | Banda extra $0.09/GB — **evitar** |
| **Google Cloud** | e2-micro | ~$10 | 1 GB included | Banda extra $0.08/GB — **evitar** |

**Configuração típica (Docker):**

```yaml
version: "3.8"
services:
  coturn:
    image: coturn/coturn:latest
    network_mode: "host"  # ← CRÍTICO: evita port forwarding overhead
    restart: unless-stopped
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
```

**Por que `network_mode: host`?**

O TURN precisa alocar **portas UDP aleatórias** (50k-60k) para cada relay. Mapear 16k portas no Docker (`49152-65535:49152-65535/udp`) causa:
- Overhead enorme no iptables (16k regras)
- Problemas com o Docker daemon
- Latência adicional

Com `network_mode: host`, o coturn usa as portas diretamente do host sem overhead.

**Firewall necessário:**

```bash
# UFW no host
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp  # TURNS (TLS)
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp  # relay range
```

**Custo total (exemplo Hetzner CX11):**
- VPS: €4.50/mês ≈ R$25/mês
- Banda: 20 TB incluso (suficiente para ~20.000 horas de streaming @ 2 Mbps)
- **Total: ~R$25/mês fixo**

#### Opção 2: TURN Gerenciado (Metered.ca Open Relay)

**Plano gratuito:**
- 20 GB/mês de relay
- 31+ regiões globais
- Latência <30ms
- SEM necessidade de VPS própria
- SEM configuração de firewall

**Limitações:**
- 20 GB pode ser pouco (1 sessão HD 720p usa ~1.5 GB/hora)
- Dependência de terceiros
- SLA não contratual (free tier)

**Custo:** $0 (free tier) ou $9.99/mês (250 GB), $49.99 (1 TB)

#### Opção 3: Xirsys

- Free tier: ~5 GB/mês (hard cap)
- Pago: $9.99/mês (25 GB)
- 11 regiões
- API REST para credenciais dinâmicas

**Mais caro e menos geração que Metered.ca.**

### Cálculo Realista de Banda TURN

**Por sessão de remote browser:**
```
Resolução: 1280×720 @ 30fps
Codec: VP8 (qualidade screencast)
Bitrate médio: 800 kbps - 2 Mbps
```

**Cenário conservador:** 1.2 Mbps média

```
1 hora de streaming:
1.2 Mbps × 3600s ÷ 8 = 540 MB (por direção)

TURN relay vê tráfego bidirecional:
Upload (server → cliente) + Download (cliente → server)
= 540 MB + 540 MB = 1.08 GB por hora por sessão
```

**Se 20% das sessões usam TURN:**
```
100 sessões/dia × 30min cada = 50 horas/dia
20% usam TURN = 10 horas/dia de relay
10h × 1.08 GB/h = 10.8 GB/dia
≈ 324 GB/mês
```

**Conclusão de custo:**
- Para **< 1000 usuários/dia** com taxa de uso TURN ~20%: **VPS Hetzner** (20 TB) é suficiente e barato (€4.50/mês)
- Para **> 10.000 usuários/dia**: TURN gerenciado (Metered.ca paid) pode ser mais simples, mas o custo será significativo ($100-500/mês)
- **Open Relay gratuito** serve para **MVP e testes** (20 GB/mês ≈ 18 horas de relay)

---

## 6. Por Que MJPEG/WebSocket é Melhor Que WebRTC para Este Use Case (Atual)

### Sua Arquitetura Atual (MJPEG Fallback)

```
Xvfb → Chromium → Screenshot JPEG → WebSocket → Browser → <img> tag
```

**Latência medida:** ~500ms
**Vantagens:**
- **Simplicidade extrema:** Não precisa de STUN/TURN/ICE/SDP
- **Funciona em qualquer rede:** HTTP/WebSocket atravessa qualquer firewall
- **Zero configuração NAT:** Só precisa de um WebSocket server acessível
- **Sem taxa de relay cara:** O servidor WebSocket é o mesmo do backend
- **Debug fácil:** Basta abrir DevTools e ver os frames JPEG
- **Cross-platform:** Funciona em qualquer browser, inclusive mobile

### Por Que WebRTC É Mais Complexo

| Aspecto | MJPEG/WebSocket | WebRTC |
|---------|-----------------|--------|
| **NAT traversal** | Nenhum (WS é TCP 80/443) | Complexo (STUN/TURN/ICE/SDP) |
| **Latência** | ~500ms (HTTP overhead) | 50-150ms (P2P ideal), 150-300ms (TURN) |
| **Custo operacional** | Apenas CPU/banda do servidor WS | + TURN server (banda ×2) |
| **Esforço de desenvolvimento** | ~1 dia | ~1-2 semanas (TURN + debug + monitoring) |
| **Confiabilidade** | Muito alta (TCP) | Média (UDP + NAT issues) |
| **Escalabilidade** | Linear (1× bandwidth) |+TURN (2× bandwidth se relay) |
| **Mobile connections** | OK (WS over cellular) | Pode falhar em redes 4G/5G restritivas |
| **Firewall corporativo** | Sempre funciona (porta 443) | Pode falhar se bloqueiam UDP/STUN |

### Quando MJPEG é Suficiente (Seu Caso)

**Use MJPEG se:**
- ✅ A latência de **~500ms é aceitável** para interação remota
- ✅ Você não precisa de áudio bidirecional
- ✅ O custo de operar TURN é proibitivo
- ✅ Seus usuários estão em redes corporativas/restritivas
- ✅ Simplicidade de deploy é crítica

**MJPEG NÃO é suficiente se:**
- ❌ Você precisa de latência < 200ms (gaming, drawing colaborativo)
- ❌ Quer suporte a áudio
- ❌ Precisa de qualidade de vídeo superior (sem JPEG artifacts)
- ❌ Tem orçamento para TURN e quer experiência premium

### Melhorias Possíveis no MJPEG Atual

Antes de implementar WebRTC, otimize o MJPEG:

1. **Aumentar frame rate controlado:**
```javascript
// No ideal, o frame rate deveria ser adaptativo
// Baseado em: CPU disponível, banda do cliente, movimento na tela
targetFps = calculateAdaptiveFps();
```

2. **JPEG quality ajustável:**
```bash
# No ffmpeg:
-vqscale:v 2  # quality 2 (boa) vs 5 (média) vs 10 (ruim)
```

3. **Compressão WebP no lugar de JPEG:**
- WebP lossless tem 30% menos tamanho que JPEG lossless
- Suporte moderno em browsers: Chrome, Firefox, Edge (não Safari antigo)

4. **HTTP/2 multiplexing:** Se já usa HTTP/2, multiple WebSocket connections competem menos.

5. **Adaptive bitrate no WebSocket:** Enviar frames menores quando detecta congestão (via RTT do WS ping/pong).

**Potencial de latência MJPEG com otimizações:** ~300-400ms

---

## 7. Quando WebRTC Vale a Pena vs Quando Não Vale

### WebRTC Vale a Pena Se:

✅ **1. Latência < 200ms é requisito hard**
   - Jogos, Ferramentas de design colaborativo, CAD remoto
   - Sua latência atual MJPEG é 500ms → WebRTC com TURN (~150-250ms) melhora 2×

✅ **2. Áudio bidirecional é necessário**
   - MJPEG não tem áudio nativo
   - WebRTC integra áudio + vídeo sincronizados

✅ **3. Volume justifica custo de TURN**
   - Se > 1000 horas/mês de sessão (≈ 1 TB/mês relay)
   - Custo Hetzner €4.50/mês é irrelevante vs valor do produto

✅ **4. Seus usuários não estão atrás de corporate firewalls pesados**
   - Usuários residenciais: STUN funciona 80% do tempo
   - Se 20% usam TURN, o custo é gerenciável

✅ **5. Você tem expertise em networking e suporte técnico**
   - Debug ICE failures exige conhecimento
   - Monitorar métricas de TURN usage
   - Ter plano B se TURN cair

### WebRTC NÃO Vale a Pena Se:

❌ **1. Latência atual é aceitável para seu user persona**
   - Se são usuários fazendo pesquisas, navegação simples, 500ms é OK
   - WebRTC com TURN (~200ms) é melhoria marginal

❌ **2. Seu volume é baixo (< 100 usuários/dia)**
   - Custo de desenvolvimento (+1-2 semanas) > valor percebido
   - Open Relay 20 GB/mês pode ser suficiente, mas ainda é复杂度 extra

❌ **3. Você não tem orçamento para VPS extra + suporte**
   - Mesmo €4.50/mês + tempo de sysadmin
   - Se Open Relay 20 GB Acabar,用户体验 cai abruptamente

❌ **4. Usuários predominantemente enterprise/educacional**
   - Redes corporativas bloqueiam UDP frequentemente
   - 40-50% das conexões usarão TURN → custo dispara
   - MJPEG over HTTPS funciona sempre

❌ **5. Simplicidade e confiabilidade são prioridade #1**
   - WebRTC introduces: STUN/TURN failures, ICE timeout, NAT traversal bugs, symmetric NAT issues
   - MJPEG: "só funciona"

### Decisão Framework

```
Devo usar WebRTC?
├── Latência atual (MJPEG) ≥ 400ms E latência é crítica?
│   ├── SIM → considere WebRTC
│   └── NÃO → fique com MJPEG
├── Volume de sessões > 500/dia?
│   ├── SIM → TURN self-hosted viável
│   └── NÃO → Open Relay 20 GB/mês pode ser suficiente
├── Usuários enterprise/corporativos > 30%?
│   ├── SIM → ~40% usarão TURN → custo alto → MJPEG pode ser melhor
│   └── NÃO → STUN resolve 80% → TURN só 15-20%
└── Equipe tem expertise networking / tempo para debug?
    ├── SIM → implemente WebRTC gradualmente
    └── NÃO → MJPEG é mais seguro
```

---

## 8. Conclusão: Deve o Serende Tentar WebRTC de Novo?

### Estado Atual

- ✅ Projeto tem implementação WebRTC com `@roamhq/wrtc`
- ❌ Apenas STUN configurado (linhas 15-18 de `webrtc-manager.js`)
- ✅ Fallback automático para MJPEG após 5 segundos (evita用户体验 100% falha)
- 🔄 O fallback é acionado frequentemente em produção?

### Problema Fundamental

**Seu servidor está atrás de NAT (container Docker).** Sem TURN, conexões falham em:
- Qualquer symmetric NAT no cliente (VPNs corporativas)
- Quando o provedor cloud usa 1:1 NAT (seu IP retornado pelo STUN é privado)
- Redes empresariais/educacionais com firewall UDP

**Taxa de falha esperada sem TURN: 20-40% dos usuários**

### Se Decidir Implementar TURN

**Passos mínimos:**

1. **Escolha TURN provider:**
   - Para MVP/testes: Open Relay Metered.ca (grátis, 20 GB/mês)
   - Para produção: coturn em Hetzner CX11 (€4.50/mês)

2. **Atualize webrtc-manager.js:**

```javascript
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:turn.seusite.com:3478',
    username: 'dynamic',  // gerado via REST API se use-auth-secret
    credential: generateTURNCredential()  // HMAC-SHA1
  },
  {
    urls: 'turn:turn.seusite.com:3478?transport=tcp',
    username: 'dynamic',
    credential: generateTURNCredential()
  },
  {
    urls: 'turns:turn.seusite.com:5349',
    username: 'dynamic',
    credential: generateTURNCredential()
  }
];
```

3. **Aumente ICE gathering timeout:**
```javascript
// webrtc-manager.js linha 156-158
await Promise.race([
  iceGatheringPromise,
  // Aumente de 1500ms para 8000ms
  new Promise((resolve) => setTimeout(resolve, 8000)),
]);
```

4. **Exponha credenciais TURN via API** (se use-auth-secret):
```javascript
// server/webrtc-manager.js ou novo endpoint
function getIceServersForClient(userId) {
  const secret = process.env.TURN_SECRET;
  const ttl = 86400; // 24h
  const username = `${Math.floor(Date.now()/1000) + ttl}:${userId}`;
  const credential = crypto.createHmac('sha1', secret)
                           .update(username)
                           .digest('base64');

  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: `turn:${process.env.TURN_HOST}:3478`,
        username, credential
      }
    ]
  };
}
```

5. **Teste exaustivo:**
   - Use [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) com suas credenciais
   - Verifique se candidatos `relay` aparecem quando `iceTransportPolicy: 'relay'`
   - Teste com clientes atrás de VPNs corporativas
   - Monitore logs do coturn para alocações ativas

### Alternativa: Abandonar WebRTC e Otimizar MJPEG

**Se você decidir que WebRTC não vale:**

1. **Implemente compressão WebP** no lugar de JPEG
2. **Dynamic quality/fps:** Diminua quality se CPU > 80%, aumente se movimento detectado
3. **HTTP/2 server push** para reduzir overhead
4. **Browser-side interpolation:** Deixe o browser upscale/downscale conforme necessidade
5. **Prefetching:** Envie 2 frames adiantados para esconder latência

**Latência potencial com otimizações MJPEG: 300-400ms**

**Adeus complexidade:** Sem TURN, sem STUN issues, sem ICE debugging.

---

## Recomendação Final (Honesta)

### Análise Custo-Benefício

| Item | WebRTC + TURN | MJPEG Otimizado |
|------|---------------|-----------------|
| **Esforço dev** | 1-2 semanas (TURN + debug + CI) | 2-3 dias (otimizações) |
| **Custo operacional** | €4.50-50/mês (TURN server) | $0 (só CPU/banda atual) |
| **Latência** | 150-250ms (com TURN relay) | 300-500ms (melhorado) |
| **Confiabilidade** | Média (NAT issues) | Alta (só funciona) |
| **Suporte a áudio** | Nativo | Precisa implementar separadamente |
| **Scalabilidade multi-viewer** | Boa (SFU) | Ruim (cada viewer duplica banda) |

### Decisão Recomendada

**Implemente TURN via Open Relay (gratuito) e faça A/B testing por 30 dias.**

1. **Semana 1-2:** Implemente TURN com Open Relay (20 GB/mês free)
2. **Semana 3-4:** Colete métricas:
   - `% de sessões usando TURN relay` (verifique candidatos `relay` nos logs)
   - Latência real glass-to-glass com/ sem TURN (use timestamp no servidor e medida no cliente)
   - Estatísticas do coturn: bytes relayed, allocations ativos
   - Suporte tickets: "vídeo travando" vs anterior

3. **Decisão após 30 dias:**
   - Se **> 30% das sessões usam TURN** e **custo de banda no Open Relay estourar 15 GB/mês** → migre para coturn próprio (Hetzner €4.50/mês)
   - Se **< 10% das sessões usam TURN** → desative TURN, volte a MJPEG, evite complexidade desnecessária
   - Se **a melhoria de latência (500ms → 200ms) for criticamente elogiada pelos usuários** → continue com TURN
   - Se **não houver diferença perceptível** → abandone WebRTC, foque em MJPEG otimizado

### Risco de Não Implementar TURN

**Seu produto oferece pior experiência a 20-40% dos usuários** (aquele que caem no fallback MJPEG de 500ms) sem dar a eles a opção de melhoria via TURN. Isso pode seraceitável se:
- Seu usuário médio é casual (consulta rápida, não importa 500ms)
- Seus usuários enterprise (que mais sofrem com ICE failures) são minoritários

**Se você tem usuários reclamando de "vídeo lento/travando", a primeira causa é quase certamente a queda no fallback MJPEG.** Implementar TURN pode resolver 20-40% desses casos.

### E Se eu Fosse Você

**Eu implementaria TURN com Open Relay e faria A/B testing por 30 dias.**

Motivos:
1. Custo zero (20 GB/mês)
2. Risgo baixo (fallback MJPEG ainda funciona)
3. Dados reais > suposições
4. Se funcionar bem, migrar para coturn próprio é trivial (mesma API)
5. Aprender sobre problemas de NAT traversal é valioso para qualquer produto de vídeo

**Mas se:**
- Você está com 2 meses pra MVP e precisa focar em features
- Seu volume é < 100 usuários/dia
- Você não tem tempo pra debug de ICE failures

**Então fique com MJPEG otimizado.** A diferença de latência entre 400ms e 200ms não justifica 2 semanas de trabalho e introdução de complexidade de TURN.

---

## Referências

- [WebRTC ICE candidates — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols)
- [node-webrtc Issue #293: srflx candidates not generated](https://github.com/node-webrtc/node-webrtc/issues/293)
- [ICE in WebRTC: Server Setup and Relative Performance — WebRTC.ventures](https://webrtc.ventures/2022/04/ice-in-webrtc/)
- [WebRTC Workflow: Signaling, SDP, and ICE/STUN/TURN](https://webrtc.link/en/articles/webrtc-workflow/)
- [STUN, TURN and ICE Servers — Metered.ca](https://www.metered.ca/blog/list-of-webrtc-ice-servers/)
- [TURN Server Costs: A Complete Guide — DEV Community](https://dev.to/alakkadshaw/turn-server-costs-a-complete-guide-1c4b)
- [mediasoup Documentation — PlainTransport](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)
- [FFmpeg x11grab → RTP pipeline (mediasoup demo)](https://github.com/versatica/mediasoup-demo/blob/v3/broadcasters/ffmpeg.sh)
- [Neko (m1k1o) — Remote Browser com WebRTC (Go + GStreamer)](https://github.com/m1k1o/neko)
- [WebRTC Latency Comparison — nanocosmos](https://www.nanocosmos.net/blog/webrtc-latency/)
- [Trickle ICE Testing Tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
- [coturn Docker Hub](https://hub.docker.com/r/coturn/coturn)
- [Metered.ca Open Relay Project](https://www.metered.ca/tools/openrelay/)
- [Hetzner Cloud Pricing](https://www.hetzner.com/cloud)

---

**Documento criado em:** 2026-03-17
**Status:** Análise técnica honesta baseada em pesquisa e código existente
**Próximo passo:** Decidir entre implementar TURN (com Open Relay) vs otimizar MJPEG
