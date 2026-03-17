# Persistência de Perfil Chrome: Guia Completo

**Data:** 2025-03-17
**Revisão:** 1.0
**Aplicação:** Sistema Remote Browser - Multi-tenant

---

## 1. Como o Chrome Salva Dados de Sessão no `user-data-dir`

### 1.1 Estrutura do Diretório de Dados do Usuário

O Chrome armazena todos os dados de perfil em um diretório configurável via flag `--user-data-dir`. Cada perfil é uma pasta dentro desse diretório.

**Caminhos padrão por sistema operacional:**

- **Windows:** `%LOCALAPPDATA%\Google\Chrome\User Data\`
- **macOS:** `~/Library/Application Support/Google/Chrome/`
- **Linux:** `~/.config/google-chrome/` ou `~/.config/chromium/`

**Subdiretórios de perfil:**
- `Default/` - Perfil principal
- `Profile 1/`, `Profile 2/`, etc. - Perfis adicionais
- `System Profile/` - Perfil do sistema
- `Guest Profile/` - Perfil de convidado

Cada perfil é completamente independente com seus próprios cookies, local storage, extensões, etc.

### 1.2 O Que é Persistido Automaticamente

O Chrome persiste automaticamente (sem necessidade de intervenção programática):

| Tipo de Dado | Arquivo/Diretório | Descrição |
|-------------|-------------------|-----------|
| **Cookies** | `Cookies` (SQLite) | Banco de dados SQLite com todos os cookies |
| **Local Storage** | `Local Storage/leveldb/` | Dados localStorage por origem |
| **Session Storage** | `Session Storage/` | Dados sessionStorage |
| **IndexedDB** | `IndexedDB/` | Bancos de dados IndexedDB por origem |
| **Cache** | `Cache/` | Cache HTTP |
| **Extensões** | `Extensions/` | Extensões instaladas |
| **Bookmarks** | `Bookmarks` (JSON) | Favoritos |
| **Histórico** | `History` (SQLite) | Histórico de navegação |
| **Senhas** | `Login Data` (SQLite) | Senhas salvas (criptografadas) |
| **Preferências** | `Preferences` (JSON) | Configurações do usuário |
| **Sessão de Abas** | `Sessions/` (v86+) | Estado das abas abertas |
| **Sessão Legado** | `Current Session`, `Last Session` (pre-v86) | Estado das abas (legado) |
| **Form Data** | `Web Data` (SQLite) | Dados de formulários salvos |
| **OAuth Tokens** | Various | Tokens de autenticação |

### 1.3 Como a Persistência Funciona

O Chrome atualiza arquivos de forma assíncrona durante a execução:

1. **Writes Incrementais:** Cookies, localStorage e IndexedDB são gravados continuamente conforme modificados
2. **Flush em Intervalos:** O Chrome faz flush periódico para disco (a cada 30 segundos a 5 minutos dependendo do tipo de dado)
3. **No Shutdown Graceful:** Quando o Chrome é fechado normalmente, todos os dados pendentes são forçados para disco
4. **Crash Recovery:** Após crash, o Chrome verifica arquivos de sessão (Last Session/Current Session) e pode restaurar abas

⚠️ **IMPORTANTE:** Dados NÃO são garantidamente salvos se o Chrome for morto com `kill -9` (SIGKILL) ou `taskkill /F`. Alterações recentes podem ser perdidas.

---

## 2. Arquivos Importantes para Persistência

### 2.1 Arquivos Críticos (Não Devem Ser Ignorados)

```plaintext
user-data-dir/
├── Local State                    # Metadados do diretório User Data
├── Default/ (ou Profile N/)
│   ├── Preferences               # Configurações principais
│   ├── Bookmarks                 # Favoritos
│   ├── History                   # Histórico
│   ├── Cookies                   # Cookies (SQLite DB)
│   ├── Cookies-journal           # Journal do SQLite
│   ├── Login Data                # Senhas (SQLite)
│   ├── Login Data-journal        # Journal de senhas
│   ├── Web Data                  # Dados de formulários/autocomplete
│   ├── Local Storage/
│   │   └── leveldb/              # localStorage para todas as origens
│   ├── Session Storage/
│   │   └── leveldb/              # sessionStorage
│   ├── IndexedDB/
│   │   └── */*.indexeddb.leveldb # Bancos IndexedDB
│   ├── Cache/
│   │   └── *                    # Cache HTTP
│   ├── Extensions/              # Extensões instaladas
│   ├── Extension Settings/      # Configurações de extensões
│   ├── Session_*
│   └── Tabs_*                   # Arquivos de sessão (v86+)
```

### 2.2 Estrutura Detalhada por Tipo

**Local Storage (Origem específica):**
```
Local Storage/
└── leveldb/
    ├── 000003.log
    ├── 000004.log
    ├── LOG
    ├── MANIFEST-000001
    └── m_000003.log
```

A chave LevelDB combina o protocolo + domínio, ex: `chrome-extension_<extension-id>_0.localstorage`

**IndexedDB:**
```
IndexedDB/
└── https_example.com_0.indexeddb.leveldb/
    ├── 000003.log
    ├── MANIFEST-000001
    └── ...
```

**Cookies:**
- Arquivo: `Cookies` (binário, formato SQLite)
- Estrutura da tabela `cookies`: name, value, host_key, path, expires_utc, is_secure, is_httponly, etc.

**Session Files (Chrome 86+):**
```
sessions/
├── Session_<timestamp>
└── Tabs_<timestamp>
```

Arquivos binários que serializam o estado de todas as abas e janelas.

### 2.3 Tamanho e Performance

Perfis podem crescer significativamente:
- **Conservador:** 100MB - 1GB (usuário leve)
- **Típico:** 1GB - 5GB (usuário médio com cache)
- **Grande:** 5GB - 20GB+ (muitas extensões, vídeos em cache)
- **Crítico:** > 20GB necessita de limpeza periódica

---

## 3. Backup e Restauração Programática

### 3.1 Backup Completo de Perfil

```javascript
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const copyDir = async (src, dest) => {
  const exists = promisify(fs.exists);
  const mkdir = promisify(fs.mkdir);
  const readdir = promisify(fs.readdir);
  const stat = promisify(fs.stat);
  const copyFile = promisify(fs.copyFile);

  if (await exists(dest)) {
    await rimraf(dest); // Rimraf para remover recursivamente
  }
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
};

async function backupProfile(profilePath, backupPath, userId) {
  console.log(`Backing up profile ${userId} from ${profilePath} to ${backupPath}`);

  // FECHAR O CHROME ANTES DO BACKUP (obrigatório)
  // Só copiar arquivos se o Chrome estiver completamente fechado

  try {
    await copyDir(profilePath, path.join(backupPath, userId));
    console.log(`✓ Backup completed for user ${userId}`);

    // Verificar integridade dos arquivos críticos
    const criticalFiles = ['Cookies', 'Preferences', 'Bookmarks', 'Local Storage'];
    for (const file of criticalFiles) {
      const filePath = path.join(backupPath, userId, file);
      const exists = await exists(filePath);
      if (!exists) {
        console.warn(`⚠ Critical file missing: ${file}`);
      }
    }

    return { success: true, backupPath: path.join(backupPath, userId) };
  } catch (error) {
    console.error('Backup failed:', error);
    return { success: false, error: error.message };
  }
}
```

**Nota Crítica:** O backup deve ser feito com Chrome **completamente fechado**, caso contrário arquivos podem estar em estado inconsistente.

### 3.2 Restauração de Perfil

```javascript
async function restoreProfile(backupPath, targetPath, userId) {
  const sourcePath = path.join(backupPath, userId);

  console.log(`Restoring profile ${userId} from ${sourcePath} to ${targetPath}`);

  // 1. FECHAR Chrome completamente se estiver rodando
  // 2. Mover perfil atual para backup
  if (await exists(targetPath)) {
    const backupOld = `${targetPath}.old-${Date.now()}`;
    await fs.rename(targetPath, backupOld);
    console.log(`Old profile backed up to: ${backupOld}`);
  }

  // 3. Copiar perfil do backup
  await copyDir(sourcePath, targetPath);

  // 4. Corrigir permissões
  // No Linux: chown -R chrome:chrome targetPath
  // No Windows: Set ACLs appropriately

  console.log(`✓ Profile restored successfully for user ${userId}`);
  return { success: true, targetPath };
}
```

### 3.3 Backup Incremental/Automático

```javascript
class ProfileManager {
  constructor(config) {
    this.baseUserDataDir = config.userDataDir; // Ex: /tmp/chrome-profiles
    this.backupDir = config.backupDir;         // Ex: /backup/profiles
    this.retentionDays = config.retention || 30;
  }

  async createSnapshot(userId, chromeProcessPid) {
    // Usar CDP para graceful shutdown antes do backup
    const client = await this.connectToChrome(chromeProcessPid);

    // Salvar estado via CDP primeiro (ver seção 6)
    await client.session.send('Browser.close');

    // Aguardar processo terminar
    await this.waitForProcessExit(chromeProcessPid, 30000);

    // Agora fazer backup
    const profilePath = path.join(this.baseUserDataDir, userId);
    return await backupProfile(profilePath, this.backupDir, userId);
  }

  async scheduleBackupInterval(userId, intervalMs = 3600000) {
    setInterval(async () => {
      try {
        await this.backupProfileIfInactive(userId);
      } catch (err) {
        console.error(`Backup failed for ${userId}:`, err);
      }
    }, intervalMs);
  }
}
```

---

## 4. Problemas Comuns

### 4.1 Lock Files

**Problema:** Chrome cria arquivos de lock para impedir múltiplas instâncias no mesmo `user-data-dir`:

- **`SingletonLock`** (arquivo vazio): Indica que um perfil está em uso
- **`SingletonSocket`** (socket Unix ou pipe nomeado Windows): Socket IPC para comunicação

Se o Chrome crashar, estes arquivos podem permanecer, causando erro:

```
[ERROR:profile.cc(236)] Profile is already in use.
```

**Solução Programática:**

```javascript
const fs = require('fs');

function clearProfileLocks(profilePath) {
  const lockFile = path.join(profilePath, 'SingletonLock');
  const socketFile = path.join(profilePath, 'SingletonSocket');

  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log('Removed SingletonLock');
    }
    if (fs.existsSync(socketFile)) {
      fs.unlinkSync(socketFile);
      console.log('Removed SingletonSocket');
    }
    return true;
  } catch (err) {
    console.error('Failed to clear locks:', err);
    return false;
  }
}
```

⚠️ **Aviso:** Só remover locks se tiver certeza que o Chrome não está rodando. Remover locks com Chrome ativo causa corrupção.

### 4.2 Corruption do Arquivo `Preferences`

**Sintomas:**
- Chrome inicia com erro "Your preferences file is corrupted"
- Configurações são perdidas
- Extensões desativadas

**Causas:**
- Crash durante escrita assíncrona
- Kill -9 durante persistência
- Disco cheio/montação incorreta

**Solução:**

```javascript
const fs = require('fs');

function repairPreferences(profilePath) {
  const prefFile = path.join(profilePath, 'Preferences');

  try {
    const content = fs.readFileSync(prefFile, 'utf8');
    const data = JSON.parse(content);

    // Navegação segura: o Chrome vai regenerar a partir do default se necessário
    return { valid: true, data };

  } catch (err) {
    console.error('Preferences corrupted, removing to regenerate:', err);

    // Remover Preferences corrompido
    // Chrome vai criar um novo na próxima inicialização
    if (fs.existsSync(prefFile)) {
      const backup = `${prefFile}.corrupted-${Date.now()}`;
      fs.renameSync(prefFile, backup);
    }

    // Opcional: copiar Preferences de um perfil "template" limpo
    // return copyTemplatePreferences(profilePath);

    return { repaired: true };
  }
}
```

**Recuperação Avançada:**
1. Fechar Chrome completamente
2. Renomear `Preferences` → `Preferences.corrupted`
3. Iniciar Chrome → gera novo Preferences (padrão)
4. Restaurar manualmente apenas as configurações necessárias

### 4.3 Databases SQLite Corrompidos

Arquivos como `Cookies`, `History`, `Login Data`, `Web Data` são SQLite.

**Detecção:**

```bash
sqlite3 /path/to/profile/Cookies "PRAGMA integrity_check;"
```

Se retornar `error` ou algo diferente de `ok`, está corrompido.

**Reparação:**

```javascript
const { execSync } = require('child_process');

function repairSQLite(dbPath) {
  try {
    // Fazer backup primeiro
    const backup = `${dbPath}.backup`;
    fs.copyFileSync(dbPath, backup);

    // Executar VACUUM e integrity check
    execSync(`sqlite3 "${dbPath}" "PRAGMA integrity_check;"`, { stdio: 'pipe' });
    execSync(`sqlite3 "${dbPath}" "VACUUM;"`, { stdio: 'pipe' });

    console.log(`✓ Repaired ${dbPath}`);
    return true;

  } catch (err) {
    console.error(`Failed to repair ${dbPath}:`, err.message);

    // Se falhar, restaurar de backup ou remover
    // Chrome vai recriar na próxima escrita
    return false;
  }
}
```

Na prática, se um desses arquivos estiver muito corrompido, é mais fácil:
1. Fazer backup do perfil inteiro
2. Deletar apenas o arquivo corrompido
3. Reiniciar Chrome → ele recria vazio
4. Restaurar dados manualmente de backup (se possível)

### 4.4 Disco Cheio

**Problema:** Se o disco encher durante escrita, Chrome pode corromper perfil.

**Prevenção:**
```javascript
function checkDiskSpace(dir, minGB = 2) {
  const stats = fs.statvfsSync(dir);
  const freeGB = (stats.f_bavail * stats.f_frsize) / (1024 ** 3);

  if (freeGB < minGB) {
    throw new Error(`Insufficient disk space: ${freeGB.toFixed(2)}GB free, need ${minGB}GB`);
  }

  return freeGB;
}
```

---

## 5. Multi-Tenant: Um Perfil por Usuário

### 5.1 Arquitetura Recomendada

```plaintext
/var/chrome-profiles/
├── user_12345/
│   ├── Default/           # Perfil completo
│   └── metadata.json      # Metadados: userId, createdAt, lastSeen
├── user_67890/
│   └── Default/
└── user_abcdef/
    └── Default/
```

### 5.2 Isolamento Completo

**Cada usuário → um `user-data-dir` separado:**

```javascript
class MultiTenantProfileManager {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.ensureBaseDirExists();
  }

  getProfilePath(userId) {
    return path.join(this.baseDir, `user_${userId}`);
  }

  async launchBrowserForUser(userId, options = {}) {
    const profilePath = this.getProfilePath(userId);

    // Garantir que o diretório existe
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
      console.log(`Created new profile for user ${userId}`);
    }

    // Limpar locks antigos se houver
    clearProfileLocks(profilePath);

    // Launch Chrome com user-data-dir único
    const browser = await puppeteer.launch({
      headless: options.headless || 'shell',
      args: [
        `--user-data-dir=${profilePath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
      ...options,
    });

    return browser;
  }

  async terminateUserSession(userId, saveState = true) {
    const profilePath = this.getProfilePath(userId);

    // 1. Fechar Chrome gracefulmente (ver seção 6)
    // 2. Forçar flush de writes
    // 3. Opcional: compactar perfil

    if (saveState) {
      await this.forceProfileFlush(profilePath);
    }

    // Remover locks órfãos
    clearProfileLocks(profilePath);

    return true;
  }
}
```

### 5.3 BrowserContexts vs user-data-dir separado

**Opção 1: user-data-dir separado (Recomendado para multi-tenant)**

```javascript
// Cada usuário tem diretório separado
await manager.launchBrowserForUser('user_123'); // user-data-dir = /profiles/user_123
await manager.launchBrowserForUser('user_456'); // user-data-dir = /profiles/user_456
```

✅ Prós: Isolamento total, persists entre sessões, extensões separadas
❌ Contras: Consome mais disco (não compartilha cache/extensions)

**Opção 2: BrowserContexts (Incognito contexts)**

```javascript
const browser = await puppeteer.launch();
const context1 = await browser.createBrowserContext();
const page1 = await context1.newPage();
// context1 é isolado, mas não persiste (é como incognito)
```

✅ Prós: Leve, compartilha Chrome binário, ótimo para paralelismo
❌ Contras: **Não persiste** entre execuções, dados deletados ao fechar contexto

**Conclusão:** Para multi-tenant com sessões persistentes, usar `user-data-dir` separado por usuário é obrigatório.

### 5.4 Scale considerations

Para 1000+ usuários simultâneos:

```javascript
// Pool de processos Chrome (1 Chrome por N usuários)
class ChromeProcessPool {
  constructor(maxProcesses = 50) {
    this.maxProcesses = maxProcesses;
    this.processes = new Map(); // userId → { process, userDataDir }
  }

  async acquire(userId) {
    // Se já existe processo para este usuário, reusar
    if (this.processes.has(userId)) {
      return this.processes.get(userId);
    }

    // Se há processos livres (< max), criar novo
    if (this.processes.size < this.maxProcesses) {
      const process = await this.spawnChrome(userId);
      this.processes.set(userId, process);
      return process;
    }

    // Caso contrário, esperar ou escalar verticalmente
    throw new Error('No available Chrome processes');
  }
}
```

---

## 6. Garantir que o Perfil é Salvo ANTES do Chrome Fechar

### 6.1 O Problema

Se o Chrome for morto bruscamente (timeout, crash, kill -9):
- Write-ahead logs não são aplicados
- Dados recentes em memória não são persistidos
- Perfil pode ficar inconsistente

### 6.2 Graceful Shutdown via CDP

**MÉTODO OFICIAL:** Use `Browser.close()` via Chrome DevTools Protocol.

```javascript
const CDP = require('chrome-remote-interface');

async function gracefulShutdown(debuggingPort = 9222) {
  try {
    const client = await CDP({ port: debuggingPort });

    // 1. Fechar todas as abas
    const { Browser } = client;
    await Browser.close();

    // 2. Aguardar o Chrome encerrar
    // O Browser.close() faz Chrome.process.close() internamente
    // O processo deve terminar em 5-10 segundos

    console.log('Chrome shut down gracefully');
    return true;

  } catch (err) {
    console.error('CDP shutdown failed:', err);
    return false;
  }
}
```

**Fluxo correto:**

```javascript
async function safeClose(browser) {
  // 1. Tentar graceful shutdown via CDP primeiro
  try {
    await browser.close(); // puppeteer browser.close() envia Browser.close()
    console.log('Chrome closed gracefully via CDP');
    return true;
  } catch (err) {
    console.warn('Graceful shutdown failed, forcing kill:', err.message);
  }

  // 2. Fallback: force kill (menos seguro)
  const process = browser.process();
  process.kill('SIGTERM'); // SIGTERM primeiro

  // Aguardar até 10 segundos
  await new Promise(resolve => setTimeout(resolve, 10000));

  if (process.exitCode === null) {
    process.kill('SIGKILL'); // Forçar se não morrer
  }

  return false; // Indica shutdown forçado
}
```

### 6.3 Forçar Flush Manualmente (Pre-Shutdown)

Antes de fechar, forçar persistência:

```javascript
// Forçar flush de IndexedDB
async function flushIndexedDB(client) {
  try {
    // IndexedDB geralmente é bem sincronizado,
    // mas podemos forçar fechamento de conexões
    const { Runtime, IndexedDB } = client;

    // Avaliar script para forçar flush de localStorage/sessionStorage
    await Runtime.evaluate({
      expression: `
        for (let db of indexedDB.databases()) {
          indexedDB.deleteDatabase(db.name);
        }
      `,
    });
  } catch (err) {
    console.warn('IndexedDB flush failed:', err.message);
  }
}

// Salvar cookies críticos via CDP antes do shutdown
async function backupCriticalCookies(debuggingPort) {
  const client = await CDP({ port: debuggingPort });
  const { Network } = client;

  await Network.enable();

  const cookies = await Network.getCookies();
  // Salvar cookies em arquivo JSON para backup

  return cookies.cookies;
}
```

### 6.4 Timeout e Auto-Close Seguro

```javascript
class SessionManager {
  constructor(timeoutMs = 30 * 60 * 1000) { // 30 minutos default
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  async createSession(userId, browser) {
    const session = {
      browser,
      startTime: Date.now(),
      timeoutTimer: setTimeout(() => this.autoClose(userId), this.timeoutMs),
    };

    this.sessions.set(userId, session);
    return session;
  }

  resetTimeout(userId) {
    const session = this.sessions.get(userId);
    if (session) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = setTimeout(() => this.autoClose(userId), this.timeoutMs);
      session.lastActivity = Date.now();
    }
  }

  async autoClose(userId) {
    console.log(`Auto-closing session for ${userId} (timeout)`);

    const session = this.sessions.get(userId);
    if (!session) return;

    // Graceful shutdown primeiro
    const success = await safeClose(session.browser);

    if (!success) {
      console.warn(`Forcefully killed session ${userId}`);
      // Log métrica de timeout forçado
    }

    this.sessions.delete(userId);
  }

  async manualClose(userId) {
    const session = this.sessions.get(userId);
    if (!session) return;

    clearTimeout(session.timeoutTimer);

    const success = await safeClose(session.browser);
    this.sessions.delete(userId);

    return success;
  }
}
```

### 6.5 Trap de Sinais (SIGTERM, SIGINT)

Para capturar quando o container/processo principal está sendo finalizado:

```javascript
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

signals.forEach(signal => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, gracefully closing all Chrome instances...`);

    // Fechar todas as sessões ativas
    for (const [userId, session] of sessionManager.sessions.entries()) {
      await sessionManager.manualClose(userId);
    }

    console.log('All sessions closed, exiting...');
    process.exit(0);
  });
});
```

---

## 7. CDP para Salvar Cookies e Storage (Sem Dependência de Arquivos)

### 7.1 Por Que Usar CDP?

- Para exportar sessões entre diferentes perfis/máquinas
- Para backup instantâneo em cloud
- Para migração de usuários
- Para auditoria de dados de sessão
- Para restore programático sem copiar arquivos inteiros

### 7.2 APIs CDP Disponíveis

| Storage Type | Domain | Métodos Principais |
|-------------|--------|-------------------|
| Cookies | `Network` | `getCookies`, `getAllCookies`, `setCookie`, `deleteCookie` |
| localStorage/sessionStorage | `DOMStorage` | `getDOMStorageItems`, `setDOMStorageItem`, `removeDOMStorageItem` |
| IndexedDB | `IndexedDB` | `getDatabaseMetadata`, `requestDatabase`, `requestData` |
| CacheStorage | `CacheStorage` | `getCacheStorage`, `requestCacheKeys`, `requestCachedResponse` |
| General Quota | `Storage` | `getUsageAndQuota` |

### 7.3 Exemplo: Exportar Todos os Dados de Sessão via CDP

```javascript
const CDP = require('chrome-remote-interface');

async function exportSessionData(debuggingPort = 9222) {
  const client = await CDP({ port: debuggingPort });
  const { Network, DOMStorage, IndexedDB, CacheStorage } = client;

  const sessionData = {
    cookies: [],
    localStorage: {},
    sessionStorage: {},
    indexedDB: {},
    cache: {},
    exportedAt: new Date().toISOString(),
  };

  // === 1. Cookies ===
  await Network.enable();
  const cookiesResp = await Network.getCookies();
  sessionData.cookies = cookiesResp.cookies;

  // === 2. localStorage ===
  await DOMStorage.enable();
  const storageItems = await DOMStorage.getDOMStorageItems({ storageId: {} });

  // Obter todas as DOMStorages
  const domStorages = await DOMStorage.getDOMStorageIds();
  for (const storage of domStorages.storageIds) {
    const items = await DOMStorage.getDOMStorageItems({ storageId: storage });
    const key = `${storage.securityOrigin}:${storage.storageId}`;

    if (storage.storageId === 'localstorage') {
      sessionData.localStorage[key] = items.entries;
    } else if (storage.storageId === 'sessionstorage') {
      sessionData.sessionStorage[key] = items.entries;
    }
  }

  // === 3. IndexedDB ===
  await IndexedDB.enable();
  const databases = await IndexedDB.requestDatabaseNames({ securityOrigin: '' });

  for (const origin of databases.databaseNames) {
    sessionData.indexedDB[origin] = {};

    const metadata = await IndexedDB.requestDatabaseMetadata({ origin });
    for (const db of metadata.databases) {
      sessionData.indexedDB[origin][db.name] = {
        tables: [],
        metadata: {
          id: db.id,
          name: db.name,
          version: db.version,
        },
      };

      // Obter todos os object stores
      for (const objStore of db.objectStoreNames) {
        const records = await IndexedDB.requestData({
          origin,
          databaseName: db.name,
          objectStoreName: objStore,
        });

        sessionData.indexedDB[origin][db.name].tables.push({
          name: objStore,
          records: records.objectStoreData || [],
        });
      }
    }
  }

  // === 4. CacheStorage (opcional, pode ser pesado) ===
  await CacheStorage.enable();
  const cacheStorages = await CacheStorage.getCacheStorage({ securityOrigin: '' });

  for (const cache of cacheStorages.cacheStorages) {
    const cacheId = { securityOrigin: cache.securityOrigin, cacheId: cache.cacheId };

    try {
      const entries = await CacheStorage.requestCacheKeys({ cacheId });
      const cacheEntries = [];

      for (const entry of entries.cacheKeys) {
        const response = await CacheStorage.requestCachedResponse({
          cacheId,
          requestURL: entry.requestURL,
        });
        cacheEntries.push({
          requestURL: entry.requestURL,
          responseURL: response.response.url,
          status: response.response.status,
          headers: response.response.headers,
          // body: response.response.body (binary, omitir por padrão)
        });
      }

      sessionData.cache[cache.cacheId] = cacheEntries;
    } catch (err) {
      console.warn(`Failed to get cache ${cache.cacheId}:`, err.message);
    }
  }

  return sessionData;
}
```

### 7.4 Exemplo: Restaurar Dados de Sessão via CDP

```javascript
async function importSessionData(sessionData, debuggingPort = 9222) {
  const client = await CDP({ port: debuggingPort });
  const { Network, DOMStorage, IndexedDB } = client;

  // === 1. Restaurar Cookies ===
  await Network.enable();
  for (const cookie of sessionData.cookies) {
    try {
      await Network.setCookie({
        ...cookie,
        // Alguns campos são read-only, ajustar conforme necessário
      });
    } catch (err) {
      console.warn(`Failed to restore cookie ${cookie.name}:`, err.message);
    }
  }

  // === 2. Restaurar localStorage/sessionStorage ===
  await DOMStorage.enable();
  const domStorages = await DOMStorage.getDOMStorageIds();

  for (const storage of domStorages.storageIds) {
    const key = `${storage.securityOrigin}:${storage.storageId}`;
    const dataKey = storage.storageId === 'localstorage'
      ? 'localStorage'
      : 'sessionStorage';

    if (sessionData[dataKey][key]) {
      for (const [k, v] of Object.entries(sessionData[dataKey][key])) {
        try {
          await DOMStorage.setDOMStorageItem({
            storageId: storage,
            key: k,
            value: v,
          });
        } catch (err) {
          console.warn(`Failed to restore ${dataKey} key ${k}:`, err.message);
        }
      }
    }
  }

  // === 3. Restaurar IndexedDB (complexo) ===
  // IndexedDB não tem API direta para criar databases via CDP
  // É mais fácil recriar via JavaScript injection

  await IndexedDB.enable();
  const script = `
    const sessionData = ${JSON.stringify(sessionData)};

    for (const [origin, databases] of Object.entries(sessionData.indexedDB)) {
      for (const [dbName, dbInfo] of Object.entries(databases)) {
        // Abrir ou criar database
        const request = indexedDB.open(dbName, dbInfo.metadata.version);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          for (const table of dbInfo.tables) {
            if (!db.objectStoreNames.contains(table.name)) {
              db.createObjectStore(table.name, { keyPath: 'id', autoIncrement: true });
            }
          }
        };

        request.onsuccess = (event) => {
          const db = event.target.result;

          for (const table of dbInfo.tables) {
            const store = db.transaction(table.name, 'readwrite').objectStore(table.name);

            for (const record of table.records) {
              store.add(record);
            }
          }
        };
      }
    }
  `;

  await Runtime.evaluate({ expression: script });
  console.log('✓ Session data restored via CDP');
}
```

### 7.5 Use Case: Backup/Restore em Tempo Real

```javascript
class CDPBackupService {
  constructor() {
    this.backupInterval = 5 * 60 * 1000; // 5 minutos
    this.backups = new Map(); // userId → backup data
  }

  async startPeriodicBackup(userId, browser) {
    const wsUrl = await this.getWebSocketUrl(browser);

    setInterval(async () => {
      try {
        const data = await exportSessionData(wsUrl.port);
        this.backups.set(userId, {
          data,
          timestamp: Date.now(),
        });

        // Opcional: enviar para cloud storage
        await this.uploadToCloud(userId, data);

      } catch (err) {
        console.error(`Backup failed for ${userId}:`, err);
      }
    }, this.backupInterval);
  }

  async restoreLatestBackup(userId, newBrowserWsUrl) {
    const backup = this.backups.get(userId);
    if (!backup) {
      throw new Error('No backup available');
    }

    // Aguardar Chrome novo iniciar completamente
    await new Promise(resolve => setTimeout(resolve, 5000));

    await importSessionData(backup.data, newBrowserWsUrl.port);
    console.log(`Restored ${userId} from backup at ${new Date(backup.timestamp).toISOString()}`);
  }
}
```

---

## 8. Código Node.js Completo: Gerenciador de Perfis Chrome

### 8.1 Arquivo: `ChromeProfileManager.js`

```javascript
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const puppeteer = require('puppeteer');
const CDP = require('chrome-remote-interface');

class ChromeProfileManager {
  constructor(config = {}) {
    this.config = {
      baseProfileDir: config.baseProfileDir || '/var/chrome-profiles',
      backupDir: config.backupDir || '/backup/chrome-profiles',
      chromeExecutable: config.chromeExecutable || puppeteer.executablePath(),
      defaultArgs: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-software-rasterizer',
        '--disable-web-security', // CUIDADO: só para desenvolvimento
        `--user-data-dir=`, // Será substituído por perfil
      ],
      ...config,
    };

    this.instances = new Map(); // userId → { browser, profilePath, metadata }
    this.sessionManager = new SessionManager(config.sessionTimeout || 30 * 60 * 1000);

    this.ensureDirectories();
    this.setupSignalHandlers();
  }

  ensureDirectories() {
    [this.config.baseProfileDir, this.config.backupDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
    });
  }

  getProfilePath(userId) {
    // Sanitizar userId para path seguro
    const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.config.baseProfileDir, `user_${safeUserId}`);
  }

  getMetadataPath(userId) {
    return path.join(this.getProfilePath(userId), 'metadata.json');
  }

  async loadMetadata(userId) {
    const metadataPath = this.getMetadataPath(userId);

    if (fs.existsSync(metadataPath)) {
      try {
        const data = fs.readFileSync(metadataPath, 'utf8');
        return JSON.parse(data);
      } catch (err) {
        console.warn(`Failed to load metadata for ${userId}:`, err.message);
      }
    }

    return null;
  }

  async saveMetadata(userId, metadata) {
    const metadataPath = this.getMetadataPath(userId);
    const fullMetadata = {
      userId,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      sessionCount: 0,
      ...metadata,
    };

    fs.writeFileSync(metadataPath, JSON.stringify(fullMetadata, null, 2));
    return fullMetadata;
  }

  clearProfileLocks(profilePath) {
    const lockFile = path.join(profilePath, 'SingletonLock');
    const socketFile = path.join(profilePath, 'SingletonSocket');

    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        console.log(`[${profilePath}] Removed SingletonLock`);
      }
      if (fs.existsSync(socketFile)) {
        fs.unlinkSync(socketFile);
        console.log(`[${profilePath}] Removed SingletonSocket`);
      }
      return true;
    } catch (err) {
      console.error(`Failed to clear locks in ${profilePath}:`, err.message);
      return false;
    }
  }

  checkProfileHealth(profilePath) {
    const issues = [];
    const criticalFiles = ['Preferences', 'Cookies', 'Bookmarks'];

    for (const file of criticalFiles) {
      const filePath = path.join(profilePath, file);
      if (!fs.existsSync(filePath)) {
        issues.push(`Missing critical file: ${file}`);
      }
    }

    // Verificar tamanho do diretório
    const stats = this.getDirectorySize(profilePath);
    if (stats.size > 50 * 1024 * 1024 * 1024) { // 50GB
      issues.push(`Profile too large: ${(stats.size / (1024**3)).toFixed(2)}GB`);
    }

    // Verificar se Chrome está rodando (lock file ativo)
    const lockStat = fs.existsSync(path.join(profilePath, 'SingletonLock'))
      ? fs.statSync(path.join(profilePath, 'SingletonLock'))
      : null;

    if (lockStat) {
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (lockAge < 10000) {
        // Lock recente, Chrome pode estar rodando
        issues.push('Profile appears to be in use (active lock)');
      }
    }

    return {
      healthy: issues.length === 0,
      issues,
      size: stats,
    };
  }

  getDirectorySize(dir) {
    let size = 0;

    function traverse(currentDir) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile()) {
          try {
            size += fs.statSync(fullPath).size;
          } catch (err) {
            // Ignorar arquivos que não conseguimos ler
          }
        }
      }
    }

    try {
      traverse(dir);
    } catch (err) {
      console.error(`Failed to calculate size for ${dir}:`, err.message);
    }

    return { size, readble: `${(size / (1024**2)).toFixed(2)} MB` };
  }

  async launchBrowser(userId, options = {}) {
    const profilePath = this.getProfilePath(userId);
    const isNewProfile = !fs.existsSync(profilePath) || fs.readdirSync(profilePath).length === 0;

    // Criar diretório se não existir
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    // Limpar locks antigos (se houver)
    this.clearProfileLocks(profilePath);

    // Verificar saúde do perfil
    const health = this.checkProfileHealth(profilePath);
    if (!health.healthy) {
      console.warn(`Profile health issues for ${userId}:`, health.issues);

      // Se crítico, criar backup e novo perfil
      if (health.issues.some(i => i.includes('corrupt') || i.includes('Missing'))) {
        await this.repairProfile(userId);
      }
    }

    // Preparar args
    const args = this.config.defaultArgs.map(arg =>
      arg.startsWith('--user-data-dir=')
        ? `--user-data-dir=${profilePath}`
        : arg
    );

    // Adicionar args customizados
    if (options.extraArgs) {
      args.push(...options.extraArgs);
    }

    try {
      const browser = await puppeteer.launch({
        headless: options.headless || 'shell',
        executablePath: this.config.chromeExecutable,
        args,
        ignoreDefaultArgs: options.ignoreDefaultArgs || false,
      });

      // Registrar instância ativa
      this.instances.set(userId, {
        browser,
        profilePath,
        launchTime: Date.now(),
        metadata: await this.loadMetadata(userId) || {},
      });

      // Iniciar timeout manager
      await this.sessionManager.createSession(userId, browser);

      // Atualizar metadata
      const meta = await this.loadMetadata(userId) || {};
      meta.sessionCount = (meta.sessionCount || 0) + 1;
      meta.lastSeen = new Date().toISOString();
      await this.saveMetadata(userId, meta);

      console.log(`Launched browser for ${userId} (profile: ${isNewProfile ? 'new' : 'existing'})`);
      return browser;

    } catch (err) {
      console.error(`Failed to launch browser for ${userId}:`, err);
      throw err;
    }
  }

  async repairProfile(userId) {
    const profilePath = this.getProfilePath(userId);
    console.log(`Attempting to repair profile for ${userId}`);

    // 1. Backup do perfil atual
    const backupPath = path.join(this.config.backupDir, `${userId}-repair-${Date.now()}`);
    await this.backupProfile(userId, backupPath);

    // 2. Remover/corrigir arquivos problemáticos
    const repairActions = [
      () => this.repairPreferences(profilePath),
      () => this.repairSQLiteDatabases(profilePath),
      () => this.clearProfileLocks(profilePath),
    ];

    for (const action of repairActions) {
      try {
        await action();
      } catch (err) {
        console.warn(`Repair step failed: ${err.message}`);
      }
    }

    console.log(`Repair completed for ${userId}`);
  }

  async backupProfile(userId, backupPath = null) {
    const profilePath = this.getProfilePath(userId);

    if (!fs.existsSync(profilePath)) {
      throw new Error(`Profile does not exist: ${profilePath}`);
    }

    const targetBackupPath = backupPath ||
      path.join(this.config.backupDir, `${userId}-${Date.now()}`);

    console.log(`Backing up ${userId} to ${targetBackupPath}`);

    // FECHAR Chrome primeiro se estiver rodando
    if (this.instances.has(userId)) {
      console.log(`Closing active browser for ${userId} before backup...`);
      await this.closeBrowser(userId, { graceful: true });
    }

    // Copiar diretório
    await this.copyDirectory(profilePath, targetBackupPath);

    // Salvar metadados do backup
    const backupMeta = {
      userId,
      backupPath: targetBackupPath,
      size: this.getDirectorySize(profilePath),
      backedUpAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(targetBackupPath, 'backup-metadata.json'),
      JSON.stringify(backupMeta, null, 2)
    );

    console.log(`✓ Backup completed: ${(backupMeta.size.size / (1024**3)).toFixed(2)} GB`);
    return backupMeta;
  }

  async restoreProfile(userId, backupPath) {
    const profilePath = this.getProfilePath(userId);
    const sourcePath = backupPath;

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Backup not found: ${sourcePath}`);
    }

    console.log(`Restoring ${userId} from ${sourcePath}`);

    // FECHAR Chrome se estiver ativo
    if (this.instances.has(userId)) {
      await this.closeBrowser(userId, { graceful: true });
    }

    // Backup do perfil atual
    if (fs.existsSync(profilePath)) {
      const currentBackup = `${profilePath}.pre-restore-${Date.now()}`;
      await this.copyDirectory(profilePath, currentBackup);
      console.log(`Current profile backed up to: ${currentBackup}`);
    }

    // Restaurar
    if (fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }

    await this.copyDirectory(sourcePath, profilePath);
    console.log(`✓ Profile restored for ${userId}`);
  }

  async closeBrowser(userId, options = { graceful: true }) {
    const instance = this.instances.get(userId);
    if (!instance) {
      console.warn(`No active browser for ${userId}`);
      return false;
    }

    console.log(`Closing browser for ${userId} (graceful: ${options.graceful})`);

    try {
      if (options.graceful) {
        // Usar CDP Browser.close()
        const wsEndpoint = await instance.browser.wsEndpoint();
        const url = new URL(wsEndpoint);
        const port = parseInt(url.port);

        const client = await CDP({ port });
        await client.Browser.close();
        await new Promise(resolve => setTimeout(resolve, 5000)); // Aguardar
      } else {
        // Force kill
        instance.browser.process().kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      // Remover da registry
      this.instances.delete(userId);
      this.sessionManager.sessions.delete(userId);

      console.log(`✓ Browser closed for ${userId}`);
      return true;

    } catch (err) {
      console.error(`Failed to close browser for ${userId}:`, err);

      // Force kill como fallback
      try {
        instance.browser.process().kill('SIGKILL');
        this.instances.delete(userId);
        this.sessionManager.sessions.delete(userId);
      } catch (e) {
        console.error(`Failed to force kill:`, e);
      }

      return false;
    }
  }

  async closeAllBrowsers() {
    console.log('Closing all browsers...');

    const results = {};
    for (const [userId] of this.instances) {
      results[userId] = await this.closeBrowser(userId, { graceful: true });
    }

    console.log(`Closed ${Object.values(results).filter(r => r).length}/${Object.keys(results).length} browsers`);
    return results;
  }

  async getSessionState(userId) {
    const instance = this.instances.get(userId);
    if (!instance) return null;

    // Obter dados via CDP (ver seção 7)
    const wsEndpoint = await instance.browser.wsEndpoint();
    const url = new URL(wsEndpoint);
    const port = parseInt(url.port);

    try {
      const sessionData = await exportSessionData(port);
      return {
        status: 'active',
        uptime: Date.now() - instance.launchTime,
        data: sessionData,
      };
    } catch (err) {
      console.error(`Failed to get session state for ${userId}:`, err);
      return { status: 'error', error: err.message };
    }
  }

  async cleanupOldBackups(keepDays = 30) {
    console.log('Cleaning up old backups...');

    const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000);
    const entries = fs.readdirSync(this.config.backupDir);

    let deleted = 0;
    for (const entry of entries) {
      const fullPath = path.join(this.config.backupDir, entry);

      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          deleted++;
        }
      } catch (err) {
        console.warn(`Failed to clean up ${entry}:`, err.message);
      }
    }

    console.log(`Deleted ${deleted} old backups`);
    return deleted;
  }

  // --- Helpers ---

  async copyDirectory(src, dest) {
    const exists = fs.existsSync;
    const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
    const readdir = fs.readdirSync;
    const stat = fs.statSync;
    const copyFile = fs.copyFileSync;

    if (exists(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    mkdir(dest);

    const entries = readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else if (entry.isFile()) {
        try {
          copyFile(srcPath, destPath);
        } catch (err) {
          console.warn(`Failed to copy ${srcPath}:`, err.message);
        }
      }
    }
  }

  async getWebSocketUrl(browser) {
    const wsEndpoint = await browser.wsEndpoint();
    const url = new URL(wsEndpoint);
    const port = parseInt(url.port);
    return { port, url: wsEndpoint };
  }

  repairPreferences(profilePath) {
    const prefFile = path.join(profilePath, 'Preferences');

    try {
      JSON.parse(fs.readFileSync(prefFile, 'utf8'));
      return true; // Já está OK
    } catch (err) {
      console.log(`Repairing Preferences for ${profilePath}`);
      if (fs.existsSync(prefFile)) {
        const backup = `${prefFile}.corrupted-${Date.now()}`;
        fs.renameSync(prefFile, backup);
      }
      // Chrome vai recriar na próxima inicialização
      return false;
    }
  }

  repairSQLiteDatabases(profilePath) {
    const sqliteFiles = ['Cookies', 'History', 'Login Data', 'Web Data'];

    for (const file of sqliteFiles) {
      const filePath = path.join(profilePath, file);
      if (!fs.existsSync(filePath)) continue;

      try {
        execSync(`sqlite3 "${filePath}" "PRAGMA integrity_check;"`, {
          stdio: 'ignore',
        });
      } catch (err) {
        console.log(`SQLite corruption detected in ${file}, backing up...`);
        const backup = `${filePath}.corrupted-${Date.now()}`;
        fs.renameSync(filePath, backup);
        // Chrome vai recriar vazio
      }
    }
  }

  getActiveUsers() {
    return Array.from(this.instances.keys());
  }

  getUserStats(userId) {
    const instance = this.instances.get(userId);
    const meta = this.loadMetadata(userId);

    return {
      userId,
      active: !!instance,
      profilePath: this.getProfilePath(userId),
      metadata: meta,
      uptime: instance ? Date.now() - instance.launchTime : null,
    };
  }

  setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`\nReceived ${signal}, initiating graceful shutdown...`);

        try {
          await this.closeAllBrowsers();
          console.log('All browsers closed successfully');
        } catch (err) {
          console.error('Error during shutdown:', err);
        }

        process.exit(0);
      });
    });
  }
}

// --- Funções Auxiliares CDP (ver seção 7) ---

async function exportSessionData(debuggingPort) {
  const client = await CDP({ port: debuggingPort });
  const { Network, DOMStorage, IndexedDB } = client;

  try {
    const sessionData = {
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      indexedDB: {},
      exportedAt: new Date().toISOString(),
    };

    // Cookies
    await Network.enable();
    const cookiesResp = await Network.getCookies();
    sessionData.cookies = cookiesResp.cookies;

    // DOM Storage
    await DOMStorage.enable();
    const domStorages = await DOMStorage.getDOMStorageIds();
    for (const storage of domStorages.storageIds) {
      const items = await DOMStorage.getDOMStorageItems({ storageId: storage });
      const key = `${storage.securityOrigin}:${storage.storageId}`;

      if (storage.storageId === 'localstorage') {
        sessionData.localStorage[key] = items.entries;
      } else {
        sessionData.sessionStorage[key] = items.entries;
      }
    }

    // IndexedDB (simplificado - sem recursão deep)
    await IndexedDB.enable();
    try {
      const dbs = await IndexedDB.requestDatabaseNames({ securityOrigin: '' });
      for (const origin of dbs.databaseNames) {
        const meta = await IndexedDB.requestDatabaseMetadata({ origin });
        sessionData.indexedDB[origin] = meta.databases.map(db => ({
          name: db.name,
          version: db.version,
          tables: db.objectStoreNames, // Simplificado
        }));
      }
    } catch (err) {
      console.warn('IndexedDB export failed (may need page context):', err.message);
    }

    return sessionData;
  } finally {
    client.close();
  }
}

module.exports = { ChromeProfileManager, exportSessionData };
```

### 8.2 Uso Prático

```javascript
const { ChromeProfileManager } = require('./ChromeProfileManager');

async function main() {
  const manager = new ChromeProfileManager({
    baseProfileDir: '/var/chrome-profiles',
    backupDir: '/backup/chrome-profiles',
    sessionTimeout: 30 * 60 * 1000, // 30 minutos
  });

  // Criar sessão para usuário
  const browser = await manager.launchBrowser('user_12345');

  // Usar o browser para scraping, automação, etc
  const page = await browser.newPage();
  await page.goto('https://example.com');

  // Obter estado atual
  const state = await manager.getSessionState('user_12345');
  console.log('Session data:', state);

  // Fechar gracefully
  await manager.closeBrowser('user_12345');

  // Backup manual
  await manager.backupProfile('user_12345');

  // Stats
  console.log(manager.getUserStats('user_12345'));
}

main().catch(console.error);
```

---

## 9. Resumo de Melhores Práticas

### 9.1 Checklist de Deploy em Produção

- [ ] Cada usuário → diretório `user-data-dir` separado
- [ ] Chrome sempre fechado gracefulmente (`Browser.close()` via CDP)
- [ ] Trap de sinais (SIGTERM/SIGINT) para shutdown limpo
- [ ] Limpeza automática de locks órfãos na inicialização
- [ ] Health check de perfil (arquivos críticos, tamanho)
- [ ] Backup incremental periódico (ideal: a cada hora ou mudança significativa)
- [ ] Retenção de backup configurável (padrão: 30 dias)
- [ ] Logging de ações críticas (shutdown forçado, corrupção)
- [ ] Monitor de disco (alertar se < 2GB livre)
- [ ] Separação por ambiente (dev/staging/prod em dirs diferentes)

### 9.2 Não Fazer

- ❌ Usar `kill -9` (SIGKILL) regularmente → corrupção de perfil
- ❌ Compartilhar `user-data-dir` entre múltiplos browsers simultâneos
- ❌ Fazer backup com Chrome rodando (arquivos inconsistentes)
- ❌ Ignorar erros de integridade SQLite (deixar propagar)
- ❌ Armazenar milhões de perfis na mesma partição (performance degrade)
- ❌ Esquecer de limpar backups antigos (custo de armazenamento)

### 9.3 Escalabilidade

| Usuários Simultâneos | Estratégia Recomendada |
|---------------------|----------------------|
| < 100 | 1 Chrome por usuário (isolado) |
| 100 - 1000 | Pool de Chromes com múltiplos perfis por processo (contextos) |
| > 1000 | Systems como Kubernetes com auto-scaling de pods |

**Observação:** Chrome consome ~100-300MB RAM por instância. 1000 usuários simultâneos = 100-300GB RAM (inviável). Usar pooling ou linha de execução sequencial.

### 9.4 Monitoramento

```javascript
// Métricas importantes a coletar
const metrics = {
  profile: {
    sizeBytes: getDirectorySize(profilePath),
    healthScore: calculateHealthScore(),
    corruptionEvents: countCorruptionEvents(),
  },
  sessions: {
    activeCount: manager.getActiveUsers().length,
    avgUptime: calcularUptimeMedio(),
    gracefulShutdownRate: percentualShutdownGraceful(),
  },
  storage: {
    totalUsedGB: somaTodasPastas(),
    growthRateMBPerDay: calcularCrescimento(),
  },
};
```

---

## 10. Referências e Fontes

### Documentação Oficial

- [Chrome User Data Directory - Chromium Docs](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Chrome Shutdown Documentation](https://chromium.googlesource.com/chromium/src/+/master/docs/shutdown.md)

### Insights Técnicos

- User Data Directory persistence: [Browserless Documentation](https://docs.browserless.io/enterprise/user-data-directory)
- Session file structure (Chrome 86+): [Google Groups Discussion](https://groups.google.com/a/chromium.org/g/chromium-discuss/c/O33rONHw-g0)
- Graceful shutdown via `Browser.close()`: [Chromium Shutdown Docs](https://chromium.googlesource.com/chromium/src/+/master/docs/shutdown.md)
- Profile backup/restore procedures: [GreenGeeks Tutorial](https://www.greengeeks.com/tutorials/how-to-backup-and-restore-all-settings-in-google-chrome/)
- Lock file behavior: Community reports on SingletonLock/SingletonSocket

### Multi-Tenant Considerations

- [Puppeteer user-data-dir multiple instances issue](https://github.com/puppeteer/puppeteer/issues/3373)
- [Chrome profile isolation best practices](https://webscraping.ai/faq/puppeteer/how-to-handle-multiple-browser-instances-in-puppeteer)
- Browser contexts vs separate profiles: [Puppeteer Issue #85](https://github.com/puppeteer/puppeteer/issues/85)

### CDP Storage APIs

- Network domain (cookies): [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- DOMStorage domain: [CDP DOMStorage](https://chromedevtools.github.io/devtools-protocol/tot/DOMStorage/)
- IndexedDB domain: [CDP IndexedDB](https://chromedevtools.github.io/devtools-protocol/tot/IndexedDB/)
- CacheStorage domain: [CDP CacheStorage](https://chromedevtools.github.io/devtools-protocol/tot/CacheStorage/)

---

**Fim do Documento**
