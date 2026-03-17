# Isolamento Multi-Tenant para Remote Browser

**Data:** 2026-03-17
**Contexto:** Pesquisa sobre como isolar sessoes de usuarios diferentes em um sistema de remote browser, cobrindo estrategias de isolamento de processos, limites de recursos, cleanup de dados e o debate Docker-in-Docker vs user-data-dir.

---

## 1. Como Browserbase e Browserless Isolam Sessoes

### 1.1 Browserbase — Modelo Serverless por Sessao

A Browserbase adota uma arquitetura totalmente gerenciada onde **cada sessao de browser roda em isolamento completo**. Os principios fundamentais sao:

- Cada sessao e um processo/container efemero independente, nao compartilhando estado com outras sessoes.
- A Sessions API controla todo o ciclo de vida: criacao, TTL, timeout, keep-alive, uploads e encerramento via REST/SDK.
- Conformidade SOC-2 Type 1 e HIPAA — o que implica isolamento de dados entre tenants como requisito de compliance, nao apenas conveniencia tecnica.
- A plataforma processou 50 milhoes de sessoes em 2025 com mais de 1.000 clientes, demonstrando viabilidade de escala.

O modelo e essencialmente **"compute efemero"**: o browser e tratado como uma funcao serverless, nao como uma VM de longa duracao.

### 1.2 Browserless — Modelo Container + Context Pool

O Browserless opera de duas formas complementares:

**Modo container por sessao:** Cada sessao roda dentro de um container Docker separado, que tem seu proprio filesystem, stack de rede e arvore de processos. Quando o container para, tudo dentro dele desaparece — cookies, historico, arquivos baixados.

**Modo context-based (dentro de um unico browser):** Para maior performance, um unico processo Chrome pode hospedar dezenas de sessoes isoladas via **browser contexts** (similar a perfis distintos dentro do mesmo Chrome). Cada context leva milissegundos para criar e consome KB em vez de MB.

O trade-off do modo context-based e critico para multi-tenant:
- Um crash pode afetar 20-50 sessoes simultaneamente.
- Uma pagina com memory leak ou crypto-miner consome CPU de todas as outras sessoes no mesmo browser.
- Ao contrario de containers separados, nao ha cgroups limitando recursos por context individual.

**Licao pratica do Browserless (5 milhoes de sessoes/semana):**
- Reuso de browser e muito mais performatico que criar instancias novas, mas introduz risco de contaminacao entre sessoes.
- Fechar paginas e contexts corretamente e critico — "zombie sessions" levam a memory leaks e exaustao de file descriptors.
- A sessao inativa e encerrada apos 30 segundos, lançando uma instancia de browser nova para cada nova sessao.

**Fontes:**
- [Browserbase Architecture Overview](https://www.browserbase.com/)
- [Observations running more than 5 million headless sessions a week — Browserless](https://www.browserless.io/blog/observations-running-more-than-5-million-headless-sessions-a-week)
- [Scaling Headless Browsers: Contexts vs Instances — DEV Community](https://dev.to/deepak_mishra_35863517037/scaling-headless-browsers-managing-contexts-vs-instances-1d73)
- [Production Best Practices — Browserless Docs](https://docs.browserless.io/enterprise/docker/best-practices)

---

## 2. Namespaces Linux e cgroups para Isolamento de Processos Chrome

### 2.1 Fundamentos: O Que Namespaces e cgroups Fazem

**Namespaces** respondem a pergunta "o que o processo pode ver?". Existem 8 tipos desde o kernel 5.6:

| Namespace | O que isola |
|---|---|
| `pid` | Arvore de processos — o processo nao ve PIDs externos |
| `user` | IDs de usuario — permite ter "root" dentro do namespace sem privilegios reais no host |
| `net` | Interfaces de rede, regras iptables, tabelas de roteamento |
| `mnt` | Pontos de montagem do filesystem |
| `ipc` | Comunicacao entre processos (semaforos, message queues, shared memory) |
| `uts` | Hostname e nome de dominio |
| `cgroup` | Namespace de cgroup (impede ver hierarchy do host) |
| `time` | Clocks do sistema (kernel 5.6+) |

**cgroups** respondem "quanto pode usar?". Contabilizam e limitam CPU, memoria, I/O e rede para um grupo de processos.

A combinacao namespaces + cgroups e a base de todos os containers Linux (Docker, LXC, Podman).

### 2.2 Como o Chrome Usa Namespaces Internamente

O Chrome no Linux ja usa namespaces para isolar seus proprios processos internos (renderer, GPU, network service) do processo browser principal:

- **Layer 1 — Namespace/SUID Sandbox:** A partir do Chrome M-43, se o kernel suporta unprivileged user namespaces, elas sao usadas automaticamente. Cada processo renderer roda em seu proprio PID namespace e network namespace.
- **Layer 2 — Seccomp-BPF:** Um filtro BPF e avaliado a cada syscall do processo sandboxed para decidir se deve ser permitida. Isso restringe drasticamente a superficie de ataque do kernel.

Para multi-tenant, isso significa que o Chrome **ja aplica isolamento interno entre tabs/renderers**. O que precisamos adicionar e isolamento **entre diferentes usuarios/sessoes** no nivel do host.

### 2.3 Aplicando Namespaces por Sessao com `unshare`

Para isolar um processo Chrome completamente do host sem Docker completo:

```bash
# Cria novo namespace de PID, network, mount e user para o processo Chrome
unshare --pid --net --mount --user --fork \
  -- chrome --no-sandbox --user-data-dir=/tmp/profile-session-123
```

Com `--net`, o processo Chrome nao tem acesso a rede do host — util para criar uma interface de rede virtual dedicada por sessao via `veth` pair.

**Fontes:**
- [What Are Namespaces and cgroups, and How Do They Work? — NGINX Blog](https://blog.nginx.org/blog/what-are-namespaces-cgroups-how-do-they-work)
- [Container Security Fundamentals Part 2: Isolation & Namespaces — Datadog Security Labs](https://securitylabs.datadoghq.com/articles/container-security-fundamentals-part-2/)
- [Linux Sandboxing — Chromium Docs](https://chromium.googlesource.com/chromium/src/+/0e94f26e8/docs/linux_sandboxing.md)

---

## 3. Limitar CPU e Memoria por Sessao

### 3.1 Por Que Chrome Precisa de Limites Externos

O Chrome usa tantos recursos quanto disponiveis. Nao existe flag nativa para limitar memoria ou CPU de forma confiavel — qualquer limitacao deve ser imposta externamente pelo OS.

Uma sessao headless tipica consome:
- **200-512 MB RAM** no modo leve
- **512 MB - 2 GB RAM** com conteudo JS pesado
- **100-500% CPU** durante rendering intenso

Sem limites externos, uma unica sessao comprometida ou com pagina pesada pode derrubar o host inteiro.

### 3.2 cgroups v1 — Metodo classico com cgconfig

```bash
# /etc/cgconfig.conf
group chrome-session-{SESSION_ID} {
  cpu {
    cpu.cfs_quota_us = 200000;   # 2 CPUs equivalentes
    cpu.cfs_period_us = 100000;
  }
  memory {
    memory.limit_in_bytes = "1G";
    memory.soft_limit_in_bytes = "768M";
  }
}
```

Criacao e execucao programatica:

```bash
# Cria cgroup especifico para a sessao
cgcreate -g cpu,memory:chrome-session-123

# Define limites
cgset -r memory.limit_in_bytes=1073741824 chrome-session-123
cgset -r cpu.cfs_quota_us=200000 chrome-session-123

# Lanca Chrome dentro do cgroup
cgexec -g cpu,memory:chrome-session-123 \
  chrome --user-data-dir=/tmp/profiles/session-123 --no-sandbox

# Ao encerrar sessao
cgdelete -g cpu,memory:chrome-session-123
```

### 3.3 cgroups v2 — Metodo moderno com systemd-run (Recomendado)

Em Ubuntu 22.04+ e qualquer distro com systemd moderno, cgroups v2 e o default:

```bash
# Lanca Chrome com limites de CPU e memoria por sessao
systemd-run --scope \
  --slice=browser-sessions.slice \
  -p MemoryMax=1G \
  -p MemoryHigh=768M \
  -p CPUQuota=200% \
  -p TasksMax=200 \
  -- chrome --user-data-dir=/tmp/profiles/session-123 --no-sandbox

# Monitorar uso em tempo real
systemd-cgtop
```

Opcoes de memoria do systemd/cgroups v2:

| Opcao | Comportamento |
|---|---|
| `MemoryMin` | Protecao minima — memoria nunca reclamada abaixo deste valor |
| `MemoryLow` | Protecao suave — reclamada so se necessario |
| `MemoryHigh` | Limite suave — throttling comeca aqui, processo nao e morto |
| `MemoryMax` | Limite duro — OOM killer ativado se excedido |

### 3.4 Via Docker (Abordagem mais Comum em Producao)

```bash
docker run --rm \
  --memory="1g" \
  --memory-swap="1g" \
  --cpus="2" \
  --pids-limit=200 \
  --shm-size="512m" \
  chrome-session-image
```

O Docker usa cgroups internamente — e uma interface mais amigavel que configura cgroups v1 ou v2 automaticamente dependendo do host.

**Fontes:**
- [Restrict Chrome CPU and memory with cgroups — GitHub Gist](https://gist.github.com/jakewarren/477ecd1149abe908cbd5cf7a7c9abaa3)
- [Limit specific process memory with cgroups and earlyoom — Raymii.org](https://raymii.org/s/articles/Limit_specific_process_memory_on_desktop_linux_with_cgroups.html)
- [Using cgroups to limit browser memory+CPU — GitHub Gist](https://gist.github.com/hardfire/7e5d9e7ce218dcf2f510329c16517331)
- [Configuring resource management with cgroups-v2 and systemd — Red Hat Docs](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/managing_monitoring_and_updating_the_kernel/assembly_configuring-resource-management-using-systemd_managing-monitoring-and-updating-the-kernel)

---

## 4. Cleanup Seguro de Profile Data Entre Usuarios

### 4.1 O Que o user-data-dir Contem

O `--user-data-dir` e o diretorio onde o Chrome persiste toda informacao de estado:

- Cookies e session cookies
- localStorage e sessionStorage (IndexedDB, WebSQL)
- Cache de paginas e recursos
- Credenciais salvas (passwords, autofill)
- Certificados de cliente
- Historico de navegacao e downloads
- Extensoes instaladas e seus dados
- Service workers e cache offline

Uma contaminacao cruzada deste diretorio entre usuarios e uma falha grave de segurança — potencialmente expondo credenciais, sessoes autenticadas e dados pessoais de um usuario para outro.

### 4.2 Estrategias de Isolamento por user-data-dir

**Diretorio unico e efemero por sessao (baseline):**

```javascript
// Node.js — criacao e cleanup automatico
const os = require('os');
const path = require('path');
const fs = require('fs');

const sessionId = crypto.randomUUID();
const profileDir = path.join(os.tmpdir(), 'chrome-profiles', sessionId);

const browser = await chromium.launch({
  args: [`--user-data-dir=${profileDir}`]
});

try {
  // ... usa o browser ...
} finally {
  await browser.close();
  await fs.promises.rm(profileDir, { recursive: true, force: true });
}
```

**Regras criticas:**
- **Nunca reutilizar** o mesmo `user-data-dir` para usuarios diferentes.
- O Chrome **bloqueia** uso concorrente do mesmo diretorio — e uma relacao 1:1 obrigatoria.
- Ao usar `--user-data-dir`, o modo incognito e **desabilitado automaticamente**.
- Dados em `/tmp` sao apagados no reboot, mas nao durante a sessao ativa — o cleanup explicito e necessario.

### 4.3 tmpfs para Garantia de Efemeridade

Montar o diretorio de profiles em tmpfs (memoria RAM) garante:
1. Performance superior — sem I/O de disco
2. Efemeridade garantida — reboot limpa tudo automaticamente
3. Impossibilidade de recuperacao forense simples do disco

```bash
# Montar tmpfs para profiles (no host)
mount -t tmpfs -o size=4G,mode=1777 tmpfs /var/remote-browser/profiles

# Cada sessao cria seu subdiretorio
mkdir -p /var/remote-browser/profiles/session-${UUID}
```

Alternativa com overlayfs (inspirado no Profile-sync-daemon do Arch Linux): manter uma copia base limpa em disco e montar camadas de escrita em tmpfs — so as mudancas ficam em RAM, economizando memoria sem abrir mao da performance.

### 4.4 Cleanup Forcado Apos Crash

O Chrome pode deixar residuos mesmo apos crash (singletons, lock files):

```bash
# Script de cleanup post-sessao
cleanup_profile() {
  local profile_dir="$1"

  # Mata qualquer processo Chrome ainda usando o profile
  fuser -k "$profile_dir" 2>/dev/null || true

  # Remove com sobrescrita para evitar recuperacao (para dados sensiveis)
  find "$profile_dir" -type f -exec shred -uz {} \; 2>/dev/null
  rm -rf "$profile_dir"

  # Remove cgroup da sessao se existir
  cgdelete -g cpu,memory:chrome-session-${SESSION_ID} 2>/dev/null || true
}
```

Para dados altamente sensiveis, `shred` ou `srm` antes do `rm` impede recuperacao simples, mas em SSDs com wear-leveling o `shred` nao e completamente efetivo — containerizacao com filesystem efemero e a alternativa mais segura.

### 4.5 Validacao de Cleanup

```bash
# Verificar que nenhum processo Chrome ainda referencia o profile
lsof +D /var/remote-browser/profiles/session-${UUID}

# Confirmar que o diretorio foi removido
test ! -d /var/remote-browser/profiles/session-${UUID} && echo "Cleanup OK"
```

**Fontes:**
- [User Data Directory for persisting sessions — Browserless Docs](https://docs.browserless.io/enterprise/user-data-directory)
- [Chromium Docs: User Data Directory](https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md)
- [Session isolation in Headless Chrome — chromium-dev](https://groups.google.com/a/chromium.org/g/headless-dev/c/JLbSKaWLy-E)
- [Profile-sync-daemon (overlayfs) — ArchWiki](https://wiki.archlinux.org/title/Profile-sync-daemon)

---

## 5. Docker-in-Docker e Necessario ou user-data-dir e Suficiente?

### 5.1 O Espectro de Isolamento

Existem varios niveis de isolamento, cada um com trade-offs diferentes:

| Abordagem | Nivel de Isolamento | Overhead | Complexidade |
|---|---|---|---|
| `--user-data-dir` unico por sessao | Estado do browser apenas | Minimo | Baixa |
| `--user-data-dir` + cgroups | Estado + recursos do OS | Baixo | Media |
| `--user-data-dir` + namespaces Linux | Estado + visibilidade de recursos | Baixo-medio | Media-alta |
| Container Docker por sessao | OS-level (filesystem, rede, processos) | Medio (500MB-1GB) | Media |
| VM por sessao | Hardware-level | Alto (1-4GB) | Alta |
| Docker-in-Docker | Container dentro de container | Alto + overhead de DinD | Muito alta |

### 5.2 Quando user-data-dir e Suficiente

`user-data-dir` isolado e **suficiente** quando:
- As sessoes sao de usuarios confiados (ex: automacao propria, sem input externo malicioso)
- O sistema de backend nao processa conteudo de usuarios nao-confiados
- O risco de kernel exploit e baixo (ex: ambiente interno, Chrome atualizado constantemente)
- A performance e o fator critico (latencia de startup, densidade de sessoes)

Limitacoes que nao sao resolvidas por `user-data-dir` sozinho:
- Nao isola processos no nivel do kernel — um processo comprometido ve todos os outros processos do host via `/proc`
- Nao limita CPU/memoria automaticamente
- Nao isola o stack de rede — sessoes compartilham interfaces de rede do host
- Nao impede acesso ao filesystem do host (dependendo das permissoes)

### 5.3 Container Docker por Sessao (Abordagem Recomendada para Multi-Tenant)

Para multi-tenant real (sessoes de usuarios diferentes sem confiança mutua), um **container Docker por sessao** oferece o melhor balance entre segurança e complexidade:

```dockerfile
# Imagem base para sessao de browser
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Usuario nao-privilegiado
RUN useradd -m -u 1001 browseruser
USER browseruser

WORKDIR /home/browseruser
```

```bash
# Lanca container por sessao com limites
docker run --rm \
  --name "session-${SESSION_ID}" \
  --memory="1g" \
  --memory-swap="1g" \
  --cpus="2" \
  --pids-limit=200 \
  --network="bridge-session-${SESSION_ID}" \  # rede isolada
  --read-only \
  --tmpfs /tmp:size=500m,exec \
  --tmpfs /home/browseruser/.config:size=200m \
  --cap-drop=ALL \
  --cap-add=SYS_PTRACE \  # necessario para Chrome sandbox
  --security-opt seccomp=chrome-seccomp.json \
  --security-opt no-new-privileges \
  chrome-session-image
```

Garantias que o container fornece:
- Filesystem isolado — nada persiste apos `--rm`
- Stack de rede isolado — sem acesso a rede interna do host
- Arvore de processos isolada — o processo dentro do container nao ve processos externos
- cgroups automaticamente configurados pelo Docker (`--memory`, `--cpus`)
- Qualquer exploit fica contido dentro do container

### 5.4 Docker-in-Docker: Necessario?

**Docker-in-Docker (DinD) e DESNECESSARIO para a maioria dos casos de multi-tenant browser.**

DinD e relevante apenas quando voce precisa **gerar containers dentro de um ambiente que ja e um container** — por exemplo, pipelines CI/CD onde o runner e em si um container Docker.

Para remote browser multi-tenant, o padrao correto e:
- Host (ou VM) executa o **Docker daemon**
- O orchestrador (fora dos containers) **cria containers de sessao** via Docker API/socket
- Cada sessao e um container independente

DinD introduz problemas que superam seus beneficios neste contexto:
- Requer `--privileged` ou montagem do socket Docker — ambos reduzem o isolamento de segurança
- Overhead de ter um daemon Docker dentro do container
- Risco de container escape via socket compartilhado
- Complexidade operacional alta sem ganho real de isolamento

**A excecao:** Se o sistema inteiro precisa ser portavel (ex: rodar em Kubernetes sem privilegios de host), entao tecnicas como `rootless Docker` ou `podman` podem ser consideradas em vez de DinD classico.

### 5.5 Seccomp Profile para Chrome em Container

O Chrome precisa de algumas syscalls que o perfil default do Docker bloqueia (principalmente para criar seus proprios namespaces internos). A solucao e usar um seccomp profile customizado:

```bash
# Baixar o perfil seccomp especifico para Chrome (Jess Frazelle)
curl -o chrome-seccomp.json \
  https://raw.githubusercontent.com/jfrazelle/dotfiles/master/etc/docker/seccomp/chrome.json

# Usar no docker run
docker run --security-opt seccomp=chrome-seccomp.json ...
```

Alternativas ao `--no-sandbox` (que desativa todas as protecoes):
- Usar o seccomp profile correto + `SYS_PTRACE` capability
- Usar `--sandbox` com usuario nao-root dentro do container
- Usar `--disable-setuid-sandbox` em vez de `--no-sandbox` completo

**Fontes:**
- [Docker Browser Isolation Guide 2026 — Sendwin](https://blog.send.win/docker-browser-browser-isolation-guide-2026/)
- [Running Chromium in Docker Without Selling Your Soul — Medium](https://medium.com/code-and-coffee/running-chromium-in-docker-without-selling-your-soul-433e591802f2)
- [Seccomp Security Profiles for Docker — Docker Docs](https://docs.docker.com/engine/security/seccomp/)
- [Enhanced Container Isolation — Docker Docs](https://docs.docker.com/enterprise/security/hardened-desktop/enhanced-container-isolation/)
- [Containerized Browser Isolation Guide 2026 — Sendwin](https://blog.send.win/containerized-browser-browser-isolation-guide-2026/)

---

## 6. Modelo de Ameaca e Defense-in-Depth

### 6.1 Cadeia de Ataque Tipica

Um ataque contra sistema multi-tenant de remote browser tipicamente segue:

```
Payload malicioso na pagina web
        ↓
Exploit no renderer do Chrome (ex: V8, Blink)
        ↓
Execucao de codigo no processo renderer (sandboxed)
        ↓
Sandbox escape via IPC/Mojo ou kernel vulnerability
  (ex: CVE-2025-2783 via Mojo, CVE-2025-38236 via AF_UNIX socket)
        ↓
Acesso ao processo browser ou ao kernel do host
        ↓
Container breakout (se em container sem hardening adequado)
        ↓
Acesso ao host ou a outras sessoes de usuarios
```

### 6.2 Vulnerabilidades Recentes Relevantes

**CVE-2025-2783 (Chrome Mojo Sandbox Escape — in the wild):**
- Componente IPC do Chrome no Windows — manipulacao de handles via DuplicateHandle
- Permitia escape da sandbox e execucao arbitraria no host
- Patched em Chrome 134.0.6998.178
- Usado na campanha "Operation ForumTroll" contra governo e midia

**CVE-2025-38236 (Linux kernel — Chrome sandbox escape via AF_UNIX):**
- Flaw use-after-free no subsistema AF_UNIX socket com MSG_OOB
- Permite mover do renderer sandbox do Chrome para execucao com privilegios de kernel
- Descoberto pelo Google Project Zero

A implicacao para multi-tenant: **o Chrome sandbox nao e a ultima linha de defesa**. O isolamento de container/namespace do host DEVE existir como camada adicional.

### 6.3 Camadas de Defesa Recomendadas

```
┌─────────────────────────────────────────────┐
│  Nivel 1: Atualizacao de Chrome             │  Chrome atualizado diariamente
├─────────────────────────────────────────────┤
│  Nivel 2: Chrome Sandbox interno            │  Namespaces + Seccomp-BPF (builtin)
├─────────────────────────────────────────────┤
│  Nivel 3: Container por sessao              │  Filesystem/rede/processos isolados
├─────────────────────────────────────────────┤
│  Nivel 4: Seccomp profile customizado       │  Bloqueia syscalls nao necessarias
├─────────────────────────────────────────────┤
│  Nivel 5: cgroups (limites de recursos)     │  CPU/memoria/pids por sessao
├─────────────────────────────────────────────┤
│  Nivel 6: rede isolada por sessao           │  veth pair ou rede bridge dedicada
├─────────────────────────────────────────────┤
│  Nivel 7: user-data-dir efemero + cleanup   │  Sem persistencia entre sessoes
├─────────────────────────────────────────────┤
│  Nivel 8: usuario nao-privilegiado          │  Sem root dentro do container
└─────────────────────────────────────────────┘
```

**Fontes:**
- [CVE-2025-2783: Chrome Sandbox Escape — Sangfor Threat Intelligence](https://www.sangfor.com/farsight-labs-threat-intelligence/cybersecurity/cve-2025-2783-google-chrome-sandbox-escape)
- [Remote Browser Isolation to Protect from Web-Based Threats — Apriorit](https://www.apriorit.com/dev-blog/707-cybersecurity-rbi)
- [Browser Sandboxing for Coding Agents: 2026 Security Guide — Blaxel](https://blaxel.ai/blog/browser-sandboxing-for-coding-agents)
- [Chrome Sandbox Under Fire: Linux Kernel Vulnerability — Medium](https://medium.com/@seripallychetan/chrome-sandbox-under-fire-linux-kernel-vulnerability-allows-privilege-escalation-bdbcfc51892d)

---

## 7. Recomendacoes para Este Projeto (remote-browser)

### 7.1 Arquitetura Recomendada

Para o projeto atual, que e um **remote browser multi-usuario** com streaming via WebRTC/CDPscreencast, recomenda-se a seguinte arquitetura de isolamento:

```
┌───────────────────────────────────┐
│  Host / VM Principal              │
│  ┌─────────────────────────────┐  │
│  │  Orchestrator (Node.js)     │  │  - Gerencia ciclo de vida das sessoes
│  │  - Docker API               │  │  - Roteia WebSocket/WebRTC por sessao
│  │  - Session Manager          │  │  - Health checks + cleanup
│  └──────────┬──────────────────┘  │
│             │ docker run          │
│  ┌──────────▼───┐ ┌────────────┐  │
│  │ Container    │ │ Container  │  │  - Um container por sessao de usuario
│  │ Sessao A     │ │ Sessao B   │  │  - --memory=1g --cpus=2
│  │ Chrome+Agent │ │ Chrome+    │  │  - --read-only + tmpfs
│  │ user-data A  │ │ user-data B│  │  - seccomp=chrome.json
│  └──────────────┘ └────────────┘  │
└───────────────────────────────────┘
```

### 7.2 Configuracao Minima de Segurança por Container

```bash
docker run --rm \
  --name "session-${SESSION_ID}" \
  # Limites de recursos
  --memory="1g" \
  --memory-swap="1g" \
  --cpus="2.0" \
  --pids-limit=500 \
  --shm-size="256m" \
  # Filesystem
  --read-only \
  --tmpfs /tmp:size=256m,mode=1777,exec \
  --tmpfs /home/chrome:size=512m \
  # Rede
  --network="session-net-${SESSION_ID}" \
  --dns="8.8.8.8" \
  # Segurança
  --cap-drop=ALL \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=chrome-seccomp.json \
  --security-opt no-new-privileges \
  # Sem persistencia
  --env SESSION_ID="${SESSION_ID}" \
  remote-browser-session:latest
```

### 7.3 Lifecycle de uma Sessao

```
1. Usuario solicita sessao
        ↓
2. Orchestrator gera SESSION_ID = uuid()
        ↓
3. docker run com limites + rede isolada
        ↓
4. Chrome inicia com --user-data-dir=/tmp/profile (efemero dentro do container)
        ↓
5. Stream WebRTC/screencast estabelecido com o usuario
        ↓
6. Sessao ativa (timeout: 30min padrao)
        ↓
7. Usuario desconecta OU timeout
        ↓
8. docker stop session-${SESSION_ID}
        ↓
9. docker rm session-${SESSION_ID}  ← todo dado destruido automaticamente
        ↓
10. Rede session-net-${SESSION_ID} removida
```

### 7.4 O Que NAO Fazer

- **Nao compartilhar** um unico processo Chrome entre usuarios diferentes via browser contexts para producao multi-tenant com usuarios desconfiados.
- **Nao usar** `--no-sandbox` sem compensar com isolamento de container.
- **Nao reutilizar** `user-data-dir` entre sessoes de usuarios diferentes.
- **Nao montar** o socket Docker (`/var/run/docker.sock`) dentro de containers de sessao.
- **Nao usar** DinD (Docker-in-Docker) — nao traz beneficio e aumenta a superficie de ataque.
- **Nao expor** diretamente a porta do Chrome DevTools Protocol para a internet.

---

## 8. Resumo Executivo

| Pergunta | Resposta |
|---|---|
| Como Browserbase/Browserless isolam sessoes? | Containers efemeros por sessao (Browserbase: serverless; Browserless: Docker containers ou browser contexts) |
| Namespaces Linux sao necessarios? | Sim, indiretamente via Docker. Diretamente via `unshare` e possivel mas mais complexo |
| Como limitar CPU/memoria por sessao? | cgroups v2 via `systemd-run` (sem Docker) ou flags `--memory`/`--cpus` do Docker (recomendado) |
| Como fazer cleanup seguro? | Diretorio efemero em tmpfs, `rm -rf` apos sessao, containers `--rm` garantem efemeridade total |
| Docker-in-Docker e necessario? | Nao. Orchestrador no host + containers de sessao e o padrao correto |
| `user-data-dir` separado e suficiente? | Para usuarios confiados sim. Para multi-tenant com usuarios desconhecidos, container por sessao e obrigatorio |
| Principal ameaca? | Cadeia: exploit renderer → sandbox escape → kernel escape/container breakout |
| Melhor defesa? | Defense-in-depth: container por sessao + seccomp customizado + cgroups + Chrome atualizado + rede isolada |

---

## Referencias

- [Browserbase — Cloud Headless Browser Platform](https://www.browserbase.com/)
- [Browserless vs. Browserbase — Browserless Blog](https://www.browserless.io/blog/browserless-vs-browserbase)
- [Observations running more than 5 million headless sessions — Browserless](https://www.browserless.io/blog/observations-running-more-than-5-million-headless-sessions-a-week)
- [Production Best Practices — Browserless Docs](https://docs.browserless.io/enterprise/docker/best-practices)
- [Linux Sandboxing — Chromium Docs](https://chromium.googlesource.com/chromium/src/+/0e94f26e8/docs/linux_sandboxing.md)
- [What Are Namespaces and cgroups — NGINX Blog](https://blog.nginx.org/blog/what-are-namespaces-cgroups-how-do-they-work)
- [Container Security Fundamentals Part 2 — Datadog Security Labs](https://securitylabs.datadoghq.com/articles/container-security-fundamentals-part-2/)
- [Restrict Chrome CPU and memory with cgroups — GitHub Gist](https://gist.github.com/jakewarren/477ecd1149abe908cbd5cf7a7c9abaa3)
- [Using cgroups to limit browser memory+CPU — GitHub Gist](https://gist.github.com/hardfire/7e5d9e7ce218dcf2f510329c16517331)
- [Limit specific process memory with cgroups — Raymii.org](https://raymii.org/s/articles/Limit_specific_process_memory_on_desktop_linux_with_cgroups.html)
- [Chromium Docs: User Data Directory](https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md)
- [User Data Directory — Browserless Docs](https://docs.browserless.io/enterprise/user-data-directory)
- [Seccomp Security Profiles for Docker — Docker Docs](https://docs.docker.com/engine/security/seccomp/)
- [Enhanced Container Isolation — Docker Docs](https://docs.docker.com/enterprise/security/hardened-desktop/enhanced-container-isolation/)
- [Running Chromium in Docker — Medium](https://medium.com/code-and-coffee/running-chromium-in-docker-without-selling-your-soul-433e591802f2)
- [Remote Browser Isolation to Protect from Web-Based Threats — Apriorit](https://www.apriorit.com/dev-blog/707-cybersecurity-rbi)
- [CVE-2025-2783: Chrome Sandbox Escape — Sangfor](https://www.sangfor.com/farsight-labs-threat-intelligence/cybersecurity/cve-2025-2783-google-chrome-sandbox-escape)
- [Browser Sandboxing for Coding Agents 2026 — Blaxel](https://blaxel.ai/blog/browser-sandboxing-for-coding-agents)
- [Kubernetes Browser Isolation Guide 2026 — Sendwin](https://blog.send.win/kubernetes-browser-browser-isolation-guide-2026/)
- [Containerized Browser Isolation Guide 2026 — Sendwin](https://blog.send.win/containerized-browser-browser-isolation-guide-2026/)
- [Chromium OS Cgroups Design](https://www.chromium.org/chromium-os/chromiumos-design-docs/chromium-os-cgroups/)
- [cgroups — Wikipedia](https://en.wikipedia.org/wiki/Cgroups)
- [Linux Namespaces — Wikipedia](https://en.wikipedia.org/wiki/Linux_namespaces)
