# WebRTC em Ambientes NAT/Docker sem IP Publico: ICE, TURN e Latencia

**Data:** 2026-03-17
**Contexto:** Projeto remote-browser usando `@roamhq/wrtc` em Node.js atras de NAT/Docker

---

## 1. Por Que o ICE Falha em Ambientes NAT/Docker

### O Problema Fundamental

WebRTC usa ICE (Interactive Connectivity Establishment) para descobrir o caminho de rede mais eficiente entre dois pares. O processo depende de cada par anunciar candidatos de rede validos — enderecos IP e portas pelos quais pode ser alcancado. O problema central em ambientes NAT/Docker e que os candidatos anunciados sao invalidos ou irrealcaveis do exterior.

### Tipos de Candidatos ICE

O ICE gera tres categorias de candidatos, em ordem de prioridade:

| Tipo | Fonte | Prioridade | Descricao |
|------|-------|-----------|-----------|
| **host** | Interface de rede local | Mais alta | IP privado da maquina (ex: `172.17.0.2`) |
| **srflx** (server reflexive) | Servidor STUN | Media | IP publico visto do exterior via NAT |
| **relay** | Servidor TURN | Mais baixa | IP do servidor TURN que repassara os dados |

Existe ainda o candidato **prflx** (peer reflexive), descoberto dinamicamente durante os connectivity checks.

### Por Que o Docker Torna Tudo Pior

Um container Docker opera em uma rede privada interna com dupla camada de NAT:

```
Browser do cliente
    ↕ (internet)
IP Publico do host (ex: 203.0.113.10)
    ↕ (NAT do host / iptables)
IP do host na rede docker (ex: 172.17.0.1)
    ↕ (NAT da bridge docker0)
IP do container (ex: 172.17.0.2)  ← onde roda o @roamhq/wrtc
```

Quando o `@roamhq/wrtc` gera candidatos ICE do tipo `host`, ele anuncia `172.17.0.2` — um endereco completamente inacessivel do exterior. O STUN pode resolver o IP publico do host (`203.0.113.10`), mas esse IP ja passou por NAT e, dependendo do tipo de NAT do roteador/provedor, pode nao ser suficiente.

### O Problema do Symmetric NAT

Existem quatro tipos de NAT, em ordem crescente de restritividade:

1. **Full Cone NAT**: Qualquer pacote externo para IP:porta mapeada e aceito
2. **Address-Restricted NAT**: So aceita pacotes do IP com quem ja comunicou
3. **Port-Restricted NAT**: Aceita apenas do IP:porta exato ja contactado
4. **Symmetric NAT**: Cria um mapeamento diferente para cada destino — impossibilita P2P

Em Symmetric NAT, um candidato `srflx` obtido via STUN nao funciona para comunicacao com outros pares porque o NAT aloca uma porta diferente para cada conexao de destino diferente. Isso e muito comum em:

- VPNs corporativas
- Redes de hoteis e aeroportos
- ISPs residenciais modernos com CGN (Carrier-Grade NAT)
- Provedores de cloud que fazem 1:1 NAT (sua VPS tem IP privado)

### Resumo dos Cenarios de Falha

```
Cenario                         | Candidato host | Candidato srflx | Resultado
--------------------------------|----------------|-----------------|----------
Docker sem IP publico no host   | Inutilizavel   | Inutilizavel    | FALHA TOTAL
VPS com 1:1 NAT (sem ext-ip)    | Inutilizavel   | Pode funcionar  | INSTAVEL
Cliente atras de Symmetric NAT  | N/A            | FALHA           | FALHA
Cliente em rede corporativa UDP | N/A            | Bloqueado        | FALHA
```

---

## 2. Como o TURN Resolve o Problema

### Mecanismo de Relay

Um servidor TURN (Traversal Using Relays around NAT) atua como intermediario de confiar para ambos os pares:

```
[Node.js / @roamhq/wrtc]  ←→  [Servidor TURN (IP publico)]  ←→  [Browser do cliente]
```

O fluxo completo com TURN:

1. O servidor Node.js abre uma **alocacao TURN** (TURN allocation) no servidor TURN, recebendo um IP:porta relay publico
2. Esse IP:porta relay e anunciado como candidato ICE do tipo `relay`
3. O browser do cliente tambem aloca no mesmo servidor TURN (ou usa candidatos relay proprios)
4. Todos os pacotes de midia trafegam pelo servidor TURN, que os repassa entre os pares

### Por Que o TURN Sempre Funciona

O servidor TURN e uma maquina com IP publico real e portas abertas. Ambos os pares fazem conexoes **de saida** para o servidor TURN — conexoes de saida atravessam qualquer NAT, inclusive Symmetric NAT. O TURN simplesmente repassa o que recebe de cada lado para o outro.

### ICE com TURN: Processo Completo

```
1. GATHERING (coleta de candidatos)
   - Node.js gera candidato host: 172.17.0.2:XXXX (inutilizavel externamente)
   - Node.js contacta STUN → gera candidato srflx: 203.0.113.10:YYYY (pode falhar)
   - Node.js aloca no TURN → gera candidato relay: turn.exemplo.com:ZZZZ
   - Browser faz o mesmo processo

2. SIGNALING (troca via servidor de sinalizacao)
   - Server envia SDP + lista de candidatos para o browser
   - Browser envia SDP + lista de candidatos para o server

3. CONNECTIVITY CHECKS (verificacao em ordem de prioridade)
   - Testa par host-host → falha (IPs privados)
   - Testa par srflx-srflx → pode falhar (Symmetric NAT)
   - Testa par relay-relay → SUCESSO (via TURN)

4. NOMINACAO
   - ICE nomeia o melhor par que passou nos checks
   - Se relay for o unico que funciona, e esse que e usado
   - Midia comeca a fluir pelo caminho escolhido
```

---

## 3. Estado Atual do Projeto

O arquivo `server/webrtc-manager.js` atual usa apenas STUN do Google:

```javascript
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
```

E o `frontend/src/hooks/useWebRTC.ts` no lado do cliente tambem usa apenas STUN:

```javascript
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
})
```

Isso e suficiente apenas se:
- O servidor esta em uma maquina com IP publico direto (sem NAT)
- O cliente nao esta atras de Symmetric NAT ou firewall restritivo

Em qualquer outro cenario — incluindo Docker em VPS com NAT 1:1, que e o caso mais comum em provedores como EasyPanel — a conexao vai falhar com o erro `ICE failed`.

O hook ja implementa fallback para MJPEG apos 5 segundos de timeout, o que confirma que o problema foi antecipado mas nao resolvido na raiz.

---

## 4. Opcoes de TURN Server

### 4.1 Coturn (Self-Hosted, Gratuito)

O coturn e o servidor TURN open-source mais utilizado, implementando os RFCs 5766 (TURN), 5389 (STUN), 6062 (TCP), 6156 (IPv6) e outros.

**Vantagens:**
- Totalmente gratuito, sem limites de banda
- Controle total sobre a configuracao
- Suporta UDP/TCP/TLS/DTLS
- Autenticacao por credenciais estaticas ou por segredo compartilhado (REST API)

**Pre-requisito:** Uma maquina com IP publico real e portas abertas (pode ser uma VPS pequena, $5/mes na DigitalOcean, Hetzner, etc.)

**Instalacao com Docker (modo host recomendado):**

```yaml
# docker-compose.coturn.yml
version: "3.9"
services:
  coturn:
    image: coturn/coturn:latest
    restart: unless-stopped
    network_mode: "host"   # essencial para TURN funcionar corretamente
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
```

**Configuracao minima (`turnserver.conf`):**

```ini
# Identidade
realm=turn.meudominio.com
server-name=turn.meudominio.com

# Rede
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0

# IP externo da maquina (obrigatorio se atras de NAT)
# Para VPS com IP publico direto, deixar apenas external-ip=IP_PUBLICO
# Para 1:1 NAT: external-ip=IP_PUBLICO/IP_PRIVADO
external-ip=203.0.113.10

# Faixa de portas para relay de midia
min-port=49152
max-port=65535

# Autenticacao por segredo compartilhado (compativel com credenciais temporarias)
use-auth-secret
static-auth-secret=GERE_COM_openssl_rand_hex_32

# TLS (recomendado para clientes em redes restritivas)
cert=/etc/letsencrypt/live/turn.meudominio.com/cert.pem
pkey=/etc/letsencrypt/live/turn.meudominio.com/privkey.pem

# Logs
log-file=stdout
verbose

# Seguranca
no-multicast-peers
no-cli
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

**Por que `network_mode: host`?** O TURN aloca portas dinamicas para cada alocacao de relay. Publicar um range de 16383 portas UDP no Docker (`49152-65535:49152-65535/udp`) causa overhead enorme de regras iptables e pode travar o Docker. Com `network_mode: host`, as portas sao expostas diretamente sem overhead.

**Firewall (UFW/iptables) na maquina coturn:**

```bash
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/udp
ufw allow 5349/tcp
ufw allow 49152:65535/udp
```

### 4.2 Metered.ca / Open Relay Project (Gratuito Gerenciado)

O Open Relay Project (operado pela Metered.ca) oferece TURN gratuito sem necessidade de infraestrutura propria:

- **URL:** https://www.metered.ca/tools/openrelay/
- **Limite:** 20 GB/mes de dados relay
- **Regioes:** Global (edge routing)
- **Latencia:** <30ms em 31+ regioes

**Configuracao para usar Open Relay:**

```javascript
const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: 'METERED_USERNAME',
    credential: 'METERED_CREDENTIAL',
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: 'METERED_USERNAME',
    credential: 'METERED_CREDENTIAL',
  },
  {
    urls: 'turns:global.relay.metered.ca:443',
    username: 'METERED_USERNAME',
    credential: 'METERED_CREDENTIAL',
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: 'METERED_USERNAME',
    credential: 'METERED_CREDENTIAL',
  },
];
```

**Obtencao de credenciais:** Registro gratuito em https://dashboard.metered.ca (sem cartao de credito para o free tier).

### 4.3 Xirsys (Gratuito com Limites)

- **Free tier:** ~5 GB/mes (limite rigido, sem upgrade automatico)
- **Paid:** $9.99/mes para 25 GB
- **API REST** para gerar credenciais temporarias
- **11 regioes:** US, UK, Alemanha, Holanda, Canada, Brasil, Hong Kong, etc.

Xirsys tem uma API para gerar credenciais ICE dinamicamente:

```javascript
const res = await fetch('https://global.xirsys.net/_turn/MEU_CANAL', {
  method: 'PUT',
  headers: {
    'Authorization': 'Basic ' + btoa('USUARIO:SEGREDO'),
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ format: 'urls' }),
});
const { v: iceServers } = await res.json();
// iceServers ja vem no formato correto para RTCPeerConnection
```

### 4.4 Comparativo dos Servicos Gratuitos

| Servico | Free Tier | Regions | Latencia | Limitacoes |
|---------|-----------|---------|---------|------------|
| Coturn self-hosted | Ilimitado | Onde voce hospedar | Depende da localizacao | Requer VPS extra |
| Open Relay (Metered) | 20 GB/mes | 31+ regioes | <30ms | 20 GB pode ser pouco para producao |
| Metered.ca pago | 500 MB/mes | 31+ regioes | <30ms | Precisa de upgrade para mais banda |
| Xirsys free | ~5 GB/mes | 11 paises | Bom | Hard cap, sem fallback |

**Recomendacao para este projeto:**
- **Desenvolvimento/testes:** Open Relay (Metered) — zero configuracao, 20 GB gratis
- **Producao leve:** Coturn em uma VPS Hetzner (€4/mes) — sem limites, controle total
- **Producao escalavel:** Metered.ca pago + coturn proprio como backup

---

## 5. Configuracao do @roamhq/wrtc com TURN

### Configuracao do Servidor Node.js

No `server/webrtc-manager.js`, a configuracao de ICE servers precisa incluir o TURN:

```javascript
// Usando coturn proprio
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:turn.meudominio.com:3478' },
  {
    urls: 'turn:turn.meudominio.com:3478',
    username: 'gerado_pelo_turn',
    credential: 'credencial_temporaria',
  },
  {
    urls: 'turn:turn.meudominio.com:3478?transport=tcp',
    username: 'gerado_pelo_turn',
    credential: 'credencial_temporaria',
  },
  {
    urls: 'turns:turn.meudominio.com:5349',
    username: 'gerado_pelo_turn',
    credential: 'credencial_temporaria',
  },
];
```

### Geracao de Credenciais Temporarias (Seguranca)

Nao use usuario/senha fixos. O coturn suporta o mecanismo `use-auth-secret` que permite gerar credenciais temporarias com TTL:

```javascript
const crypto = require('crypto');

function generateTurnCredentials(secret, ttlSeconds = 3600) {
  // username = timestamp de expiracao
  const timestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = String(timestamp);

  // credential = HMAC-SHA1 do username com o segredo
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');

  return { username, credential };
}

// Uso:
const { username, credential } = generateTurnCredentials(process.env.TURN_SECRET);
const ICE_SERVERS = [
  {
    urls: `turn:${process.env.TURN_HOST}:3478`,
    username,
    credential,
  },
];
```

### Problema Conhecido com @roamhq/wrtc e Candidatos SRFLX

Ha um issue documentado no repositorio `node-webrtc` onde o modulo nao gera candidatos `srflx` (server reflexive) mesmo quando um servidor STUN e configurado. Isso significa que no lado do servidor Node.js, os unicos candidatos validos podem ser:

- `host` (IP do container, inutilizavel externamente)
- `relay` (via TURN, se configurado)

Isso reforca a necessidade de TURN para qualquer deploy em container — o STUN sozinho nao e suficiente.

### Tanto Servidor Quanto Cliente Precisam de TURN

Um erro comum e configurar TURN apenas no servidor. Ambos os lados precisam de TURN se qualquer um deles estiver atras de NAT restritivo:

```typescript
// frontend/src/hooks/useWebRTC.ts — o cliente tambem precisa de TURN
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.meudominio.com:3478',
      username: credenciais.username,
      credential: credenciais.credential,
    },
  ],
});
```

A pratica recomendada e que o servidor de sinalizacao (o backend Express) exponha um endpoint para o cliente obter credenciais TURN temporarias antes de iniciar a conexao:

```
GET /api/webrtc/ice-servers
→ { iceServers: [...] }  // com credenciais temporarias geradas no momento
```

---

## 6. Latencia Real com TURN vs Sem TURN

### Numeros Consolidados

| Caminho | Latencia Adicional | Quando Ocorre |
|---------|-------------------|---------------|
| P2P direto (host candidates) | 0 ms | Mesma rede local |
| P2P via NAT (srflx candidates) | 0-10 ms | NAT simples, mesmo datacenter |
| Relay via TURN (relay candidates) | +50 a +150 ms por direcao | Symmetric NAT, firewall restritivo |
| Round-trip com TURN | +100 a +300 ms total | Depende da distancia ao servidor TURN |

### Impacto no Remote Browser

Para o caso de uso de remote browser (streaming de tela), a latencia tem impacto diretamente na responsividade:

```
Sem TURN (falha total)   → Cai para MJPEG fallback → ~500ms de latencia
Com TURN (relay)         → WebRTC relay → ~100-300ms de latencia
Com TURN proximo ao user → WebRTC relay → ~50-100ms de latencia
P2P direto               → WebRTC P2P → ~20-50ms de latencia
```

O TURN e sempre melhor que o fallback MJPEG, mesmo com a latencia adicional de relay.

### Fatores que Afetam a Latencia com TURN

1. **Distancia geografica ao servidor TURN:** O maior fator. Um servidor TURN em Frankfurt para um usuario no Brasil adiciona ~180ms so pelo RTT geografico.

2. **UDP vs TCP:** TURN sobre UDP e mais rapido. TURNS sobre TCP/TLS adiciona latencia pela natureza do TCP (retransmissoes, sem priorizacao de pacotes recentes).

3. **Banda disponivel no servidor TURN:** TURN repassa TODA a midia. A banda do servidor TURN e o gargalo.

4. **Numero de hops de rede:** Quanto mais rotas entre os pares, maior a latencia.

### Taxa Real de Uso de TURN em Producao

Dados de telemetria de servicos WebRTC em producao:

- ~75-85% das sessoes conseguem conexao P2P direta (sem TURN)
- ~15-25% das sessoes necessitam de TURN relay
- Em ambientes corporativos/escolares: esse numero pode chegar a 40-50%

Para o remote browser, onde o servidor e um container Docker atras de NAT (sem IP publico direto), a taxa de necessidade de TURN e provavelmente maior — pois o proprio servidor nunca consegue candidatos host ou srflx validos.

---

## 7. Diagnostico e Debug

### Verificar Candidatos ICE Gerados

No lado do servidor, adicionar log de candidatos ajuda a diagnosticar:

```javascript
pc.onicecandidate = (e) => {
  if (e.candidate) {
    console.log('[ICE] Candidato gerado:', {
      type: e.candidate.type,       // host | srflx | relay
      protocol: e.candidate.protocol, // udp | tcp
      address: e.candidate.address,
      port: e.candidate.port,
    });
    iceCandidates.push(e.candidate.toJSON());
  } else {
    console.log('[ICE] Gathering completo. Total:', iceCandidates.length);
  }
};
```

Se voce ver apenas candidatos do tipo `host` com IPs `172.x.x.x` (IPs Docker), isso confirma que o STUN nao esta funcionando e o TURN e obrigatorio.

### Testar o Servidor TURN

Usando a ferramenta Trickle ICE (https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):

1. Adicionar o servidor TURN com usuario/credencial
2. Clicar em "Gather candidates"
3. Verificar se aparecem candidatos do tipo `relay`

Pela linha de comando com `turnutils_uclient` (incluso no pacote coturn):

```bash
# Instalar coturn (so para usar as ferramentas de teste)
apt-get install coturn

# Testar STUN
turnutils_stunclient turn.meudominio.com

# Testar TURN (requer credenciais)
turnutils_uclient -u usuario -w senha turn.meudominio.com
```

### Estado ICE e Diagnostico pelo Browser

No Chrome, acessar `chrome://webrtc-internals/` para ver:
- Candidatos gerados e recebidos
- Estado de cada par de candidatos
- Qual par foi nominado (host/srflx/relay)
- Estatisticas de pacotes perdidos, RTT

---

## 8. Plano de Implementacao para o Remote Browser

### Fase 1: TURN via Open Relay (sem infraestrutura adicional)

Mais rapido de implementar. Usar o Open Relay Project da Metered.ca:

1. Criar conta em https://dashboard.metered.ca
2. Obter credenciais TURN
3. Atualizar `ICE_SERVERS` no `server/webrtc-manager.js` e em `useWebRTC.ts`
4. Adicionar endpoint `/api/webrtc/ice-servers` para expor credenciais ao frontend

### Fase 2: Coturn Proprio (producao)

Para remover dependencia de terceiros e sem limites de banda:

1. Provisionar VPS pequena com IP publico (Hetzner CX11: €4/mes, suficiente para dezenas de sessoes simultaneas)
2. Criar `docker-compose.coturn.yml` com `network_mode: host`
3. Configurar dominio `turn.meudominio.com` apontando para a VPS
4. Instalar certificado SSL via Let's Encrypt
5. Configurar `use-auth-secret` com um segredo forte
6. Adicionar geracao de credenciais temporarias no backend
7. Configurar monitoramento (coturn tem endpoint REST para estatisticas)

### Consideracoes de Custo de Banda

O TURN relay repassa toda a midia. Para o remote browser:

- Resolucao 1280x720 @ 30fps com VP8: ~500 Kbps a 2 Mbps por sessao
- 10 sessoes simultaneas: ~5 a 20 Mbps de banda no servidor TURN
- 1 TB de banda tipica de VPS da Hetzner cobre: ~500 GB de video relay (eficiencia ~50% por overhead do protocolo)

Uma VPS Hetzner CX11 com 20 TB de banda por mes cobre aproximadamente 1000-2000 horas de sessao relay — mais do que suficiente para uso interno ou pequena escala.

---

## 9. Referencias

- [WebRTC ICE candidates — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols)
- [GetStream — ICE Candidates Tutorial](https://getstream.io/resources/projects/webrtc/basics/ice-candidates/)
- [ICE in WebRTC: Server Setup and Relative Performance — WebRTC.ventures](https://webrtc.ventures/2022/04/ice-in-webrtc/)
- [STUN, TURN and ICE Servers — DEV Community](https://dev.to/sayem_omer/stun-turn-and-ice-servers-nat-traversal-for-webrtc-5e29)
- [Use of TURN in WebRTC Revisited — Medium/L7mp Technologies](https://medium.com/l7mp-technologies/use-of-turn-in-webrtc-revisited-it-may-be-more-useful-than-you-thought-856059fd27a3)
- [How to Use TURN Server with Node WebRTC Library — DEV Community](https://dev.to/alakkadshaw/how-to-use-turn-server-with-nodejs-webrtc-library-2b4g)
- [coturn GitHub Repository](https://github.com/coturn/coturn)
- [coturn no Docker Hub](https://hub.docker.com/r/coturn/coturn)
- [Metered.ca: Running coturn in Docker](https://www.metered.ca/blog/running-coturn-in-docker-a-step-by-step-guide/)
- [Turnix.io: Coturn + Docker Practical Guide](https://turnix.io/guides/setup-coturn-server)
- [GabrielTanner: How to set up your own TURN server](https://gabrieltanner.org/blog/turn-server/)
- [Metered.ca TURN Pricing](https://www.metered.ca/pricing)
- [Xirsys TURN Pricing](https://xirsys.com/pricing/)
- [Open Relay Project — Free WebRTC TURN Server](https://www.metered.ca/tools/openrelay/)
- [List of WebRTC ICE Servers — Metered.ca](https://www.metered.ca/blog/list-of-webrtc-ice-servers/)
- [WebRTC NAT Traversal Methods — LiveSwitch](https://www.liveswitch.io/blog/webrtc-nat-traversal-methods-a-case-for-embedded-turn)
- [Troubleshooting WebRTC Connection Issues — AddPipe](https://blog.addpipe.com/troubleshooting-webrtc-connection-issues/)
- [TURN Server Costs: A Complete Guide — DEV Community](https://dev.to/alakkadshaw/turn-server-costs-a-complete-guide-1c4b)
- [WebRTC Latency Comparison — Nanocosmos](https://www.nanocosmos.net/blog/webrtc-latency/)
- [node-webrtc Issue: Not getting srflx candidates with iceServers](https://github.com/node-webrtc/node-webrtc/issues/293)
