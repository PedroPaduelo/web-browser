# Node.js Process Management para Chrome/Chromium

*Guia completo sobre spawn, gerenciamento, cleanup e monitoramento de processos Chrome em Node.js*

---

## 📋 Sumário

1. [Introdução](#introdução)
2. [Métodos child_process: spawn vs exec vs fork](#métodos-child_process-spawn-vs-exec-vs-fork)
3. [Spawnando Chrome com child_process.spawn](#spawnando-chrome-com-child_processspawn)
4. [Arquitetura: Como o Puppeteer Gerencia Chrome](#arquitetura-como-o-puppeteer-gerencia-chrome)
5. [Process Cleanup e Graceful Shutdown](#process-cleanup-e-graceful-shutdown)
6. [SIGTERM/SIGKILL: Ordem Correta de Shutdown](#sigtermsigkill-ordem-correta-de-shutdown)
7. [Zombie Processes: Prevenção e Limpeza](#zombie-processes-prevenção-e-limpeza)
8. [Memory Monitoring de Processos Filhos](#memory-monitoring-de-processos-filhos)
9. [Auto-Restart de Chrome que Crasha](#auto-restart-de-chrome-que-crasha)
10. [Exemplo Completo: Chrome Manager Class](#exemplo-completo-chrome-manager-class)
11. [Boas Práticas e Checklist](#boas-práticas-e-checklist)

---

## Introdução

Gerenciar processos Chrome/Chromium em Node.js é um desafio complexo que envolve:

- **Spawn do processo Chrome** com flags apropriadas
- **Gerenciamento de ciclo de vida** (start, stop, restart, health check)
- **Cleanup graceful** para evitar zombie processes
- **Signal handling** (SIGTERM, SIGKILL, SIGINT)
- **Memory monitoring** para detectar leaks
- **Recovery automático** em caso de crashes

Este documento apresenta padrões de arquitetura testados em produção, baseados em lições do Puppeteer, run-headless-chromium e experiências da comunidade Node.js.

---

## Métodos child_process: spawn vs exec vs fork

### Comparação Rápida

| Método | Buffering | Stream | IPC | Use-case para Chrome |
|--------|-----------|--------|-----|---------------------|
| `exec` | ✅ (bufferiza tudo) | ❌ | ❌ | NÃO RECOMENDADO (pode estourar buffer) |
| `spawn` | ❌ | ✅ (stream) | ❌ | ✅ **RECOMENDADO** |
| `fork` | ❌ | ✅ (stream) | ✅ (message channel) | ⚠️ Só para Node.js |

### 1. `child_process.exec()` ❌ NÃO USE para Chrome

```javascript
const { exec } = require('child_process');

// ❌ PROBLEMA: Buffer limit (200KB padrão)
// Chrome gera MUITA saída que estoura o buffer
exec('google-chrome --headless', (error, stdout, stderr) => {
  // NEVER CHEGA AQUI - Chrome nunca termina sozinho!
});
```

**Por que não usar:**
- Buffer limit padrão é 200KB
- Chrome headless roda indefinidamente, nunca termina
- stdout/stderr são bufferizados (perde logs em tempo real)
- Sem streaming, impossível monitorar output

### 2. `child_process.spawn()` ✅ RECOMENDADO

```javascript
const { spawn } = require('child_process');

const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--remote-debugging-port=9222',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  'about:blank'
], {
  stdio: 'pipe',           // Pipe para capturar stdout/stderr
  detached: false,         // Manter child process vinculado
  shell: false             // Evitar shell injection
});

// Stream contínuo de output
chrome.stdout.on('data', (data) => {
  console.log(`Chrome stdout: ${data}`);
});

chrome.stderr.on('data', (data) => {
  console.error(`Chrome stderr: ${data}`);
});

// Evento de saída
chrome.on('exit', (code, signal) => {
  console.log(`Chrome exitou com código ${code}, sinal ${signal}`);
});
```

**Vantagens:**
- ✅ Streaming de stdout/stderr (sem buffer limit)
- ✅ Controle direto sobre o processo
- ✅ Pode matar processo a qualquer momento
- ✅ Acesso direto ao PID
- ✅ Baixa overhead

**Flags importantes:**
```javascript
const chromeFlags = [
  '--headless=new',              // Chrome 109+ headless mode
  '--no-sandbox',               // Necessário em Docker (cuidado: security)
  '--disable-setuid-sandbox',   // Complemento do no-sandbox
  '--remote-debugging-port=9222',
  '--disable-dev-shm-usage',    // Evita /dev/shm full em Docker
  '--disable-gpu',             // Desativa GPU (sem display)
  '--disable-software-rasterizer',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--mute-audio',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-translate',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-background-networking',
  '--disable-features=AudioServiceOutOfProcess',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--user-data-dir=/tmp/chrome-profile-' + Date.now()
];
```

### 3. `child_process.fork()` ❌ NÃO USE para Chrome

```javascript
const { fork } = require('child_process');

// ❌ Erro: fork só executa arquivos JavaScript Node.js!
// Chrome é binário nativo, não funciona
const chrome = fork('/usr/bin/google-chrome'); // ERRO!
```

**Onde usar fork:**
- Processos filho Node.js que precisam de IPC
- Workers para computação paralela
- Isolamento de módulos nativos problemáticos

---

## Como Puppeteer Gerencia Processos Chrome

O Puppeteer é a referência de arquitetura para gerenciar Chrome. Entender seu código fonte revela padrões críticos.

### Puppeteer BrowserRunner (conceitual)

```javascript
// Baseado no código do Puppeteer (lib/BrowserRunner.ts)

class BrowserRunner {
  constructor() {
    this._process = null;
    this._closed = false;
    this._listeningPromise = null;
  }

  async launch(config) {
    const executablePath = config.executablePath;
    const args = this._buildChromeArgs(config);

    // 1. Spawn do processo Chrome
    this._process = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // ⚠️ IMPORANTE: child fica independente
      cwd: config.userDataDir || os.tmpdir()
    });

    // 2. Pipe imediato de stdout/stderr
    this._setupPipes();

    // 3. Monitorar processo para crash detection
    this._process.on('exit', (code, signal) => {
      if (!this._closed) {
        this._handleCrash(code, signal);
      }
    });

    // 4. Aguardar debugger port ficar disponível
    await this._waitForListening();

    return this._process;
  }

  async close() {
    this._closed = true;

    if (!this._process) return;

    // 5. Graceful shutdown via CDP (Chrome DevTools Protocol)
    try {
      await this._sendCloseViaCDP();
    } catch (e) {
      console.warn('Failed to close via CDP:', e);
    }

    // 6. Aguardar processo terminar voluntariamente
    const exited = await this._waitForExit(5000);

    if (!exited) {
      // 7. Forçar kill se não sair
      await this._killProcess();
    }
  }

  _setupPipes() {
    // Capturar stderr para detectar erros
    this._process.stderr.on('data', (data) => {
      const message = data.toString();
      if (this._isCrashMessage(message)) {
        this._maybeMarkAsCrash();
      }
    });

    // Limitar buffer de stdout se não for consumido
    this._process.stdout.on('data', (data) => {
      // Processar ou descartar
    });
  }

  async _killProcess() {
    // Ordem: SIGTERM → aguarda → SIGKILL
    process.kill(-this._process.pid, 'SIGTERM');

    await this._waitForExit(3000);

    if (this._process.exitCode === null) {
      process.kill(-this._process.pid, 'SIGKILL');
      await this._waitForExit(2000);
    }
  }
}
```

### Lições da Arquitetura do Puppeteer

1. **`detached: true`** - Chrome fica independente do parent Node
   ```javascript
   detached: true  // Chrome vira "órfão" propositalmente
   ```
   - Quando Node morre, Chrome continua rodando
   - Precisamos gerenciar manualmente o processo Chrome
   - Permite que Chrome sobreviva a restart do processo pai

2. **Close via CDP primeiro** - Fecha abas gracefully
   ```javascript
   // Usar Chrome DevTools Protocol para fechar todas as páginas
   await client.send('Browser.close');
   ```
   - Dispara eventos `beforeunload` nas páginas
   - Permite salvar estado, fechar conexões
   - Chrome sai mais rápido e limpo

3. **SIGTERM antes de SIGKILL** - Graceful → Force
   ```javascript
   process.kill(-pid, 'SIGTERM');  // Graceful shutdown
   await wait(5000);
   if (stillRunning) {
     process.kill(-pid, 'SIGKILL');  // Force kill
   }
   ```

4. **Monitorar stderr para detecção de crash**
   ```javascript
   stderr.on('data', (data) => {
     if (data.includes('Chrome failed to start')) {
       this._crashDetected = true;
     }
   });
   ```

5. **`-pid` no process.kill()** - Mata todo o processo group
   ```javascript
   process.kill(-pid, 'SIGTERM');  // Sinal para todo o processo group
   ```
   - Sinal negativo mata o processo e todos os children
   - Útil quando Chrome spawnou outros processos

---

## Process Cleanup e Graceful Shutdown

### O Problema do Cleanup

Quando Node.js morre abruptamente (SIGKILL, crash, `process.exit(1)`), os processos filhos **não são automaticamente terminados** se `detached: true`.

**Exemplo de processo órfão:**
```bash
# Antes de matar Node:
$ ps aux | grep chrome
user   12345  0.5%  Chrome...
user   12346  0.3%  Xvfb...

# Depois de SIGKILL no Node (PID 10000):
$ ps aux | grep chrome
user   12345  0.5%  Chrome...   <-- Orfão! ppid mudou para 1
user   12346  0.3%  Xvfb...    <-- Orfão!
```

### Solution 1: Signal Forwarding (SIGTERM → Chrome)

```javascript
const { spawn } = require('child_process');

class ChromeProcess {
  constructor() {
    this.chrome = null;
    this.xvfb = null;
  }

  async start() {
    // Spawn Xvfb se necessário
    this.xvfb = this._startXvfb();

    // Spawn Chrome
    this.chrome = spawn('google-chrome', [
      '--headless=new',
      `--remote-debugging-port=${this.port}`,
      '--no-sandbox'
    ], {
      detached: false,  // Manter vinculado ao parent
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Setup signal forwarding
    this._setupSignalHandling();
  }

  _setupSignalHandling() {
    // Capturar sinais do sistema e repassar para Chrome
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    signals.forEach(signal => {
      process.on(signal, () => {
        console.log(`Recebido ${signal}, fechando Chrome...`);
        this._gracefulShutdown(signal);
      });
    });

    // Capturar exit para cleanup final
    process.on('exit', (code) => {
      console.log(`Processo Node saindo com código ${code}`);
      this._forceKillAll();
    });

    // Capturar uncaughtException
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      this._forceKillAll();
      process.exit(1);
    });

    // Capturar unhandledRejection
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled rejection:', reason);
      this._gracefulShutdown('SIGTERM');
    });
  }

  async _gracefulShutdown(signal) {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    console.log(`Iniciando graceful shutdown (sinal: ${signal})`);

    try {
      // 1. Tentar fechar via CDP (Chrome DevTools Protocol)
      if (this.client) {
        await this._closeViaCDP();
      }

      // 2. Aguardar processo sair voluntariamente
      const exited = await this._waitForProcess(5000);

      if (!exited) {
        // 3. SIGTERM para Chrome e todos os children
        this._killProcessTree(this.chrome.pid, 'SIGTERM');
        await this._waitForProcess(3000);
      }

      if (!this._isProcessGone(this.chrome)) {
        // 4. SIGKILL como último recurso
        console.warn('Chrome não respondeu ao SIGTERM, usando SIGKILL');
        this._killProcessTree(this.chrome.pid, 'SIGKILL');
      }
    } catch (error) {
      console.error('Erro durante shutdown:', error);
      this._forceKillAll();
    } finally {
      // Limpar Xvfb se existir
      if (this.xvfb) {
        this._killProcessTree(this.xvfb.pid, 'SIGTERM');
      }

      process.exit(0);
    }
  }

  _forceKillAll() {
    // Kill recursivo de todos os processos
    this._killProcessTree(this.chrome?.pid, 'SIGKILL');
    this._killProcessTree(this.xvfb?.pid, 'SIGKILL');
  }

  _killProcessTree(pid, signal) {
    if (!pid) return;

    try {
      // Sinal negativo mata o processo group inteiro
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') { // ESRCH = processo não existe
        console.warn(`Erro ao matar PID ${pid}:`, error.message);
      }
    }
  }

  _waitForProcess(timeout) {
    return new Promise((resolve) => {
      if (!this.chrome) {
        resolve(true);
        return;
      }

      const start = Date.now();

      const checkInterval = setInterval(() => {
        if (this._isProcessGone(this.chrome)) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (Date.now() - start > timeout) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 100);
    });
  }

  _isProcessGone(process) {
    // Verificar se processo ainda existe
    try {
      process.kill(0); // Sinal 0 só verifica existência
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      return false;
    }
  }
}
```

### Solution 2: Child-Killer Module (Recomendado)

```javascript
// npm install child-killer
const childKiller = require('child-killer');

class ChromeManager {
  async start() {
    this.chrome = spawn('google-chrome', args, {
      detached: true  // Problema: Chrome fica órfão!
    });

    // child-killer automaticamente limpa filhos órfãos
    childKiller(this.chrome.pid);
  }

  async stop() {
    if (this.chrome) {
      await this.chrome.kill('SIGTERM');
    }
  }
}
```

**Como o child-killer funciona:**
- Monitora o processo parent (Chrome)
- Quando Chrome morre, mata todos os seus children
- Adiciona wrappers nos sinais SIGINT, SIGTERM, SIGHUP
- Elimina zombie processes

### Solution 3: Process Tree Kill (pidtree)

```javascript
// npm install pidtree
const pidtree = require('pidtree');

async function killProcessTree(pid, signal = 'SIGTERM') {
  try {
    // 1. Encontrar todos os PIDs na árvore
    const pids = await pidtree(pid);
    // Ex: [12345 (Chrome), 12346 (GPU), 12347 (utility), ...]

    // 2. Matar todos (do leaf para root)
    pids.reverse().forEach(childPid => {
      try {
        process.kill(childPid, signal);
      } catch (error) {
        // Ignorar ESRCH (processo já morreu)
      }
    });
  } catch (error) {
    console.warn('pidtree error:', error.message);
  }
}
```

---

## SIGTERM/SIGKILL: Ordem Correta de Shutdown

### Diferenças entre Sinais

| Sinal | Número | Ação | Quando usar |
|-------|--------|------|-------------|
| `SIGTERM` | 15 | Graceful termination | Primeiro, sempre |
| `SIGINT` | 2 | Interrupt (Ctrl+C) | Interactive |
| `SIGKILL` | 9 | Kill imediato, unforgiving | Último recurso |
| `SIGQUIT` | 3 | Quit + core dump | Debug |
| `SIGHUP` | 1 | Hangup (reload config) | Restart |

### Shutdown Sequence Padrão

```javascript
async function shutdownSequence(chromePid) {
  console.log('Iniciando shutdown sequence...');

  // Step 1: Enviar SIGTERM (graceful)
  console.log('[1/5] Enviando SIGTERM...');
  process.kill(-chromePid, 'SIGTERM');

  // Step 2: Aguardar 5 segundos
  await wait(5000);

  if (!isProcessAlive(chromePid)) {
    console.log('[✓] Chrome fechou gracefully em <5s');
    return true;
  }

  // Step 3: Enviar SIGINT (interrupt)
  console.log('[2/5] Chrome ainda rodando, enviando SIGINT...');
  process.kill(-chromePid, 'SIGINT');
  await wait(3000);

  if (!isProcessAlive(chromePid)) {
    console.log('[✓] Chrome fechou após SIGINT');
    return true;
  }

  // Step 4: SIGKILL (forçado)
  console.log('[3/5] Chrome resistente, usando SIGKILL...');
  process.kill(-chromePid, 'SIGKILL');
  await wait(2000);

  if (!isProcessAlive(chromePid)) {
    console.log('[✓] Chrome morto com SIGKILL');
    return true;
  }

  // Step 5: Fallback - mata todo o processo group
  console.log('[4/5] SIGKILL falhou, matando processo group...');
  process.kill(-chromePid, 'SIGKILL');
  process.kill(-chromePid, 'SIGKILL'); // Duplo kill

  await wait(1000);

  // Step 6: Emergency - force kill via killall
  console.log('[5/5] Usando killall como último recurso...');
  execSync(`killall -9 chrome chromium 2>/dev/null || true`);

  return !isProcessAlive(chromePid);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'ESRCH'; // Não existe
  }
}
```

### Por que o Sinal Negativo (`-pid`)?

```javascript
process.kill(12345, 'SIGTERM');   // Mata APENAS PID 12345

process.kill(-12345, 'SIGTERM');  // Mata TODO o processo GROUP
                                  // (PID 12345 + todos os children)
```

**Process Groups:**
- Quando `detached: true`, Chrome cria um novo processo group
- O PID do grupo é o mesmo do processo líder
- Sinal negativo envia para todos no grupo
- **IMPORTANTE**: Funciona apenas se o Chrome foi spawnado no mesmo user namespace

---

## Zombie Processes: Prevenção e Limpeza

### O Que São Zombies?

```bash
# Zombie: processo terminado mas não "reaped" pelo parent
$ ps aux | grep chrome
user   12345  0.0%  Z+   <defunct>   # <-- ZOMBIE!
user   10000  0.1%  node src/server.js

# Orphan: processo ainda rodando mas sem parent válido
user   12346  5.2%  chrome      # <-- ORPHAN (ppid=1)
```

**Zombie成因 (Formação):**
```
1. Parent spawns child (Chrome)
2. Child termina (crash, SIGTERM, etc)
3. Parent NÃO chama wait()/waitpid()
4. Kernel mantém entrada na process table (Zombie)
5. Parent morre → Zombie vira Orphan (ppid=1)
6. init (PID 1) adota e reapiza após intervalo
```

### Problemas Causados

- **Consome PID** (cada zombie usa um PID, limite ~32768)
- **Process table cheia** → `fork(): Cannot allocate memory`
- **Memory leak indireto** (kernel mantém metadata)
- **Difícil diagnosticar** (ps mostra como `<defunct>`)

### Prevenção 1: Sempre Esperar `exit` Event

```javascript
const chrome = spawn('google-chrome', args);

// ✅ CORRETO: Esperar evento 'exit' (ou 'close')
chrome.on('exit', (code, signal) => {
  console.log(`Chrome exitou, código ${code}, sinal ${signal}`);
  // Kernel automaticamente "reaps" o processo aqui
});

// ❌ ERRADO: Ignorar evento exit
// Se ignorar, vira zombie quando morrer
```

**`exit` vs `close`:**
- `exit` - Processo terminou (código de saída disponível)
- `close` - Streams fechados (mais confiável para spawn)
- Usar ambos:

```javascript
chrome.on('exit', handleExit);
chrome.on('close', handleExit);
```

### Prevenção 2: `unref()` em Processos Órfãos Propositais

```javascript
// Se você QUER que Chrome sobreviva ao Node (detached: true):
const chrome = spawn('google-chrome', args, {
  detached: true,
  stdio: 'ignore'
});

// Importante: Chamar unref() permite que Node saia mesmo
// com Chrome ainda rodando (Chrome não vira zombie)
chrome.unref();

// Node pode morrer agora sem bloquear
// Chrome continua rodando como processo independente
```

**Como `unref()` funciona:**
```javascript
// Sem unref():
process.nextTick(() => console.log('Impossível Node sair'));
// Event loop mantém processo vivo

// Com unref():
chrome.unref();
process.nextTick(() => console.log('Node pode sair agora'));
// Chrome não mantém event loop ativo
```

### Prevenção 3: Tratar Todos os Sinais

```javascript
class ChromeManager {
  constructor() {
    this.chrome = null;
    this._setupSignalHandlers();
  }

  _setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`Signal ${signal} recebido`);

        // 1. Fechar gracefully
        await this._gracefulShutdown();

        // 2. Exit com código apropriado
        const exitCode = signal === 'SIGINT' ? 0 : 1;
        process.exit(exitCode);
      });
    });

    // Capturar exceptions não tratados
    process.on('uncaughtException', async (error) => {
      console.error('Uncaught exception:', error);
      await this._forceKillAll();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('Unhandled rejection:', reason);
      await this._gracefulShutdown();
      process.exit(1);
    });
  }
}
```

### Prevenção 4: Child-Killer Automático

```javascript
// child-killer cuida de zombies automaticamente
const childKiller = require('child-killer');

const chrome = spawn('google-chrome', args);

// child-killer adiciona handlers:
// - SIGINT, SIGTERM: mata Chrome e todos os children
// - 'exit' do parent: mata Chrome se ainda rodando
childKiller(chrome.pid);
```

### Limpeza Manual de Zombies Existentes

```bash
# 1. Listar zombies
$ ps aux | grep 'defunct'
user   12345  0.0%  Z+   <defunct>

# 2. Encontrar parent (PPID) do zombie
$ ps -o ppid= -p 12345
10000

# 3. Matar parent (que vai "reap" o zombie)
$ kill -SIGTERM 10000

# 4. Verificar se zombie sumiu
$ ps aux | grep 12345
# Nada (zombie foi reapado)
```

### Script de Limpeza Automática

```javascript
#!/usr/bin/env node

// zombie-cleanup.js - Executar periodicamente
const { execSync } = require('child_process');

function cleanupZombies() {
  try {
    // Encontrar todos os zombies
    const zombies = execSync(
      "ps aux | grep '<defunct>' | awk '{print $2}'"
    ).toString().trim().split('\n').filter(Boolean);

    if (zombies.length > 0) {
      console.log(`[${new Date().toISOString()}] Encontrados ${zombies.length} zombies`);

      zombies.forEach(pid => {
        try {
          // Encontrar parent do zombie
          const ppid = execSync(`ps -o ppid= -p ${pid}`)
            .toString().trim();

          // Matar parent para reapizar zombie
          if (ppid && ppid !== '1') {
            console.log(`  Zombie PID ${pid} (parent: ${ppid})`);
            execSync(`kill -SIGTERM ${ppid} 2>/dev/null`);
          }
        } catch (error) {
          // Zombie já foi limpo por outro processo
        }
      });
    }
  } catch (error) {
    // Erro ao listar processos (normal se não houver zombies)
  }
}

// Executar a cada 30 segundos
setInterval(cleanupZombies, 30000);

// Executar imediatamente
cleanupZombies();
```

---

## Memory Monitoring de Processos Filhos

### Por que Monitorar Memória?

```javascript
// Problema típico: Chrome vazando memória ao longo do tempo
// 00:00: Uso 200MB
// 06:00: Uso 1.5GB  <-- Memory leak!
// 12:00: OOM kill do processo
```

### 1. Monitorar Processo Node (Pai)

```javascript
class MemoryMonitor {
  constructor() {
    this.samples = [];
    this.maxSamples = 100;
  }

  start(intervalMs = 30000) {
    this.interval = setInterval(() => {
      this._collectSample();
      this._analyze();
    }, intervalMs);
  }

  stop() {
    clearInterval(this.interval);
  }

  _collectSample() {
    const mem = process.memoryUsage();
    const sample = {
      timestamp: Date.now(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external
    };

    this.samples.push(sample);

    // Manter apenas últimas N amostras
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  _analyze() {
    if (this.samples.length < 10) return;

    const window = this.samples.slice(-10);
    const avgGrowth = this._calculateGrowth(window);

    console.log(`[Memory] RSS: ${(this.samples[this.samples.length-1].rss / 1024 / 1024).toFixed(1)}MB | Crescimento médio: ${avgGrowth.toFixed(2)}MB/min`);

    // Alertar se crescimento acelerado (>100MB/min)
    if (avgGrowth > 100) {
      console.warn('[ALERTA] Crescimento de memória detectado:', avgGrowth, 'MB/min');
    }
  }

  _calculateGrowth(samples) {
    if (samples.length < 2) return 0;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const timeMinutes = (last.timestamp - first.timestamp) / 1000 / 60;

    if (timeMinutes === 0) return 0;

    const rssGrowthBytes = last.rss - first.rss;
    const rssGrowthMB = rssGrowthBytes / 1024 / 1024;

    return rssGrowthMB / timeMinutes;
  }

  getCurrentUsage() {
    return process.memoryUsage();
  }
}
```

### 2. Monitorar Processo Chrome (Filho) via PID

Node.js **não** tem API nativa para ler memória de processos filhos. Precisamos de workarounds:

#### Opção A: Leitura via `/proc/<pid>/status` (Linux)

```javascript
function getProcessMemory(pid) {
  return new Promise((resolve, reject) => {
    try {
      const status = require('fs').readFileSync(`/proc/${pid}/status`, 'utf8');

      const parse = (key) => {
        const match = status.match(new RegExp(`${key}:\\s+(\\d+)`));
        return match ? parseInt(match[1], 10) * 1024 : 0; // KB → bytes
      };

      resolve({
        rss: parse('VmRSS'),          // Resident Set Size
        vsz: parse('VmSize'),         // Virtual Memory Size
        heap: parse('VmData'),        // Heap size
        stack: parse('VmStk'),        // Stack size
        swap: parse('VmSwap')         // Swap usage
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Uso
async function monitorChromeMemory(chromePid) {
  try {
    const mem = await getProcessMemory(chromePid);
    console.log(`Chrome (PID ${chromePid}) RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);
    return mem;
  } catch (error) {
    console.error('Processo Chrome já morreu?', error.message);
    return null;
  }
}
```

#### Opção B: Usar `pidusage` (npm)

```javascript
// npm install pidusage
const pidusage = require('pidusage');

async function monitorChromeMemory(chromePid) {
  try {
    const stats = await pidusage(chromePid);

    console.log(`Chrome (PID ${chromePid}):
      CPU: ${stats.cpu.toFixed(1)}%
      Memory: ${(stats.memory / 1024 / 1024).toFixed(1)}MB
      VSZ: ${(stats.vsz / 1024 / 1024).toFixed(1)}MB
    `);

    return stats;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Processo Chrome não existe mais');
    } else {
      console.error('Erro ao monitorar:', error);
    }
    return null;
  }
}

// Monitorar múltiplos PIDs
async function monitorProcessTree(rootPid) {
  // Primeiro, encontrar todos os PIDs na árvore
  const pids = await getProcessTree(rootPid); // usa pidtree

  // Monitorar todos (root + children)
  const stats = await Promise.all(
    pids.map(pid => pidusage(pid).catch(() => null))
  );

  const totalMemory = stats
    .filter(s => s)
    .reduce((sum, s) => sum + s.memory, 0);

  console.log(`Total memória do grupo Chrome: ${(totalMemory / 1024 / 1024).toFixed(1)}MB`);
}
```

### 3. Detecção de Memory Leak

```javascript
class ChromeMemoryLeakDetector {
  constructor(chromePid) {
    this.chromePid = chromePid;
    this.samples = [];
    this.alertThreshold = 50; // MB/min
  }

  async start(intervalMs = 60000) {
    setInterval(() => this._check(), intervalMs);
  }

  async _check() {
    try {
      const mem = await getProcessMemory(this.chromePid);
      if (!mem) return;

      const now = Date.now();
      this.samples.push({ timestamp: now, rss: mem.rss });

      // Manter última hora
      const hourAgo = now - 60 * 60 * 1000;
      this.samples = this.samples.filter(s => s.timestamp > hourAgo);

      if (this.samples.length >= 2) {
        this._analyzeGrowth();
      }
    } catch (error) {
      console.error('Erro no detector:', error);
    }
  }

  _analyzeGrowth() {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];

    const timeHours = (last.timestamp - first.timestamp) / 1000 / 3600;
    const rssGrowthMB = (last.rss - first.rss) / 1024 / 1024;
    const growthPerHour = rssGrowthMB / timeHours;

    if (growthPerHour > 100) {
      console.warn('[ALERTA CRÍTICA] Vazamento de memória em Chrome!');
      console.warn(`  Crescimento: ${growthPerHour.toFixed(1)}MB/h`);
      console.warn(`  RSS: ${(last.rss / 1024 / 1024).toFixed(1)}MB`);
      this._triggerRecovery();
    } else if (growthPerHour > this.alertThreshold) {
      console.warn('[ALERTA] Crescimento suspeito:', growthPerHour.toFixed(1), 'MB/h');
    }
  }

  _triggerRecovery() {
    // Auto-restart do Chrome (ver próxima seção)
    console.log('Iniciando recovery automático...');
    this.onLeakDetected?.();
  }
}
```

---

## Auto-Restart de Chrome que Crasha

### Padrão Supervisor/Manager

```javascript
class ChromeSupervisor {
  constructor(config) {
    this.config = config;
    this.chrome = null;
    this.restartCount = 0;
    this.maxRestarts = 10;
    this.restartBackoff = 1000; // Começa com 1s
  }

  async start() {
    await this._launchWithRetry();
    this._monitor();
  }

  async _launchWithRetry() {
    while (this.restartCount < this.maxRestarts) {
      try {
        console.log(`Chrome launch attempt ${this.restartCount + 1}/${this.maxRestarts}`);

        this.chrome = await this._launchChrome();

        console.log(`Chrome iniciado com sucesso (PID: ${this.chrome.pid})`);
        this.restartCount = 0; // Reset contador
        this.restartBackoff = 1000;

        return this.chrome;
      } catch (error) {
        this.restartCount++;
        console.error(`Falha no launch ${this.restartCount}:`, error.message);

        if (this.restartCount >= this.maxRestarts) {
          throw new Error(`Chrome falhou ${this.maxRestarts} vezes, desistindo`);
        }

        // Exponential backoff
        const waitMs = this.restartBackoff * Math.pow(2, this.restartCount);
        console.log(`Aguardando ${waitMs}ms antes do próximo attempt...`);

        await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 30000)));
      }
    }
  }

  _launchChrome() {
    return new Promise((resolve, reject) => {
      const chrome = spawn('google-chrome', this._buildArgs(), {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      // Capturar erro inicial
      let errorOutput = '';
      chrome.stderr.on('data', (data) => {
        errorOutput += data.toString();

        // Chrome failed to start: Xvfb
        if (data.includes('failed to start') || data.includes('cannot open display')) {
          reject(new Error(errorOutput));
        }
      });

      // Timeout de inicialização (30s)
      const launchTimeout = setTimeout(() => {
        chrome.kill('SIGKILL');
        reject(new Error('Chrome timeout após 30s'));
      }, 30000);

      // Aguardar processo ficar saudável (ex.: port 9222 aberta)
      this._waitForPortOpen(this.config.port).then(() => {
        clearTimeout(launchTimeout);
        resolve(chrome);
      }).catch(reject);
    });
  }

  _monitor() {
    // Detectar crash imediato
    this.chrome.on('exit', (code, signal) => {
      console.log(`Chrome crashou? Código: ${code}, Sinal: ${signal}`);

      if (!this._intentionalShutdown) {
        console.log('Iniciando restart automático...');
        this._restart();
      }
    });

    // Monitorar memory leak
    this._memoryDetector = new ChromeMemoryLeakDetector(this.chrome.pid);
    this._memoryDetector.onLeakDetected = () => {
      this._restartMemoryLeak();
    };
    this._memoryDetector.start();
  }

  async _restart() {
    try {
      // 1. Cleanup do Chrome antigo
      await this._cleanupOldChrome();

      // 2. Launch novo Chrome
      this.chrome = await this._launchChrome();

      // 3. Reconfigurar monitoramento
      this._monitor();

      console.log('Chrome restartado com sucesso');
    } catch (error) {
      console.error('Falha no restart:', error);
    }
  }

  async _restartMemoryLeak() {
    console.log('Restart por memory leak detectado...');

    // Graceful shutdown primeiro
    await this._gracefulShutdown();

    // Aguardar um pouco para memória ser liberada pelo OS
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Relaunch
    await this._restart();
  }

  async _gracefulShutdown() {
    if (!this.chrome) return;

    try {
      // Via CDP primeiro
      if (this.client) {
        await this.client.send('Browser.close');
      }

      // Aguardar
      await this._waitForProcess(5000);
    } catch (error) {
      console.warn('Erro no graceful shutdown:', error.message);
    }

    // Force se necessário
    this._killChrome();
  }

  _killChrome() {
    if (!this.chrome) return;

    try {
      process.kill(-this.chrome.pid, 'SIGTERM');
    } catch (error) {
      // Já morreu
    }
  }

  async _cleanupOldChrome() {
    if (this.chrome && !this.chrome.killed) {
      try {
        process.kill(-this.chrome.pid, 'SIGKILL');
      } catch (error) {
        // Ignorar
      }
    }
  }

  async stop() {
    this._intentionalShutdown = true;
    await this._gracefulShutdown();
    this._memoryDetector?.stop();
  }
}
```

---

## Exemplo Completo: Chrome Manager Class

```javascript
// chrome-manager.js
const { spawn } = require('child_process');
const pidtree = require('pidtree');
const pidusage = require('pidusage');
const net = require('net');

class ChromeManager {
  constructor(options = {}) {
    this.options = {
      chromePath: options.chromePath || '/usr/bin/google-chrome',
      port: options.port || 9222,
      userDataDir: options.userDataDir || `/tmp/chrome-profile-${Date.now()}`,
      headless: options.headless !== false,
      maxRestarts: options.maxRestarts || 5,
      memoryThreshold: options.memoryThreshold || 1024 * 1024 * 1024, // 1GB
      ...options
    };

    this.chrome = null;
    this.xvfb = null;
    this.restartCount = 0;
    this.isShuttingDown = false;
    this.client = null;

    this._setupSignalHandlers();
  }

  async start() {
    if (this.chrome) {
      throw new Error('Chrome já está rodando');
    }

    await this._launch();
    this._startHealthMonitor();
    console.log(`Chrome Manager iniciado (PID: ${this.chrome?.pid})`);
  }

  async _launch() {
    // 1. Verificar se porta está livre
    await this._waitForPortFree(this.options.port);

    // 2. Spawn Chrome
    this.chrome = await this._spawnChrome();

    // 3. Aguardar port ficar aberta
    await this._waitForPortOpen(this.options.port);

    console.log(`Chrome rodando em PID ${this.chrome.pid}, porta ${this.options.port}`);

    // 4. Monitorar crash
    this.chrome.on('exit', (code, signal) => {
      this._handleCrash(code, signal);
    });
  }

  async _spawnChrome() {
    return new Promise((resolve, reject) => {
      const args = this._buildChromeArgs();

      const chrome = spawn(this.options.chromePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          // XDG_RUNTIME_DIR para evitar erros no Docker
          XDG_RUNTIME_DIR: `/tmp/chrome-runtime-${Date.now()}`
        }
      });

      // Capturar stderr para detecção de erro
      let errorMsg = '';
      chrome.stderr.on('data', (data) => {
        const text = data.toString();
        errorMsg += text;

        if (text.includes('Failed to move to new namespace') ||
            text.includes('cannot open display') ||
            text.includes('No usable sandbox!')) {
          reject(new Error(errorMsg));
        }
      });

      chrome.stdout.on('data', (data) => {
        // Opcional: logar output do Chrome
        // console.log('[Chrome]', data.toString().trim());
      });

      chrome.on('error', reject);

      // Timeout de inicialização
      const timeout = setTimeout(() => {
        chrome.kill('SIGKILL');
        reject(new Error('Chrome timeout na inicialização (30s)'));
      }, 30000);

      // Sucesso: Chrome spawnado
      chrome.on('spawn', () => {
        clearTimeout(timeout);
        resolve(chrome);
      });
    });
  }

  _buildChromeArgs() {
    return [
      '--headless=new',
      `--remote-debugging-port=${this.options.port}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-translate',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-background-networking',
      `--user-data-dir=${this.options.userDataDir}`,
      'about:blank'
    ];
  }

  async _waitForPortOpen(port) {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const socket = net.createConnection(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
        });
        socket.once('error', () => {
          throw new Error('Connection refused');
        });
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve);
          setTimeout(() => reject(new Error('Timeout')), 2000);
        });
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`Porta ${port} não abriu após ${maxAttempts} segundos`);
  }

  async _waitForPortFree(port) {
    for (let i = 0; i < 10; i++) {
      try {
        const socket = net.createConnection(port, '127.0.0.1');
        socket.destroy();
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch {
        // Porta não está em uso (OK)
        return;
      }
    }
    throw new Error(`Porta ${port} ainda está em uso`);
  }

  _handleCrash(code, signal) {
    if (this.isShuttingDown) return;

    console.log(`Chrome crashou? Code: ${code}, Signal: ${signal}`);

    if (this.restartCount < this.options.maxRestarts) {
      console.log(`Restart ${this.restartCount + 1}/${this.options.maxRestarts}...`);
      this.restartCount++;
      this._restart();
    } else {
      console.error('Chrome crashou muitas vezes, parando...');
      this.emit('fatal', new Error('Max restarts exceeded'));
    }
  }

  async _restart() {
    try {
      await this._gracefulShutdown();
      await this._launch();
      this._startHealthMonitor();
      console.log('Chrome restartado com sucesso');
    } catch (error) {
      console.error('Falha no restart:', error);
      this.emit('restart-failed', error);
    }
  }

  async _gracefulShutdown() {
    if (!this.chrome || this.chrome.killed) return;

    try {
      // 1. Fechar via CDP
      if (this.client) {
        try {
          await this.client.send('Browser.close');
        } catch (error) {
          console.warn('CDP close falhou:', error.message);
        }
      }

      // 2. Aguardar processo sair
      await this._waitForProcess(5000);
    } catch (error) {
      console.warn('Erro no graceful shutdown:', error);
    }

    // 3. SIGTERM se ainda rodando
    if (this.chrome && !this.chrome.killed) {
      try {
        process.kill(-this.chrome.pid, 'SIGTERM');
        await this._waitForProcess(3000);
      } catch (error) {
        // Ignorar ESRCH
      }
    }

    // 4. SIGKILL se ainda rodando
    if (this.chrome && !this.chrome.killed) {
      try {
        process.kill(-this.chrome.pid, 'SIGKILL');
        await this._waitForProcess(2000);
      } catch (error) {
        // Ignorar
      }
    }

    this.chrome = null;
  }

  _waitForProcess(timeoutMs) {
    return new Promise((resolve) => {
      if (!this.chrome) {
        resolve(true);
        return;
      }

      const start = Date.now();

      const check = setInterval(() => {
        try {
          process.kill(this.chrome.pid, 0);
          if (Date.now() - start > timeoutMs) {
            clearInterval(check);
            resolve(false);
          }
        } catch (error) {
          if (error.code === 'ESRCH') {
            clearInterval(check);
            resolve(true);
          }
        }
      }, 100);
    });
  }

  _startHealthMonitor() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
    }

    this._healthInterval = setInterval(() => {
      this._healthCheck();
    }, 30000); // A cada 30 segundos
  }

  async _healthCheck() {
    if (!this.chrome || this.chrome.killed) return;

    try {
      // 1. Verificar se processo ainda existe
      process.kill(this.chrome.pid, 0);

      // 2. Verificar uso de memória
      const mem = await this._getMemoryUsage();
      if (mem && mem.rss > this.options.memoryThreshold) {
        console.warn(`[Health] Chrome memória alta: ${(mem.rss / 1024 / 1024 / 1024).toFixed(2)}GB`);
        // Pode triggerar restart aqui se configurado
      }

      // 3. Verificar se porta ainda respondendo
      const portOpen = await this._isPortOpen(this.options.port);
      if (!portOpen) {
        console.warn('[Health] Porta do Chrome não está respondendo');
      }
    } catch (error) {
      if (error.code === 'ESRCH') {
        console.warn('[Health] Chrome processo não existe mais');
        await this._restart();
      }
    }
  }

  async _getMemoryUsage() {
    try {
      // Linux: /proc/<pid>/status
      const { readFileSync } = require('fs');
      const status = readFileSync(`/proc/${this.chrome.pid}/status`, 'utf8');
      const match = status.match(/VmRSS:\s+(\d+)/);
      if (match) {
        return { rss: parseInt(match[1], 10) * 1024 };
      }
    } catch (error) {
      // Processo não existe ou OS não suporta
    }
    return null;
  }

  _isPortOpen(port) {
    return new Promise((resolve) => {
      const socket = net.createConnection(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
      setTimeout(() => resolve(false), 2000);
    });
  }

  _setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`[Signal] ${signal} recebido, iniciando shutdown...`);
        this.isShuttingDown = true;
        await this.stop();
        process.exit(0);
      });
    });

    process.on('uncaughtException', async (error) => {
      console.error('[Uncaught]', error);
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('[Unhandled Rejection]', reason);
      await this.stop();
      process.exit(1);
    });
  }

  async stop() {
    console.log('Parando Chrome Manager...');
    await this._gracefulShutdown();
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
    }
    console.log('Chrome Manager parado');
  }
}

module.exports = ChromeManager;
```

---

## Boas Práticas e Checklist

### ✅ Antes de Spawn

- [ ] Verificar se Chrome está instalado (`which google-chrome`)
- [ ] Validar flags de linha de comando
- [ ] Garantir user-data-dir exclusivo por sessão
- [ ] Verificar se porta de debugging está livre
- [ ] Configurar ambiente Docker corretamente (--shm-size)

### ✅ Durante Operação

- [ ] `detached: false` (a menos que queira processo órfão)
- [ ] Capturar `stdout` e `stderr` (não deixar buffer encher)
- [ ] Pipe logs para sistema de logging centralizado
- [ ] Monitorar memória do processo a cada 30-60s
- [ ] Registrar restart attempts
- [ ] Health check da porta de CDP

### ✅ Signal Handling

- [ ] Capturar `SIGINT`, `SIGTERM`, `SIGHUP`
- [ ] Capturar `uncaughtException`
- [ ] Capturar `unhandledRejection`
- [ ] Flag `isShuttingDown` para evitar loops
- [ ] Graceful shutdown (CDP → SIGTERM → SIGKILL)

### ✅ Cleanup

- [ ] `unref()` em processos órfãos propositais
- [ ] `childKiller()` para evitar zombies
- [ ] Kill recursivo da árvore de processos (`-pid`)
- [ ] Remover user-data-dir temporário
- [ ] Fechar sockets de debugging

### ❌ Anti-Patterns Comuns

1. **Ignorar evento `exit`**
   ```javascript
   chrome = spawn(...);
   // ❌ Nunca ouve 'exit' → zombie garantido
   ```

2. **Usar `exec` ao invés de `spawn`**
   ```javascript
   // ❌ Buffer overflow, nunca termina
   exec('google-chrome --headless');
   ```

3. **Matar apenas PID raiz (sem `-`)**
   ```javascript
   // ❌ Mata só Chrome, GPU fica órfão
   process.kill(pid, 'SIGTERM');

   // ✅ Mata todo o grupo
   process.kill(-pid, 'SIGTERM');
   ```

4. **Call `process.exit()` sem limpar filhos**
   ```javascript
   // ❌ Processos Chrome continuam rodando!
   process.exit(0);

   // ✅ Primeiro cleanup, depois exit
   await manager.stop();
   process.exit(0);
   ```

5. **Detached: true sem reason**
   ```javascript
   // ❌ Só causa orphans
   spawn(chrome, args, { detached: true });

   // ✅ Apenas se precisar que Chrome sobreviva ao Node
   ```

### 📊 Monitoramento Recomendado

```javascript
// logger.js
const chromeManager = new ChromeManager();

// Log de eventos importantes
chromeManager.on('crash', (error) => {
  logger.error('Chrome crashed', { error, restartCount: chromeManager.restartCount });
});

chromeManager.on('restart', () => {
  logger.info('Chrome restarted', {
    pid: chromeManager.chrome.pid,
    restartCount: chromeManager.restartCount
  });
});

chromeManager.on('memory-high', (stats) => {
  logger.warn('Chrome memory high', { rss: stats.rss });
});

// Métricas (Prometheus/OpenTelemetry)
setInterval(() => {
  metrics.gauge('chrome_memory_rss', chromeManager.chrome ? getMemory(chromeManager.chrome.pid) : 0);
  metrics.gauge('chrome_processes', chromeManager.chrome ? 1 : 0);
}, 10000);
```

---

## Referências e Fontes

- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html)
- [Puppeteer BrowserRunner Source](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/BrowserRunner.ts)
- [Run Headless Chromium NPM](https://www.npmjs.com/package/run-headless-chromium)
- [Node-Headless Xvfb Wrapper](https://github.com/kesla/node-headless)
- [Zombie Processes in Node.js (Saturn Cloud)](https://saturncloud.io/blog/what-is-a-zombie-process-and-how-to-avoid-it-when-spawning-nodejs-child-processes-on-cloud-foundry/)
- [5 Tips for Cleaning Orphaned Node.js Processes (Medium)](https://medium.com/@arunangshudas/5-tips-for-cleaning-orphaned-node-js-processes-196ceaa6d85e)
- [Memory Monitoring in Node.js (Node.js.org)](https://nodejs.org/en/learn/diagnostics/memory)
- [Child-Killer NPM Package](https://www.npmjs.com/package/child-killer)
- [Pidtree NPM Package](https://www.npmjs.com/package/pidtree)
- [Graceful Shutdown in Node.js](https://github.com/goldbergyoni/nodebestpractices#-24-enable-graceful-shutdown)
- [Headless Chrome Best Practices](https://pptr.dev/troubleshooting)

---

## Histórico de Revisões

| Data | Versão | Descrição |
|------|--------|-----------|
| 2025-03-17 | 1.0 | Versão inicial com base nas pesquisas da internet |

---

**Nota:** Este documento foi compilado com base em pesquisas na internet e padrões da indústria. Sempre teste as abordagens no seu ambiente específico (Docker, bare metal, Kubernetes, etc.).