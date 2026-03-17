# Gestão de Sessões de Browser Remoto: Melhores Práticas e Padrões

## 1. Melhores Práticas para Gestão de Timeout de Sessões

### 1.1 Sessões Web Tradicionais (HTTP)

Para aplicações web, as melhores práticas incluem:

- **Timeout de inatividade padrão**: 30 minutos de inatividade é o padrão recomendado para a maioria das aplicações empresariais
- **Configuração do cookie de sessão**:
  - `maxAge`: Definir duração máxima (ex: 3600000ms = 1 hora)
  - `httpOnly: true`: Previne acesso via JavaScript (XSS protection)
  - `secure: true`: Apenas via HTTPS
  - `sameSite`: Configurar apropriadamente para CSRF protection

```javascript
// Exemplo com express-session
app.use(session({
  secret: 'your-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 3600000, // 1 hora
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
}));
```

- **Regeneração de session ID** após ações sensíveis (mudança de password, login) para prevenir session hijacking
- **Destruição explícita** no logout:
  ```javascript
  req.session.destroy((err) => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
  ```
- **Notificações client-side** de expiração próxima (warning 5 minutos antes)

### 1.2 Sessões de Browser Remoto/Automação

Para sessões de browser remoto (Playwright, Puppeteer, Browserbase):

- **Timeout absoluto da sessão**: 15-30 minutos sem uso
- **Timeout de inatividade de input**: 5-10 minutos sem interação
- **Auto-cleanup**: Encerrar automaticamente sessões inativas
- **Limite máximo por utilizador**: 3-5 sessões concorrentes
- **Rate limiting**: Limitar criação de sessões (ex: 10/hora)

**Fonte**: [Best Practices for Secure Session Management in Node.js](https://dev.to/jscrambler/best-practices-for-secure-session-management-in-node-3f01)

---

## 2. Como Detectar Sessão Inativa (Último Input, Last Seen)

### 2.1 Deteção de Idle no Browser (Client-Side)

#### Método 1: Event Listeners Manual (Universal)

```javascript
class IdleDetector {
  constructor(timeoutMs = 300000) { // 5 minutos default
    this.timeoutMs = timeoutMs;
    this.lastActivity = Date.now();
    this.idle = false;
    this.onIdleChange = null;
    this.setupListeners();
  }

  setupListeners() {
    const events = [
      'mousemove', 'mousedown', 'keydown',
      'touchstart', 'scroll', 'click'
    ];

    events.forEach(event => {
      document.addEventListener(event, this.resetTimer.bind(this), true);
    });

    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));

    this.timer = setInterval(this.checkIdle.bind(this), 1000);
  }

  resetTimer() {
    this.lastActivity = Date.now();
    if (this.idle && this.onIdleChange) {
      this.idle = false;
      this.onIdleChange(false);
    }
  }

  handleVisibilityChange() {
    if (document.hidden) {
      // Tab ficou oculta ou browser minimizado
      this.resetTimer();
    }
  }

  checkIdle() {
    const idleTime = Date.now() - this.lastActivity;
    const wasIdle = this.idle;
    this.idle = idleTime > this.timeoutMs;

    if (wasIdle !== this.idle && this.onIdleChange) {
      this.onIdleChange(this.idle);
    }
  }

  getLastSeen() {
    return this.lastActivity;
  }

  isIdle() {
    return this.idle;
  }

  destroy() {
    clearInterval(this.timer);
    // Remover event listeners
  }
}
```

**Fonte**: [How to Detect Idle Time in JavaScript](https://www.w3docs.com/snippets/javascript/how-to-detect-idle-time-in-javascript.html)

#### Método 2: Idle Detection API (Modern Web API)

```javascript
const idleDetector = new IdleDetector();

idleDetector.addEventListener('change', () => {
  console.log(`User state: ${idleDetector.userState}`); // 'active' ou 'idle'
  console.log(`Screen state: ${idleDetector.screenState}`); // 'locked' ou 'unlocked'

  // Enviar heartbeat ou atualizar lastSeen no servidor
  if (idleDetector.userState === 'active') {
    updateSessionActivity();
  }
});

try {
  await idleDetector.start({
    threshold: 60000, // Report idle após 60 segundos
  });
} catch (error) {
  console.error('Idle Detection não suportada:', error);
}
```

⚠️ **Limitacao**: Suportado apenas em Chrome/Edge. Não disponível em Firefox/Safari.

**Fonte**: [IdleDetector - MDN](https://developer.mozilla.org/en-US/docs/Web/API/IdleDetector)

### 2.2 Deteção Server-Side

No lado do servidor, tracking de atividade deve ser implementado:

```javascript
class SessionTracker {
  constructor() {
    this.sessions = new Map(); // sessionId -> { lastActivity, idleSince, metadata }
    this.INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 minutos
    this.CLEANUP_INTERVAL = 60 * 1000; // 1 minuto
    this.startCleanupTimer();
  }

  updateActivity(sessionId) {
    this.sessions.set(sessionId, {
      lastActivity: Date.now(),
      idleSince: null,
      updatedAt: Date.now()
    });
  }

  markIdle(sessionId, reason = 'timeout') {
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      session.idleSince = Date.now();
      session.idleReason = reason;
      // Emitir evento ou marcar para cleanup
      this.emit('session-idle', { sessionId, reason });
    }
  }

  getStaleSessions() {
    const cutoff = Date.now() - this.INACTIVE_TIMEOUT;
    return Array.from(this.sessions.entries())
      .filter(([id, data]) => data.lastActivity < cutoff)
      .map(([id, data]) => ({ id, ...data }));
  }

  startCleanupTimer() {
    setInterval(() => {
      const stale = this.getStaleSessions();
      stale.forEach(({ id }) => {
        this.cleanupSession(id);
      });
    }, this.CLEANUP_INTERVAL);
  }

  cleanupSession(sessionId) {
    // Implementar limpeza (fechar browser, remover dados)
    this.sessions.delete(sessionId);
    this.emit('session-closed', { sessionId });
  }

  getSessionMetrics() {
    const now = Date.now();
    return {
      total: this.sessions.size,
      active: Array.from(this.sessions.values())
        .filter(s => now - s.lastActivity < 5 * 60 * 1000).length,
      idle: Array.from(this.sessions.values())
        .filter(s => s.idleSince).length,
      avgIdleTime: this.calculateAvgIdleTime()
    };
  }
}
```

---

## 3. Graceful Shutdown de Chrome: Como Garantir que Dados São Salvos

### 3.1 O Que é Graceful Shutdown?

Graceful shutdown é o processo de encerramento ordenado de uma aplicação, permitindo:
- Finalizar operações pendentes
- Salvar dados em disco
- Fechar ligações de rede adequadamente
- Libertar recursos
- Executar callbacks de cleanup

**Fonte**: [Graceful Shutdown in Node.js: Handling Stranger Danger](https://dev.to/superiqbal7/graceful-shutdown-in-nodejs-handling-stranger-danger-29jo)

### 3.2 Chrome e Graceful Shutdown

Chrome suporta graceful shutdown via sinais do sistema operativo:

| Sinal | Comportamento | Dados Salvos? |
|-------|--------------|---------------|
| **SIGTERM** | Encerramento graceful pedido | ✅ Sim |
| **SIGINT** | Ctrl+C, similar a SIGTERM | ✅ Sim |
| **SIGKILL** | Kill imediato (kill -9) | ❌ Não |
| **SIGSEGV** | Crash segmentation fault | ❌ Não |

**Fonte**: [How to exit chrome?](https://www.clrn.org/how-to-exit-chrome/)

### 3.3 Implementação de Graceful Shutdown com Playwright/Puppeteer

```javascript
class GracefulBrowserManager {
  constructor() {
    this.browser = null;
    this.sessions = new Map();
    this.isShuttingDown = false;
    this.setupSignalHandlers();
  }

  setupSignalHandlers() {
    // Capturar sinais de encerramento
    process.on('SIGTERM', this.handleShutdown.bind(this));
    process.on('SIGINT', this.handleShutdown.bind(this));
    process.on('SIGQUIT', this.handleShutdown.bind(this));

    // Capturar exceções não tratadas
    process.on('uncaughtException', this.handleError.bind(this));
    process.on('unhandledRejection', this.handleError.bind(this));
  }

  async handleShutdown(signal) {
    if (this.isShuttingDown) {
      console.log('Forçando encerramento (já em shutdown)...');
      process.exit(1);
      return;
    }

    this.isShuttingDown = true;
    console.log(`${signal} recebido. Iniciando graceful shutdown...`);

    try {
      // 1. Parar de aceitar novas sessões
      await this.stopAcceptingNewSessions();

      // 2. Notificar clientes conectados (WebSocket)
      await this.notifyClientsOfShutdown();

      // 3. Esperar sessões ativas terminarem (com timeout)
      await this.waitForActiveSessions(10000); // 10 segundos

      // 4. Fechar todas as páginas abertas
      await this.closeAllPages();

      // 5. Salvar logs e métricas
      await this.saveMetrics();

      // 6. Fechar browser
      if (this.browser) {
        await this.browser.close();
        console.log('Browser encerrado com sucesso');
      }

      // 7. Fechar recursos adicionais
      await this.cleanupResources();

      console.log('Graceful shutdown completo');
      process.exit(0);

    } catch (error) {
      console.error('Erro durante shutdown:', error);
      process.exit(1);
    }
  }

  async stopAcceptingNewSessions() {
    this.acceptingNew = false;
    console.log('Novas sessões bloqueadas');
  }

  async notifyClientsOfShutdown() {
    const shutdownMessage = {
      type: 'shutdown',
      reason: 'server_maintenance',
      secondsUntilDisconnect: 30
    };

    for (const [sessionId, ws] of this.websocketClients) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(JSON.stringify(shutdownMessage));
        }
      } catch (err) {
        console.warn('Erro ao notificar cliente:', sessionId);
      }
    }
  }

  async waitForActiveSessions(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const activeSessions = this.sessions.size;

    console.log(`Aguardando ${activeSessions} sessões ativas...`);

    while (this.sessions.size > 0 && Date.now() < deadline) {
      await this.sleep(1000);
      console.log(`Sessões restantes: ${this.sessions.size}`);
    }

    if (this.sessions.size > 0) {
      console.warn(`${this.sessions.size} sessões ainda ativas após timeout. Forçando...`);
    }
  }

  async closeAllPages() {
    const pages = this.sessions.values();
    const closePromises = [];

    for (const session of pages) {
      try {
        if (session.page && !session.page.isClosed()) {
          closePromises.push(session.page.close());
        }
      } catch (err) {
        console.warn('Erro ao fechar página:', err.message);
      }
    }

    await Promise.allSettled(closePromises);
    console.log('Todas as páginas fechadas');
  }

  async saveMetrics() {
    // Salvar métricas de memória, estatísticas de uso
    const metrics = {
      timestamp: new Date().toISOString(),
      memory: process.memoryUsage(),
      activeSessions: this.sessions.size,
      totalSessionsCreated: this.totalCreated,
      uptime: process.uptime()
    };

    await this.writeMetricsToDisk(metrics);
  }

  async cleanupResources() {
    // Fechar conexões de BD, Redis, etc.
    if (this.db) await this.db.close();
    if (this.redis) await this.redis.quit();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 3.4 Playwright Browser.close() e Persistência de Dados

O método `browser.close()` do Playwright:
- ✅ Fecha todas as páginas e contexts
- ✅ Envia SIGTERM para processos Chrome
- ✅ Aguarda resposta do Chrome (default timeout: 30s)
- ✅ Limpa recursos do sistema
- ✅ **NÃO salva automaticamente dados de formulário/session** — cabe à aplicação

```javascript
const browser = await playwright.chromium.launch();

// Configurar perfis persistentes
const context = await browser.newContext({
  // localStorage, IndexedDB são persistidos no diretório userDataDir
  userDataDir: './user-data'
});

// Ao fechar, dados em userDataDir são preservados
await browser.close();
```

**Importante**: Chrome salva dados de session, localStorage, cookies automaticamente durante graceful shutdown. Dados de formulários não preenchidos podem ser perdidos se não salvos explicitamente pela aplicação.

---

## 4. SIGTERM Handling no Chrome: O Chrome Salva Dados ao Receber SIGTERM?

### 4.1 Resposta Direta: **SIM** ✅

Chrome/Chromium salva dados automaticamente ao receber SIGTERM:

### O Que É Salvo Automaticamente

1. **Session state** (abas abertas, URLs)
2. **Cookies e localStorage**
3. **IndexedDB**
4. **Form data** (se autocomplete ativado)
5. **Cache HTTP**
6. **Extensões e configurações** (se profile fornecido)

### O Que **NÃO** É Salvo Automaticamente

1. **Formulários dinâmicos** não submetidos
2. **Uploads em progresso** incompletos
3. **Download em andamento** (pode corromper arquivo)
4. **WebSocket connections** ativas
5. **Estado JavaScript** não persistido

**Fonte**: [Bugzilla - Firefox/Chromium SIGTERM Behavior](https://bugzilla.mozilla.org/show_bug.cgi?id=336193)

### 4.2 Docker/Kubernetes Context

Em containers, Docker enviará SIGTERM ao `docker stop`:

```dockerfile
# Dockerfile - Capturar SIGTERM no script de entrypoint
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

```bash
#!/bin/bash
# entrypoint.sh

# Função de cleanup
cleanup() {
  echo "SIGTERM recebido. Encerrando browser..."
  pkill -TERM chromium || true
  # Esperar graceful shutdown
  sleep 5
  exit 0
}

# Capturar sinais
trap cleanup SIGTERM SIGINT

# Executar aplicação principal
node /app/server.js
```

**Timeout padrão Docker**: 10 segundos entre SIGTERM e SIGKILL.

**Fonte**: [Docker Graceful Shutdown](https://oneuptime.com/blog/post/2026-01-16-docker-graceful-shutdown-signals/view)

---

## 5. Memory Leaks em Sessões de Longa Duração

### 5.1 Causas Principais de Memory Leaks

Para Playwright/Puppeteer, as causas mais comuns são:

#### 1. **Request/Response Objects Acumulados**

Todas as requests HTTP são armazenadas internamente até que um novo BrowserContext seja criado.

> "The objects for request/response/route get only flushed when a new context is created. If you're getting HTTP responses every two seconds, you can easily amass over 1GB of additional memory leakage within an hour."

**Fonte**: [Playwright Memory Leak Issue #15400](https://github.com/microsoft/playwright/issues/15400)

#### 2. **DOM Nodes Retidos**

Elementos do DOM removidos mas ainda referenciados por JavaScript (detached DOM trees) não são coletados pelo garbage collector.

#### 3. **Event Listeners e Intervals não Removidos**

```javascript
// ❌ LEAK - Interval nunca limpo
setInterval(() => {
  // polling...
}, 5000);

// ✅ CORRETO - Armazenar referência e limpar
this.interval = setInterval(...);
// ...
clearInterval(this.interval);
```

#### 4. **Contexts/Pages Não Fechados**

> "Reloading the page every 30 minutes doesn't free the memory. The only way to free the memory is closing the page and recreating a new one."

**Fonte**: [Memory increases when same context is used](https://github.com/microsoft/playwright/issues/6319)

#### 5. **Buffers Off-Heap Grandes**

ArrayBuffers, File objects alocados na memória nativa (C++) não são medidos por `heapUsed` mas aparecem em `rss` (Resident Set Size):

```javascript
const buffer = Buffer.alloc(100 * 1024 * 1024); // 100MB
// Isso aparece em `external` e `rss`, mas não em `heapUsed`
```

**Fonte**: [Node.js Memory Management - RSS vs Heap](https://medium.com/@dev.abdullah.muhammed/know-your-limits-node-js-memory-management-part-2-rss-buffers-and-the-off-heap-world-63bfdcff144a)

### 5.2 Impacto Real — Casos de Uso

- **Cenário**: Refresh de página a cada segundo por 20 minutos
- **Resultado**: 400MB+ de memória consumida
- **Cenário extremo**: Mais de 1GB em menos de 20 minutos

**Fonte**: [Playwright Memory Leak Discussion](https://github.com/microsoft/playwright/issues/15400)

### 5.3 Padrões para Evitar Memory Leaks

#### Pattern 1: Context Recycling

```javascript
class ContextManager {
  constructor(maxPagesPerContext = 10) {
    this.maxPagesPerContext = maxPagesPerContext;
    this.pageCount = 0;
    this.currentContext = null;
  }

  async getPage() {
    if (!this.currentContext || this.pageCount >= this.maxPagesPerContext) {
      await this.createNewContext();
    }

    this.pageCount++;
    return await this.currentContext.newPage();
  }

  async createNewContext() {
    // Fechar contexto anterior
    if (this.currentContext) {
      await this.currentContext.close();
    }

    // Criar novo contexto limpo
    this.currentContext = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      // Configurações que reduzem memória
      bypassCSP: false,
      reducedMotion: 'reduce'
    });

    this.pageCount = 0;
    console.log('Novo contexto criado (recycling)');
  }

  async shutdown() {
    if (this.currentContext) {
      await this.currentContext.close();
    }
  }
}
```

**Fonte**: [Memory Management Best Practices for Playwright](https://webscraping.ai/faq/playwright/what-are-the-memory-management-best-practices-when-running-long-playwright-sessions)

#### Pattern 2: Resource Blocking

```javascript
async blockUnnecessaryResources(context) {
  await context.route('**/*', (route, request) => {
    const resourceType = request.resourceType();

    // Bloquear imagens, fonts, stylesheets se não necessários
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });
}
```

**Fonte**: [Browserless - Memory Leak Prevention](https://www.browserless.io/blog/memory-leak-how-to-find-fix-prevent-them)

#### Pattern 3: Memory Monitoring com Auto-Restart

```javascript
class MemoryAwareManager {
  constructor() {
    this.memoryThreshold = 512 * 1024 * 1024; // 512MB heapUsed
    this.monitoringInterval = 30000; // 30 segundos
    this.startMonitoring();
  }

  startMonitoring() {
    setInterval(() => {
      const mem = process.memoryUsage();
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);

      console.log(`📊 Memória: Heap=${heapUsedMB}MB, RSS=${Math.round(mem.rss/1024/1024)}MB`);

      if (mem.heapUsed > this.memoryThreshold) {
        console.log('⚠️ Threshold excedido. Reiniciando sessão...');
        this.forceRecycle();
      }
    }, this.monitoringInterval);
  }

  async forceRecycle() {
    // Fechar todas as páginas e contextos
    await this.contextManager.shutdown();
    // Reiniciar
    await this.contextManager.createNewContext();
  }
}
```

**Fonte**: [Memory Management Best Practices for Playwright](https://webscraping.ai/faq/playwright/what-are-the-memory-management-best-practices-when-running-long-playwright-sessions)

#### Pattern 4: Try/Catch/Finally com Cleanup

```javascript
async executeWithCleanup(task) {
  let page, context;

  try {
    context = await this.browser.newContext();
    page = await context.newPage();
    const result = await task(page);
    return result;
  } finally {
    // Garantir cleanup mesmo em erro
    if (page && !page.isClosed()) {
      await page.close().catch(console.error);
    }
    if (context) {
      await context.close().catch(console.error);
    }
  }
}
```

#### Pattern 5: Browser Pool Management

Para alta carga comectar um pool de browsers:

```javascript
class BrowserPool {
  constructor(maxBrowsers = 3) {
    this.maxBrowsers = maxBrowsers;
    this.browsers = [];
    this.available = [];
    this.initialize();
  }

  async initialize() {
    for (let i = 0; i < this.maxBrowsers; i++) {
      const browser = await playwright.chromium.launch({
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          '--disable-background-timer-throttling',
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ]
      });
      this.browsers.push(browser);
      this.available.push(browser);
    }
  }

  async acquire() {
    if (this.available.length === 0) {
      await this.waitForAvailable();
    }
    return this.available.pop();
  }

  async release(browser) {
    // Reciclar context antes de devolver ao pool
    this.available.push(browser);
  }

  async shutdownAll() {
    await Promise.all(
      this.browsers.map(browser => browser.close())
    );
  }
}
```

---

## 6. Como Implementar Heartbeat para Detectar Clientes Desconectados

### 6.1 Heartbeat com WebSocket — Padrão Client/Server

#### Server-Side (Node.js com ws)

```javascript
const WebSocket = require('ws');

class WebSocketServerWithHeartbeat extends WebSocket.Server {
  constructor(server, options = {}) {
    super(server, options);

    this.PING_INTERVAL = 30000; // 30 segundos
    this.PONG_TIMEOUT = 10000;  // 10 segundos para responder
    this.HEARTBEAT_TIMEOUT = 45000; // 45 segundos sem heartbeat = morto

    this.setupHeartbeat();
  }

  setupHeartbeat() {
    // Enviar ping periódico para todos os clientes
    setInterval(() => {
      this.clients.forEach(ws => {
        if (ws.isAlive === false) {
          console.log('Cliente inativo, terminando conexão');
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping(() => {});
      });
    }, this.PING_INTERVAL);

    // Configurar handler para pong
    this.on('connection', (ws, req) => {
      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
        ws.lastPong = Date.now();
      });

      ws.on('close', () => {
        console.log('Cliente desconectado');
      });

      ws.on('error', (err) => {
        console.error('Erro WebSocket:', err);
      });

      // Heartbeat custom para sessões de browser
      this.setupSessionHeartbeat(ws);
    });
  }

  setupSessionHeartbeat(ws) {
    // Dar heartbeat da sessão juntamente com活动
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        // Monitorar mensagens específicas da sessão
        if (data.type === 'session:heartbeat' ||
            data.type === 'session:input') {
          ws.lastSessionActivity = Date.now();
        }
      } catch (err) {
        // JSON parse error, ignore
      }
    });

    // Monitorar inatividade da sessão separadamente
    setInterval(() => {
      if (!ws.lastSessionActivity) return;

      const idleTime = Date.now() - ws.lastSessionActivity;
      if (idleTime > 10 * 60 * 1000) { // 10 minutos
        console.log(`Sessão inativa há ${Math.round(idleTime/60000)}min`);
        // Notificar ou encerrar sessão
        this.emit('session-idle', { ws, idleTime });
      }
    }, 60000); // Checar a cada minuto
  }
}

// Implementação da biblioteca 'ws' (original)
if (!WebSocket.prototype.isAlive) {
  WebSocket.prototype.isAlive = true;
  WebSocket.prototype._heartbeat = function() {
    this.isAlive = true;
  };
}
```

#### Cliente-Side (Browser/Frontend)

```javascript
class HeartbeatClient {
  constructor(wsUrl, options = {}) {
    this.ws = new WebSocket(wsUrl);
    this.interval = options.interval || 30000;
    this.timeout = options.timeout || 10000;
    this.sessionId = options.sessionId;

    this.setupHandlers();
    this.startHeartbeat();
  }

  setupHandlers() {
    this.ws.onopen = () => {
      console.log('WebSocket conectado');
      this.sendHeartbeat(); // Enviar imediatamente
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'ping') {
          this.sendPong();
        }

        if (data.type === 'session:close') {
          this.handleServerClose(data);
        }
      } catch (err) {
        console.error('Erro ao processar mensagem:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.log('Conexão fechada:', event.code, event.reason);
      this.stopHeartbeat();
      this.reconnect();
    };

    this.ws.onerror = (err) => {
      console.error('Erro WebSocket:', err);
    };
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.interval);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatInterval);
  }

  sendHeartbeat() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'session:heartbeat',
        sessionId: this.sessionId,
        timestamp: Date.now()
      }));
    }
  }

  sendPong() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'pong',
        timestamp: Date.now()
      }));
    }
  }

  handleServerClose(data) {
    console.log('Servidor solicitou fechamento:', data.reason);
    this.ws.close(1000, data.reason);
  }

  reconnect() {
    setTimeout(() => {
      console.log('Tentando reconectar...');
      this.ws = new WebSocket(this.ws.url);
      this.setupHandlers();
      this.startHeartbeat();
    }, 5000);
  }
}
```

**Fonte**: [WebSocket Heartbeat Best Practices](https://stackoverflow.com/questions/12539072/how-to-keep-websocket-connection-alive)

### 6.2 Heartbeat em HTTP Long-Polling/SSE

Para conexões HTTP tradicionais (Server-Sent Events, polling):

```javascript
class HTTPHeartbeat {
  constructor() {
    this.lastSeen = new Map(); // sessionId -> timestamp
    this.timeout = 5 * 60 * 1000; // 5 minutos
  }

  update(sessionId) {
    this.lastSeen.set(sessionId, Date.now());
  }

  getStaleSessions() {
    const cutoff = Date.now() - this.timeout;
    return Array.from(this.lastSeen.entries())
      .filter(([id, timestamp]) => timestamp < cutoff)
      .map(([id]) => id);
  }

  cleanupStaleSessions(sessionManager) {
    const stale = this.getStaleSessions();
    stale.forEach(sessionId => {
      console.log(`Sessão stale detectada: ${sessionId}`);
      sessionManager.terminateSession(sessionId);
      this.lastSeen.delete(sessionId);
    });
  }
}
```

---

## 7. Limites Recomendados: Máximo de Sessões, Timeout, Memória por Sessão

### 7.1 Limites por Sessão Individual

#### Memória por Sessão Chrome

| Componente | Memória Estimada |
|------------|------------------|
| Processo Chrome browser | 80–150 MB |
| Processo GPU (se habilitado) | 30–50 MB |
| Processo renderer (por página) | 50–200 MB |
| Processo plugin/extensão | 10–30 MB |

**Total por sessão headless com 1 página**: **~200–400 MB**

**Fonte**: Baseado em [Chrome Memory Usage](https://www.browserless.io/blog/memory-leak-how-to-find-fix-prevent-them)

**Considerações**:
- **Com cache desativado** (`--disable-dev-shm-usage`): -50MB
- **Sem extensões**: -20MB
- **Headless vs Headed**: Headless usa ~15% menos memória
- **Viewport reduzido** (800x600 vs 1920x1080): -30% memória renderer

#### CPU por Sessão

- **Idle**: 0.1–0.5% CPU
- **Página estática**: 1–3% CPU
- **Vídeo/Streaming**: 5–15% CPU
- **JavaScript pesado**: 10–30% CPU

### 7.2 Limites no Node.js

```javascript
// Configure Node.js para browsers pesados
const MAX_OLD_SPACE_SIZE = 4096; // 4GB para processos browser-heavy

process.memoryUsage(); // Monitorar
// {
//   rss: 200000000,        // Total RAM usada pelo processo
//   heapTotal: 180000000,  // Heap total reservado
//   heapUsed: 120000000,   // Heap em uso atualmente
//   external: 5000000      // Buffers C++
// }
```

**Regra de ouro**:
- `heapUsed` < 70% de `heapTotal`
- `rss` < 80% da RAM disponível do container
- Threshold de alerta: `heapUsed > 512MB`

**Fonte**: [Node.js Memory Understanding](https://nodejs.org/en/learn/diagnostics/memory/understanding-and-tuning-memory)

### 7.3 Máximo de Sessões Concurrentes

#### Por Container

```javascript
// Cálculo conservador
const MEMORY_PER_SESSION = 512 * 1024 * 1024; // 512MB por sessão
const SYSTEM_MEMORY = 4 * 1024 * 1024 * 1024; // 4GB total
const SAFETY_MARGIN = 0.2; // 20% para sistema + buffer

const maxSessions = Math.floor(
  (SYSTEM_MEMORY * (1 - SAFETY_MARGIN)) / MEMORY_PER_SESSION
);

// 4GB container → max 6 sessões simultâneas
```

**Recomendações práticas**:

| Tipo de Container | Memória Total | Sessões Simultâneas Máximo |
|-------------------|---------------|----------------------------|
| Small (2GB) | 2GB | 2–3 sessões |
| Medium (4GB) | 4GB | 6–8 sessões |
| Large (8GB) | 8GB | 12–15 sessões |
| XL (16GB) | 16GB | 25–30 sessões |

#### Por Cliente/Utilizador

- **Pessoal/FREE**: 1 sessão simultânea
- **Team/Pro (por user)**: 3–5 sessões simultâneas
- **Enterprise**: 10+ sessões (com rate limiting)

#### Global Rate Limiting

```javascript
// Exemplo de rate limiting por IP
const rateLimit = require('express-rate-limit');

const sessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10, // máximo 10 sessões por hora
  message: 'Limite de sessões excedido. Tente novamente mais tarde.'
});

app.post('/api/sessions/create', sessionLimiter, createSession);
```

### 7.4 Timeouts Recomendados

| Timeout | Valor Recomendado | Caso de Uso |
|---------|------------------|-------------|
| Sessão inativa (idle) | 10 minutos | Auto-close |
| Sessão absoluta (max age) | 2 horas | Forced cleanup |
| WebSocket ping/pong | 30 segundos | Detect connection loss |
| HTTP request timeout | 60 segundos | Browser commands |
| Browser launch timeout | 30 segundos | Launch startup |
| Context creation | 15 segundos | New context |
| Page navigation | 30 segundos | goto() |
| Graceful shutdown | 10–30 segundos | SIGTERM handling |
| Force kill (fallback) | 5 segundos | After graceful timeout |

**Fonte**: [Playwright Timeout Configuration](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-default-timeout)

### 7.5 Configuração Docker

```dockerfile
# Limitar recursos do container
docker run \
  --memory=4g \
  --memory-swap=4g \
  --memory-reservation=3g \
  --cpus=2 \
  --pids-limit=200 \
  your-browser-image

# No docker-compose.yml
services:
  browser:
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2.0'
        reservations:
          memory: 3G
```

---

## 8. Como o Browserbase Gerencia Lifecycle de Sessões

⚠️ **Nota**: A documentação oficial do Browserbase sobre detalhes internos de gerenciamento de sessões é limitada. Esta seção é baseada em padrões da indústria e inferências das APIs disponíveis.

### 8.1 API de Sessões do Browserbase

```javascript
// Criar sessão
const session = await browserbase.sessions.create({
  projectId: 'proj_xxx',
  timeout: 1800, // segundos (30 minutos default)
  maxIdleTime: 600, // 10 minutos inativo
  browser: 'chromium', // ou 'firefox', 'webkit'
  proxy: 'optional-proxy-url',
  headless: true
});

// Conectar via CDP ou WebSocket
const wsUrl = session.connectUrl;

// Cleanup explícito
await session.close();
```

### 8.2 Features Esperadas (Padrão da Indústria)

#### 1. **Auto-Timeout e Cleanup Automático**

- Sessões automaticamente fechadas após `timeout` segundos (default: 30min)
- Sessões inativas (`maxIdleTime`) são encerradas
- Algoritmo LRU (Least Recently Used) para limpeza quando资源限 reached

#### 2. **Recycle de Recursos**

- Nova sessão = novo browser profile isolado
- Perfis são destruídos após timeout
- Cache limpo entre sessões

#### 3. **Monitoramento e Métricas**

Esperado que o Browserbase monitore:
- **Sessões ativas por projeto**
- **Memória média por sessão**
- **CPU utilizada**
- **Tempo médio de vida útil**
- **Falhas de lancamento**

#### 4. **Rate Limiting e Quotas**

Provavelmente implementam:
- Máximo de sessões concorrentes por project (ex: 10, 50, 100)
- Limite de criações por minuto/hora
- Burst capacity control

#### 5. **Graceful Shutdown de Infraestrutura**

Em escala multi-tenant:
- Health checks periódicos
- Detecção de containers unhealthy (memória, CPU)
- Auto-restart de workers
- Drain connections antes de shutdown

### 8.3 Comparação com Outros Serviços

| Serviço | Timeout Padrão | Max Concurrente | Persistência |
|---------|----------------|-----------------|--------------|
| **Browserbase** | 30 min (configurável) | Por plan (10–1000+) | Per-profile option |
| **Browserless** | 30 min | Rate-limited | Sem persistência |
| **Playwright Cloud** | 15 min | 5–50 por key | None |
| **Puppeteer Cluster** | Custom | Ilimitado (self-hosted) | Custom |

### 8.4 Recomendações para Implementação Própria

Se estiver construindo uma solução similar ao Browserbase:

1. **Isolamento de Sessões**
   - Cada sessão tenhaprProfile separado (userDataDir)
   - Limpar profile ao fechar sessão
   - Não reutilizar profiles entre tenants

2. **Auto-Recovery**
   - Retry com exponential backoff se lançamento falhar
   - Health check de browser pós-launch
   - Fallback para headless se headed falhar

3. **Observabilidade**
   ```javascript
   class SessionMetrics {
     recordLaunchTime(sessionId, duration) { ... }
     recordMemoryUsage(sessionId, heapUsed, rss) { ... }
     recordErrors(sessionId, error) { ... }
     getProjectHealth(projectId) { ... }
   }
   ```

4. **Graceful Degradation**
   - Se memória > threshold por sessão → warn e close
   - Se CPU > 80% → throttle ou close sessões idle
   - Se erro repeated → ban da sessão por cooling-off period

5. **Security Isolation**
   - Cada sessão em sandbox separada (user namespace)
   - Sem acesso à host filesystem (mounts read-only)
   - Network isolation por sessão (VPC, network policies)

---

## 9. Checklist de Implementação

### Antes de Production

- [ ] Implementar session tracker server-side
- [ ] Configurar timeouts apropriados por tipo de uso
- [ ] Add graceful shutdown handlers (SIGTERM/SIGINT)
- [ ] Add memory monitoring com thresholds
- [ ] Implement context recycling (max 10 páginas por contexto)
- [ ] Setup WebSocket heartbeat (ping 30s, timeout 10s)
- [ ] Add resource blocking (imagens, fonts se desnecessárias)
- [ ] Configure Docker limits (memória, CPUs, pids)
- [ ] Setup logging de session lifecycle (create, activity, close)
- [ ] Testar graceful shutdown em staging
- [ ] Load test com 10x concorrência planejada
- [ ] Documentar procedures de troubleshooting de memory leaks

### Monitorização Contínua

- [ ] Alertas para `heapUsed > 512MB` por sessão
- [ ] Alertas para `rss > 1GB` por container
- [ ] Métricas: sessões ativas, idle, média de duração
- [ ] Log aggregation de session timeouts e erros
- [ ] Audit trail de criação/remoção de sessões

---

## 10. Referências e Fontes

### Documentação Oficial

- [Node.js Memory Management](https://nodejs.org/en/learn/diagnostics/memory/understanding-and-tuning-memory)
- [Playwright Browser Contexts](https://playwright.dev/docs/browser-contexts)
- [MDN - Idle Detection API](https://developer.mozilla.org/en-US/docs/Web/API/IdleDetector)
- [Docker Graceful Shutdown](https://docs.docker.com/engine/reference/run/#stop-signal)

### Artigos Técnicos

- [Graceful Shutdown in Node.js](https://dev.to/superiqbal7/graceful-shutdown-in-nodejs-handling-stranger-danger-29jo) — DEV Community
- [Memory Management Best Practices for Playwright](https://webscraping.ai/faq/playwright/what-are-the-memory-management-best-practices-when-running-long-playwright-sessions) — WebScraping.AI
- [Browserless - Memory Leak Prevention](https://www.browserless.io/blog/memory-leak-how-to-find-fix-prevent-them) — Browserless
- [Session Management Best Practices](https://dev.to/jscrambler/best-practices-for-secure-session-management-in-node-3f01) — DEV Community
- [Node.js Memory: RSS, Heap, External](https://medium.com/@dev.abdullah.muhammed/know-your-limits-node-js-memory-management-part-2-rss-buffers-and-the-off-heap-world-63bfdcff144a) — Medium

### GitHub Issues

- [Playwright Memory Leak Issue #15400](https://github.com/microsoft/playwright/issues/15400)
- [Playwright Memory Increases with Reused Context #6319](https://github.com/microsoft/playwright/issues/6319)
- [Chromium Bugzilla - SIGTERM Handling](https://bugzilla.mozilla.org/show_bug.cgi?id=336193)

### Ferramentas

- Clinic.js HeapProfiler — https://clinicjs.org/
- Chrome DevTools Memory Tab
- heapdump npm package
- `process.memoryUsage()` — built-in Node.js

---

## 11. Conclusão

A gestão eficaz de sessões de browser remoto requer atenção a:

1. **Timeouts estratégicos** — balancear user experience vs resource conservation
2. **Deteção proativa de inatividade** — usar client-side + server-side tracking
3. **Graceful shutdown robusto** — SIGTERM suportado, cleanup ordenado
4. **Prevenção de memory leaks** — context recycling, proper cleanup, monitoring
5. **Heartbeat mecanismo** — WebSocket ping/pong + HTTP heartbeat fallback
6. **Limites realistas** — memory per sessão ~300–500MB, calcular max concurrente
7. **Observabilidade** — métricas, alertas, logs detalhados

Implementando estes padrões, sistemas de remote browser podem escalar de dezenas para milhares de sessões concorrentes com estabilidade e previsibilidade.

---

**Última atualização**: 2025-03-17 (pesquisa baseada em 2024-2025)