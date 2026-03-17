# Configuracao de TURN Server (coturn) para WebRTC

**Data:** 2026-03-17
**Escopo:** coturn, WebRTC NAT traversal, @roamhq/wrtc, metered.ca Open Relay

---

## 1. STUN vs TURN: Diferenca Fundamental

### STUN (Session Traversal Utilities for NAT)

O STUN permite que um cliente descubra seu IP publico e a porta mapeada pelo NAT. Funciona assim:

1. Cliente envia uma requisicao para o servidor STUN
2. Servidor responde com o IP/porta publico que ele ve
3. Cliente compartilha essa informacao com o peer remoto via sinalização
4. Os peers tentam se conectar diretamente

**Candidatos gerados:** `host` (rede local) e `srflx` (server-reflexive = IP publico via STUN)

**Custo de banda:** quase zero. Apenas pequenas mensagens de discovery.

**Quando falha:** NAT simetrico. Nesse tipo de NAT, cada destino diferente recebe um mapeamento diferente, entao o IP/porta que o STUN informa nao funciona para o peer real.

### TURN (Traversal Using Relays around NAT)

TURN e uma extensao do STUN. Quando conexao direta falha, o TURN age como relay: todo o trafego de midia passa pelo servidor TURN.

**Candidatos gerados:** `relay`

**Custo de banda:** altissimo. Toda a midia passa pelo servidor. Uma chamada de video HD consome 2-4 Mbps por participante. O servidor TURN ve o dobro (upload + download). Em 1 hora = 1,8-3,6 GB por chamada.

**Quando e necessario:** NAT simetrico, firewalls corporativos restritivos, redes que bloqueiam UDP.

### Tabela Comparativa

| Aspecto | STUN | TURN |
|---|---|---|
| Funcao | Descobre IP publico | Repassar (relay) todo o trafego |
| Tipo de candidato ICE | srflx | relay |
| Custo de banda | ~0 | Todo o trafego de midia |
| Latencia adicional | ~0 (conexao direta) | +100-300ms (roteamento extra) |
| % de conexoes que usam | ~80-86% resolvem com STUN | ~15-25% precisam de TURN |
| Custo de servidor | Praticamente gratis | $0.05-0.15/GB; $500-2000+/mes em escala |

**Regra de ouro:** STUN e free, TURN e caro. Use TURN apenas como fallback.

---

## 2. Como o ICE Funciona (Framework de Negociacao)

O protocolo ICE (Interactive Connectivity Establishment) orquestra tudo:

1. Cada peer coleta candidatos: host (IP local), srflx (via STUN), relay (via TURN)
2. Os candidatos sao trocados via sinalização (WebSocket, etc.)
3. ICE faz connectivity checks em pares de candidatos
4. Seleciona o melhor par que funciona: prefere host > srflx > relay

O TURN so e usado se nenhum candidato de menor custo funcionar.

---

## 3. Instalacao do coturn

### Via apt (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install coturn
```

Habilitar como servico:
```bash
# Editar /etc/default/coturn
TURNSERVER_ENABLED=1

sudo systemctl enable coturn
sudo systemctl start coturn
```

### Via Docker (recomendado para producao)

```bash
# Modo host (mais simples, sem mapeamento de porta individual)
docker run -d --network=host \
  -v /etc/turnserver.conf:/etc/coturn/turnserver.conf \
  coturn/coturn

# Ou com portas explicitas
docker run -d \
  -p 3478:3478 -p 3478:3478/udp \
  -p 5349:5349 -p 5349:5349/udp \
  -p 49152-65535:49152-65535/udp \
  -v /etc/turnserver.conf:/etc/coturn/turnserver.conf \
  coturn/coturn
```

**Nota:** O range UDP 49152-65535 para relay e muito grande para mapear via NAT em Docker. Prefira `--network=host` em producao, ou reduza o range (ex: 49152-49400).

### Via docker-compose (producao)

```yaml
version: '3.8'
services:
  coturn:
    image: coturn/coturn:latest
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    restart: unless-stopped
```

---

## 4. Configuracao Minima (/etc/turnserver.conf)

### Configuracao basica (lt-cred-mech — Long-Term Credentials)

```ini
# Rede
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=SEU_IP_PUBLICO

# Range de portas para relay
min-port=49152
max-port=49300

# Autenticacao
realm=seudominio.com
lt-cred-mech
fingerprint

# Usuario estatico (username:password)
user=webrtcuser:suasenha123

# TLS (opcional, recomendado para producao)
cert=/etc/letsencrypt/live/seudominio.com/fullchain.pem
pkey=/etc/letsencrypt/live/seudominio.com/privkey.pem

# Logging
log-file=/var/log/coturn/turnserver.log
verbose

# Seguranca
no-loopback-peers
no-multicast-peers
```

**Campos obrigatorios minimos:** `listening-port`, `lt-cred-mech`, `user`, `realm`, `fingerprint`.

### Configuracao com REST API / Credenciais Efemeras (use-auth-secret)

Para producao com muitos usuarios, o modelo de credenciais efemeras e superior:

```ini
listening-port=3478
external-ip=SEU_IP_PUBLICO
realm=seudominio.com
fingerprint

# Em vez de lt-cred-mech + user estatico, use:
use-auth-secret
static-auth-secret=SUA_CHAVE_SECRETA_COMPARTILHADA

min-port=49152
max-port=49400
no-loopback-peers
no-multicast-peers
```

**Como funciona:** O backend Node.js gera credenciais temporarias via HMAC-SHA1. As credenciais expiram apos um tempo (ex: 24h). Nao precisam ser armazenadas — sao computadas on-demand.

**Geracao das credenciais temporarias (Node.js):**

```javascript
const crypto = require('crypto');

function generateTurnCredentials(secret, ttlSeconds = 86400) {
  const unixTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${unixTimestamp}:webrtcuser`;
  const password = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');
  return { username, password };
}

// Uso:
const { username, password } = generateTurnCredentials('SUA_CHAVE_SECRETA');
// Retornar para o cliente via API
```

---

## 5. Portas do Firewall

Abrir no firewall/security group do cloud provider:

| Porta | Protocolo | Uso |
|---|---|---|
| 3478 | TCP + UDP | STUN/TURN principal |
| 5349 | TCP + UDP | TURN/STUNS (TLS) |
| 49152-49400 | UDP | Relay range (ajuste conforme min-port/max-port) |

```bash
# UFW (Ubuntu)
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:49400/udp
```

---

## 6. Diferenca entre Realm e Credentials

**Realm:** Identifica o dominio/espaco de autenticacao do TURN server. E incluido no calculo do hash MD5 da senha (para lt-cred-mech). Todos os usuarios de um realm compartilham o mesmo namespace.

- Cada realm pode ter suas proprias quotas e usuarios
- Se voce mudar o `realm`, precisara regenerar todas as chaves de usuario (turnadmin)
- Para setups simples, use seu dominio (ex: `example.com`)

**Credentials (lt-cred-mech):**
- `user=nome:senha` — senha em plaintext (menos seguro) ou chave gerada por `turnadmin`
- A chave gerada leva em conta username + realm + senha
- Nao mudam dinamicamente (estaticas)

**Credentials (use-auth-secret):**
- Nenhuma senha fixa por usuario
- Senha computada: `base64(hmac-sha1(username_com_timestamp, shared_secret))`
- Expiram apos o timestamp contido no username
- Mais seguras para producao com muitos usuarios

**Gerando chave com turnadmin (para lt-cred-mech):**
```bash
turnadmin -k -u webrtcuser -r seudominio.com -p suasenha
# Retorna: 0xbc807ee29df3c9ffa736523fb2c4e8ee
# Usar no turnserver.conf: user=webrtcuser:0xbc807ee29df3c9ffa736523fb2c4e8ee
```

---

## 7. Usando TURN com @roamhq/wrtc no Node.js

O `@roamhq/wrtc` e um fork mantido do pacote `wrtc` (WebRTC nativo para Node.js). A API e identica ao WebRTC do browser.

### Instalacao

```bash
npm install @roamhq/wrtc
```

### Configuracao basica com TURN

```javascript
const { RTCPeerConnection } = require('@roamhq/wrtc');

// Credenciais estaticas (lt-cred-mech)
const iceServers = [
  {
    urls: 'stun:stun.l.google.com:19302'
  },
  {
    urls: 'turn:seudominio.com:3478',
    username: 'webrtcuser',
    credential: 'suasenha123'
  },
  {
    // TURN sobre TCP (para contornar firewalls que bloqueiam UDP)
    urls: 'turn:seudominio.com:3478?transport=tcp',
    username: 'webrtcuser',
    credential: 'suasenha123'
  },
  {
    // TURNS (TLS) — para firewalls que exigem criptografia
    urls: 'turns:seudominio.com:5349',
    username: 'webrtcuser',
    credential: 'suasenha123'
  }
];

const pc = new RTCPeerConnection({
  iceServers,
  iceTransportPolicy: 'all' // ou 'relay' para forcar TURN sempre
});

pc.onicecandidate = (event) => {
  if (event.candidate) {
    console.log('ICE candidate:', event.candidate.type, event.candidate.candidate);
    // Tipo 'relay' = candidato TURN encontrado
  }
};
```

### Forcar uso exclusivo de TURN (debug/teste)

```javascript
const pc = new RTCPeerConnection({
  iceServers: [/* ... */],
  iceTransportPolicy: 'relay' // so aceita candidatos relay
});
```

### Com credenciais efemeras (use-auth-secret)

```javascript
const crypto = require('crypto');
const { RTCPeerConnection } = require('@roamhq/wrtc');

function getTurnConfig(secret) {
  const ttl = 86400; // 24 horas
  const unixTs = Math.floor(Date.now() / 1000) + ttl;
  const username = `${unixTs}:user`;
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');

  return {
    iceServers: [
      {
        urls: 'turn:seudominio.com:3478',
        username,
        credential
      }
    ]
  };
}

const pc = new RTCPeerConnection(getTurnConfig(process.env.TURN_SECRET));
```

### Campo `credential` vs `credentials`

Atencao: a spec WebRTC usa `credential` (singular). Alguns exemplos antigos usam `credentials` (plural). Com `@roamhq/wrtc`, use `credential` (singular).

```javascript
// CORRETO:
{ urls: '...', username: '...', credential: '...' }

// ERRADO (pode nao funcionar):
{ urls: '...', username: '...', credentials: '...' }
```

---

## 8. Como Testar se o TURN Esta Funcionando

### Metodo 1: Trickle ICE (browser)

Acesse: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

1. Adicione o servidor: `turn:seudominio.com:3478`
2. Informe username e credential
3. Clique "Gather candidates"
4. Procure por candidatos do tipo **`relay`** nos resultados

Se aparecer `relay` = TURN funcionando. Se so aparecer `host` e `srflx` = STUN OK mas TURN com problema.

### Metodo 2: turnutils_uclient (linha de comando)

```bash
# Instalar junto com coturn
turnutils_uclient -u webrtcuser -w suasenha123 -t seudominio.com
```

### Metodo 3: Script JavaScript de teste

```javascript
const { RTCPeerConnection } = require('@roamhq/wrtc');

async function testTurn(config) {
  const pc = new RTCPeerConnection(config);
  const candidates = [];

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      candidates.push(e.candidate);
      console.log(`Tipo: ${e.candidate.type} | ${e.candidate.candidate}`);
    }
  };

  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete') {
      const hasRelay = candidates.some(c => c.type === 'relay');
      console.log('TURN funcionando:', hasRelay);
      pc.close();
    }
  };

  // Criar oferta para disparar coleta de candidatos
  await pc.createDataChannel('test');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
}

testTurn({
  iceServers: [{
    urls: 'turn:seudominio.com:3478',
    username: 'webrtcuser',
    credential: 'suasenha123'
  }],
  iceTransportPolicy: 'relay' // so relay para testar TURN isoladamente
});
```

### Metodo 4: Verificar logs do coturn

```bash
# Logs em tempo real
sudo journalctl -u coturn -f

# Ou no arquivo de log
tail -f /var/log/coturn/turnserver.log
```

Procure por linhas com `session`, `allocation`, `relay` para ver conexoes ativas.

### Metodo 5: Ferramenta online da metered.ca

https://www.metered.ca/turn-server-testing — interface web simples para testar qualquer TURN server.

---

## 9. TURN Gratuito via Metered.ca / Open Relay

### Open Relay Project

O metered.ca oferece um TURN server gratuito chamado Open Relay:

**URL:** https://www.metered.ca/tools/openrelay/

**Limite gratuito:** 20 GB/mes de trafego TURN.

**Credenciais estaticas (simples, pode estar deprecado):**

```javascript
const iceServers = [
  {
    urls: 'stun:openrelay.metered.ca:80'
  },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];
```

**Via API (recomendado — credenciais dinamicas):**

```javascript
// No backend (Node.js):
const response = await fetch(
  `https://yourappname.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`
);
const iceServers = await response.json();

// No frontend ou no peer connection:
const pc = new RTCPeerConnection({ iceServers });
```

Para obter API key: cadastro gratuito em https://www.metered.ca

**Configuracao completa que a API retorna:**

```javascript
[
  { urls: "stun:stun.relay.metered.ca:80" },
  { urls: "turn:global.relay.metered.ca:80",   username: "...", credential: "..." },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "...", credential: "..." },
  { urls: "turn:global.relay.metered.ca:443",  username: "...", credential: "..." },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "...", credential: "..." }
]
```

**Para Matrix/Synapse (static auth):**
```
URL: staticauth.openrelay.metered.ca
Secret: openrelayprojectsecret
```

### Vantagens do Open Relay

- Roda nas portas 80 e 443 (contorna firewalls corporativos)
- Suporta TURNS + SSL (contorna deep packet inspection)
- Geo-targeting automatico (menor latencia)
- 20 GB gratis/mes
- Nao precisa de servidor proprio

### Quando usar Open Relay vs coturn proprio

| Cenario | Recomendacao |
|---|---|
| Desenvolvimento e testes | Open Relay gratuito |
| Produto com < 100 usuarios | Open Relay (plano gratuito ou pago) |
| Produto com alto volume | coturn proprio (custo de banda mais baixo) |
| Necessidade de SLA 99.999% sem gerir infra | Metered.ca pago |
| Compliance / dados nao podem sair da infra propria | coturn proprio |

---

## 10. Custo de Banda do TURN Server

### Calculo pratico

- Video HD bilateral: ~2 Mbps/participante → servidor ve 4 Mbps total
- 1 hora de chamada: ~1.8 GB pelo servidor
- Se 20% das chamadas usam TURN: em 100 horas de chamada/dia, 20h passam pelo TURN = 36 GB/dia = ~1 TB/mes

### Custo estimado (VPS comum)

| Provedor | Custo de banda |
|---|---|
| Hetzner | ~1 euro/TB (muito barato, ideal para TURN) |
| DigitalOcean | $0.01/GB alem de 1TB incluido |
| AWS EC2 | $0.09/GB — caro para TURN |
| Google Cloud | $0.08/GB — caro para TURN |

**Recomendacao:** Para TURN server proprio, use Hetzner ou OVH (Europa) ou Vultr. AWS/GCP sao proibitivos para volumes altos de TURN.

### Estrategias para reduzir custo TURN

1. **Preferir STUN:** Garantir que a configuracao ICE tente conexao direta antes do relay.
2. **iceTransportPolicy: 'all'** (nunca use `'relay'` em producao — isso desabilita conexao direta).
3. **NAT64/IPv6:** Redes com IPv6 nativo raramente precisam de TURN.
4. **SFU em vez de mesh:** Para N participantes, um SFU e mais eficiente que cada par usando TURN.
5. **Limitar relay range:** `min-port`/`max-port` pequenos economizam portas mas nao banda.
6. **Monitorar com `total-quota` e `user-quota`** no coturn para limitar abuso.

---

## 11. Configuracao Completa de Producao (Exemplo)

### turnserver.conf para producao com TLS e use-auth-secret

```ini
# Identidade
realm=turn.example.com
server-name=turn.example.com

# Rede
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=203.0.113.1  # SEU IP PUBLICO

# Relay range (pequeno para facilitar firewall)
min-port=49152
max-port=49400

# Autenticacao por shared secret (REST API style)
use-auth-secret
static-auth-secret=sua-chave-secreta-forte-aqui

# TLS
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-tlsv1
no-tlsv1_1

# Seguranca
fingerprint
no-loopback-peers
no-multicast-peers

# Logging
log-file=/var/log/coturn/turnserver.log
simple-log

# Performance (opcional)
total-quota=1000
bps-capacity=0
```

### Backend Node.js gerando credenciais

```javascript
const crypto = require('crypto');

const TURN_SECRET = process.env.TURN_SECRET;
const TURN_SERVER = process.env.TURN_SERVER || 'turn.example.com';

function getIceServers(userId = 'anon') {
  const ttl = 86400; // 24h
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${exp}:${userId}`;
  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');

  return [
    { urls: `stun:stun.l.google.com:19302` },
    { urls: `stun:${TURN_SERVER}:3478` },
    { urls: `turn:${TURN_SERVER}:3478`,            username, credential },
    { urls: `turn:${TURN_SERVER}:3478?transport=tcp`, username, credential },
    { urls: `turns:${TURN_SERVER}:5349`,           username, credential },
    { urls: `turns:${TURN_SERVER}:5349?transport=tcp`, username, credential }
  ];
}

// Endpoint REST para o cliente buscar credenciais
app.get('/api/ice-servers', (req, res) => {
  res.json(getIceServers(req.user?.id));
});
```

### Cliente (browser ou @roamhq/wrtc)

```javascript
const { RTCPeerConnection } = require('@roamhq/wrtc'); // ou window.RTCPeerConnection no browser

async function createPeerConnection() {
  // Buscar credenciais do backend (nao expor o secret no cliente)
  const response = await fetch('/api/ice-servers');
  const iceServers = await response.json();

  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: 'all', // tenta P2P primeiro, TURN como fallback
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      console.log(`Candidato: ${candidate.type}`); // host | srflx | relay
      // enviar para o peer via sinalização
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Conexao:', pc.connectionState);
  };

  return pc;
}
```

---

## 12. Resumo de Decisao

```
Precisa de TURN?
├── Sim (NAT simetrico, firewall corporativo, usuarios enterprise)
│   ├── Volume baixo (<100 usuarios) → Open Relay metered.ca (gratis)
│   ├── Volume medio (controle de custo) → coturn proprio em Hetzner
│   └── Sem querer gerir infra → metered.ca pago
└── Nao tenho certeza → monitore % de candidatos relay em producao
    └── Se > 20% relay → vale considerar TURN dedicado
```

---

## Referencias

- [coturn GitHub](https://github.com/coturn/coturn)
- [WebRTC.org — TURN Server](https://webrtc.org/getting-started/turn-server)
- [metered.ca — How to setup coturn](https://www.metered.ca/blog/coturn/)
- [metered.ca — Open Relay Project](https://www.metered.ca/tools/openrelay/)
- [metered.ca — Lista de ICE Servers](https://www.metered.ca/blog/list-of-webrtc-ice-servers/)
- [GabrielTanner — TURN Server Setup](https://gabrieltanner.org/blog/turn-server/)
- [WebRTC.ventures — STUN vs TURN](https://webrtc.ventures/2020/12/webrtc-signaling-stun-vs-turn/)
- [DEV Community — TURN com Node.js wrtc](https://dev.to/alakkadshaw/how-to-use-turn-server-with-nodejs-webrtc-library-2b4g)
- [Trickle ICE Testing Tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
- [metered.ca — TURN Server Testing](https://www.metered.ca/turn-server-testing)
- [bloggeek.me — WebRTC TURN Explained](https://bloggeek.me/webrtcglossary/turn/)
- [metered.ca — Running coturn in Docker](https://www.metered.ca/blog/running-coturn-in-docker-a-step-by-step-guide/)
- [VideoSDK — TURN vs STUN](https://www.videosdk.live/developer-hub/webrtc/turn-server-for-webrtc)
- [L7mp — TURN Authentication](https://medium.com/l7mp-technologies/lets-talk-about-turn-authentication-c2767514bc0c)
- [VideoSDK — como testar TURN](https://www.videosdk.live/developer-hub/stun-turn-server/turn-server-test)
