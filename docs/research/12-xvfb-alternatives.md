# Alternativas ao Xvfb para Virtual Display no Linux

**Data:** 2026-03-17
**Contexto:** Remote Browser Project — avaliação de display virtual para execução do Chrome sem tela física.

---

## 1. O Problema: Por Que Precisamos de um Display Virtual?

O Chrome (e qualquer aplicação gráfica X11/Wayland) exige um servidor de display para funcionar em modo "headful" — com GUI completa, extensões, contexto de renderização completo. Em servidores sem monitor físico e sem GPU conectada, a solução tradicional é criar um display virtual em memória.

No contexto deste projeto (**remote browser com streaming WebRTC**), estamos rodando Chrome em modo headful (com interface gráfica real) para capturar e transmitir a tela via WebRTC. Isso é diferente de scraping ou automação simples, onde `--headless` seria suficiente.

---

## 2. Opções de Display Virtual: Análise Comparativa

### 2.1 Xvfb (X Virtual Framebuffer)

**O que é:** Servidor X11 que opera completamente em memória virtual, sem hardware gráfico. Implementa o protocolo X11 integralmente — do ponto de vista do cliente, comporta-se como qualquer servidor X real.

**Como funciona:**
- Cria um framebuffer em RAM com resolução e profundidade de cor configuráveis
- Renderização via software (sem aceleração de hardware)
- Suporta extensões X11: GLX, RENDER, MIT-SHM (shared memory)
- Clientes conectam via socket Unix (`:99`, `:1`, etc.)

**Comando típico:**
```bash
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
export DISPLAY=:99
google-chrome --no-sandbox
```

**Prós:**
- Compatibilidade universal com aplicações X11
- Amplamente testado em CI/CD (GitHub Actions, Jenkins, etc.)
- Integração direta com `x11grab` (FFmpeg) para captura de vídeo
- Funciona com extensões Chrome (ao contrário do modo headless nativo)

**Contras:**
- Overhead de CPU/memória não desprezível (software rendering)
- Bug conhecido de memory leak: o processo Xvfb pode crescer indefinidamente quando clientes desconectam sem o flag `-noreset`
- Sem aceleração GPU — todos os pixels calculados por CPU
- Framebuffer armazena pixels em RAM: 1920x1080x32bpp = ~8 MB por tela
- Deprecated em algumas distribuições modernas (RHEL/CentOS Stream 10 removeu suporte ao Xorg completo)

**Consumo de recursos (tipico):**
- Xvfb em idle: 10–30 MB RAM
- Com Chrome conectado a 1080p: 50–150 MB RAM adicionais no processo Xvfb
- Memory leak sem `-noreset`: crescimento ilimitado ao longo do tempo
- CPU em idle: quase zero; sob renderização ativa: 5–25% de um core

---

### 2.2 Xvnc (TigerVNC / TightVNC)

**O que é:** Combinação de servidor X11 virtual com servidor VNC integrado. Permite acesso remoto ao display virtual sem ferramentas adicionais.

**Como funciona:**
- Servidor X11 virtual (igual ao Xvfb) + protocolo VNC para acesso remoto
- Disponível como `Xvnc` (parte do TigerVNC)
- Clientes VNC podem conectar diretamente sem x11vnc separado

**Comando típico:**
```bash
Xvnc :1 -geometry 1920x1080 -depth 24 -SecurityTypes None
export DISPLAY=:1
google-chrome
```

**Prós:**
- Display virtual + acesso remoto built-in (VNC)
- Útil para debug visual: conectar um viewer VNC e ver o que o Chrome está fazendo
- Mesma compatibilidade que Xvfb com aplicações X11

**Contras:**
- Overhead maior que Xvfb (mantém encoder VNC rodando continuamente)
- VNC comprime/descomprime frames — CPU adicional
- Para transmissão WebRTC, seria necessário capturar o stream VNC e reencoder — latência extra
- Complexidade de setup maior
- Não indicado para casos onde acesso remoto não é necessário

**Consumo de recursos:** 20–60 MB adicionais vs. Xvfb puro (encoder VNC em background)

---

### 2.3 Xephyr (Nested X Server)

**O que é:** Servidor X11 aninhado — roda dentro de outro servidor X ou Wayland, exibindo o display virtual em uma janela no host.

**Como funciona:**
- Conecta-se a um display existente (`:0` ou Wayland via XWayland)
- Exibe o display virtual como uma janela no host
- Não opera sem um display pai — não é adequado para servidores headless puros

**Prós:**
- Útil para testes visuais em desenvolvimento
- Rápido e estável para aplicações gráficas
- Boa ferramenta de debug

**Contras:**
- **Não adequado para servidores sem display:** requer um display pai para funcionar
- Uso em produção limitado
- Não resolve o problema de "servidor sem monitor físico" sem um display base

**Veredicto para este projeto:** Irrelevante em produção; útil apenas para desenvolvimento local.

---

### 2.4 Xdummy (Dummy Video Driver)

**O que é:** Driver de vídeo "dummy" para o servidor X.Org — não é um servidor separado, mas um módulo que cria um display virtual dentro do servidor X normal.

**Como funciona:**
- Usa o driver `dummy` do X.Org: `/etc/X11/xorg.conf` com `Driver "dummy"`
- Inicia o servidor X completo (`Xorg`) sem hardware real
- Mais leve que Xvfb em termos de overhead de software

**Configuração:**
```
Section "Device"
    Identifier "Configured Video Device"
    Driver "dummy"
    VideoRam 256000
EndSection
Section "Screen"
    Identifier "Default Screen"
    Monitor "Configured Monitor"
    Device "Configured Video Device"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1920x1080"
    EndSubSection
EndSection
```

**Prós:**
- Menor overhead que Xvfb em alguns cenários
- Integra-se perfeitamente com qualquer aplicação X11

**Contras:**
- Menos documentação e suporte da comunidade
- Requer configuração manual do xorg.conf
- Também baseado em Xorg — mesma trajetória de deprecação
- Menos testado em containers/Docker

---

### 2.5 Weston (Compositor Wayland)

**O que é:** Compositor Wayland de referência com backend headless — pode rodar sem display físico ou dentro de outro compositor.

**Como funciona:**
- Weston com backend `headless` cria um compositor Wayland em memória
- Aplicações Wayland conectam diretamente ao socket Wayland
- Aplicações X11 podem rodar via **XWayland** (camada de compatibilidade)
- Ferramenta `xwfb-run` (Red Hat) serve como drop-in replacement do `xvfb-run`

**Iniciativa Red Hat (xwayland-run):**
Diante da remoção do Xorg/Xvfb do RHEL/CentOS Stream 10, a Red Hat desenvolveu o pacote `xwayland-run` com três utilitários:
- `xwayland-run` — executa clientes X11 em instância Xwayland dedicada
- `wlheadless-run` — executa clientes Wayland em compositor headless (Weston, Cage, Mutter, GNOME-Kiosk)
- `xwfb-run` — substituto direto do `xvfb-run` usando Xwayland + compositor headless

**Comando típico:**
```bash
# Weston headless backend
weston --backend=headless-backend.so --shell=kiosk-shell.so &
export WAYLAND_DISPLAY=wayland-0
google-chrome --ozone-platform=wayland

# Ou usando xwfb-run (drop-in replacement)
xwfb-run google-chrome
```

**Prós:**
- Moderno, nativo Wayland — path futuro em distribuições Linux
- Chrome suporta Wayland nativamente via `--ozone-platform=wayland`
- Menor overhead que Xvfb+Chrome em comparação a X11+Chrome
- Escalável: sem o overhead do protocolo X11 (que é mais verboso)
- Chromium usa Weston internamente para testes em build bots
- Suporte de compositing: permite aceleração GPU em alguns cenários

**Contras:**
- Setup mais complexo (inicializar Weston + XWayland se necessário)
- Quebra de dependências reportada em EPEL10 (problema de empacotamento, não arquitetural)
- Menor documentação para uso com Chrome em produção
- O Chrome com `--ozone-platform=wayland` ainda está madurando em alguns cenários

**Consumo de recursos (estimado):**
- Weston headless: 15–40 MB RAM
- Menor overhead de IPC vs. X11 (protocolo Wayland é mais eficiente)

---

## 3. Chrome Headless Nativo: A Opção Sem Display Virtual

### 3.1 `--headless` (novo, padrão desde Chrome 112/v128)

O modo headless nativo do Chrome elimina completamente a necessidade de display virtual. A partir do Chrome 112, o `--headless` foi unificado com o modo regular — é literalmente o mesmo browser, apenas sem janela visível.

**Arquitetura:**
```
Blink (engine) → renderiza DOM/CSS/JS
    ↓
Compositor (cc) → calcula layers
    ↓
Skia/GPU → pinta pixels em framebuffer off-screen
    ↓
Nenhuma saída visual (descartada)
```

O Chrome com `--headless`:
- Executa o pipeline completo de renderização (parse HTML → DOM → CSSOM → layout → paint → composite)
- Pinta pixels em framebuffer off-screen na memória
- Não exige servidor X11, Wayland, ou qualquer display
- Suporta CDP (Chrome DevTools Protocol) para automação completa
- Screenshots via `--screenshot`, PDF via `--print-to-pdf`
- **NÃO suporta extensões Chrome** (limitação do modo headless)

**Como iniciar:**
```bash
google-chrome \
  --headless \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  https://example.com
```

### 3.2 `chrome-headless-shell` (antigo headless, separado desde Chrome 132)

A partir do Chrome 132 (janeiro de 2025), o modo headless antigo foi removido do binário principal e disponibilizado como binário separado: `chrome-headless-shell`.

| Característica | `chrome --headless` | `chrome-headless-shell` |
|---|---|---|
| Base de código | Chrome completo | Implementação separada/stripped |
| Funcionalidades | Completas (paridade total) | Limitadas (sem extensões, sem UI completa) |
| Performance | Levemente mais lento | Mais rápido (menos features) |
| Memória | Maior (full browser) | Menor |
| Extensões | Não suporta | Não suporta |
| Uso ideal | E2E testing, máxima compatibilidade | Scraping, PDFs, automação simples |

### 3.3 Chrome com `--ozone-platform=headless`

Para casos onde o Chrome precisa de pipeline de renderização mais controlado sem display:

```bash
google-chrome \
  --ozone-platform=headless \
  --ozone-dump-file=/tmp/output/ \
  --headless
```

O backend Ozone `headless` renderiza para arquivos PNG (software rendering apenas, sem GPU). Útil para screenshot pipelines mas não para streaming contínuo.

---

## 4. Rendering Direto em Memória: DRM/KMS e GBM

Para cenários avançados onde há GPU disponível mas sem display físico conectado, é possível usar o subsistema DRM/KMS do Linux diretamente.

### 4.1 Como funciona DRM/KMS

O **Direct Rendering Manager (DRM)** é o subsistema do kernel Linux para interface com GPUs. O **Kernel Mode Setting (KMS)** configura resoluções e framebuffers diretamente no kernel.

```
Aplicação → /dev/dri/card0 (DRM) → GPU → framebuffer em VRAM
```

**Sem X11 ou Wayland!** A aplicação fala diretamente com o kernel via DRM.

Para rendering off-screen com GPU:
- **GBM (Generic Buffer Management):** aloca buffers GPU-friendly
- **EGL:** contexto OpenGL/GLES sem display físico (`EGL_EXT_platform_device`)
- Renderização acontece na VRAM, resultado pode ser lido de volta para RAM

### 4.2 Chrome com DRM/GBM

O Chrome suporta renderização direta via DRM/GBM no ChromeOS (via `--ozone-platform=drm`). Em produção em servidores sem display:

```bash
# Requer GPU com driver KMS e permissão ao /dev/dri/
google-chrome \
  --ozone-platform=drm \
  --no-sandbox \
  --disable-setuid-sandbox
```

**Limitações em servidores cloud:**
- Instâncias cloud (AWS, GCP, Azure) geralmente não expõem `/dev/dri/card0`
- GPUs virtuais (vGPU) podem não suportar modesetting completo
- Instâncias com GPU dedicada (p3, g4dn na AWS) suportam DRM/GBM

### 4.3 Nvidia EGL Headless

Com GPUs Nvidia em servidores, existe a opção de usar EGL headless:

```bash
# Requer nvidia-persistenced e configuração adequada
export __EGL_VENDOR_LIBRARY_DIRS=/usr/share/glvnd/egl_vendor.d
google-chrome \
  --use-gl=egl \
  --use-angle=egl \
  --headless
```

---

## 5. Benchmarks e Comparações de Performance

### 5.1 Dados de benchmark disponíveis

Os benchmarks mais citados na literatura técnica comparam Chromium+Xvfb vs. Chrome headless em page load time:

| Configuração | Tempo para 10 page loads | Notas |
|---|---|---|
| Chromium + Xvfb | ~96 segundos | Build Release |
| Chrome --headless (novo) | ~81 segundos | Build Release, 15% mais rápido |
| Chrome --headless (debug) | ~129 segundos | Debug build, não representativo |

Fonte: [discussão na mailing list chromium headless-dev](https://groups.google.com/a/chromium.org/g/headless-dev/c/J6SjKnRQGQc)

**Observação importante:** Estes benchmarks são de page load time para automação/scraping. Para o caso de uso de **streaming WebRTC com captura de tela**, o perfil de performance é diferente.

### 5.2 Consumo de memória (estimativas consolidadas)

| Componente | RAM estimada | Notas |
|---|---|---|
| Xvfb (1080p, 24bpp) | 10–30 MB | Processo Xvfb idle |
| Xvfb framebuffer (1080p) | ~8 MB | 1920×1080×4 bytes |
| Chrome headful + Xvfb | 500 MB–1.5 GB | Chrome + Xvfb juntos |
| Chrome --headless | 300 MB–1 GB | Variável, sem display |
| chrome-headless-shell | 200–600 MB | Menor que full Chrome |
| Weston headless | 15–40 MB | Compositor sozinho |
| Chrome + Weston (Wayland) | Similar ao headless | Sem overhead X11 |

**Nota:** Valores de Chrome são altamente variáveis dependendo do conteúdo da página, número de tabs, extensões ativas e configurações de flags.

### 5.3 Overhead de CPU: comparação qualitativa

| Modo | CPU overhead (idle) | CPU overhead (rendering ativo) |
|---|---|---|
| Xvfb | Desprezível | 5–25% (software rasterization) |
| Weston headless | Desprezível | 2–10% (mais eficiente) |
| Chrome --headless | Maior (60fps rendering contínuo) | Significativo |
| Chrome + Xvfb (headful) | Baixo display overhead | Médio |

**Ponto crítico (reportado pela equipe do browserless.io):** Chrome headless renderiza a 60fps mesmo sem ninguém assistindo — gasto de CPU desnecessário. Flags para mitigar: `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`.

---

## 6. Análise para o Projeto Remote Browser

O projeto remote-browser tem um requisito específico: **rodar Chrome em modo headful (com GUI real) para capturar a tela e transmitir via WebRTC**. Isso implica:

1. Chrome com janela gráfica real (não headless puro)
2. Captura de framebuffer para encoding de vídeo
3. Suporte a extensões Chrome (se necessário)
4. Baixa latência de captura → encoding → transmissão

### 6.1 Por que `--headless` puro não serve

- Modo headless não expõe framebuffer capturável pelo `x11grab` do FFmpeg
- Não suporta extensões Chrome
- CDP pode tirar screenshots, mas com latência muito maior que captura direta de framebuffer
- Não permite interação com interface visual real (necessário para navegação remota controlada pelo usuário)

### 6.2 Comparativo de opções viáveis para o projeto

| Opção | Compatibilidade | Overhead | Captura de Vídeo | Extensões | Maturidade |
|---|---|---|---|---|---|
| **Xvfb + x11grab** | Alta | Médio | Direta (FFmpeg) | Sim | Alta |
| **Xvfb + WebRTC nativo** | Alta | Médio-Alto | Via X11/GStreamer | Sim | Alta |
| **Weston + Chrome Wayland** | Média | Baixo-Médio | Via pipewire/wlroots | Sim | Média |
| **Chrome --headless + CDP** | Alta | Médio | Via CDP (lenta) | Não | Alta |
| **DRM/GBM direto** | Baixa (sem GPU virtual) | Mínimo | Via DRM | Sim | Baixa |

### 6.3 Flags de otimização para Chrome + Xvfb

Para minimizar overhead na configuração atual (Xvfb + Chrome headful):

```bash
# Xvfb otimizado
Xvfb :99 \
  -screen 0 1920x1080x24 \
  -ac \
  -noreset \        # evita memory leak
  +extension GLX \
  +render \
  -nolisten tcp     # segurança: apenas socket Unix

# Chrome otimizado para captura
DISPLAY=:99 google-chrome \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu-sandbox \
  --disable-setuid-sandbox \
  --no-first-run \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --disable-ipc-flooding-protection \
  --window-size=1920,1080 \
  --window-position=0,0 \
  --start-maximized
```

### 6.4 Alternativa futura: Chrome + Wayland (Weston headless)

Para reduzir overhead X11 e se preparar para distribuições que estão removendo Xorg:

```bash
# Iniciar Weston headless
weston \
  --backend=headless-backend.so \
  --width=1920 --height=1080 \
  --shell=kiosk-shell.so \
  --socket=wayland-remote-browser &

# Chrome com Wayland
WAYLAND_DISPLAY=wayland-remote-browser google-chrome \
  --ozone-platform=wayland \
  --no-sandbox \
  --start-maximized
```

Captura via PipeWire (protocolo moderno para captura de tela no Wayland):
```bash
# GStreamer + PipeWire para captura Wayland
gst-launch-1.0 pipewiresrc ! videoconvert ! x264enc ! rtph264pay ! udpsink
```

---

## 7. Recomendação Final

### Para o estado atual do projeto (curto prazo):

**Continuar com Xvfb** é a escolha mais pragmática:
- Compatibilidade total com Chrome headful
- Pipeline de captura x11grab/FFmpeg já funcional
- Menor risco de regressões
- Ampla documentação disponível

**Otimizações obrigatórias:**
1. Sempre usar `-noreset` no Xvfb para evitar memory leak
2. Usar `-nolisten tcp` por segurança
3. Ajustar resolução ao mínimo necessário (cada pixel economizado = menos RAM e CPU)
4. Usar shared memory (`-shmem`) para comunicação mais rápida entre Chrome e Xvfb

### Para evolução futura (médio prazo):

Avaliar migração para **Weston headless + Chrome Wayland** quando:
- Distribuições base começarem a remover Xorg/Xvfb (RHEL/CentOS Stream 10 já fez isso)
- O suporte `--ozone-platform=wayland` do Chrome estiver mais maduro
- PipeWire para captura de tela Wayland estiver consolidado

### Para casos sem display virtual (longo prazo):

Se o objetivo mudar para **renderização pura sem GUI visível** (apenas scraping/automação), migrar para `chrome --headless` nativo eliminaria toda a camada de display virtual, reduzindo ~30–50% do overhead total de memória e eliminando processos auxiliares (Xvfb/Weston).

---

## 8. Referências

- [Chrome Headless mode | Chrome for Developers](https://developer.chrome.com/docs/chromium/headless)
- [Download old Headless Chrome as chrome-headless-shell](https://developer.chrome.com/blog/chrome-headless-shell)
- [Chromium Docs — Ozone Overview](https://chromium.googlesource.com/chromium/src/+/lkgr/docs/ozone_overview.md)
- [Headless Chromium (README)](https://chromium.googlesource.com/chromium/src/+/lkgr/headless/README.md)
- [Display Servers comparison: Xvfb, WayLand, Xdummy, Xvnc (Medium)](https://medium.com/@s.atmaramani/display-servers-comparision-xvfb-wayland-xdummy-xvnc-51b657c04eee)
- [Understand whether Weston on Wayland can replace Xvfb (Adoptium)](https://github.com/adoptium/infrastructure/issues/3851)
- [Red Hat Developing New xwayland-run & wlheadless-run Utilities (Phoronix)](https://www.phoronix.com/news/xwayland-run)
- [Weston headless backend — xvfb-run emulation (mailing list)](https://lists.freedesktop.org/archives/wayland-devel/2019-January/039803.html)
- [xwfb-run man page (OpenSUSE)](https://manpages.opensuse.org/Tumbleweed/xwayland-run/xwfb-run.1.en.html)
- [headless performance benchmark (Chromium mailing list)](https://groups.google.com/a/chromium.org/g/headless-dev/c/J6SjKnRQGQc)
- [Xvfb Memory Leak Workaround](https://blog.jeffterrace.com/2012/07/xvfb-memory-leak-workaround.html)
- [Choosing Headful over Headless Browsers (Anchor)](https://anchorbrowser.io/blog/choosing-headful-over-headless-browsers)
- [Running Headless Chrome at Scale (DEV Community)](https://dev.to/max_kurz/running-headless-chrome-at-scale-production-lessons-from-millions-of-renders-djg)
- [How can I make Headless Chromium use less CPU and memory? (WebScraping.AI)](https://webscraping.ai/faq/headless-chromium/how-can-i-make-headless-chromium-use-less-cpu-and-memory)
- [Direct Rendering Manager (Wikipedia)](https://en.wikipedia.org/wiki/Direct_Rendering_Manager)
- [x11docker wiki — X server and Wayland Options](https://github.com/mviereck/x11docker/wiki/X-server-and-Wayland-Options)
- [Observations running more than 5 million headless sessions (browserless.io)](https://www.browserless.io/blog/2019/03/13/more-observations/)
- [Headless vs. Headful Browsers in 2025 (ScrapingAnt)](https://scrapingant.com/blog/headless-vs-headful-browsers-in-2025-detection-tradeoffs)
- [Xvfb bug: memory leak on server regeneration (Red Hat Bugzilla)](https://bugzilla.redhat.com/show_bug.cgi?id=498357)
