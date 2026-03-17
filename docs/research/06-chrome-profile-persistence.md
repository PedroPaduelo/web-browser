# Chrome Profile Persistence: Pesquisa Completa
**Data:** 2026-03-17
**Contexto:** Serende Remote Browser — necessidade de persistir login do usuário entre sessões do Chrome headless

---

## 1. Como Funciona `--user-data-dir`

O flag `--user-data-dir` instrui o Chrome a usar um diretório específico no disco como raiz de todos os dados do perfil. Sem ele, o Chrome headless cria um diretório temporário em memória/disco que é destruído ao fechar o processo — cada sessão começa do zero.

```bash
# Com persistência
google-chrome --headless=new \
  --user-data-dir=/data/profiles/user123 \
  --remote-debugging-port=9222

# Sem persistência (ephemeral)
google-chrome --headless=new \
  --remote-debugging-port=9222
```

### Flags relacionados

| Flag | Função |
|------|---------|
| `--user-data-dir=PATH` | Diretório raiz do perfil (contém um ou mais profiles) |
| `--profile-directory=NAME` | Sub-perfil dentro do user-data-dir (padrão: `Default`) |
| `--disk-cache-dir=PATH` | Separar cache do profile (útil para não incluir cache no backup) |
| `--disk-cache-size=BYTES` | Limitar tamanho do cache (ex: `--disk-cache-size=52428800` = 50MB) |
| `--no-first-run` | Pular wizard inicial |
| `--no-default-browser-check` | Evitar diálogos de checagem |

### Restrição crítica: 1 processo por diretório

O Chrome usa um **lock file** (`SingletonLock` ou `lockfile`) no `user-data-dir` para garantir exclusividade. Tentar iniciar dois processos apontando para o mesmo diretório causará erro ou comportamento indefinido. Consequência direta para o Serende: cada sessão de usuário deve ter seu próprio `user-data-dir` isolado.

---

## 2. Estrutura de Arquivos do Profile Chrome

O diretório `user-data-dir` contém arquivos globais e um subdiretório por profile (geralmente `Default/`).

### Estrutura de alto nível

```
/user-data-dir/
├── Local State                    # JSON: chave de criptografia, prefs globais
├── SingletonLock                  # Arquivo de lock (process PID)
├── Default/                       # Profile principal
│   ├── Cookies                    # SQLite: cookies (CRIPTOGRAFADO)
│   ├── Login Data                 # SQLite: senhas salvas (CRIPTOGRAFADO)
│   ├── Login Data-journal         # WAL journal do Login Data
│   ├── Preferences                # JSON: preferências do profile
│   ├── Secure Preferences         # JSON: preferências seguras
│   ├── Bookmarks                  # JSON: favoritos
│   ├── History                    # SQLite: histórico de navegação
│   ├── Favicons                   # SQLite: ícones de sites
│   ├── Top Sites                  # SQLite: sites mais visitados
│   ├── Web Data                   # SQLite: autopreenchimento, formulários
│   ├── Web Data-journal           # WAL journal do Web Data
│   ├── Network/
│   │   └── Cookies                # (Chrome 96+) Cookies movidos para cá
│   ├── Local Storage/
│   │   └── leveldb/               # LevelDB: dados localStorage de todos os origins
│   ├── Session Storage/           # LevelDB: sessionStorage (efêmero por aba)
│   ├── IndexedDB/
│   │   ├── https_site.com_0.indexeddb.leveldb/  # LevelDB por origin
│   │   └── https_site.com_0.indexeddb.blob/     # Blobs do IndexedDB
│   ├── Service Worker/
│   │   ├── CacheStorage/          # Cache API (service worker cache)
│   │   └── ScriptCache/           # Scripts dos service workers
│   ├── Cache/                     # Cache HTTP do browser (pode ser EXCLUÍDO do backup)
│   ├── Code Cache/                # V8 bytecode cache (pode ser EXCLUÍDO do backup)
│   ├── GPUCache/                  # Cache de shaders GPU (pode ser EXCLUÍDO do backup)
│   ├── Extensions/                # Extensões instaladas
│   └── Extension State/           # Estado das extensões
└── Profile 1/                     # Profile alternativo (se existir)
    └── ...                        # Mesma estrutura
```

### Formatos de armazenamento por tipo de dado

| Dado | Formato | Arquivo/Pasta |
|------|---------|---------------|
| Cookies | SQLite (criptografado) | `Default/Network/Cookies` |
| Senhas | SQLite (criptografado) | `Default/Login Data` |
| localStorage | LevelDB | `Default/Local Storage/leveldb/` |
| IndexedDB | LevelDB | `Default/IndexedDB/*.leveldb/` |
| Cache API (SW) | Arquivos binários | `Default/Service Worker/CacheStorage/` |
| Cache HTTP | Arquivos binários | `Default/Cache/` |
| Preferências | JSON | `Default/Preferences` |

---

## 3. Cookies: Armazenamento e Criptografia

### Localização

- Chrome < 96: `Default/Cookies`
- Chrome >= 96: `Default/Network/Cookies`

É um banco SQLite com tabela `cookies` contendo campos: `host_key`, `name`, `encrypted_value`, `path`, `expires_utc`, `is_secure`, `is_httponly`, `samesite`, etc.

O campo `value` é sempre vazio — o valor real fica em `encrypted_value` (criptografado).

### Esquema de criptografia por plataforma

| Plataforma | Método | Onde fica a chave |
|-----------|--------|-------------------|
| Windows | DPAPI (+ v10/v11 AES-256-GCM) | `Local State` → `os_crypt.encrypted_key` (DPAPI encrypted) |
| macOS | AES-256-GCM + chave no Keychain | macOS Keychain |
| Linux (com keyring) | AES-256-GCM + GNOME Keyring / KDE Wallet | Sistema de keyring |
| Linux (sem keyring / headless) | AES-256-GCM + senha hardcoded `"peanuts"` derivada via PBKDF2 | `Local State` |

**Implicação para o Serende (Linux headless sem keyring):** O Chrome usa a senha padrão `peanuts` com PBKDF2 para derivar a chave AES. Cookies com prefixo `v10` podem ser descriptografados sem keyring. Isso facilita backup/restore em ambiente Docker/headless.

### App-Bound Encryption (v20, Chrome 127+ no Windows)

Versão mais recente no Windows adiciona uma camada SYSTEM-DPAPI via COM server (elevation service). **Não afeta Linux.**

---

## 4. localStorage e SessionStorage

### localStorage (persistente)

- Formato: LevelDB (não SQLite — mudou anos atrás)
- Localização: `Default/Local Storage/leveldb/`
- Todos os origins ficam no mesmo banco LevelDB, separados por chave
- Chaves no formato: `_https://site.com\x00\x01key_name`
- Persiste indefinidamente até ser apagado pelo site ou pelo usuário
- Limite: ~5-10MB por origin

### sessionStorage (volátil)

- Formato: LevelDB
- Localização: `Default/Session Storage/`
- Persiste apenas durante a vida do processo Chrome
- **Não sobrevive** ao fechamento do browser, mesmo com `--user-data-dir`
- Não deve ser incluído em backup/restore

---

## 5. IndexedDB

- Formato: LevelDB (um subdiretório por origin)
- Localização: `Default/IndexedDB/`
- Nomenclatura: `https_site.com_0.indexeddb.leveldb/` + `https_site.com_0.indexeddb.blob/`
- Usado por apps modernas (Firebase Auth, PWAs, WhatsApp Web, etc.)
- Persiste com `--user-data-dir`
- Muitas autenticações modernas (Firebase, Auth0) armazenam tokens aqui

---

## 6. Service Workers e Cache API

- Service Worker registrations: `Default/Service Worker/`
- Cache API (usado por SWs): `Default/Service Worker/CacheStorage/`
- Scripts dos SWs: `Default/Service Worker/ScriptCache/`
- Persistem com `--user-data-dir`
- Permitem funcionamento offline de PWAs
- O cache HTTP padrão (`Default/Cache/`) é separado e pode ser excluído do backup

---

## 7. Headless Novo vs Antigo: Impacto na Persistência

O Chrome 128 (agosto 2024) tornou `--headless=new` o padrão. O Chrome 132 (janeiro 2025) removeu `--headless=old` completamente.

| Característica | `--headless=old` (chrome-headless-shell) | `--headless=new` (padrão atual) |
|---------------|------------------------------------------|----------------------------------|
| Arquitetura | Browser separado, não compartilha código do Chrome | Chrome real sem UI |
| Persistência de dados | Não persistia nada | Usa user-data-dir real |
| Profile compartilhado | Não conflita com Chrome GUI | Conflita se mesmo diretório |
| User-Agent | Revela `HeadlessChrome/...` | Igual ao Chrome headful |
| Multi-instância | Múltiplas instâncias no mesmo dir | **Proibido** — requer dirs únicos |
| Velocidade | Ligeiramente mais rápido | Ligeiramente mais lento |

**Recomendação para o Serende:** Usar `--headless=new` (ou simplesmente `--headless`) com um `--user-data-dir` único por sessão de usuário.

---

## 8. Puppeteer: Context Persistente

No Puppeteer, o contexto padrão já é persistente. Basta passar `userDataDir`:

```javascript
const puppeteer = require('puppeteer');

const browser = await puppeteer.launch({
  headless: true,                      // --headless=new
  userDataDir: '/data/profiles/user123',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
  ]
});

const page = await browser.newPage();
await page.goto('https://app.exemplo.com');

// Salvar cookies em JSON (alternativa ao user-data-dir)
const cookies = await page.cookies();
await fs.writeFile('./cookies.json', JSON.stringify(cookies, null, 2));

// Restaurar cookies em nova sessão
const savedCookies = JSON.parse(await fs.readFile('./cookies.json'));
await page.setCookie(...savedCookies);

await browser.close();
// Profile salvo em /data/profiles/user123
```

### Gerenciamento programático de cookies no Puppeteer

```javascript
// Obter cookies
const cookies = await page.cookies('https://site.com');

// Definir cookie
await page.setCookie({
  name: 'session',
  value: 'abc123',
  domain: 'site.com',
  path: '/',
  httpOnly: true,
  secure: true,
  expires: Math.floor(Date.now() / 1000) + 86400 * 30,
});

// Deletar cookie
await page.deleteCookie({ name: 'session', domain: 'site.com' });

// Via CDP direto (baixo nível)
const client = await page.target().createCDPSession();
await client.send('Network.enable');
const { cookies } = await client.send('Network.getAllCookies');
```

---

## 9. Playwright: Context Persistente e storageState

### `launchPersistentContext`

Playwright requer o uso explícito de `launchPersistentContext` para persistência (ao contrário do Puppeteer onde é o padrão):

```typescript
import { chromium } from 'playwright';

const context = await chromium.launchPersistentContext(
  '/data/profiles/user123',   // userDataDir
  {
    headless: true,
    args: ['--no-sandbox'],
  }
);

const page = await context.newPage();
await page.goto('https://app.exemplo.com');
// Login...

await context.close(); // Fecha e salva automaticamente no userDataDir
```

### `storageState`: abordagem alternativa mais leve

`storageState` é uma abordagem que salva apenas cookies e localStorage em JSON, sem precisar preservar o `user-data-dir` inteiro:

```typescript
// SALVAR estado após login
await page.context().storageState({ path: 'auth-state.json' });

// Arquivo gerado
// {
//   "cookies": [
//     {
//       "name": "session_id",
//       "value": "xyz...",
//       "domain": ".app.exemplo.com",
//       "path": "/",
//       "expires": 1780000000,
//       "httpOnly": true,
//       "secure": true,
//       "sameSite": "Lax"
//     }
//   ],
//   "origins": [
//     {
//       "origin": "https://app.exemplo.com",
//       "localStorage": [
//         { "name": "auth_token", "value": "Bearer eyJ..." }
//       ]
//     }
//   ]
// }

// RESTAURAR em nova sessão
const context = await browser.newContext({
  storageState: 'auth-state.json'
});
// OU via config global do Playwright:
// use: { storageState: 'auth-state.json' }
```

### IndexedDB no storageState (Playwright 1.51+)

```typescript
// Incluir IndexedDB no export (Firebase Auth, etc.)
await context.storageState({
  path: 'auth-state.json',
  indexedDB: true   // novo em v1.51
});
```

### sessionStorage (não capturado automaticamente)

```typescript
// Salvar sessionStorage manualmente
const sessionData = await page.evaluate(() => JSON.stringify(sessionStorage));

// Restaurar via initScript
await context.addInitScript(data => {
  for (const [key, value] of Object.entries(JSON.parse(data))) {
    window.sessionStorage.setItem(key, value);
  }
}, sessionData);
```

### Comparação Puppeteer vs Playwright

| Aspecto | Puppeteer | Playwright |
|---------|-----------|------------|
| Contexto persistente padrão | Sim (com `userDataDir`) | Não — requer `launchPersistentContext` |
| API de storageState JSON | Não nativo | Sim (`context.storageState()`) |
| IndexedDB no storageState | Não | Sim (v1.51+, flag `indexedDB: true`) |
| sessionStorage no storageState | Não | Não (workaround manual) |

---

## 10. Estratégias de Backup e Restore

### Estratégia 1: Backup do user-data-dir completo

A abordagem mais simples. Copia o diretório inteiro entre sessões.

**Arquivos essenciais para login** (mínimo necessário):
```
user-data-dir/
├── Local State               # OBRIGATÓRIO: chave de criptografia
└── Default/
    ├── Cookies               # ou Network/Cookies no Chrome >= 96
    ├── Login Data            # senhas salvas (opcional)
    ├── Login Data-journal    # journal do acima
    ├── Preferences           # configurações do profile
    ├── Local Storage/        # localStorage (autenticação moderna)
    │   └── leveldb/
    └── IndexedDB/            # IndexedDB (Firebase, PWAs)
```

**Arquivos que podem ser EXCLUÍDOS** (não afetam login):
```
Default/Cache/           # Cache HTTP (regenerado automaticamente)
Default/Code Cache/      # V8 bytecode cache (regenerado)
Default/GPUCache/        # GPU shaders (regenerado)
Default/History          # Histórico (privacidade)
Default/Session Storage/ # Volátil por design
```

### Estratégia 2: Backup seletivo com tar

```bash
# Backup mínimo para login (exclui cache)
tar -czf profile-user123-$(date +%Y%m%d).tar.gz \
  --exclude='Default/Cache' \
  --exclude='Default/Code Cache' \
  --exclude='Default/GPUCache' \
  --exclude='Default/Session Storage' \
  -C /data/profiles \
  user123/

# Verificar tamanho
du -sh profile-user123-*.tar.gz

# Restore
tar -xzf profile-user123-20260317.tar.gz -C /data/profiles/
```

### Estratégia 3: rsync incremental

```bash
# Sync inicial ou incremental (apenas mudanças)
rsync -av --delete \
  --exclude='Default/Cache/' \
  --exclude='Default/Code Cache/' \
  --exclude='Default/GPUCache/' \
  --exclude='Default/Session Storage/' \
  /data/profiles/user123/ \
  /backup/profiles/user123/

# Snapshot com timestamp
rsync -av \
  /data/profiles/user123/ \
  /backup/profiles/user123-$(date +%Y%m%d-%H%M%S)/
```

### Estratégia 4: Apenas cookies em JSON (mais leve)

Útil quando não se usa Playwright. Extrai cookies via CDP:

```javascript
// Extrair cookies via CDP
const cdp = await fetch('http://localhost:9222/json');
const targets = await cdp.json();

// Via página Puppeteer/CDP
const cookies = await page.cookies();
const cookiesJson = JSON.stringify(cookies, null, 2);
await fs.writeFile('/data/sessions/user123-cookies.json', cookiesJson);

// Restaurar
const cookies = JSON.parse(await fs.readFile('/data/sessions/user123-cookies.json'));
await page.setCookie(...cookies);
```

### Estratégia 5: storageState Playwright (recomendada para Playwright)

```typescript
// Script de extração de estado
async function saveSession(page: Page, userId: string) {
  const state = await page.context().storageState({ indexedDB: true });
  await fs.writeFile(
    `/data/sessions/${userId}-state.json`,
    JSON.stringify(state, null, 2)
  );
}

// Restauração em nova sessão
async function loadSession(browser: Browser, userId: string) {
  const statePath = `/data/sessions/${userId}-state.json`;
  const context = await browser.newContext({
    storageState: statePath
  });
  return context;
}
```

---

## 11. Melhores Práticas para Salvar e Restaurar Login

### 1. Fechar Chrome antes de fazer backup

O Chrome mantém arquivos abertos e usa WAL (Write-Ahead Log) no SQLite e LevelDB. Copiar com o processo rodando pode resultar em dados corrompidos ou incompletos.

```bash
# Correto: fechar primeiro
pkill -f chrome
sleep 2  # aguardar flush
tar -czf backup.tar.gz /data/profiles/user123/

# Alternativa: usar checkpoint no SQLite (se leitura com o processo rodando for necessária)
sqlite3 ~/.config/google-chrome/Default/Cookies "PRAGMA wal_checkpoint(FULL);"
```

### 2. Preservar `Local State` junto com o profile

O arquivo `Local State` na raiz do `user-data-dir` contém a chave de criptografia usada para os cookies. Sem ele, os cookies não podem ser descriptografados e o login falha silenciosamente.

### 3. Diretório único por usuário e por sessão

```
/data/profiles/
├── user-abc123/     # Profile persistente do usuário abc123
├── user-def456/     # Profile persistente do usuário def456
└── temp-session-xyz/  # Sessão temporária (pode ser descartada)
```

Nunca compartilhe `user-data-dir` entre dois processos Chrome simultâneos.

### 4. Separar cache do profile (produção)

```bash
google-chrome --headless=new \
  --user-data-dir=/data/profiles/user123 \
  --disk-cache-dir=/tmp/chrome-cache/user123 \
  --disk-cache-size=52428800  # 50MB max
```

Isso mantém o backup do profile pequeno (sem cache).

### 5. Verificar validade da sessão antes de usar

Cookies podem expirar. Antes de assumir que o perfil está autenticado:

```javascript
async function isSessionValid(page) {
  await page.goto('https://app.exemplo.com/dashboard');
  // Se redirecionar para login, sessão expirou
  return page.url().includes('/dashboard');
}

// Se inválida, fazer login novamente e salvar novo state
if (!await isSessionValid(page)) {
  await doLogin(page);
  await saveSession(page, userId);
}
```

### 6. Rotacionar/versionar backups

```bash
# Manter últimas 7 versões
ls -t /backup/profiles/user123-*.tar.gz | tail -n +8 | xargs rm -f

# Ou usar diretório com data
BACKUP_DIR="/backup/profiles/$(date +%Y/%m/%d)"
mkdir -p "$BACKUP_DIR"
cp -r /data/profiles/user123/ "$BACKUP_DIR/user123/"
```

### 7. Criptografar backups (dados sensíveis)

O arquivo de cookies contém sessões autenticadas. Em produção:

```bash
# Criptografar backup
gpg --symmetric --cipher-algo AES256 profile-user123.tar.gz

# Ou usar age (mais moderno)
age -r $(cat ~/.config/age/key.pub) -o profile-user123.tar.gz.age profile-user123.tar.gz
```

### 8. Lidar com perfil corrompido

Se o Chrome recusar iniciar com o profile (crash anterior, lock stale, corrupção):

```bash
# Remover lock stale
rm /data/profiles/user123/SingletonLock
rm /data/profiles/user123/SingletonSocket
rm /data/profiles/user123/Default/.com.google.Chrome.*

# Se corrupção grave, restaurar do backup e relogar
```

---

## 12. Considerações para o Serende

Com base na análise acima, as implicações diretas para o projeto:

### Arquitetura de profiles recomendada

```
/data/
├── profiles/
│   ├── {userId}/           # Profile persistente por usuário
│   │   ├── Local State
│   │   └── Default/
│   │       ├── Cookies (ou Network/Cookies)
│   │       ├── Local Storage/
│   │       └── IndexedDB/
│   └── ...
├── sessions/               # Dados de sessão temporários
│   └── {sessionId}/        # Diretório de trabalho da sessão ativa
└── backups/
    └── {userId}/
        └── {YYYYMMDD}/     # Backup diário
```

### Fluxo de inicialização da sessão

```
1. Usuário inicia sessão
2. Verificar se profile existe em /data/profiles/{userId}/
3. Se SIM: copiar para diretório de sessão temporário (ou usar direto)
4. Iniciar Chrome com --user-data-dir=/data/profiles/{userId}/
5. Verificar se sessão ainda é válida (navegar para URL protegida)
6. Se sessão inválida: notificar usuário para relogar
7. Ao finalizar sessão: profile já está salvo no diretório (Chrome gravou)
8. Backup periódico para /data/backups/{userId}/{data}/
```

### Tamanho esperado de profile mínimo

| Componente | Tamanho típico |
|-----------|----------------|
| Cookies + Local State | 100KB - 2MB |
| Local Storage (LevelDB) | 1-20MB |
| IndexedDB | 1-50MB (apps complexos) |
| Service Worker cache | 5-100MB (PWAs) |
| Cache HTTP | 100MB-2GB (EXCLUIR do backup) |
| **Total sem cache** | **~5-100MB por usuário** |

### Limpeza periódica do cache

```bash
# Script de limpeza (executar com Chrome fechado)
rm -rf /data/profiles/{userId}/Default/Cache/
rm -rf /data/profiles/{userId}/Default/Code\ Cache/
rm -rf /data/profiles/{userId}/Default/GPUCache/
# Não remover Local Storage, IndexedDB, Cookies
```

---

## 13. Armadilhas Conhecidas

1. **Windows headless cookie bug**: No Windows, o Chrome headless pode silenciosamente descartar cookies ao fechar. Não afeta Linux.

2. **CDP Browser Context (incognito)**: Criar contextos via `Target.createBrowserContext` CDP resulta em contextos isolados sem persistência (equivalente a incognito). Para persistência, usar o contexto padrão (Default).

3. **Chrome 96+**: Cookies mudaram de `Default/Cookies` para `Default/Network/Cookies`. Scripts que fazem backup manual precisam verificar ambos os locais.

4. **LevelDB não é copiável com processo rodando**: O LevelDB usa arquivos de lock e WAL. Copiar com o processo ativo pode gerar banco corrompido. Sempre fechar o Chrome antes de copiar.

5. **`storageState` não captura sessionStorage**: Se a aplicação usa sessionStorage para tokens, usar `addInitScript` para restaurar manualmente.

6. **Permissões de arquivo**: Ao restaurar um profile de backup, verificar que o usuário do processo Chrome tem permissão de leitura/escrita no diretório.

7. **Profile de Chrome GUI vs headless**: Apontar `--user-data-dir` para o profile do Chrome instalado do sistema pode causar conflitos. Sempre usar um diretório dedicado para o headless.

---

## Referências

- [Chrome Headless Mode — Chrome for Developers](https://developer.chrome.com/docs/chromium/headless)
- [Chromium Docs — User Data Directory](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)
- [Browserless — User Data Directory for persisting sessions](https://docs.browserless.io/enterprise/user-data-directory)
- [Playwright — Authentication](https://playwright.dev/docs/auth)
- [Playwright — BrowserType](https://playwright.dev/docs/api/class-browsertype)
- [Playwright — BrowserContext storageState](https://playwright.dev/docs/api/class-browsercontext)
- [Puppeteer — Cookies Guide](https://pptr.dev/guides/cookies)
- [WebScraping.AI — How does Headless Chromium handle website cookies and local storage?](https://webscraping.ai/faq/headless-chromium/how-does-headless-chromium-handle-website-cookies-and-local-storage)
- [WebScraping.AI — How do I manage sessions and cookies effectively in Headless Chromium?](https://webscraping.ai/faq/headless-chromium/how-do-i-manage-sessions-and-cookies-effectively-in-headless-chromium)
- [Rebrowser — Profiles & Persistent Context](https://rebrowser.net/docs/profiles-and-persistent-context)
- [BrowserStack — Using Persistent Context in Playwright](https://www.browserstack.com/guide/playwright-persistent-context)
- [BrowserStack — Playwright storageState](https://www.browserstack.com/guide/playwright-storage-state)
- [CCL Solutions — Chromium Session Storage and Local Storage](https://www.cclsolutionsgroup.com/post/chromium-session-storage-and-local-storage)
- [Chrome Cookie Storage Locations](https://eathealthy365.com/chrome-cookie-storage-3-key-locations-management-tips/)
- [Chrome Profile Persistence Optimization — Cameyo](https://helpcenter.cameyo.com/support/solutions/articles/80001044939-chrome-profile-persistence-optimization)
- [How to manage cookies, sessions and the data directory for Puppeteer — Browserless](https://www.browserless.io/blog/manage-sessions)
- [Removing --headless=old from Chrome](https://developer.chrome.com/blog/removing-headless-old-from-chrome)
- [Apify — Creating multiple browser contexts](https://docs.apify.com/academy/puppeteer-playwright/browser-contexts)
- [Chromium Issue #775703 — Headless maintains a different profile folder](https://bugs.chromium.org/p/chromium/issues/detail?id=775703)
