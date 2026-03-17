# Multi-Tenant Browser Session Isolation: Pesquisa e Recomendações

**Data:** Março 2025
**Autor:** Pesquisa Automatizada
**Revisão:** 1.0

## Sumário

Este documento apresenta uma análise detalhada sobre isolamento de sessões de navegador em arquiteturas multi-tenant, com foco em segurança, estratégias de isolamento e implementações de referência no setor.

---

## 1. Como Isolar Sessões de Diferentes Usuários no Chrome

### 1.1. Estratégias de Isolamento

#### a) `--user-data-dir` - Perfiles de Dados Separados

O Chrome suporta múltiplos profiles através do parâmetro `--user-data-dir`, que permite executar múltiplas instâncias independentes do navegador[^1].

**Como funciona:**
- Cada instância do Chrome com um `--user-data-dir` diferente mantém seus próprios:
  - Cookies e sessões de autenticação
  - Cache
  - Histórico de navegação
  - Extensões instaladas
  - Configurações
  - Senhas salvas

**Implementação:**
```bash
# Criar diretório para o tenant
mkdir -p /browser-data/tenant-123

# Iniciar Chrome com user-data-dir isolado
chrome --user-data-dir=/browser-data/tenant-123 \
       --remote-debugging-port=9222 \
       --no-first-run
```

**Limitações críticas:**
A documentação oficial do Chromium enfatiza que **não há expectativa de privacidade especial** quando múltiplos usuários compartilham a mesma identidade de sistema operacional[^1]. As preferências e configurações não têm criptografia adicional além daquela já existente nos diretórios de dados do usuário.

No macOS, como as senhas são armazenadas no keychain comumente acessível, um usuário em uma conta pode acessar senhas armazenadas por outro usuário no mesmo sistema.

#### b) Usuários do Sistema Operacional Separados

Para verdadeiro isolamento de segurança, a abordagem recomendada é **combinar**:
1. Usuários Unix/Linux separados (UIDs diferentes)
2. `--user-data-dir` em diretórios com permissões restritas
3. Containers Docker com namespaces de usuário

Isso garante que processos de tenants diferentes não possam acessar os recursos de memória compartilhada ou arquivos entre si.

#### c) Containers Docker/LXC

**Arquitetura recomenda:**
```yaml
services:
  browser-tenant-1:
    image: chrome-headless
    user: "1001:1001"  # UID/GID único por tenant
    volumes:
      - ./data/tenant-1:/home/chromeuser/.config/google-chrome
    network_mode: "bridge"
    cpus: 2.0
    mem_limit: 4g
    security_opt:
      - no-new-privileges:true
      - apparmor:chrome-browser
      - seccomp=chrome-seccomp.json
    capabilities:
      - NET_ADMIN  # apenas se necessário
      - CHOWN
      - SETUID
      - SETGID
      - SYS_ADMIN  # apenas se necessário
```

### 1.2. Site Isolation (Camada Adicional)

O Chrome inclui **Site Isolation** por padrão desde a versão 76 (Desktop) e 77 (Android)[^1]. Esta funcionalidade:
- Separa páginas de sites diferentes em diferentes processos
- Dificulta que sites maliciosos acessem dados de outros sites
- Bloqueia processos de receberem dados sensíveis de outros sites

**Ativação:**
```bash
chrome --enable-site-per-process \
       --site-per-process
```

**Importante:** Site Isolation protege contra ataques **dentro do mesmo navegador**, mas **não** substitui o isolamento entre tenants.

---

## 2. Segurança: O Que Pode Vazar Entre Sessões?

### 2.1. Riscos de Vazamento

#### a) Sem Isolamento Adequado
- **Cookies e sessões ativas:** Acesso a contas autenticadas
- **Cache de arquivos:** Arquivos temporários acessíveis
- **Histórico de navegação:** Metadados de atividades
- **Local Storage/IndexedDB:** Dados da aplicação
- **Credenciais salvas:** Senhas e autenticação
- **Extensões instaladas:** Extensões podem capturar dados
- **WebRTC leaks:** IP real exposto mesmo com proxy
- **Fingerprinting:** Canvas, WebGL, fonts, etc

#### b) Isolamento Inadequado
Mesmo com `--user-data-dir` separado, ainda há riscos:
- **Process Memory:** Se o mesmo sistema operacional, theoretically um exploit poderia acessar memória de outros processos (embora difícil)
- **File System:** Se permissões mal configuradas
- **Network:** Sem isolamento de rede, pacotes podem ser sniffed em ambientes compartilhados
- **Kernel:** Vulnerabilidades no kernel permitem escapar de containers
- **GPU/Acceleration:** Compartilhamento de recursos de hardware pode vazar informações via timing attacks

### 2.2. Vulnerabilidades Específicas do Chrome

Em 2024, foram reportadas mais de 50 vulnerabilidades críticas ou severas no Chromium[^3]. Várias foram rastreadas como exploradas ativamente pelo CISA KEV.

**Tipos de vulnerabilidades relevantes:**
- **Use-after-free:** Permite execução de código
- **Sandbox escape:** Quebra do sandbox de processos
- **Information disclosure:** Vazamento de memória entre processos
- **Integer overflow:** Leva a execução de código

**Mitigação:**
- Manter Chrome atualizado
- Usar seccomp, AppArmor/SELinux
- Executar com o menor privilégio possível (non-root)
- Habilitar Site Isolation
- Usar sandboxing de namespace de usuário

### 2.3. Vazamentos Laterais

**Timing attacks:** Mesmo sem acesso direto, um tenant pode inferir atividade de outro através de:
- Uso de CPU/disco I/O (observável via shared metrics)
- Latência de rede (se compartilhada)
- Estruturas de memória em sistemas de paginação

**Mitigação:** Isolamento físico de recursos (CPU pinning, memória dedicada, rede dedicada).

---

## 3. user-data-dir por Usuário: Vantagens e Desvantagens

### 3.1. Vantagens

✅ **Isolamento funcional**
- Cookies, cache, histórico completamente separados
- Extensões independentes
- Configurações independentes
- Senhas independentes (dentro do mesmo perfil OS)

✅ **Facilidade de implementação**
- Simples de configurar
- Não requer modificações no Chrome
- Compatível com todas as versões

✅ **Boas práticas de limpeza**
- Basta deletar o diretório para limpar a sessão
- Não há remnants交叉 contaminación

✅ **Suporte a múltiplas sessões simultâneas**
- Cada tenant pode ter várias instâncias simultâneas sem conflito
- Mas cada instância deve ter seu próprio user-data-dir

### 3.2. Desvantagens

❌ **Isolamento de sistema operacional**
- Não isola em nível de sistema operacional
- Se rodar como mesmo UID, há risco de acessar arquivos de outros tenants se as permissões estiverem mal configuradas

❌ **Overhead de recursos**
- Cada user-data-dir consome espaço em disco
- Múltiplas instâncias multiplicam uso de RAM
- Sem deduplicação de código Chrome

❌ **Gestão complexa em escala**
- Milhares de diretórios = milhares de arquivos
- Backup/restore complicado
- Limpeza manual ou scripts de GC necessários

❌ **Sem isolamento de rede**
- Todas as instâncias compartilham a mesma interface de rede (se no mesmo host)
- IPs/geolocalização são os mesmos para todos os tenants
- Pode ser mitigado com proxies por tenant

❌ **Sem rate limiting integrado**
- Chrome não tem built-in rate limiting por user-data-dir
- Deve ser implementado Outside (load balancer, proxy, etc)

❌ **Sem isolamento de CPU/memória**
- Scheduler do OS decide alocação de CPU
- Memória não tem quotas (a menos que use cgroups/containers)

### 3.3. Recomendação

**Usar `--user-data-dir` COMO PARTE da estratégia, não como única camada.**

Estrutura recomendada:
```
Tenant A:
  - UID/GID único (docker user, ou usuário Unix)
  - user-data-dir em diretório acessível apenas por esse UID
  - Container com cgroups limitando CPU/memória
  - Network namespace separado (ou pelo menos veth pair dedicado)
  - Seccomp/AppArmor profile
```

---

## 4. Como Browserbase/Steel Gerenciam Isolamento Multi-Tenant

### 4.1. Browserbase

**Arquitetura Serverless:**
Browserbase roda em infraestrutura serverless, tratando browsers como unidades de compute efêmeras[^2]. A plataforma:

- **Spin up de milhares de browsers em milissegundos**
- **4 vCPUs por browser instance** (recursos dedicados)
- **Globalmente distribuído** (regions para latência)
- **Sem cold starts** (mantém warm pool)

**Isolation por Sessão:**
- Cada sessão é uma instância de browser completamente independente
- Disposable: quando a sessão termina, o container é destruído
- Isolamento de rede: cada sessão tem sua própria stack de rede
- Contexts API: permite persistir cookies entre sessões do mesmo usuário, mas **dentro** de um escopo de tenant/project

**Session Management:**
```javascript
// Cada sessão é independente
const session = await browserbase.createSession({
  projectId: "proj_xxx",  // Escopo do tenant
  userId: "user_123"      // Identificação do usuário final
});

// Contexts permitem reutilizar estado
const context = await browserbase.createContext({
  projectId: "proj_xxx"
});

// Reutilizar contexto em múltiplas sessões
const session1 = await browserbase.createSession({ contextId: context.id });
const session2 = await browserbase.createSession({ contextId: context.id });
```

**Multi-Tenancy:**
- Projetos (`projectId`) separam tenants
- API Keys são scoped por projeto
- Cada projeto tem seu próprio pool de resources
- Billing e usage tracking por projeto

**Rate Limiting:**
Browserbase implementa rate limiting por projeto/API key nos níveis:
- Sessões concorrentes
- API requests por minuto
- Lifetime de sessão (inativo por 60s = timeout)

### 4.2. Steel Browser

Steel é open-source e pode ser self-hosted, o que permite total controle sobre o isolamento[^2].

**Container Sandbox:**
O Steel Browser é descrito como um "browser sandbox em container production-ready":
- Robusto para uso em produção
- Stealth capabilities built-in (anti-detecção)
- Session management completo
- Web UI para visualizar/debuggar sessões
- Suporte a Puppeteer, Playwright, Selenium

**Multi-Tenant:**
Como é self-hosted, a implementação de multi-tenancy fica a cargo do operador:
- Pode usar namespaces Kubernetes por tenant
- Database separado por tenant (ou shared com tenant_id)
- Autenticação via SSO/JWT com claims de tenant
- Rate limiting por tenant no ingress controller

**Exemplo de deployment multi-tenant com Steel:**

```yaml
# Namespace por tenant ou shared namespace com RBAC
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-a
---
# LimitRange por tenant
apiVersion: v1
kind: LimitRange
metadata:
  name: tenant-limits
  namespace: tenant-a
spec:
  limits:
  - default:
      memory: "2Gi"
      cpu: "1000m"
    defaultRequest:
      memory: "1Gi"
      cpu: "500m"
    type: Container
---
# NetworkPolicy isolamento
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-cross-tenant
  namespace: tenant-a
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

### 4.3. Comparação: Browserbase vs Steel

| Aspecto | Browserbase | Steel (self-hosted) |
|---------|-------------|---------------------|
| **Tipo** | Managed cloud (serverless) | Open-source + you manage |
| **Isolation** | Container por sessão | Container (você controla) |
| **Multi-tenant** | Built-in (projectId scoping) | Você implementa |
| **Rate limiting** | Built-in por API key | Você implementa (nginx/k8s/whatever) |
| **Stealth** | Built-in em tiers pagos | Built-in |
| **Customização** | Limitada (API only) | Total controle |
| **Compliance** | SOC2, GDPR (they handle) | Você é responsável |
| **Lock-in** | Vendor lock-in | Nenhum lock-in |

---

## 5. Problemas de Compartilhamento de Recursos (CPU, Memória, Display)

### 5.1. CPU

**Problema:** Múltiplas sessões competem por ciclos de CPU.

**Efeitos:**
- Latência alta se overcommit
- Processos stuck em run queue
- Inconsistência de performance

**Solução:**
- **cgroups v2** (Linux) com quotas
- **CPU pinning** (CPU affinity) para evitar cache thrashing
- **CPU shares** para weighting relativo

```bash
# Exemplo com systemd-run
systemd-run --unit=browser-tenant-1 \
  --scope \
  -p CPUQuota=200% \
  -p CPUShares=512 \
  chrome --user-data-dir=/data/tenant-1

# Docker compose
services:
  tenant-1:
    cpus: "2.0"  # Máximo de 2 CPUs
    cpu_quota: 200000  # 200% de uma CPU
    cpu_period: 100000
```

**Best practice:**
- Provisionar no máximo **70-80%** de uso médio
- Overcommit controlado com monitoring
- Priorização por tenant tier (ex: premium = mais CPU share)

### 5.2. Memória

**Problema:** Chrome é memory hungry (500MB-2GB por sessão dependendo de tabs).

**Efeitos:**
- OOM killer matando processos
- Swap thrashing (performance catastrófica)
- Instabilidade do sistema

**Solução:**
- **cgroups mem limit** (hard limit)
- **memsw limit** (memória + swap)
- **OOM score adjust** para priorizar quem morre

```bash
# Docker
mem_limit: 4g
memswap_limit: 6g  # mem + swap
oom_score_adj: 500  # menos prioritário que processos críticos

# Systemd
systemd-run -p MemoryMax=4G -p MemorySwapMax=6G
```

**Monitoring:**
```bash
# Verificar uso por cgroup
cat /sys/fs/cgroup/memory/docker/<container-id>/memory.usage_in_bytes
cat /sys/fs/cgroup/memory/docker/<container-id>/memory.max_usage_in_bytes
```

**Best practice:**
- Alocar **pelo menos 1.5-2GB** por sessão Chrome (com tabs típicas)
- Headless mode consome menos RAM (sem GPU compositing)
- Chrome `--single-process` NÃO é seguro (isolation reduzida)

### 5.3. Display (Se aplicável - VNC/WebRTC)

**Problema:** Se usar VNC streaming ou WebRTC para mostrar o browser:

- **GPU memory:** VNC server e Chrome compositor usam GPU
- **Network bandwidth:** Resolução alta = muitos pixels
- **CPU encoding:** Software encoding (x264) é CPU intensivo
- **Latency:** Varia conforme load do host

**Solução:**
- **GPU isolation** via MIG (NVIDIA) ou device plugins (K8s)
- **Resolution scaling:** 720p vs 1080p vs 4K
- **FPS limiting:** 15-30fps (web browsing não precisa de 60fps)
- **Codec:** H.264 (hardware acceleration) vs VP8/VP9

```bash
# VNC com bandwidth limit
x11vnc -display :1 -rfbport 5901 \
  -quality 70 -compresslevel 5 \
  -clip xinerama0  # clip resolution
```

**Kasm Workspaces approach:**
Kasm usa **KasmVNC** para streaming[^4]. Cada container tem acesso a GPU? (depende do deploy). A renderização happens dentro do container, e apenas pixels são streamed para o cliente final.

---

## 6. Rate Limiting e Quotas por Tenant

### 6.1. Por Que Rate Limit?

Rate limiting previne:
- **Denial of Service:** Um tenant monopolizando recursos
- **Abuse:** Scraping excessivo, credential stuffing
- **Custo runaway:** Serviço pago por uso
- **Fair usage:** Todos os tenants têm experiência aceitável

### 6.2. Níveis de Rate Limiting

```yaml
# Exemplo de hierarquia
levels:
  - tenant_level:
      max_sessions: 50  # Máximo de sessões simultâneas por tenant
      max_api_rpm: 1000  # API requests por minuto
      max_browser_minutes_per_day: 1440  # 24h de browser максимум
      max_concurrent_sessions: 10  # Sessões simultâneas

  - user_level (dentro do tenant):
      max_sessions: 5  # Por usuário
      max_browser_minutes_per_day: 480  # 8h

  - endpoint_specific:
      /api/sessions/create: 60/min  # Criar sessão é caro
      /api/sessions/{id}/navigate: 120/min  # Navegação mais barata
      /api/sessions/{id}/screenshot: 30/min  # Screenshot é expensive
```

### 6.3. Estratégias de Implementação

#### a) Token Bucket (Leaky Bucket)

**Algoritmo padrão da indústria**:

```
Para cada tenant/endpoint:
  - bucket_size: N tokens
  - refill_rate: R tokens/segundo
  - current_tokens: T

Quando request chega:
  Se T >= 1: processar, T -= 1
  Se não: rejeitar (429 Too Many Requests)
```

**Implementação:**
- In-memory (Redis) para single-node
- Distributed rate limiting com Redis em cluster
- Cuidado com clock skew em multi-região

#### b) Sliding Window Log

Mais preciso, mas maior overhead:

```python
# Pseudocódigo
def allow_request(tenant_id, endpoint):
  now = time.time()
  window_start = now - 60  # 1 minuto

  # Pegar timestamps de requests anteriores do tenant+endpoint
  requests = redis.zrangebyscore(f"rl:{tenant_id}:{endpoint}", window_start, now)

  if len(requests) < limit:
    redis.zadd(f"rl:{tenant_id}:{endpoint}", {str(now): now})
    redis.expire(f"rl:{tenant_id}:{endpoint}", 120)
    return True
  else:
    return False
```

#### c) Fixed Window Counter

Mais simples, mas pode ter "burst boundary" issues:

```python
window = floor(now / 60) * 60  # Janela de 1min
key = f"rl:{tenant_id}:{endpoint}:{window}"
count = redis.incr(key)
if count == 1:
  redis.expire(key, 120)  # 2 janelas de buffer
return count <= limit
```

### 6.4. Quotas de Tempo de Sessão

Um problema comum[^3] é que browsers **não fechados** continuam consumindo tempo de sessão:

```javascript
// Bad - esqueceu de fechar
const session = await browserbase.createSession();
await session.navigate("https://example.com");
// session.close() nunca chamado = vazamento de recursos

// Good - try/finally ou using
const session = await browserbase.createSession();
try {
  await session.navigate("https://example.com");
  // ...
} finally {
  await session.close();
}

// Ou com timeout automático
await session.create({
  timeout: 300000,  // 5 minutos max
  idleTimeout: 60000  // Fecha após 60s inativo
});
```

**Cloudflare Browser Rendering** fecha sessões após **1 minuto de inatividade** por padrão[^3].

**Best practice:**
- **Idle timeout automático:** 60s-300s
- **Hard timeout máximo:** 10-30 minutos
- **Tracking de sessões abertas:** Dashboard admin + alertas
- **Garbage collection:** Job que fecha sessões órfãs periodicamente

### 6.5. Rate Limiting por Resource Type

```javascript
// Rate limiting diferente por tipo de operação
const limits = {
  'session.create': { rpm: 60, concurrent: 10 },     // Caro
  'navigate': { rpm: 1000, per_session: 60 },        // Barato
  'screenshot': { rpm: 300, per_session: 30 },       // Medium
  'click': { rpm: 3000, per_session: 300 },          # Muito barato
  'evaluate': { rpm: 2000, per_session: 200 },       # Barato
  'upload': { rpm: 100, per_day: 1000, max_size_mb: 50 }  # Muito caro
};
```

---

## 7. Como Implementar Limites de Sessões por Usuário

### 7.1. Abordagem: Tracking de Sessões Ativas

**Data model:**
```sql
CREATE TABLE active_sessions (
  session_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_activity TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,

  -- Índices para queries de limitação
  INDEX idx_tenant_user (tenant_id, user_id),
  INDEX idx_expires (expires_at)
);

CREATE TABLE tenant_limits (
  tenant_id UUID PRIMARY KEY,
  max_concurrent_sessions INT DEFAULT 10,
  max_sessions_per_user INT DEFAULT 5,
  max_daily_minutes INT DEFAULT 1440,

  -- Podem ser NULL = unlimited
  max_api_rpm INT,
  max_browser_minutes INT
);
```

### 7.2. Lógica de Controle

```python
class SessionManager:
    def __init__(self, db, redis):
        self.db = db
        self.redis = redis

    async def can_create_session(self, tenant_id, user_id):
        # 1. Verificar limite por usuário
        user_sessions = await self.db.fetch("""
            SELECT COUNT(*) FROM active_sessions
            WHERE tenant_id = $1 AND user_id = $2
              AND expires_at > NOW()
        """, tenant_id, user_id)

        tenant_limit = await self.get_tenant_limit(tenant_id, 'max_sessions_per_user')
        if user_sessions >= tenant_limit:
            raise LimitExceeded(f"Usuário atingiu limite de {tenant_limit} sessões")

        # 2. Verificar limite global do tenant
        tenant_sessions = await self.db.fetch("""
            SELECT COUNT(*) FROM active_sessions
            WHERE tenant_id = $1 AND expires_at > NOW()
        """, tenant_id)

        tenant_global_limit = await self.get_tenant_limit(tenant_id, 'max_concurrent_sessions')
        if tenant_sessions >= tenant_global_limit:
            raise LimitExceeded(f"Tenant atingiu limite de {tenant_global_limit} sessões")

        # 3. Rate limiting por API (Redis token bucket)
        if not await self.check_rate_limit(tenant_id, user_id, 'session.create'):
            raise RateLimited("Muitas requisições. Tente novamente em alguns segundos.")

        return True

    async def create_session(self, tenant_id, user_id, **kwargs):
        await self.can_create_session(tenant_id, user_id)

        session_id = generate_uuid()
        expires_at = datetime.utcnow() + timedelta(hours=1)  # Default 1h

        # Marcar sessão como ativa
        await self.db.execute("""
            INSERT INTO active_sessions
            (session_id, tenant_id, user_id, expires_at)
            VALUES ($1, $2, $3, $4)
        """, session_id, tenant_id, user_id, expires_at)

        # Cache Redis para quick lookup
        key = f"session:{session_id}"
        await self.redis.hset(key, mapping={
            'tenant_id': str(tenant_id),
            'user_id': str(user_id),
            'expires_at': expires_at.isoformat()
        })
        await self.redis.expire(key, 3600)

        # Agendar heartbeat (keepalive)
        asyncio.create_task(self.heartbeat_loop(session_id))

        return session_id

    async def close_session(self, session_id):
        await self.db.execute(
            "DELETE FROM active_sessions WHERE session_id = $1",
            session_id
        )
        await self.redis.delete(f"session:{session_id}")

    async def heartbeat_loop(self, session_id):
        """Extende expires_at while session is active"""
        while True:
            await asyncio.sleep(30)  # A cada 30 segundos

            # Verificar se sessão ainda existe
            exists = await self.db.fetchval(
                "SELECT 1 FROM active_sessions WHERE session_id = $1",
                session_id
            )
            if not exists:
                break

            # Extender expires_at (sliding window)
            await self.db.execute("""
                UPDATE active_sessions
                SET expires_at = NOW() + INTERVAL '1 hour',
                    last_activity = NOW()
                WHERE session_id = $1
            """, session_id)
```

### 7.3. Middleware/Filter Global

```python
# FastAPI middleware
@app.middleware("http")
async def session_limit_middleware(request: Request, call_next):
    # Extrair tenant_id e user_id do JWT ou header
    tenant_id = get_tenant_id(request)
    user_id = get_user_id(request)

    # Se for endpoint de criar sessão, verificar limites ANTES
    if request.url.path == "/api/v1/sessions":
        try:
            await session_manager.can_create_session(tenant_id, user_id)
        except LimitExceeded as e:
            return JSONResponse(
                status_code=403,
                content={"error": str(e), "code": "LIMIT_EXCEEDED"}
            )

    response = await call_next(request)
    return response
```

### 7.4. Cleanup de Sessões Órfãs

```python
# Cron job ou task assíncrona
async def cleanup_orphaned_sessions():
    """Remove sessões expiradas não fechadas"""
    while True:
        await asyncio.sleep(60)  # A cada minuto

        # Pegar sessões expiradas
        expired = await db.fetch("""
            SELECT session_id FROM active_sessions
            WHERE expires_at < NOW()
        """)

        for session in expired:
            session_id = session['session_id']
            # Forçar fechamento do container/browser
            await force_kill_browser(session_id)
            await session_manager.close_session(session_id)

            log.info(f"Session {session_id} expired and was cleaned up")
```

### 7.5. Quotas por Tenant Tier

```sql
-- Tabela de planos
CREATE TABLE tenant_plans (
  plan_id UUID PRIMARY KEY,
  name VARCHAR(100),  -- "free", "pro", "enterprise"
  max_concurrent_sessions INT,
  max_sessions_per_user INT,
  max_api_rpm INT,
  max_browser_minutes_per_day INT,
  max_storage_gb INT,
  priority INT  -- Para scheduling (enterprise = alta prioridade)
);

-- Relacionar tenant ao plano
ALTER TABLE tenants ADD COLUMN plan_id UUID REFERENCES tenant_plans(plan_id);
```

---

## 8. Recomendações de Segurança para Remote Browser Service Público

### 8.1. Defense in Depth

Implementar múltiplas camadas de defesa:

```
┌─────────────────────────────────────┐
│   Layer 7: Application Logic        │
│   - Tenant context verification     │
│   - Authorization per resource      │
│   - Input validation                │
├─────────────────────────────────────┤
│   Layer 6: Authentication           │
│   - JWT com tenant_id claim         │
│   - SSO/SAML integration            │
│   - MFA                             │
├─────────────────────────────────────┤
│   Layer 5: Network                  │
│   - NetworkPolicy (K8s)             │
│   - iptables/nftables               │
│   - VPC per tenant (opcional)       │
├─────────────────────────────────────┤
│   Layer 4: Container/VM             │
│   - User namespaces                 │
│   - seccomp/AppArmor                │
│   - Dropped capabilities            │
│   - Read-only rootfs (opcional)     │
├─────────────────────────────────────┤
│   Layer 3: Host OS                  │
│   - SELinux/AppArmor                │
│   - Kernel hardening                │
│   - Host-based firewall             │
├─────────────────────────────────────┤
│   Layer 2: Physical                 │
│   - Encrypted disks                 │
│   - BIOS/UEFI secure boot           │
│   - TPM                             │
├─────────────────────────────────────┤
│   Layer 1: Organizational           │
│   - Access controls                │
│   - Audit logs                     │
│   - Incident response              │
└─────────────────────────────────────┘
```

### 8.2. Tenant Isolation Checklist

#### Database
- [ ] Tenant ID em **todas** as tabelas
- [ ] Foreign key constraints com tenant_id
- [ ] Row Level Security (PostgreSQL RLS) habilitado
- [ ] Queries Always filter por tenant_id (sem exceções)
- [ ] Different database credentials por tenant (opcional, para tenants enterprise)
- [ ] Backups separados por tenant (ou encrypted com tenant key)

#### Authentication & Session
- [ ] JWT contém tenant_id claim validado em cada request
- [ ] Tokensassinados com keys diferentes por ambiente (não por tenant)
- [ ] Refresh tokens scoped por tenant
- [ ] SSO com domínio/tenant mapping
- [ ] Session timeout configurável por tenant
- [ ] Revogação imediata de sessões (logout em todos devices)

#### API & Application
- [ ] Middleware global extrai e valida tenant_id em **todos** endpoints
- [ ] Rate limiting por tenant (não apenas global)
- [ ] Quotas e limits configuráveis por tenant (tier-based)
- [ ] Auditing log de todas as ações com tenant_id, user_id, timestamp
- [ ] PII masking em logs (não logar cookies, passwords, conteúdo de páginas)
- [ ] HTTPS mandatory (certificado válido, TLS 1.3)
- [ ] CORS configurado por tenant (allow-list de origins)

#### Infrastructure
- [ ] Containers rodam com UID/GID não-privilegiados (não root)
- [ ] seccomp profile bloqueando syscalls desnecessários
- [ ] AppArmor/SELinux confine
- [ ] Capabilities dropped: ALL, adicionar apenas NET_ADMIN, CHOWN, SETUID, SETGID se necessário
- [ ] Read-only filesystem onde possível (ex: /usr, /opt)
- [ ] tmpfs para /tmp (não persistente)
- [ ] user-data-dir mounted como volume com permissões 700 (apenas owner)
- [ ] NetworkPolicy bloqueando cross-tenant communication
- [ ] Resource quotas (CPU, memória, storage) via cgroups
- [ ] Ephemeral storage (não persistir a não ser que explicitamente requestado)

#### Browser/Chrome Specific
- [ ] Chrome rodando com `--no-sandbox` NUNCA usar em produção (se precisar, usar setuid sandbox)
- [ ] `--disable-dev-shm-usage` (evitar shared memory attacks)
- [ ] `--disable-gpu` se não precisar (reduz attack surface)
- [ ] `--disable-software-rasterizer` (evitar fallback inseguro)
- [ ] `--disable-background-networking` (evitar telemetry)
- [ ] `--disable-default-apps` (não instalar apps padrão)
- [ ] `--disable-extensions` (não permitir extensions não-auditadas)
- [ ] `--incognito` (opcional, para sessões truly ephemeral)
- [ ] Disable WebGL/canvas fingerprinting se preocupado com tracking (mas quebra muitos sites)
- [ ] Clear cache/cookies/history on session close (garantir)

#### Monitoring & Detection
- [ ] Log aggregation centralizado (ELK/Splunk/Datadog) com tenant_id em todos logs
- [ ] Alertas para: cross-tenant access attempts, resource exhaustion, unusual patterns
- [ ] Metrics: sessões ativas por tenant, API errors, resource usage, latency
- [ ] Anomaly detection: tenant que de repente consome 10x mais resources
- [ ] Pentest regular (cross-tenant penetration testing)
- [ ] Vulnerability scanning (CVEs no Chrome, kernel, container runtime)

#### Data Protection
- [ ] Encryption at rest (volumes, databases)
- [ ] Encryption in transit (TLS everywhere)
- [ ] PII encryption (field-level) se necessário (PCI, HIPAA)
- [ ] Data retention policy + automatic deletion
- [ ] Secure deletion (shred) de dados quando tenant deleta conta
- [ ] Backups encrypted com different keys per tenant (opcional)
- [ ] GDPR compliance: right to be forgotten implementado
- [ ] No logging de sensitive data (passwords, credit cards, PII)

#### Operational Security
- [ ] CI/CD com security scanning (SAST, DAST, dependency vulnerabilities)
- [ ] Secrets management (Vault/aws secrets manager, não no código)
- [ ] Principle of least privilege (admin accounts, service accounts)
- [ ] Regular security audits
- [ ] Incident response plan documentado
- [ ] Breach notification process (notify tenants)
- [ ] SOC2 Type II / ISO 27001 certification se enterprise clients

### 8.3. Padrões de Código Seguros

**NUNCA faça:**

```javascript
// ❌ BAD: query sem tenant filter
const getUserData = async (userId) => {
  const result = await db.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0];
};

// ✅ GOOD: sempre inclui tenant_id
const getUserData = async (tenant_id, userId) => {
  const result = await db.query(
    'SELECT * FROM users WHERE id = $1 AND tenant_id = $2',
    [userId, tenant_id]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
};
```

**Mesmo em JOINs:**

```sql
-- ❌ BAD
SELECT s.*, u.name
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.session_id = 'abc123';

-- ✅ GOOD
SELECT s.*, u.name
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.session_id = 'abc123'
  AND s.tenant_id = 'tenant-123'  -- Checa session
  AND u.tenant_id = 'tenant-123'; -- Checa user (redundante se FK)
```

**Row Level Security (PostgreSQL):**

```sql
-- Habilitar RLS na tabela
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Policy que filtra automaticamente por tenant_id
CREATE POLICY tenant_isolation_policy ON sessions
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

-- Como usar:
SET app.current_tenant = '550e8400-e29b-41d4-a716-446655440000';
SELECT * FROM sessions;  -- Automaticamente filtra
```

### 8.4. Pentesting Checklist (Cross-Tenant)

Testes obrigatórios:

1. **IDOR (Insecure Direct Object Reference)**
   - Testar acesso a sessões de outros tenants mudando IDs na URL
   - `GET /api/v1/sessions/{session_id}` de outro tenant deve retornar 403/404

2. **Parameter pollution**
   - `tenant_id` em body/header/query: é validado ou ignorado?
   - Podemos sobrescrever tenant_id enviando mais de um?

3. **Time-of-check to time-of-use (TOCTOU)**
   - Criar sessão, pegar ID, imediatamente tentar acessar como outro tenant
   - Race condition entre verificação e execução

4. **Cache poisoning**
   - Se usa Redis/Memcached, os keys são namespaced por tenant?
   - `GET /api/v1/session/{id}` → cache key `session:{id}` é compartilhado?
   - Deve ser `tenant:{tenant_id}:session:{id}`

5. **Cross-tenant data leakage via logs**
   - Logs contêm tenant_id, user_id, mas também dados da sessão?
   - Screenshots/logs de sessão são acessíveis a outros tenants em storage (S3)?

6. **Container escape**
   - Se usar containers, testar escape (CVE-2022-0185, etc)
   - Ver se process no host é visível (ps aux)

7. **Side-channel attacks**
   - Medir latency de endpoints para inferir existência de dados
   - Error messages different filesizes (timing)

8. **Subdomain takeover**
   - Se usa subdomains por tenant (tenant1.service.com), garantir queWildcard DNS não permita takeover
   - Redeploy deleta subdomains antigos

9. **Default credentials**
   - Testar se algum tenant pode acessar admin panel default
   - Se houver "master tenant" ou "system tenant"

10. **Reuse de session IDs**
    - Após sessão fechar, ID pode ser reutilizado por outro tenant?
    - UUIDs são únicos globalmente? (usar uuidv4, não incremental)

### 8.5. Compliance Considerations

**GDPR (General Data Protection Regulation):**
- Data processing agreement (DPA) com cada tenant
- Data localization (onde os dados são processados/armazenados)
- Right to erasure: deletar todos os dados do tenant (e backups)
- Data portability: exportar dados em formato machine-readable
- Breach notification: 72h para supervisory authority + afetados

**SOC 2 Type II:**
- Security, Availability, Confidentiality (pode adicionar Privacy)
- Auditoria de controles internos por 6-12 meses
- Evidence de logs, monitoring, access reviews

**HIPAA (se lidar com saúde):**
- Business Associate Agreement (BAA)
- Encriptação em rest/transit
- Audit logs imutáveis
- Access controls rigorosos
- Incident response plan

**PCI DSS (se processar pagamentos):**
- Nunca armazenar CVV
- Tokenização de cartões
- Network segmentation
- Penetration testing quarterly
- File integrity monitoring

---

## 9. Recomendações Finais e Arquitetura Sugerida

### 9.1. Arquitetura Ideal

```
┌─────────────────────────────────────────────────────────────┐
│                      Load Balancer (L7)                    │
│  - Rate limiting por tenant (API key/JWT)                │
│  - TLS termination                                       │
│  - WAF (SQLi, XSS, etc)                                 │
└────────────────┬──────────────────────────────────────────┘
                 │
┌────────────────▼──────────────────────────────────────────┐
│              API Gateway / Auth Service                  │
│  - JWT validation (assinar com HMAC-SHA256)             │
│  - Extrair tenant_id, user_id                          │
│  - Set header X-Tenant-ID, X-User-ID                  │
│  - Cache de tenant config (Redis: tenant:{id}:config) │
└────────────────┬──────────────────────────────────────────┘
                 │
┌────────────────▼──────────────────────────────────────────┐
│       Session Manager Service (Stateless)               │
│  - Verificar limites por tenant                        │
│  - Alocar recursos (CPU/Mem quota)                     │
│  - Criar registro em DB + Redis                        │
│  - Providenciar connection string pro worker           │
└────────────────┬──────────────────────────────────────────┘
                 │
┌────────────────▼──────────────────────────────────────────┐
│            Worker Pool (K8s Jobs/Pods)                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐         │
│  │ Tenant A   │ │ Tenant B   │ │ Tenant C   │         │
│  │ Container  │ │ Container  │ │ Container  │         │
│  │ UID: 1001  │ │ UID: 1002  │ │ UID: 1003  │         │
│  │ cgroup:    │ │ cgroup:    │ │ cgroup:    │         │
│  │ 2CPU/4GB   │ │ 1CPU/2GB   │ │ 4CPU/8GB   │         │
│  │           │ │            │ │            │         │
│  │ Chrome     │ │ Chrome     │ │ Chrome     │         │
│  │ --user-    │ │ --user-    │ │ --user-    │         │
│  │ data-dir=  │ │ data-dir=  │ │ data-dir=  │         │
│  │ /data/...  │ │ /data/...  │ │ /data/...  │         │
│  └────────────┘ └────────────┘ └────────────┘         │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          ▼                               │
│               Chrome DevTools Protocol (CDP)           │
│               (WebSocket por sessão)                  │
└──────────────────────────────────────────────────────────┘
                 │
┌────────────────▼──────────────────────────────────────────┐
│                Storage (S3/Blob)                       │
│  - Session videos (encrypted)                          │
│  - Screenshots (encrypted)                             │
│  - Logs tenant-scoped (different bucket/prefix)       │
└──────────────────────────────────────────────────────────┘
```

### 9.2. Stack Tecnológica Recomendada

**Infraestrutura:**
- Kubernetes (ou Nomad) para orquestração de containers
- Docker com runtime security (gVisor, Kata Containers, ou Firecracker para stronger isolation)
- Cgroups v2 para resource limiting
- NetworkPolicy (Cilium/Calico) para isolamento de rede
- seccomp + AppArmor/SELinux

**Backend:**
- Go/Rust/Java para services de gerenciamento (performance + segurança)
- PostgreSQL com Row Level Security
- Redis para caching + rate limiting tokens
- NATS/Kafka para eventos (session.created, session.closed)

**Frontend (Dashboard):**
- React/Vue com auth via SSO
- Multi-tenant UI: tenant selector, usage graphs
- Session inspector embed (like Browserbase Inspector)

**Monitoramento:**
- Prometheus + Grafana (metrics por tenant)
- Loki/ELK (logs com tenant_id label)
- Jaeger/Zipkin (distributed tracing)
- Alertas: PagerDuty/Slack

**Segurança:**
- Vault (secrets management)
- OPA/Gatekeeper (policy as code para K8s)
- Falco (runtime security monitoring)
- Trivy/Clair (vulnerability scanning de containers)

### 9.3. Cost Model (Pricing por Tenant)

```yaml
free_tier:
  max_concurrent_sessions: 2
  max_sessions_per_user: 1
  max_browser_minutes_per_day: 60
  max_api_rpm: 100
  resources_per_session: "1CPU/1GB"
  storage_days: 1
  price: $0

pro_tier:
  max_concurrent_sessions: 10
  max_sessions_per_user: 3
  max_browser_minutes_per_day: 600
  max_api_rpm: 1000
  resources_per_session: "2CPU/2GB"
  storage_days: 7
  price: $29/mês

business_tier:
  max_concurrent_sessions: 50
  max_sessions_per_user: 10
  max_browser_minutes_per_day: 5000
  max_api_rpm: 10000
  resources_per_session: "4CPU/4GB"
  storage_days: 30
  price: $299/mês

enterprise:
  custom: true
  sla: "99.99%"
  support: "24/7"
  features:
    - "dedicated infrastructure"
    - "on-premise deployment"
    - "audit logs retention: 2 years"
    - "SOC2 Type II report"
  price: "contact sales"
```

---

## 10. Conclusão

A arquitetura de um serviço de remote browser multi-tenant requer:

1. **Isolation forte**: Containers com UIDs separados, cgroups, seccomp, AppArmor, network policies
2. **user-data-dir separado por tenant**: Simples e eficaz, mas não suficiente sozinho
3. **Rate limiting robusto**: Token bucket por tenant, por user, por endpoint
4. **Quotas de tempo**: Idle timeout + hard limit + cleanup automático
5. **Monitoring & Auditing**: Logs centralizados, alertas, anomaly detection
6. **Compliance**: GDPR, SOC2, HIPAA dependendo do mercado
7. **Defense in depth**: Múltiplas camadas, nenhuma única ponto de falha

Referências de mercado como **Browserbase** (serverless) e **Steel** (self-hosted) mostram que é possível escalar para milhares de sessões simultâneas com isolamento adequado. A escolha entre managed vs self-hosted depende do caso de uso, compliance requirements e budget.

O maior risco em serviços públicos é **cross-tenant data leakage** — um bug no código que permite um tenant acessar dados de outro. Essa é a vulnerabilidade mais crítica e deve ser prevenida com:
- Testes intensivos (unit, integration, pentest)
- Row Level Security no database
- Middleware global que nunca confia em input do cliente para tenant_id
- Auditoria de todos os logs com tenant context

Implementar essas práticas desde o dia 1 evita refatorações catastróficas depois.

---

## Referências

[^1]: Chromium Project - Multiple Chrome Users. Disponível em: https://www.chromium.org/user-experience/multi-profiles/
[^2]: Chromium Docs - User Data Directory. Disponível em: https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md
[^3]: Protected your data with site isolation - Chrome Enterprise. Disponível em: https://support.google.com/chrome/a/answer/7581529?hl=en
[^4]: Browserbase Documentation - Under the hood. Disponível em: https://docs.browserbase.com/under-the-hood
[^5]: Steel Browser - GitHub Repository. Disponível em: https://github.com/steel-dev/steel-browser
[^6]: Kasm Workspaces - Browser Isolation. Disponível em: https://www.kasmweb.com/docs/develop/guide/browser_isolation.html
[^7]: Cloudflare - Rate Limiting Best Practices. Disponível em: https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/
[^8]: Cloudflare - Browser Rendering Limits. Disponível em: https://developers.cloudflare.com/browser-rendering/limits/
[^9]: AIMultiple - Remote Browsers Benchmark (2025). Disponível em: https://aimultiple.com/remote-browsers
[^10]: Redis Blog - Data Isolation in Multi-Tenant SaaS. Disponível em: https://redis.io/blog/data-isolation-multi-tenant-saas/
[^11]: Security Boulevard - Tenant Isolation in Multi-Tenant Systems. Disponível em: https://securityboulevard.com/2025/12/tenant-isolation-in-multi-tenant-systems-architecture-identity-and-security/
[^12]: AWS Whitepaper - SaaS Architecture Fundamentals. Disponível em: https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html
[^13]: Packet Labs - Web Browser Best Practices 2024. Disponível em: https://www.packetlabs.net/posts/web-browser-best-practices-for-security-and-privacy-in-2024/
[^14]: Wikipedia - Browser Isolation. Disponível em: https://en.wikipedia.org/wiki/Browser_isolation

---

**Fim do documento**
