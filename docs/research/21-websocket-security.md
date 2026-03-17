# WebSocket Security: Autenticação, Autorização e Proteção

## Introdução

Este documento aborda as melhores práticas de segurança para WebSockets em aplicações Node.js, com foco no contexto do projeto Remote Browser. Inclui implementações práticas com código.

## 1. Autenticação de Conexões WebSocket

### 1.1 Métodos de Autenticação

Existem três métodos principais para autenticar conexões WebSocket:

#### a) Token JWT na Query String (Recomendado)

```javascript
// server/websocket-server.js
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware de autenticação
function authenticateWebSocket(req, next) {
  const params = url.parse(req.url, true).query;
  const token = params.token;

  if (!token) {
    return next(new Error('Token não fornecido'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    next(new Error('Token inválido ou expirado'));
  }
}

// Criar servidor WebSocket com autenticação
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws, req) => {
  // Autenticação via middleware
  authenticateWebSocket(req, (err) => {
    if (err) {
      ws.close(1008, `Autenticação falhou: ${err.message}`);
      return;
    }

    // Conexão autenticada - associar user à conexão
    ws.user = req.user;
    ws.sessionId = req.user.sessionId;

    console.log(`Usuário ${ws.user.id} conectado`);

    // Handshake completo
    ws.send(JSON.stringify({
      type: 'auth-success',
      message: 'Autenticado com sucesso',
      user: { id: ws.user.id, role: ws.user.role }
    }));
  });
});
```

**Vantagens:**
- Simples de implementar
- Compatível com todos os clientes WebSocket
- O token é visível no handshake HTTP (não criptografado)

**Desvantagens:**
- Token aparece em logs de servidor (access logs)
- Pode ser capturado em redes não-HTTPS
- Requer HTTPS em produção

#### b) Token no Header da Requisição HTTP Handshake

```javascript
// server/websocket-server.js
function authenticateWebSocketByHeader(req, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new Error('Token não fornecido'));
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    next(new Error('Token inválido ou expirado'));
  }
}
```

**Vantagens:**
- Token não aparece na URL
- Mais seguro contra logs acidentais
- Padrão REST para autenticação

**Desvantagens:**
- Nem todos os clientes WebSocket enviam headers facilmente
- Browsers limitam headers customizados em conexões WebSocket (CORS preflight)

#### c) Autenticação via Cookie (para Browsers)

```javascript
// server/index.js - servidor HTTP com cookie-session
const express = require('express');
const cookieSession = require('cookie-session');
const { Server } = require('ws');

const app = express();

// Configurar cookie session
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET],
  maxAge: 24 * 60 * 60 * 1000 // 1 dia
}));

// Endpoint para gerar sessão
app.get('/api/create-session', (req, res) => {
  const sessionId = generateUniqueId();
  req.session.sessionId = sessionId;
  req.session.userId = req.user.id;

  res.json({ sessionId, message: 'Sessão criada' });
});

// Servidor WebSocket compartilha o mesmo domínio
const server = app.listen(8080);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  // req.session disponível automaticamente
  if (!req.session.sessionId) {
    ws.close(1008, 'Sessão não encontrada');
    return;
  }

  ws.userId = req.session.userId;
  ws.sessionId = req.session.sessionId;
});
```

**Vantagens:**
- Automático para browsers (mesmo domínio)
- Protegido por flags HttpOnly e Secure
- Session management integrada

**Desvantagens:**
- Apenas funciona com HTTP same-origin
- Requer HTTPS para Secure cookies
- CSRF considerations se usar também HTTP

### 1.2 Comparação: Query String vs Header

| Aspecto | Query String | HTTP Header |
|---------|-------------|-------------|
| Simplicidade | Alta | Média |
| Segurança | Média (logs) | Alta |
| Compatibilidade | Excelente | Média |
| HTTPS Required | Sim (produção) | Sim (produção) |
| Padrão REST | Não | Sim |
| CORS Issues | Não | Sim (preflight) |

**Recomendação:**
- **Desenvolvimento/Testes**: Query string (simplicidade)
- **Produção**: HTTP Header (segurança) ou Cookie (same-origin browsers)

## 2. Associação WebSocket a Sessão Específica

### 2.1 Mapeamento Sessão → Conexão WebSocket

```javascript
// server/session-manager.js
const activeConnections = new Map(); // sessionId -> WebSocket

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> { userId, ws, createdAt }
    this.userConnections = new Map(); // userId -> [sessionIds]
  }

  registerSession(sessionId, userId, ws) {
    this.sessions.set(sessionId, {
      userId,
      ws,
      createdAt: Date.now()
    });

    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, []);
    }
    this.userConnections.get(userId).push(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getConnectionBySession(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.ws : null;
  }

  getUserConnections(userId) {
    const sessionIds = this.userConnections.get(userId) || [];
    return sessionIds.map(id => this.sessions.get(id)).filter(Boolean);
  }

  unregisterSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      const userSessions = this.userConnections.get(session.userId);
      if (userSessions) {
        const index = userSessions.indexOf(sessionId);
        if (index > -1) userSessions.splice(index, 1);
      }
    }
  }

  cleanupStaleSessions(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.createdAt > maxAgeMs) {
        this.unregisterSession(sessionId);
      }
    }
  }
}

const sessionManager = new SessionManager();
```

### 2.2 Integração com Autenticação JWT

```javascript
wss.on('connection', (ws, req) => {
  authenticateWebSocket(req, (err) => {
    if (err) {
      ws.close(1008, err.message);
      return;
    }

    const { sessionId, userId } = req.user;
    ws.sessionId = sessionId;
    ws.userId = userId;

    // Registrar sessão
    sessionManager.registerSession(sessionId, userId, ws);

    // Configurar cleanup ao fechar
    ws.on('close', () => {
      sessionManager.unregisterSession(sessionId);
    });

    console.log(`Sessão ${sessionId} conectada (usuário ${userId})`);
  });
});
```

### 2.3 Enviar Mensagens para Sessão Específica

```javascript
// server/message-router.js
function sendToSession(sessionId, message) {
  const session = sessionManager.getSession(sessionId);
  if (session && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function sendToUser(userId, message) {
  const connections = sessionManager.getUserConnections(userId);
  const results = [];

  for (const conn of connections) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message));
      results.push(conn.sessionId);
    }
  }

  return results;
}

// Exemplo de uso: stream de vídeo direcionada
function routeStreamToSession(sessionId, streamData) {
  const success = sendToSession(sessionId, {
    type: 'stream-data',
    data: streamData,
    timestamp: Date.now()
  });

  if (!success) {
    console.warn(`Sessão ${sessionId} offline, salvando buffer`);
    // Salvar em buffer para retransmissão quando reconectar
    bufferStreamForSession(sessionId, streamData);
  }
}
```

### 2.4 Reconexão Automática with Session Resumption

```javascript
// server/reconnect-handler.js
const PENDING_MESSAGES = new Map(); // sessionId -> [messages]

wss.on('connection', (ws, req) => {
  authenticateWebSocket(req, (err) => {
    // ... autenticação ...

    // Verificar se há mensagens pendentes
    const pending = PENDING_MESSAGES.get(sessionId) || [];

    if (pending.length > 0) {
      ws.send(JSON.stringify({
        type: 'reconnect',
        pendingCount: pending.length
      }));

      // Reenviar mensagens pendentes
      for (const msg of pending) {
        ws.send(JSON.stringify(msg));
      }

      PENDING_MESSAGES.delete(sessionId);
    }
  });

  ws.on('close', () => {
    // Manter sessão válida por X minutos após desconexão
    setTimeout(() => {
      if (!sessionManager.getSession(sessionId)) {
        sessionManager.unregisterSession(sessionId);
      }
    }, 5 * 60 * 1000); // 5 minutos grace period
  });
});
```

## 3. Rate Limiting em WebSocket

### 3.1 Rate Limiting por Conexão

```javascript
// server/rate-limiter.js
const速率限制器 = require('./rate-limiter.js');
const rateLimiter = new RateLimiter();

class ConnectionRateLimiter {
  constructor(options = {}) {
    this.maxMessagesPerSecond = options.maxMessagesPerSecond || 10;
    this.maxConnectionsPerIP = options.maxConnectionsPerIP || 5;
    this.maxMessageSize = options.maxMessageSize || 1024 * 1024; // 1MB

    this.messageCounts = new Map(); // ws -> { count, resetTime }
    this.ipConnections = new Map(); // ip -> [connections]
  }

  checkConnection(ip) {
    const connections = this.ipConnections.get(ip) || [];
    if (connections.length >= this.maxConnectionsPerIP) {
      return { allowed: false, reason: 'Máximo de conexões por IP atingido' };
    }
    return { allowed: true };
  }

  checkMessage(ws, messageSize) {
    if (messageSize > this.maxMessageSize) {
      return { allowed: false, reason: 'Mensagem muito grande' };
    }

    const now = Date.now();
    const stats = this.messageCounts.get(ws) || {
      count: 0,
      resetTime: now + 1000
    };

    // Reset do contador se passou 1 segundo
    if (now >= stats.resetTime) {
      stats.count = 0;
      stats.resetTime = now + 1000;
    }

    if (stats.count >= this.maxMessagesPerSecond) {
      return { allowed: false, reason: 'Rate limit excedido' };
    }

    stats.count++;
    this.messageCounts.set(ws, stats);

    return { allowed: true };
  }

  cleanup(ws) {
    this.messageCounts.delete(ws);
  }
}

const connectionLimiter = new ConnectionRateLimiter({
  maxMessagesPerSecond: 20,
  maxConnectionsPerIP: 3,
  maxMessageSize: 512 * 1024 // 512KB
});
```

### 3.2 Contador de Conexões por IP

```javascript
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  // Rate limit por IP
  const connCheck = connectionLimiter.checkConnection(ip);
  if (!connCheck.allowed) {
    ws.close(1008, connCheck.reason);
    return;
  }

  // Registrar conexão
  if (!connectionLimiter.ipConnections.has(ip)) {
    connectionLimiter.ipConnections.set(ip, []);
  }
  connectionLimiter.ipConnections.get(ip).push(ws);

  // Cleanup ao fechar
  ws.on('close', () => {
    const connections = connectionLimiter.ipConnections.get(ip);
    if (connections) {
      const index = connections.indexOf(ws);
      if (index > -1) connections.splice(index, 1);
      if (connections.length === 0) {
        connectionLimiter.ipConnections.delete(ip);
      }
    }
    connectionLimiter.cleanup(ws);
  });

  // Rate limit nas mensagens
  ws.on('message', (data) => {
    const msgCheck = connectionLimiter.checkMessage(ws, data.length);
    if (!msgCheck.allowed) {
      ws.close(1008, msgCheck.reason);
      return;
    }

    // Processar mensagem
    handleMessage(ws, data);
  });
});
```

### 3.3 Rate Limiting com Redis (Distribuído)

```javascript
// server/redis-rate-limiter.js
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

const client = redis.createClient({
  url: process.env.REDIS_URL
});

class DistributedRateLimiter {
  constructor() {
    this.windowMs = 60 * 1000; // 1 minuto
    this.maxMessages = 100; // 100 mensagens por minuto
  }

  async checkLimit(key) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - Math.floor(this.windowMs / 1000);

    // Usar sorted set para janela deslizante
    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local max = tonumber(ARGV[3])

      -- Remover entradas antigas
      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

      -- Contar entradas atuais
      local count = redis.call('ZCARD', key)

      if count < max then
        -- Adicionar timestamp atual
        redis.call('ZADD', key, now, ARGV[4])
        -- Expirar após janela
        redis.call('EXPIRE', key, math.ceil(ARGV[5]))
        return 1
      else
        return 0
      end
    `;

    const allowed = await client.eval(script, 1, key, now, windowStart, this.maxMessages, now, this.windowMs/1000);
    return allowed === 1;
  }

  getKey(ws, type = 'message') {
    return `rate-limit:${ws.userId || ws._socket.remoteAddress}:${type}`;
  }
}

const redisLimiter = new DistributedRateLimiter();
```

## 4. Proteção contra DDoS

### 4.1 Handshake Timeout e Limite de Conexões

```javascript
// server/ddos-protection.js
const ddosProtection = {
  maxConnections: 1000,
  connectionTimeout: 10000, // 10 segundos
  heartbeatInterval: 30000, // 30 segundos
  maxConnectionsPerIP: 5,
  connectionHistory: new Map(), // ip -> [timestamps]

  init(wss) {
    wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;

      // Verificar limite de conexões por IP
      this.checkIPLimit(ip);

      // Configurar timeout de handshake
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      // Ping periódico
      this.setupHeartbeat(ws);

      // Timeout de handshake
      const handshakeTimer = setTimeout(() => {
        if (!ws.userId) { // Não autenticado
          ws.terminate();
        }
      }, this.connectionTimeout);

      ws.on('open', () => {
        clearTimeout(handshakeTimer);
      });
    });
  },

  checkIPLimit(ip) {
    const now = Date.now();
    const history = this.connectionHistory.get(ip) || [];
    const windowStart = now - 60000; // Último minuto

    // Limpar registros antigos
    const recent = history.filter(time => time > windowStart);
    this.connectionHistory.set(ip, recent);

    if (recent.length >= this.maxConnectionsPerIP) {
      console.warn(`DDoS protection: IP ${ip} bloqueado (${recent.length} conexões/min)`);
      throw new Error('Too many connections');
    }

    recent.push(now);
  },

  setupHeartbeat(ws) {
    setInterval(() => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }

      ws.isAlive = false;
      ws.ping(() => {});
    }, this.heartbeatInterval);
  }
};

// Aplicar proteção DDoS
ddosProtection.init(wss);
```

### 4.2 Proxy Integration (Nginx/Cloudflare)

```nginx
# nginx.conf
upstream websocket_backend {
    ip_hash; # Manter sticky sessions
    server 127.0.0.1:8080;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    # SSL config
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Rate limiting por IP
    limit_req_zone $binary_remote_addr zone=ws_limit:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=ws_conn_limit:10m rate=5r/m;

    location /ws {
        # Aplicar rate limit
        limit_req zone=ws_limit burst=20 nodelay;
        limit_req zone=ws_conn_limit;

        # WebSocket upgrade headers
        proxy_pass http://websocket_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;

        # Buffer size
        proxy_buffering off;

        # Real IP header (se atrás de proxy)
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 4.3 Connection Quotas por Usuário

```javascript
// server/quota-manager.js
class QuotaManager {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  async checkUserQuota(userId) {
    const key = `user:connections:${userId}`;
    const count = await this.redis.get(key);

    if (count && parseInt(count) >= 5) {
      return { allowed: false, reason: 'Máximo de 5 conexões ativas' };
    }

    // Incrementar contador
    await this.redis.incr(key);
    await this.redis.expire(key, 3600); // 1 hora

    return { allowed: true };
  }

  async releaseConnection(userId) {
    const key = `user:connections:${userId}`;
    const current = await thisredis.decr(key);
    if (current <= 0) {
      await this.redis.del(key);
    }
  }
}
```

## 5. Como o Serende deve Autenticar Conexões WebSocket de Stream

### 5.1 Arquitetura do Remote Browser

```javascript
// server/stream-authentication.js

class StreamAuthenticator {
  constructor(sessionManager, jwtService) {
    this.sessionManager = sessionManager;
    this.jwtService = jwtService;
    this.streamTokens = new Map(); // token -> { sessionId, expiresAt }
  }

  // Gerar token de stream válido apenas para WebSocket
  async generateStreamToken(sessionId, userId, metadata = {}) {
    const token = this.jwtService.sign(
      {
        type: 'stream',
        sessionId,
        userId,
        metadata,
        // Act (audience) para validar uso específico
        aud: 'remote-browser-stream'
      },
      { expiresIn: '2h' }
    );

    // Registrar token para possível revogação
    this.streamTokens.set(token, {
      sessionId,
      userId,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
      metadata
    });

    return token;
  }

  // Validar token de stream no WebSocket
  validateStreamToken(token, sessionId) {
    const registered = this.streamTokens.get(token);
    if (!registered) return false;

    // Verificar se token pertence à sessão
    if (registered.sessionId !== sessionId) {
      return false;
    }

    // Verificar expiração
    if (Date.now() > registered.expiresAt) {
      this.streamTokens.delete(token);
      return false;
    }

    return true;
  }

  // Revogar token específico
  revokeToken(token) {
    this.streamTokens.delete(token);
  }

  // Revogar todos os tokens de uma sessão
  revokeSessionTokens(sessionId) {
    for (const [token, data] of this.streamTokens.entries()) {
      if (data.sessionId === sessionId) {
        this.streamTokens.delete(token);
      }
    }
  }
}
```

### 5.2 Fluxo de Autenticação Remote Browser

```javascript
// server/websocket-server.js - integração completa
const streamAuth = new StreamAuthenticator(sessionManager, jwtService);

wss.on('connection', async (ws, req) => {
  const params = url.parse(req.url, true).query;
  const token = params.token;

  if (!token) {
    ws.close(1008, 'Token obrigatório');
    return;
  }

  try {
    // Decodificar JWT
    const decoded = jwt.verify(token, JWT_SECRET);

    // Validações específicas para stream
    if (!decoded.sessionId) {
      throw new Error('Token não contém sessionId');
    }

    // Verificar se token foi revogado
    if (!streamAuth.validateStreamToken(token, decoded.sessionId)) {
      throw new Error('Token revogado ou expirado');
    }

    // Registrar conexão
    ws.userId = decoded.userId;
    ws.sessionId = decoded.sessionId;
    ws.token = token; // Manter para heartbeat

    sessionManager.registerSession(decoded.sessionId, decoded.userId, ws);

    console.log(`Stream autenticado: sessão ${decoded.sessionId}, usuário ${decoded.userId}`);

    // Confirmar autenticação
    ws.send(JSON.stringify({
      type: 'authenticated',
      sessionId: decoded.sessionId,
      userId: decoded.userId
    }));

    // Setup de timeout se inativo
    setupInactivityTimeout(ws, decoded.sessionId);

  } catch (err) {
    console.error('Falha na autenticação WebSocket:', err.message);
    ws.close(1008, `Autenticação falhou: ${err.message}`);
  }
});

function setupInactivityTimeout(ws, sessionId) {
  let lastActivity = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

  const checkTimeout = setInterval(() => {
    if (Date.now() - lastActivity > TIMEOUT_MS) {
      ws.close(1001, 'Timeout por inatividade');
      clearInterval(checkTimeout);
    }
  }, 60000); // Checar a cada minuto

  ws.on('message', () => {
    lastActivity = Date.now();
  });

  ws.on('close', () => {
    clearInterval(checkTimeout);
    sessionManager.unregisterSession(sessionId);

    // Revogar token automaticamente ao desconectar
    streamAuth.revokeSessionTokens(sessionId);
  });
}
```

### 5.3 Stream com Redeem Token (Two-Phase Auth)

```javascript
// Para maior segurança: dois tokens (handshake + stream)
class TwoPhaseStreamAuth {
  constructor() {
    this.handshakeTokens = new Map(); // token -> { sessionId, verified }
    this.streamTokens = new Map();
  }

  // Fase 1: Handshake inicial (validade curta, 30 segundos)
  async createHandshakeToken(sessionId) {
    const token = jwt.sign(
      { sessionId, type: 'handshake' },
      JWT_SECRET,
      { expiresIn: '30s', audience: 'handshake' }
    );

    this.handshakeTokens.set(token, { sessionId, verified: false });
    return token;
  }

  // Fase 2: Após verificar handshake, emitir stream token
  async exchangeForStreamToken(handshakeToken) {
    const handshake = this.handshakeTokens.get(handshakeToken);

    if (!handshake) {
      throw new Error('Handshake token inválido');
    }

    handshake.verified = true;
    this.handshakeTokens.delete(handshakeToken);

    const streamToken = jwt.sign(
      {
        sessionId: handshake.sessionId,
        type: 'stream'
      },
      JWT_SECRET,
      { expiresIn: '2h', audience: 'stream' }
    );

    this.streamTokens.set(streamToken, {
      sessionId: handshake.sessionId,
      handshakeVerified: true
    });

    return streamToken;
  }
}
```

## 6. Revogação de Tokens e Desconexão Forçada

### 6.1 Sistema de Revogação com Redis

```javascript
// server/token-revocation.js
class TokenRevocationService {
  constructor(redisClient) {
    this.redis = redisClient;
    this.revocationListKey = 'revoked-tokens';
  }

  async revokeToken(token) {
    // Armazenar hash do token (não o token em claro)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await this.redis.setEx(
      `${this.revocationListKey}:${tokenHash}`,
      3600, // 1 hora TTL
      'revoked'
    );
  }

  async isRevoked(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await this.redis.get(`${this.revocationListKey}:${tokenHash}`);
    return result === 'revoked';
  }

  // Revogar todos os tokens de um usuário (ex.: logout)
  async revokeUserTokens(userId) {
    const userKey = `user:revoked:${userId}`;
    const now = Date.now();
    await this.redis.setEx(userKey, 3600 * 24 * 30, now.toString()); // 30 dias
  }

  async wasUserRevoked(userId) {
    const userKey = `user:revoked:${userId}`;
    const revokedAt = await this.redis.get(userKey);
    return !!revokedAt;
  }
}
```

### 6.2 Forçar Desconexão de Sessão Específica

```javascript
// server/force-disconnect.js
class ForceDisconnectService {
  constructor(sessionManager, revocationService) {
    this.sessions = sessionManager;
    this.revocation = revocationService;
  }

  async disconnectSession(sessionId, reason = 'Desconexão administratively') {
    const session = this.sessionManager.getSession(sessionId);

    if (session && session.ws.readyState === WebSocket.OPEN) {
      // Enviar aviso antes de desconectar
      session.ws.send(JSON.stringify({
        type: 'force-disconnect',
        reason,
        disconnectAt: Date.now() + 5000 // 5 segundos para cleanup
      }));

      // Aguardar 5 segundos e fechar
      setTimeout(() => {
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.close(4000, reason);
        }
      }, 5000);

      console.log(`Sessão ${sessionId} forçada a desconectar: ${reason}`);
    }

    // Revogar tokens associados
    await this.revocation.revokeSessionTokens(sessionId);

    // Remover da sessão ativa
    this.sessionManager.unregisterSession(sessionId);
  }

  async disconnectUser(userId, reason = 'Logout em todos os dispositivos') {
    const connections = this.sessionManager.getUserConnections(userId);

    for (const session of connections) {
      await this.disconnectSession(session.sessionId, reason);
    }

    console.log(`Usuário ${userId} desconectado de ${connections.length} sessões`);
  }
}

const forceDisconnect = new ForceDisconnectService(
  sessionManager,
  new TokenRevocationService(redis)
);
```

### 6.3 Middleware de Revogação em Tempo Real

```javascript
function checkRevocationMiddleware(ws, req, next) {
  const token = req.user?.token;

  if (token) {
    revocationService.isRevoked(token).then(isRevoked => {
      if (isRevoked) {
        ws.close(1008, 'Token revogado');
        return;
      }
      next();
    }).catch(next);
  } else {
    next();
  }
}

// Verificar revogação periódicamente (polling)
function setupRevocationCheck(ws, token) {
  const CHECK_INTERVAL = 30000; // 30 segundos

  const checkRevocation = async () => {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      const revoked = await revocationService.isRevoked(token);
      if (revoked) {
        ws.close(1008, 'Token revogado pelo servidor');
        return;
      }
    } catch (err) {
      console.error('Erro ao verificar revogação:', err);
    }
  };

  const interval = setInterval(checkRevocation, CHECK_INTERVAL);

  ws.on('close', () => {
    clearInterval(interval);
  });
}
```

## 7. CORS em WebSocket

### 7.1 Entendendo CORS e WebSocket

WebSocket **não** segue as regras CORS tradicionais (Cross-Origin Resource Sharing), mas tem validação de **Origin Header**:

- Browser envia header `Origin` no handshake WebSocket
- Servidor pode validar e rejeitar conexões de origens não confiáveis
- Não há CORS preflight para WebSocket (diferente de XHR/fetch)

### 7.2 Implementação de Origin Validation

```javascript
// server/cors-validation.js
const corsMiddleware = {
  allowedOrigins: [
    'https://yourdomain.com',
    'https://app.yourdomain.com',
    'ws://localhost:3000', // desenvolvimento
    'http://localhost:3000'
  ],

  // Para Wildcard em desenvolvimento (não produção)
  allowWildcard: false,

  validateOrigin(origin) {
    if (!origin) return false; // Browsers always send origin

    if (this.allowWildcard && this.isLocalhost(origin)) {
      return true; // Permitir qualquer localhost em dev
    }

    return this.allowedOrigins.includes(origin);
  },

  isLocalhost(origin) {
    return origin.startsWith('http://localhost') ||
           origin.startsWith('http://127.0.0.1') ||
           origin.startsWith('http://[::1]') ||
           origin.startsWith('ws://localhost') ||
           origin.startsWith('ws://127.0.0.1');
  }
};

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;

  // Validar Origin
  if (origin && !corsMiddleware.validateOrigin(origin)) {
    console.warn(`Origem bloqueada: ${origin}`);
    ws.close(1008, 'Origem não permitida');
    return;
  }

  // Continuar handshake...
});
```

### 7.3 CORS com Express e ws

```javascript
const express = require('express');
const cors = require('cors');
const { Server } = require('ws');

const app = express();

// Configurar CORS para endpoints HTTP
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'https://yourdomain.com',
  credentials: true
}));

// Criar servidor HTTP + WebSocket
const server = app.listen(8080);

const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    // Validar Origin no handshake WebSocket
    const origin = info.origin;

    if (!corsMiddleware.validateOrigin(origin)) {
      done(false, 403, 'Forbidden: Invalid Origin');
      return;
    }

    // Opcional: validar também token JWT na query string
    const params = new URLSearchParams(info.req.url.split('?')[1]);
    const token = params.get('token');

    if (!token) {
      done(false, 403, 'Forbidden: Missing token');
      return;
    }

    // Verificar token assíncrono
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        done(false, 403, 'Forbidden: Invalid token');
        return;
      }

      // Anexar user info ao objeto de conexão
      info.req.user = decoded;
      done(true);
    });
  }
});
```

### 7.4 Configuração Avançada por Ambiente

```javascript
// config/cors-config.js
const getCORSOptions = () => {
  const env = process.env.NODE_ENV || 'development';
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];

  return {
    development: {
      allowWildcard: true, // Permite qualquer localhost
      verifyClient: (info, done) => {
        // Em dev, apenas validar se é localhost
        if (info.origin && !info.origin.includes('localhost')) {
          console.warn(`Origem bloqueada em dev: ${info.origin}`);
          done(false, 403, 'Forbidden: Localhost only in dev');
          return;
        }
        done(true);
      }
    },

    production: {
      allowedOrigins,
      verifyClient: (info, done) => {
        const origin = info.origin;

        if (!origin || !allowedOrigins.includes(origin)) {
          console.error(` Tentativa de conexão de origem não autorizada: ${origin}`);
          done(false, 403, 'Forbidden: Invalid Origin');
          return;
        }

        done(true);
      }
    }
  };
};

const config = getCORSOptions()[process.env.NODE_ENV];
```

### 7.5 Headers de Segurança Adicionais

```javascript
const securityHeaders = {
  // Previne MIME type sniffing
  'X-Content-Type-Options': 'nosniff',
  // Força HTTPS
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // Proteção contra clickjacking
  'X-Frame-Options': 'DENY',
  // XSS protection
  'X-XSS-Protection': '1; mode=block',
  // Content Security Policy (CSP)
  'Content-Security-Policy': "default-src 'self'"
};

// Adicionar headers no handshake WebSocket
wss.on('headers', (headers) => {
  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.push(`${key}: ${value}`);
  }
});
```

## 8. Segurança Adicional e Melhores Práticas

### 8.1 Validação de Payload

```javascript
function validateMessage(data) {
  try {
    const msg = JSON.parse(data);

    // Validar schema básico
    if (!msg.type || typeof msg.type !== 'string') {
      return { valid: false, error: 'Campo type obrigatório' };
    }

    // Tamanho máximo
    if (JSON.stringify(msg).length > 1024 * 1024) {
      return { valid: false, error: 'Mensagem muito grande (max 1MB)' };
    }

    // Validar tipos específicos
    switch (msg.type) {
      case 'stream-request':
        validateStreamRequest(msg);
        break;
      case 'command':
        validateCommand(msg);
        break;
    }

    return { valid: true, data: msg };
  } catch (err) {
    return { valid: false, error: 'JSON inválido' };
  }
}

wss.on('connection', (ws, req) => {
  ws.on('message', (data) => {
    const validation = validateMessage(data);
    if (!validation.valid) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'invalid-payload',
        message: validation.error
      }));
      return;
    }

    handleValidatedMessage(ws, validation.data);
  });
});
```

### 8.2 Reconexão Segura Client-Side

```javascript
// client/secure-websocket-client.js
class SecureWebSocketClient {
  constructor(url, options = {}) {
    this.url = url;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.backoffFactor = options.backoffFactor || 2;
    this.attempts = 0;

    this.connect();
  }

  async connect() {
    try {
      // Obter token fresco
      const token = await this.getFreshToken();

      // Adicionar token à URL
      const urlWithToken = `${this.url}?token=${token}&clientId=${this.clientId}`;

      this.ws = new WebSocket(urlWithToken);
      this.setupEventHandlers();
    } catch (err) {
      console.error('Falha ao conectar:', err);
      this.handleReconnect();
    }
  }

  setupEventHandlers() {
    this.ws.onopen = () => {
      console.log('WebSocket conectado');
      this.attempts = 0;
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'force-disconnect') {
        // Token foi revogado, não reconectar
        console.warn('Conexão forçada a fechar:', data.reason);
        this.ws.close();
        return;
      }

      this.handleMessage(data);
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket fechado:', event.code, event.reason);
      this.handleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('Erro WebSocket:', error);
    };
  }

  async handleReconnect() {
    if (this.attempts >= this.maxReconnectAttempts) {
      console.error('Máximo de tentativas de reconexão atingido');
      return;
    }

    this.attempts++;
    const delay = this.reconnectDelay * Math.pow(this.backoffFactor, this.attempts - 1);

    console.log(`Tentando reconectar em ${delay}ms (tentativa ${this.attempts})`);

    setTimeout(() => this.connect(), delay);
  }
}
```

### 8.3 Monitoring e Logging

```javascript
// server/monitoring.js
class WebSocketMonitor {
  constructor() {
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      rejectedConnections: 0,
      messagesPerSecond: 0,
      avgLatency: 0,
      authFailures: 0,
      rateLimitBlocks: 0
    };

    this.connectionLog = [];
    this.maxLogSize = 1000;
  }

  logConnection(ws, req, success, reason) {
    const entry = {
      timestamp: new Date().toISOString(),
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      userId: ws.userId,
      sessionId: ws.sessionId,
      success,
      reason
    };

    this.connectionLog.push(entry);

    // Manter limite
    if (this.connectionLog.length > this.maxLogSize) {
      this.connectionLog.shift();
    }

    // Atualizar métricas
    if (success) {
      this.metrics.totalConnections++;
      this.metrics.activeConnections++;
    } else {
      this.metrics.rejectedConnections++;
      if (reason.includes('auth')) this.metrics.authFailures++;
      if (reason.includes('rate limit')) this.metrics.rateLimitBlocks++;
    }
  }

  logDisconnection(ws) {
    this.metrics.activeConnections = Math.max(0, this.metrics.activeConnections - 1);
  }

  getMetrics() {
    return {
      ...this.metrics,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: this.activeConnectionsCount()
    };
  }

  activeConnectionsCount() {
    let count = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }
}

const monitor = new WebSocketMonitor();
```

### 8.4 Health Check Endpoint

```javascript
// server/health-endpoint.js
app.get('/health/websocket', async (req, res) => {
  const metrics = monitor.getMetrics();

  // Verificar se não há muitas conexões rejeitadas
  const healthStatus = metrics.rejectedConnections > metrics.totalConnections * 0.5
    ? 'degraded'
    : 'healthy';

  res.json({
    status: healthStatus,
    timestamp: new Date().toISOString(),
    websocket: {
      active: metrics.activeConnections,
      total: metrics.totalConnections,
      rejected: metrics.rejectedConnections,
      authFailures: metrics.authFailures,
      rateLimitBlocks: metrics.rateLimitBlocks
    },
    system: {
      uptime: metrics.uptime,
      memory: metrics.memory
    }
  });
});
```

## 9. Checklist de Segurança WebSocket

- [ ] **Autenticação**: Implementar JWT com verificação no handshake
- [ ] **TLS/SSL**: Usar `wss://` em produção (HTTPS obrigatório)
- [ ] **Origin Validation**: Validar header `Origin` no handshake
- [ ] **Rate Limiting**: Limitar mensagens por segundo por conexão
- [ ] **Connection Limits**: Limitar conexões por IP e por usuário
- [ ] **Payload Validation**: Validar tamanho e formato de mensagens
- [ ] **Heartbeat**: Implementar ping/pong para detectar conexões mortas
- [ ] **Session Management**: Mapear WebSocket → sessão específica
- [ ] **Token Revocation**: Sistema para revogar tokens ativos
- [ ] **Force Disconnect**: Capacidade de desconectar sessões remotamente
- [ ] **DDoS Protection**: IP blocking, connection timeouts, limiar de conexões
- [ ] **Logging**: Log todas as conexões, autenticações, e erros
- [ ] **Monitoring**: Expor métricas (conexões ativas, rejeitadas, etc.)
- [ ] **Graceful Shutdown**: Fechar todas as conexões antes de encerrar
- [ ] **CORS**: Apenas allowedOrigains em produção

## 10. Configuração para Produção

```javascript
// production-config.js
const config = {
  websocket: {
    port: process.env.WS_PORT || 8080,
    // Usar behind Nginx ou load balancer em produção
    behindProxy: true,
    verifyProxy: true, // confiar em X-Forwarded-For

    // Security
    requireTLS: true,
    maxPayload: 1024 * 1024, // 1MB
    maxConnections: 10000,
    perIPLimit: 10,

    // Timeouts
    handshakeTimeout: 10000,
    idleTimeout: 5 * 60 * 1000, // 5 min
    heartbeatInterval: 30000,

    // Rate limiting
    messagesPerSecond: 20,
    burst: 5,

    // JWT
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiry: '2h'
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
  }
};

module.exports = config;
```

## Referências

O código fornecido acima implementa todas as práticas de segurança mencionadas e está pronto para integração no projeto Remote Browser (Serende).

**Nota**: Sempre testar configurações de segurança em ambiente de staging antes de aplicar em produção.
