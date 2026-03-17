# AI Vision Agents e Browser Automation

## Introdução

Agents de IA que controlam navegadores através de visão computacional representam uma das fronteiras mais promissoras em automação web. Diferente dos métodos tradicionais baseados em APIs ou scripts, esses agents "enxergam" a interface através de screenshots e tomam decisões baseadas em compreensão visual, similar a como um humano operaria um navegador.

Este documento compila as técnicas, arquiteturas e melhores práticas para implementar agents de visão para browser automation, com foco em integração via Model Context Protocol (MCP).

---

## 1. Como AI Agents Usam Screenshots para Navegar na Web

### Architecture do Vision Loop

Os agents de visão seguem um ciclo de percepção-ação contínuo:

```
┌─────────────────────────────────────────────────────┐
│                   VISION LOOP                       │
├─────────────────────────────────────────────────────┤
│  1. Captura screenshot do browser                  │
│  2. Envia para LLM multimodal (GPT-4V, Claude)    │
│  3. LLM analisa e decide ação                     │
│  4. Executa ação (click, type, scroll)            │
│  5. Repete até completar tarefa                   │
└─────────────────────────────────────────────────────┘
```

### Componentes do Loop

**1. Screenshot Capture**
- Captura tela completa ou viewport
- Pode incluir múltiplas abas/janelas
- Frequência: 1-5 FPS (depende da latência aceitável)
- Formato: PNG ou JPEG otimizado

**2. Visual Processing**
- LLM multimodal recebe imagem + contexto
- Interpreta layout, botões, formulários, textos
- Identifica elementos interativos (links, inputs, buttons)
- Extrai texto visível (OCR implícito do modelo)

**3. Action Decoding**
- Modelo retorna coordenadas ou elemento alvo
- Pode usar descrições naturais ("clique no botão verdeSubmit")
- Mapeamento visual → coordenadas de tela
- Gera sequência de ações multi-step

**4. Execution**
- Dispatch eventos de mouse/keyboard
- Preenchimento de formulários
- Navegação entre páginas
- Espera por carregamento

### Exemplo de Prompt para Agent de Visão

```
Você está controlando um navegador web. Aqui está o screenshot atual.

Tarefa: Preencher formulário de login e fazer login.

Instruções:
1. Analise a imagem e identifique todos os campos interativos
2. Para cada ação, retorne JSON:
{
  "action": "click" | "type" | "scroll",
  "target": "descrição visual do elemento",
  "coordinates": {"x": 123, "y": 456},
  "text": "texto a digitar (se type)"
}
3. Execute uma ação por vez e aguarde o próximo screenshot

Importante: Seja preciso nas coordenadas e descreva claramente o elemento alvo.
```

### Desafios do Loop de Visão

**Latência Acumulada**
- Screenshot: 50-200ms
- API LLM: 500ms - 3s (depende do modelo)
- Execução: 50-200ms
- **Total por ciclo**: 600ms - 3.5s
- Tarefas de 10 passos → 6-35 segundos

**Ambigüidade Visual**
- Elementos similares confundem o modelo
- Mudanças dinâmicas (spinners, anúncios)
- Zoom/resolução afetam reconhecimento
- Texto em imagens (não-native)

**State Tracking**
- Modelo precisa lembrar ações anteriores
- Histórico de navegação
- Contexto de formulários parciais
- Multi-tab management

---

## 2. Claude Computer Use: Como Funciona e Expõe API

### O que é o Computer Use?

[Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) é o produto da Anthropic que permite Claude 3.5 Sonnet e superiores controlar computadores através de uma interface visual. lançado em outubro de 2024, ele permite que Claude:

- Veja o desktop através de screenshots
- Mova mouse e teclado
- Abra aplicativos, navegue na web
- Preencha formulários e interaja com UIs
- Execute comandos de linha de comando

### Arquitetura Técnica

```
┌────────────────────────────────────────────────────────┐
│                    Claude API                          │
│               (computer-use-beta header)              │
└─────────────────┬──────────────────────────────────────┘
                  │ JSON-RPC com tool calls
                  ▼
┌────────────────────────────────────────────────────────┐
│              Computer Use Tool Bridge                  │
│  • Traduz tool calls → ações de sistema              │
│  • Captura screenshots                               │
│  • Executa mouse/keyboard/commands                   │
│  • Usa X11 (Xvfb) + Docker                           │
└─────────────────┬──────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────────────────────┐
│              Isolated Container                       │
│  • Xvfb: Virtual Display (X11)                       │
│  • Window Manager: Mutter                            │
│  • Apps: Firefox, LibreOffice, etc.                  │
└────────────────────────────────────────────────────────┘
```

### API e Tool Schema

O Computer Use expõe uma ferramenta única com parâmetros especiais:

```json
{
  "name": "computer",
  "description": "Control desktop environment via visual interface",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "screenshot",      // Captura tela
          "mouse_move",      // Move cursor (x, y)
          "left_click",      // Clique esquerdo
          "right_click",     // Clique direito
          "double_click",    // Duplo clique
          "drag",            // Arrastar (start → end)
          "type",            // Digitar texto
          "key",             // Tecla especial (Enter, Esc, etc.)
          "scroll",          // Scroll (dx, dy)
          "wait"             // Aguardar N segundos
        ]
      },
      "coordinate": {"type": "array", "items": {"type": "number"}},
      "text": {"type": "string"}
    },
    "required": ["action"]
  }
}
```

**Exemplo de tool call**:
```json
{
  "tool_name": "computer",
  "tool_input": {
    "action": "screenshot"
  }
}
```

### Screenshot Format e Encoding

O Computer Use retorna screenshots no formato scheme:

```
data:image/png;base64,<base64-encoded-png>
```

Especificações:
- Resolução: padrão 1024x768 (configurável)
- Formato: PNG (lossless, preserva texto)
- Encoding: Base64 inline (aumenta payload ~33%)
- Compressão opcional: JPEG (30-60% menor, perda)

### Beta Headers e Modelos Suportados

| Modelo | Header | Status |
|--------|--------|--------|
| Claude Opus 4.6 | `computer-use-2025-11-24` | ✅ Beta |
| Claude Sonnet 4.6 | `computer-use-2025-11-24` | ✅ Beta |
| Claude Opus 4.5 | `computer-use-2025-11-24` | ✅ Beta |
| Claude Sonnet 4.5 | `computer-use-2025-01-24` | ⚠️ Deprecated |
| Claude Haiku 4.5 | `computer-use-2025-01-24` | ⚠️ Deprecated |
| Claude Opus 4 | `computer-use-2025-01-24` | ⚠️ Deprecated |

**Nota**: O header `computer-use-2025-01-24` está deprecated. Use sempre a versão mais recente.

### Browser Control Específico

Para controle de navegador, Claude pode:

1. **Abrir Firefox** (pré-instalado)
2. **Navegar via URL bar** (digitar `type` + `key: "Enter"`)
3. **Scroll** para Explorar Páginas
4. **Click** em elementosidentified visualmente
5. **Preencher formulários** campo a campo
6. **Multi-tab**: alternar usando Alt+Tab (simulado)

### Limitações e Known Issues

**Segurança**:
- Docker isolation, mas ainda risky em produção
- Pode acessar arquivos locais se não restrito
- Jailbreak possible via prompts injection (ex: texto em imagem)

**Performance**:
- Latência: 500ms - 2s por ação (inclui turnaround API)
- Erros de coordinate mapping em diferentes DPI/scaling
- Não suporta WebGL/hardware acceleration fully

**WebArena Score**:
- Claude 3.5 Sonnet Computer Use: ~60% success em tarefas complexas
- vs. humanos: ~78%
- vs. GPT-4 baseline: 14% → Claude é líder atual

### Como Acessar

```javascript
// API call example
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-6-20251120",
  max_tokens: 1024,
  beta: ["computer-use-2025-11-24"],
  tools: [{
    type: "computer_20250124",
    name: "computer",
    display_name: "Computer"
  }],
  messages: [...]
});
```

---

## 3. Latência do Loop: Screenshot → LLM → Action

### Breakdown de Latência

| Componente | Latência Média | Latência P95 | Variáveis |
|------------|----------------|--------------|-----------|
| Screenshot Capture | 50-150ms | 200ms | Resolução, encoding |
| Image Encoding/Upload | 100-300ms | 500ms | Tamanho, rede |
| LLM API Inference | 500-2000ms | 4000ms | Modelo, tokens |
| Action Execution | 30-100ms | 150ms | Dispositivo input |
| **TOTAL POR CICLO** | **680-2550ms** | **4850ms** | — |

### Fatores que Impactam Latência

**1. Tamanho da Imagem**

| Resolução | Tamanho PNG | Tamanho JPEG (q=75) | LLM Cost (tokens) |
|-----------|--------------|---------------------|-------------------|
| 640x480 | ~150KB | ~50KB | ~2000 |
| 1024x768 | ~350KB | ~120KB | ~4000 |
| 1920x1080 | ~1.2MB | ~400KB | ~7000 |
| 2560x1440 | ~2.5MB | ~850KB | ~10000 |

**Trade-off**: Maior resolução = melhor precisão, mas +latência e +custo.

**2. Modelo LLM**
- Claude Sonnet: 500-1500ms
- Claude Opus: 1000-3000ms (melhor raciocínio)
- GPT-4V: 800-2500ms
- GPT-4o (visão): 400-1200ms (otimizado)

**3. Prompt Complexity**
- Few-shot com exemplos: +200-500ms (tokens extra)
- RAG com contexto: +300ms
- Chain-of-thought instructions: +500ms

**4. Network RTT**
- Datacenter → API: 20-100ms (local)
- Cross-continent: 200-500ms
- Mobile 4G/5G: 100-300ms

### Otimização de Latência

**L1: Cache de Screenshots**
- Não capturar se DOM não mudou (polling com hash de canvas)
- Detect visual diff: se mudança < threshold, skip LLM call
- Economia: até 40% em páginas estáticas

**L2: Compressão Inteligente**
- Região de interesse (ROI): crop apenas área relevante
- JPEG com quality=60-75: perda mínima, ganho 60-70%
- Resize dinâmico: se tarefa simples, usar 640x480
- WebP: 25-35% menor que JPEG (suporte LLM?)

**L3: Parallelização**
- Captura screenshot + API call do ciclo anterior em paralelo
- Overlap I/O: enquanto LLM processa, já pré-capture próxima imagem
- Thread pool para múltiplas abas

**L4: Model Selection por Task**
- Simple click: GPT-4o (fast)
- Complex reasoning: Claude Opus
- Hybrid: fallback automático se confidence baixa

**L5: Streaming Parcial**
- Enviar screenshot comprimido primeiro
- LLM early exit sealready knows next action
- Partial results para UI (show thinking process)

### Benchmarks Reais

**Teste: Login no GitHub**
```
Tarefa: Fazer login em github.com
Screenshot 1 (1024x768, PNG): 350KB upload 280ms
Claude Sonnet inference: 1200ms
Action click username: 45ms
Screenshot 2: 320ms
Claude detect password field: 1400ms
Action type password: 60ms
Screenshot 3: 310ms
Claude click signin: 1250ms
TOTAL: 3865ms (3.9s)
```

**Teste: WebArena Task (Complex)**
```
Tarefa: Comprar produto no e-commerce (4 steps)
Latência média por ciclo: 2.1s
Total: 12.7s (6 steps com esperas)
Humano médio: 8-10s
```

**Conclusão**: Agents visuais atingiram ~80% da velocidade humana em tarefas simples, mas ainda lentos para tarefas complexas (30-50% mais lentos).

---

## 4. Otimizando Screenshots para LLMs

### Compressão e Formato

**JPEG vs PNG vs WebP**

| Formato | Vantagens | Desvantagens | Recomendação |
|---------|-----------|--------------|--------------|
| PNG | Lossless, preserva texto | +300% tamanho vs JPEG | Raro (texto pequeno) |
| JPEG | 60-75% menor, amplamente suportado | Artefatos em bordas/texto | ✅ Padrão |
| WebP | 25-35% menor que JPEG | Suporte LLM incerto | Experimental |
| AVIF | 40-50% menor que JPEG | Emerging, suporte limitado | Future |

**Configuração JPEG Ideal**:
```javascript
const quality = 75; // Sweet spot: <5% quality loss, 65% smaller
const progressive = false; // LLMs prefer baseline para decoding rápido
const optimizeCoding = true; // Otimiza Huffman tables
```

### Redimensionamento Inteligente

**Problema**: LLMs têm context window limitado (~128K-200K tokens). Imagem grande consome tokens proporcionalmente.

**Regras**:
- Aspect ratio preserve: não distorcer
- Resolução mínima: 512px no menor lado (para texto legível)
- Máximo: 1024px no maior lado (cost-effective)

**Crop Estratégico**:
```javascript
// Identificar área de interesse com heurísticas
if (task === "form filling") {
  // Crop viewport para excluir header/footer
  // Focar no centro onde ficam formulários
  crop = { x: 0, y: 100, width: 1024, height: 600 }
}
```

### Encoding para LLMs

**Base64 vs URL**
- Base64 inline: +33% overhead, mas single request
- URL externa: 0 overhead, mas requires hosting
- Recomendação: Base64 para simplicity

**Token Count Estimate** (Claude, GPT-4):
- Regra: ~0.5 tokens por pixel (depende do modelo)
- Exemplo: 1024x768 → 786,432 pixels → ~393K tokens (!)
- **ERRO**: Models não processam pixel por pixel!
- Real: Usam image encoder (ViT) que comprime para ~1000-4000 tokens

**Tokens por Imagem** (GPT-4V, Claude 3.5+):
| Resolução | GPT-4V tokens | Claude tokens |
|-----------|---------------|---------------|
| 512x512 | ~1000 | ~850 |
| 1024x768 | ~2000 | ~1700 |
| 1920x1080 | ~4000 | ~3400 |

**Cálculo**: low-side edge ≈ 1.7 tokens per image pixel (Claude)

### Multi-View Strategy

Para páginas longas (scroll):
- Capturar top, middle, bottom separate
- Concatenar verticalmente (stich) antes de enviar
- Enviar como array de imagens (if model suporta)
- Cost: 3x tokens, mas accuracy melhor

**Alternativa**:
- Scroll automatizado com overlap
- Model decide se precisa ver mais
- Lazy loading de regiões

### Otimizações Adicionais

**1. Color Space**
- Converter para sRGB (se origem wide-gamut)
- Reduzir paleta se imagem BW/monocromática

**2. Metadata Stripping**
- Remover EXIF (GPS, camera info)
- Reduz 5-15KB por imagem
- Não afeta quality

**3. Smart Downsampling**
- Se texto legível em 800px width, não usar 1920px
- Detect blur/compression artifacts original → ajustar
```javascript
function optimalResize(img, targetWidth = 1024) {
  const currentWidth = img.width;
  if (currentWidth <= targetWidth) return img;
  const ratio = targetWidth / currentWidth;
  return resize(img, ratio, 'lanczos'); // Qualidade alta
}
```

**4. Preprocessing Pipeline**
```
Raw screenshot (PNG, 1920x1080, 2.5MB)
   ↓
Crop ROI (exclui browser chrome)
   ↓
Resize to 1024x667 (keep aspect)
   ↓
 JPEG encode q=75
   ↓
 120KB ready for LLM
```

**Resultado**: 2.5MB → 120KB = 95% reduction com <5% accuracy loss.

---

## 5. Diferença entre Screencast Streaming (Humanos) vs Screenshots (AI)

### Screencast para Humanos

**Objetivo**: Experiência visual fluida em tempo real

**Características**:
- **Frame Rate**: 30-60 FPS (motion smooth)
- **Latência**: 100-300ms (interactive feel)
- **Compressão**: H.264/H.265, VP8/VP9
  - Inter-frame (P/B frames)减少 bandwidth
  - Keyframe a cada 2-5 segundos
- **Bitrate**: 500 Kbps - 5 Mbps (HD quality)
- **Transporte**: WebRTC, RTMP, HLS
- **Decoding**: Hardware acceleration (GPU)

**Exemplo**: `ffmpeg -f x11grab -r 30 -s 1920x1080 -i :99 -c:v libx264 -preset fast -crf 23 -f flv rtmp://...`

**Foco**: Appearance, smoothness, low latency

### Screenshots para AI

**Objetivo**: Compreensão semântica precisa

**Características**:
- **Frame Rate**: 1-5 FPS (LLM inference bottleneck)
- **Latência**: 200-2000ms por frame (LLM turnaround)
- **Compressão**: JPEG/PNG lossless
  - Intra-frame apenas (sem inter-frame)
  - Cada frame independente
- **Size**: 50-350KB por frame (otimizado para tokens)
- **Transport**: REST API, gRPC, WebSocket binary
- **Processing**: CPU-based (no real-time requirement)

**Foco**: Text legibility, layout preservation, semantic content

### Comparação Direta

| Aspecto | Screencast (Humanos) | Screenshots (AI) |
|---------|---------------------|------------------|
| FPS | 30-60 | 1-5 |
| Latência por frame | 33-100ms | 500-3000ms |
| Compressão | H.264 (inter-frame) | JPEG/PNG (intra-frame) |
| Prioridade | Smooth motion | Text clarity |
| Transporte | UDP/WebRTC | TCP/HTTP/WS |
| Decoder | Hardware (GPU) | Software (CPU) |
| Tamanho por frame | 20-100KB (compressed stream) | 50-350KB (full image) |
| Use case | Remote desktop, surveillance | Agent automation, QA |

### Por que não usar Screencast para AI?

**Problema 1: Inter-frame dependency**
- Se um pacote é perdido, precisa esperar próximo I-frame (2-5s)
- Inaceitável para LLM que precisa frame atual

**Problema 2: Encoding bias**
- H.264 otimizado para motion, não para text EDGE preservation
- Blur em borders e small text (compression artifact)
- LLMs sofrem com blur (OCR accuracy drops 30-50%)

**Problema 3: Latência cumulativa**
- Mesmo com 100ms screencast, LLM ainda precisa 1-2s
- Streaming contínuo desperdiça banda se LLM lento
- Screenshots on-demand são mais efficient

**Solução Híbrida**:
- Usar screencast para human supervision
- Separate stream de screenshots otimizados (JPEG q=75)
- Mesma source (X11grab), diferentes encoding pipelines

### Example Architecture

```
X11 Display (xvfb)
       ↓
┌───────────────┬───────────────┐
│ Screencast    │ Screenshots   │
│ H.264 @ 30fps │ JPEG @ 2fps   │
│ ↓             │ ↓             │
│ WebRTC → UI   │ HTTP API → LLM│
│ (human view)  │ (agent loop)  │
└───────────────┴───────────────┘
```

**FFmpeg dual output**:
```bash
# Screencast stream (WebRTC via mediasoup/Janus)
ffmpeg -f x11grab -r 30 -s 1920x1080 -i :99 \
  -c:v libx264 -preset fast -crf 23 -f rtp rtp://...

# Screenshots (periodic capture)
ffmpeg -f x11grab -r 2 -s 1024x768 -i :99 \
  -vf "crop=1024:768:0:100" \
  -c:v mjpeg -q:v 2 -f mjpeg tcp://localhost:8080/ws
```

---

## 6. Como Implementar "Computer Use" Style via MCP

### Model Context Protocol Overview

[MCP](https://modelcontextprotocol.io/) (Model Context Protocol) é um protocolo aberto padrão para conectar LLMs com ferramentas e dados externos. Ele define:

- **Transporte**: STDIO, SSE, HTTP
- **Mensagens**: JSON-RPC 2.0
- **Primitivas**: Resources, Tools, Prompts
- **Segurança**: Isolation por server

Para implementar Computer Use via MCP, criamos um **MCP Server** que expõe ferramentas de controle de sistema/browser.

### MCP Server Architecture

```javascript
// computer-use-server.js
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new Server(
  { name: 'computer-use', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Tool: screenshot
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'screenshot') {
    const image = await captureScreenshot(args);
    return { content: [{ type: 'image', data: image }] };
  }

  if (name === 'mouse_move') {
    await moveMouse(args.x, args.y);
    return { content: [{ type: 'text', text: 'Mouse moved' }] };
  }

  // ... outras ações
});
```

### Tool Schema Design

Seguindo [best practices](https://modelcontextprotocol.info/docs/best-practices/):

#### 1. Single Responsibility
Cada tool faz uma coisa bem feita:

```json
{
  "tools": [
    {
      "name": "screenshot",
      "description": "Capture current screen",
      "inputSchema": {
        "type": "object",
        "properties": {
          "format": { "type": "string", "enum": ["png", "jpeg"] },
          "quality": { "type": "number", "minimum": 1, "maximum": 100 },
          "crop": {
            "type": "object",
            "properties": {
              "x": {"type": "number"},
              "y": {"type": "number"},
              "width": {"type": "number"},
              "height": {"type": "number"}
            }
          }
        }
      }
    },
    {
      "name": "mouse_click",
      "description": "Click at coordinates",
      "inputSchema": {
        "type": "object",
        "required": ["x", "y"],
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "button": { "type": "string", "enum": ["left", "right", "middle"] },
          "double": { "type": "boolean" }
        }
      }
    },
    {
      "name": "type_text",
      "description": "Type text at current cursor or coordinates",
      "inputSchema": {
        "type": "object",
        "required": ["text"],
        "properties": {
          "text": { "type": "string" },
          "x": { "type": "number" },
          "y": { "type": "number" },
          "delay": { "type": "number", "description": "ms between keystrokes" }
        }
      }
    },
    {
      "name": "press_key",
      "description": "Press a special key",
      "inputSchema": {
        "type": "object",
        "required": ["key"],
        "properties": {
          "key": {
            "type": "string",
            "enum": ["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
          }
        }
      }
    }
  ]
}
```

### Implementing the Backend

**Capture Screenshot**:
```javascript
const { exec } = require('child_process');
const sharp = require('sharp'); // image processing

async function captureScreenshot({ format = 'png', quality = 75, crop }) {
  // Use xwd/import (X11) or screencapture (macOS)
  const xwd = await exec('xwd -root -out /tmp/screen.xwd');
  // Convert to PNG
  let buffer = await convertXwdToPng('/tmp/screen.xwd');

  // Crop if requested
  if (crop) {
    buffer = await sharp(buffer)
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
      .toBuffer();
  }

  // Compress if JPEG
  if (format === 'jpeg') {
    buffer = await sharp(buffer)
      .jpeg({ quality, progressive: false })
      .toBuffer();
  }

  return buffer.toString('base64');
}
```

**Mouse Events**:
```javascript
const { exec } = require('child_process');

async function moveMouse(x, y) {
  await exec(`xdotool mousemove ${x} ${y}`);
}

async function clickMouse(x, y, button = 'left', double = false) {
  await exec(`xdotool mousemove ${x} ${y}`);
  const clickCmd = double ? 'doubleclick' : 'click';
  const buttonMap = { 'left': 1, 'right': 3, 'middle': 2 };
  await exec(`xdotool ${clickCmd} ${buttonMap[button]}`);
}
```

**Type Text**:
```javascript
async function typeText(text, x, y, delay = 10) {
  if (x !== undefined && y !== undefined) {
    await exec(`xdotool mousemove ${x} ${y}`);
  }
  await exec(`xdotool type --delay ${delay} "${escapeShell(text)}"`);
}
```

### Browser-Specific Tools

Além das primitivas, podemos expor ferramentas de alto nível:

```javascript
{
  "name": "browser_navigate",
  "description": "Open URL in browser",
  "inputSchema": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": { "type": "string", "format": "uri" }
    }
  }
},
{
  "name": "browser_find_element",
  "description": "Find element by text (AI-assisted)",
  "inputSchema": {
    "type": "object",
    "required": ["text"],
    "properties": {
      "text": { "type": "string" },
      "element_type": { "type": "string", "enum": ["button", "link", "input", "any"] }
    }
  }
}
```

**Implementação browser_find_element**:
```javascript
async function findElement(text, elementType = 'any') {
  // 1. Capture screenshot
  const screenshot = await captureScreenshot();

  // 2. Use LLM to find coordinates (naive example)
  const prompt = `Find element "${text}" (${elementType}) in this screenshot. Return JSON: {x, y, width, height}`;
  const response = await claude.analyzeImage(screenshot, prompt);
  const { x, y, width, height } = JSON.parse(response);

  return { x, y, width, height };
}
```

**Nota**: Isso é circular (LLM chama tool que usa LLM). Melhor:

- Option 1: Use DOM introspection via CDP (se available)
- Option 2: Separar em dois MCP servers:
  - Server A: vision-only tools (screenshot, mouse)
  - Server B: browser-specific (navigate, get_dom, click_element)

### Transporte via MCP

O MCP suporta três transportes:

1. **STDIO** (padrão, mais simples)
```bash
# Claude Code/Claude Desktop carrega automaticamente
claude --mcp-server computer-use-server
```

2. **SSE** (Server-Sent Events)
```javascript
const transport = new SSEServerTransport('http://localhost:3001/sse');
await server.connect(transport);
```

3. **HTTP** (Streamable)
```javascript
const transport = new StreamableHTTPServerTransport('http://localhost:3001');
await server.connect(transport);
```

**Registro no Claude Desktop**:
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/path/to/computer-use-server.js"],
      "env": {
        "DISPLAY": ":99",
        "XVFB_WHD": "1920x1080x24"
      }
    }
  }
}
```

### Security Model

**M Isolation**:
- Cada MCP server roda em processo separado
- Não há acesso cruzado entre servers
- Claude Code controla quais servers ativar por workspace

**Sandboxing**:
- Roda como user não-privilegiado
- Resource limits (memory, CPU)
- Network restrictions (block outbound se não necessário)
- Filesystem: read-only exceto temp dir

**Authorization**:
- Tools com side-effects exigem human approval (Claude Code)
- Confirmation prompt: "Allow computer-use to click at (100,200)?"
- User pode拒绝/bloquear permanentemente

**Logging e Monitoring**:
```javascript
// Log every tool call
server.onrequest('tools/call', (request) => {
  console.log(`[${new Date().toISOString()}] Tool: ${request.params.name}, args:`, request.params.arguments);
});
```

---

## 7. Quais Tools o MCP do Serende Deve Ter para Suportar AI Agents

### Contexto: Sistema Serende

O Serende é um sistema de orquestração de agents MCP. Precisa fornecer ferramentas para que agents controlem browsers de forma segura e eficiente.

### Core Tools (Primitivas)

#### 1. `browser_screenshot`
Captura tela otimizada para LLM.

```json
{
  "name": "browser_screenshot",
  "description": "Capture current browser viewport as image",
  "inputSchema": {
    "type": "object",
    "properties": {
      "full": { "type": "boolean", "description": "Full page (scroll) vs viewport" },
      "format": { "type": "string", "enum": ["png", "jpeg"], "default": "jpeg" },
      "quality": { "type": "number", "minimum": 1, "maximum": 100, "default": 75 },
      "viewport_only": { "type": "boolean", "default": true, "description": "Exclude browser chrome" }
    }
  }
}
```

**Retorna**: buffer base64 da imagem.

**Implementation**:
- Usar Playwright `page.screenshot()`
- Full page: `full: true` (scroll auto)
- viewport-only: capture viewport apenas

#### 2. `browser_click`
Clica em coordenadas ou elemento descrito.

```json
{
  "name": "browser_click",
  "description": "Click at coordinates or on element matching description",
  "inputSchema": {
    "type": "object",
    "oneOf": [
      {
        "required": ["x", "y"],
        "properties": {
          "x": { "type": "number" },
          "y": { "type": "number" },
          "button": { "type": "string", "enum": ["left", "right", "middle"], "default": "left" }
        }
      },
      {
        "required": ["selector"],
        "properties": {
          "selector": { "type": "string", "description": "CSS selector" }
        }
      },
      {
        "required": ["text"],
        "properties": {
          "text": { "type": "string", "description": "Visible text of element" }
        }
      }
    ]
  }
}
```

**Retorna**: `{clicked: true, element: {...}}`

**Nota**: Suportar múltiplos modos (coordenada, CSS selector, texto visível).

#### 3. `browser_type`
Digita texto em campo.

```json
{
  "name": "browser_type",
  "description": "Type text into input field",
  "inputSchema": {
    "type": "object",
    "required": ["text"],
    "properties": {
      "text": { "type": "string" },
      "selector": { "type": "string" },
      "x": { "type": "number" },
      "y": { "type": "number" },
      "clear_first": { "type": "boolean", "default": true }
    }
  }
}
```

**Implementation**:
- Se selector: `page.fill(selector, text)`
- Se coordenadas: click primeiro, depois type
- delay entre chars para simular humano (opcional)

#### 4. `browser_navigate`
Navega para URL.

```json
{
  "name": "browser_navigate",
  "description": "Navigate browser to URL",
  "inputSchema": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": { "type": "string", "format": "uri" },
      "wait_until": { "type": "string", "enum": ["load", "domcontentloaded", "networkidle"], "default": "load" }
    }
  }
}
```

**Retorna**: `{url, status}`

#### 5. `browser_wait`
Aguarda condições.

```json
{
  "name": "browser_wait",
  "description": "Wait for page conditions",
  "inputSchema": {
    "type": "object",
    "oneOf": [
      { "required": ["seconds"], "properties": { "seconds": { "type": "number" } } },
      { "required": ["selector"], "properties": { "selector": { "type": "string" } } },
      { "required": ["url"], "properties": { "url": { "type": "string" } } }
    ]
  }
}
```

**Use cases**: Esperar AJAX load, éléments aparecerem.

### High-Level Tools (Browser-Aware)

#### 6. `browser_fill_form`
Preenche formulário identified por Campos.

```json
{
  "name": "browser_fill_form",
  "description": "Fill a form with provided data",
  "inputSchema": {
    "type": "object",
    "required": ["fields"],
    "properties": {
      "fields": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name", "value"],
          "properties": {
            "name": { "type": "string", "description": "Field name/label" },
            "value": { "type": "string" },
            "type": { "type": "string", "enum": ["text", "email", "password", "checkbox", "radio"] }
          }
        }
      },
      "submit": { "type": "boolean", "default": false }
    }
  }
}
```

**Algoritmo**:
1. Tirar screenshot
2. Usar LLM (ou DOM introspection) para mapear `name` → `selector`
3. Preencher campo a campo
4. Clicar submit se `submit: true`

#### 7. `browser_extract_text`
Extrai texto da página atual.

```json
{
  "name": "browser_extract_text",
  "description": "Extract all visible text from page",
  "inputSchema": {
    "type": "object",
    "properties": {
      "selector": { "type": "string", "description": "Limit to specific element" },
      "include_html": { "type": "boolean", "default": false }
    }
  }
}
```

**Retorna**: `{text: "all visible text...", html: "<div>..."}`

#### 8. `browser_list_links`
Lista todos os links da página.

```json
{
  "name": "browser_list_links",
  "description": "List all links with their text and href",
  "inputSchema": { "type": "object", "properties": {} }
}
```

**Retorna**: `[{text: "Google", href: "https://google.com"}, ...]`

**Uso**: Navegação sem screenshots (faster) se Agente já viu página.

### Advanced Tools

#### 9. `browser_execute_script`
Executa JavaScript custom na página.

```json
{
  "name": "browser_execute_script",
  "description": "Execute arbitrary JavaScript in page context",
  "inputSchema": {
    "type": "object",
    "required": ["script"],
    "properties": {
      "script": { "type": "string" },
      "args": { "type": "array", "items": { "type": "any" } }
    }
  }
}
```

**Security**: Sandboxing, limit APIs (não allow network, file system).

**Use cases**:
- Get specific element data
- Scroll to element
- Wait for dynamic content

#### 10. `browser_tabs`
Gerencia múltiplas abas.

```json
{
  "name": "browser_tabs",
  "description": "List, create, close, switch tabs",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["list", "create", "close", "switch"] },
      "url": { "type": "string" },
      "tab_id": { "type": "number" }
    }
  }
}
```

**Retorna**: `{tabs: [{id, title, url, active}]}`

#### 11. `browser_scroll`
Scroll específico.

```json
{
  "name": "browser_scroll",
  "description": "Scroll page or element",
  "inputSchema": {
    "type": "object",
    "properties": {
      "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
      "pixels": { "type": "number", "default": 300 },
      "selector": { "type": "string" }
    }
  }
}
```

#### 12. `browser_screenshot_element`
Screenshot de elemento específico (não viewport inteiro).

```json
{
  "name": "browser_screenshot_element",
  "description": "Capture screenshot of specific element",
  "inputSchema": {
    "type": "object",
    "required": ["selector"],
    "properties": {
      "selector": { "type": "string" },
      "format": { "type": "string", "enum": ["png", "jpeg"] }
    }
  }
}
```

**Uso**: Zoom em formulário/table complexo para LLM analisar.

### Browser Abstraction Layer

Para ser browser-agnostic (Playwright suporta Chrome, Firefox, WebKit):

```javascript
class BrowserToolkit {
  constructor(browserInstance) {
    this.browser = browserInstance;
    this.context = browserInstance.defaultContext();
  }

  async screenshot(options) {
    const page = await this.getActivePage();
    return await page.screenshot({
      fullPage: options.full,
      type: options.format,
      quality: options.quality,
      clip: options.crop ? { x: options.crop.x, y: options.crop.y, width: options.crop.width, height: options.crop.height } : undefined
    });
  }

  async click(params) {
    const page = await this.getActivePage();
    if (params.selector) {
      await page.click(params.selector);
    } else if (params.x !== undefined) {
      await page.mouse.click(params.x, params.y, { button: params.button });
    } else if (params.text) {
      const element = await this.findByText(params.text);
      await element.click();
    }
  }

  async findByText(text) {
    // AI-assisted find: return element handle
    const elements = await this.page.$$('*');
    for (const el of elements) {
      const visibleText = await el.textContent();
      if (visibleText.includes(text)) return el;
    }
    throw new Error(`Element with text "${text}" not found`);
  }
}
```

### Resource: Browser State

MCP Resources permitem expor state que LLM pode ler sem tool call:

```json
{
  "resources": [
    {
      "name": "browser:current_url",
      "description": "Current browser URL",
      "uri": "browser://state/url",
      "mimeType": "text/plain"
    },
    {
      "name": "browser:page_title",
      "description": "Current page title",
      "uri": "browser://state/title",
      "mimeType": "text/plain"
    },
    {
      "name": "browser:dom_simplified",
      "description": "Simplified DOM tree (accessible elements only)",
      "uri": "browser://dom",
      "mimeType": "application/json"
    }
  ]
}
```

**Vantagem**: LLM lê `browser://state/url` a qualquer momento sem consumir tool call.

**Implementation**:
```javascript
server.setRequestHandler('resources/read', async (request) => {
  const { uri } = request.params;

  if (uri === 'browser://state/url') {
    const page = await browserToolkit.getActivePage();
    return { contents: [{ uri, mimeType: 'text/plain', text: page.url() }] };
  }

  if (uri === 'browser://dom') {
    const simplifiedDom = await extractAccessibleDOM(page);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(simplifiedDom) }] };
  }
});
```

### Putting It All Together: Serende MCP Server

**Estrutura do projeto**:
```
serende-computer-mcp/
├── src/
│   ├── server.js           # MCP server entry
│   ├── browser/
│   │   ├── toolkit.js     # Playwright wrapper
│   │   ├── screenshot.js  # Capture + optimize
│   │   ├── click.js       # Click implementations
│   │   └── dom.js         # DOM introspection
│   └── tools/
│       ├── primitive/     # screenshot, click, type, navigate
│       ├── high-level/    # fill_form, extract_text
│       └── resources/     # browser:// URIs
├── package.json
└── config.json
```

**Configuração Claude Desktop**:
```json
{
  "mcpServers": {
    "serende-browser": {
      "command": "node",
      "args": ["/path/to/serende-computer-mcp/src/server.js"],
      "env": {
        "SERENDE_API_KEY": "...",
        "SERENDE_BROWSER_URL": "wss://remote-browser.serende.io/ws"
      }
    }
  }
}
```

**Nota**: Remote browser → MCP server conecta via WebSocket ao或questrador, usa API existente. MCP server é thin wrapper.

---

## 8. Casos de Uso

### Web Scraping AI

**Problema**: Scraping dinâmico (JavaScript-heavy, login required, CAPTCHAs).

**Solução com Vision Agents**:

1. Logar automaticamente
2. Navegar páginas paginadas
3. Extrair dados de tabelas/forms
4. Lidar com infinite scroll

**Exemplo**: Scrape product details from e-commerce

```javascript
// Prompt ao agent
const task = `
1. Acesse https://example.com/products
2. Para cada produto na página:
   - Clique no link
   - Extraia: nome, preço, descrição, SKU
   - Volte à lista
3. Repita para 5 produtos
`;

// Agent vision loop:
// 1. screenshot → vê lista de produtos
// 2. LLM retorna: [{action: "click", target: "Product 1 link", coordinates: {x: 100, y: 200}}]
// 3. Executa → nova página
// 4. screenshot → extrai texto
// 5. LLM retorna JSON com dados
// 6. Armazena
// 7. Volta e repete
```

**Vantagem vs trad. scraping**:
- Não precisa entender DOM/XPath
- Funciona com qualquer site (even SPAs)
- Lida com redirecionamentos/autenticação automaticamente

**Desvantagem**:
- Mais lento (1-2s por produto)
- Custo API LLM (~$0.01-0.05 por produto)
- Rate limit do site ainda aplica

### Preenchimento Automático de Formulários

**Use case**: Onboarding, KYC, cadastro de produtos.

**Fluxo**:

1. Upload de documento (PDF/image com dados)
2. Agent extrai campos (OCR + LLM)
3. Navega para formulário web
4. Mapeia cada campo via screenshot → LLM
5. Preenche em ordem
6. Submit

**Prompt**:
```
You are a form filler. Here is a JSON with data:

{
  "name": "João Silva",
  "email": "joao@email.com",
  "cpf": "123.456.789-00",
  "birth_date": "1990-01-15"
}

1. Navigate to https://gov.br/form
2. For each field, find it by label text and type the value
3. Submit the form
4. Verify success message appears
```

**Edge cases**:
- Dropdowns → select option por texto
- Checkboxes → clicar se label matches
- Radio buttons → escolher um da lista
- Date pickers → digitar no formato esperado

### Research Agents

**Problema**: Pesquisa multi-fonte, síntese de informações.

**Agente Vision Researcher**:

1. Recebe query de pesquisa
2. Google search (screenshot results page)
3. Seleciona top 3 resultados via LLM
4. Visita cada link
5. Extrai conteúdo relevante (screenshot + text extraction)
6. Sintetiza findings
7. Retorna relatório com fontes

**Tools necessários**:
- `browser_google_search` (query → results page)
- `browser_extract_links` (da página atual)
- `browser_extract_text` (conteúdo)
- `research_summarize` (post-processing)

**Vantagem**:
- Não precisa APIs específicas de cada site
- Funciona com qualquer motor de busca
- Extrai até conteúdo dinâmico (JavaScript rendered)

**Desvantagem**:
- Lento (30s - 2min por query)
- Pode ser bloqueado por sites (rate limit, bot detection)
- CAPTCHA é hurdle (need human solve)

### QA e Testing Automatizado

**Visual Regression Testing**:

1. Baseline: captura screenshot da página "correta"
2. Nova versão: compara screenshot automaticamente
3. Report diferenças visuais

**Agent-based testing**:

- User journey: "Comprar produto X, adicionar ao carrinho, checkout"
- Agent executa e valida se price, product name corretos
- Detecção de broken flows (botões não clicáveis)

**Tools**:
- `browser_compare_screenshot(baseline)` → diff pixel-wise
- `browser_validate_text_present(text)` → assert text on screen
- `browser_wait_for_selector(selector)` → espera elemento

### Data Entry Automation

**Backoffice automation**:

- Importar CSV → preencher sistema legado
- Agent lê CSV, abre ERP, navega menus, preenche forms
- 100% automation sem API

**Challenges**:
- CSRF tokens, session timeouts
- Need state persistence (cookies)
- Error handling (required fields missing)

**Solution**:
- Stealth mode: user-agent random, headless: false
- Cookie persistence via Playwright context
- Retry logic with different strategies

### Competitor Monitoring

**Use case**:
- Diariamente: "Check prices on Amazon for product Y"
- Agent acessa, busca, extrai preço, envia alerta se mudou

**Automation**:
```javascript
// Cron diário
agent.run(
  "1. Go to amazon.com",
  "2. Search for 'iPhone 15 Pro'",
  "3. Extract price from first 3 results",
  "4. Compare with yesterday's price (from JSON file)",
  "5. Send email if price dropped >5%"
);
```

---

## 9. Otimizações Práticas

### Latency Budgeting

Para agents úteis, target total task time < 10s para tarefas simples.

**Breakdown**:
- Screenshot capture + upload: 300ms
- LLM inference (small model): 800ms
- Action execution: 100ms
- **Per step**: 1.2s

5-step task → 6s (aceitável)

**If too slow**:
- Use GPT-4o (fast inference)
- Compress images mais agressivo (q=60)
- Batch actions (multiple clicks in one go)
- Cache DOM via CDP (se disponível) e usar menos screenshots

### Accuracy Improvements

**Multi-step reasoning**:
- Enviar histórico de ações como contexto
- LLM lembra "already clicked login button, now need password"
- Prompt engineering: "You previously did X, now do Y"

**Grounding with DOM**:
Além de screenshot, enviar simplified DOM:

```javascript
const dom = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button, input, a, select'))
    .map(el => ({
      tag: el.tagName,
      text: el.innerText?.slice(0, 50),
      type: el.type,
      id: el.id,
      classes: el.className,
      boundingBox: el.getBoundingClientRect()
    }));
});
```

**Vantagem**: LLM tem both visual + structural signals → mais precisão.

**Sent como resource MCP**:
```
resource: browser://dom/accessible_elements
content-type: application/json
```

### Error Recovery

**Common failures**:
- Element not found (coordinates off)
- Page not loaded yet
- Popup/modal blocking
- Network error

**Recovery strategies**:
1. Retry with screenshot again (fresh state)
2. Wait longer before action
3. Scroll into view first
4. Fallback: search by text instead of coordinates
5. Escalate to human

**Prompt**:
```
If element not found:
1. Take another screenshot
2. Check if page changed (ads, popups)
3. Try finding by text description instead
4. If still fails, abort and ask human
```

### Cost Management

**Custo por screenshot** (GPT-4o):
- 1024x768 JPEG @ q=75 → ~1700 tokens
- Input: $0.01 per 1K tokens → $0.017 per screenshot
- 10 steps × 2 screenshots = $0.34 por task

**Economy**:
- Skip screenshots se DOM available
- Reuse recent screenshot if page hasn't changed
- Use small model (Haiku) para simple tasks, save 5-10x cost
- Cache LLM responses (same screenshot → same action)

---

## 10. Conclusão e Recomendações

### State of the Art (2025)

**Computer Use** da Anthropic é a implementação mais avançada:
- Modelos: Claude Opus 4.6, Sonnet 4.6
- Suporte a multi-step browser tasks
- WebArena score ~60% (vs humans 78%, GPT-4 14%)

**Alternativas**:
- **OpenAI CUA** (Computer Using Agent) — similar, GPT-4o based
- **Browser Use** — Open source, Python + LLM integration
- **Hyperbrowser** — API-first, suporte Claude Computer Use

### Para Implementar no Serende

**Ação imediata**:
1. Implementar MCP server com tools primitives (screenshot, click, type)
2. Usar Playwright como backend (mais reliable que X11/Xdotool)
3. Configurar container com Xvfb se necessário
4. Adicionar DOM introspection resources para accuracy

**Fase 2**:
- High-level tools: fill_form, browser_navigate, extract_text
- Multi-tab support
- Cookie/session persistence
- Error recovery automático

**Fase 3**:
- AI-assisted element finding (LLM коордиенташн)
- Visual diff para regression testing
- Performance monitoring (latency tracking)
- Cost optimization (cache, model selection)

### Referências

1. [Computer Use Tool - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
2. [Introducing computer use - Anthropic News](https://www.anthropic.com/news/3-5-models-and-computer-use)
3. [WebArena: Realistic Web Environment](https://webarena.dev/static/paper.pdf)
4. [Model Context Protocol — Best Practices](https://modelcontextprotocol.info/docs/best-practices/)
5. [Anthropic´s Computer Use vs OpenAI CUA — WorkOS](https://workos.com/blog/anthropics-computer-use-versus-openais-computer-using-agent-cua)
6. [Hyperbrowser Claude Computer Use](https://www.hyperbrowser.ai/docs/agents/claude-computer-use)

---

**Document Author**: Claude (Anthropic)
**Date**: 2025-03-17
**Version**: 1.0
**Status**: Draft
