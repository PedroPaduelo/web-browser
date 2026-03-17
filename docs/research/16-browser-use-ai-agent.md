# Browser-Use e Stagehand: AI Agents para Controle de Browser

**Data:** 2026-03-17
**Fontes:** GitHub, documentacao oficial, InfoWorld, DeepWiki, NxCode, APIdog

---

## 1. O que e browser-use

[browser-use](https://github.com/browser-use/browser-use) e uma biblioteca Python open-source que conecta agentes de IA diretamente a navegadores web. Criado por Magnus Muller e Gregor Zunic, o projeto acumulou mais de 60.000 stars no GitHub em poucos meses — um dos projetos open-source de crescimento mais rapido em 2025. A equipe captou mais de USD 17 milhoes em seed funding.

A premissa central: dar ao LLM controle total sobre o browser como se fosse um humano — sem precisar escrever seletores CSS ou XPath frageis.

**Repositorio:** https://github.com/browser-use/browser-use
**Licenca:** MIT
**Linguagem:** Python (>=3.11)
**Instalacao:**
```bash
pip install browser-use
playwright install chromium
```

---

## 2. Como Funciona: Arquitetura e Loop do Agente

### 2.1 Visao Geral

O browser-use usa **Playwright** internamente para controlar um browser Chromium via WebSocket (Chrome DevTools Protocol — CDP). Sobre esse substrato, implementa um loop de agente:

```
Tarefa do usuario
      |
      v
 [OBSERVE] Captura estado atual: DOM processado, screenshot, URL, titulo
      |
      v
 [DECIDE]  Envia estado + tarefa ao LLM -> LLM decide proxima acao
      |
      v
 [ACT]     Executa acao via Playwright (clicar, digitar, navegar...)
      |
      v
 [EVALUATE] Re-captura o estado atualizado, avalia se tarefa concluida
      |
      +----> repete ate task_complete ou max_steps
```

### 2.2 Processamento do DOM

HTML bruto e grande demais para ser enviado ao LLM inteiro. O browser-use processa o DOM antes:

- Remove tags nao essenciais (scripts, styles, elementos ocultos)
- Atribui **indices numericos** a cada elemento interativo (botoes, inputs, links, selects)
- Gera uma representacao compacta que o LLM pode raciocinar eficientemente

Exemplo do que o LLM recebe sobre elementos interativos:
```
[0] BUTTON: "Sign In"
[1] INPUT text: placeholder="Email"
[2] INPUT password: placeholder="Password"
[3] LINK: "Forgot password?"
```

O LLM entao decide: `{"action": "click_element", "index": 0}` ou `{"action": "input_text", "index": 1, "text": "user@example.com"}`.

### 2.3 Sistema de Visao (Screenshots)

O browser-use tem um modo **hibrido DOM + Vision**:

- **DOM puro**: parseia o HTML para estrutura semantica
- **Vision**: captura screenshots como imagens base64 e as envia ao LLM multimodal

O parametro `use_vision` controla o modo:
- `"auto"` (padrao): inclui a ferramenta de screenshot mas so usa visao quando solicitado
- `True`: sempre inclui screenshots
- `False`: nunca usa screenshots (mais barato, mais rapido)

O `vision_detail_level` controla a qualidade: `'low'`, `'high'`, ou `'auto'`.

> **Nota importante:** A visao complementa o DOM, nao substitui. O DOM cobre a maioria dos casos; screenshots ajudam quando elementos sao definidos visualmente (ex: botoes sem ID claro, canvas interativos, PDF viewers).

### 2.4 Como Decide Onde Clicar

1. O LLM recebe o estado atual: DOM indexado + (opcionalmente) screenshot + historico de acoes anteriores
2. O LLM analisa a tarefa e o estado da pagina
3. Emite um JSON estruturado com a acao e os parametros
4. O browser-use mapeia o JSON para chamadas Playwright: ex. `Input.dispatchMouseEvent` com coordenadas X,Y calculadas
5. Apos a acao, o ciclo recomeca com o novo estado da pagina

Exemplo de chain de acoes:
```json
[
  {"go_to_url": {"url": "https://example.com/login"}},
  {"input_text": {"index": 1, "text": "x_user"}},
  {"input_text": {"index": 2, "text": "x_pass"}},
  {"click_element": {"index": 0}}
]
```

---

## 3. LLMs Suportados

O browser-use e model-agnostic, suportando qualquer LLM via sua propria camada de abststracao (nao depende de LangChain). Provedores suportados:

| Provedor | Classe | Modelo exemplo |
|---|---|---|
| Browser Use (proprio) | `ChatBrowserUse` | `bu-latest`, `bu-2-0` |
| Anthropic | `ChatAnthropic` | `claude-sonnet-4-0` |
| OpenAI / Azure | `ChatOpenAI`, `ChatAzureOpenAI` | `gpt-4o`, `gpt-5.1-codex-mini` |
| Google | `ChatGoogle` | `gemini-flash-latest` |
| AWS Bedrock | `ChatAWSBedrock` | `anthropic.claude-3-5-sonnet...` |
| Local (Ollama) | via OpenAI-compatible | LLaMA, Qwen, DeepSeek |
| Groq | `ChatGroq` | llama-3.x |
| Outros | xAI, Novita, Vercel AI Gateway | ... |

Exemplos de configuracao:

```python
# Claude
from browser_use import Agent, ChatAnthropic
llm = ChatAnthropic(model="claude-sonnet-4-0")

# GPT-4o
from browser_use import Agent, ChatOpenAI
llm = ChatOpenAI(model="gpt-4o")

# Modelo proprio (3-5x mais rapido, $10 de credito gratuito)
from browser_use import Agent, ChatBrowserUse
llm = ChatBrowserUse(model="bu-latest")

# Ollama local
from browser_use import Agent
from browser_use.llm import ChatOllama
llm = ChatOllama(model="llama3.2")
```

O modelo `ChatBrowserUse` proprio da empresa e otimizado para tarefas de browser e alega ser 3-5x mais rapido que outros modelos com precisao equivalente.

---

## 4. Acoes Disponiveis

O agente tem um conjunto rico de acoes:

### Navegacao
- `go_to_url(url)` — navegar para URL
- `go_back()` — voltar no historico
- `scroll(direction, amount)` — rolar pagina
- `switch_tab(index)` — alternar entre abas
- `open_tab()`, `close_tab()` — gerenciar abas

### Interacao com Elementos
- `click_element(index)` — clicar elemento pelo indice
- `input_text(index, text)` — digitar texto em campo
- `select_option(index, option)` — selecionar dropdown
- `hover_element(index)` — hover sobre elemento
- `double_click(index)` — duplo clique
- `right_click(index)` — clique direito

### Extracao
- `extract_content(goal)` — extrair dados em linguagem natural
- `get_text(index)` — obter texto de elemento
- `get_html()` — obter HTML completo

### Controle
- `wait_for_element(selector)` — aguardar elemento
- `execute_javascript(code)` — executar JS arbitrario
- `done(text)` — marcar tarefa como completa

---

## 5. Formularios e Autenticacao

### 5.1 Preenchimento de Formularios

O agente navega autonomamente ao formulario, identifica os campos pelo DOM indexado, e os preenche em sequencia. Para campos sem label clara, o modo vision complementa a identificacao.

### 5.2 Dados Sensiveis (Credenciais)

O browser-use tem um mecanismo para proteger credenciais: o parametro `sensitive_data`. O LLM nunca ve os valores reais — apenas placeholders como `x_user` e `x_pass`.

```python
agent = Agent(
    task='Log into example.com with username x_user and password x_pass',
    sensitive_data={
        'x_user': 'usuario@email.com',
        'x_pass': 'senha-real-aqui'
    },
    use_vision=False,  # desabilitar para o LLM nao ver credenciais em screenshot
    llm=ChatOpenAI(model='gpt-4.1-mini'),
)
```

Tambem suporta escopo por dominio via regex:
```python
sensitive_data = {
    'https://*.staging.example.com': {'x_user': '...', 'x_pass': '...'},
    'https://example.com': {'x_user': '...', 'x_pass': '...'},
}
```

### 5.3 Two-Factor Authentication (2FA)

Suporte via custom actions:

```python
from browser_use import Controller

controller = Controller()

@controller.action("Get 2FA code from authenticator app")
async def get_2fa_code():
    # implementacao customizada (ex: TOTP)
    return {"result": totp.now()}

agent = Agent(
    task="Login e use get_2fa_code quando pedir codigo 2FA",
    llm=llm,
    controller=controller,
)
```

### 5.4 Browser Profiles

Para reutilizar sessoes autenticadas existentes:
```python
from browser_use import BrowserConfig

config = BrowserConfig(user_data_dir="/path/to/chrome/profile")
browser = Browser(config=config)
```

### 5.5 Issues Conhecidos com Forms

- Alguns modelos menores (ex: `gpt-4o-mini`) inserem o placeholder em vez do valor real
- Campos com label ambigua ou apenas visual exigem `use_vision=True`
- Captchas: a versao cloud tem suporte nativo; self-hosted precisa de solucao externa

---

## 6. Deploy e Cloud

### 6.1 Self-Hosted (Open Source)

Totalmente gratuito — voce prove o browser e as API keys do LLM. Ideal para desenvolvimento e producao sem dependencia de servico externo.

### 6.2 Browser Use Cloud

Servico gerenciado lancado em 2025:
- Preco: $0.01 por task (spin-up) + custo por step (depende do LLM)
- Anti-detect, resolucao de CAPTCHA, proxies em 195+ paises
- API REST: `POST https://api.browser-use.com/api/v1/run-task`
- SDK: `pip install browser-use-sdk` ou `npm install browser-use-sdk`

### 6.3 Acoes Customizadas

```python
from browser_use import Tools

tools = Tools()

@tools.action(description='Buscar em banco de dados interno')
def lookup_customer(customer_id: str) -> dict:
    return db.get(customer_id)

agent = Agent(task="...", llm=llm, tools=tools)
```

---

## 7. Benchmark

O browser-use atingiu **89.1% no WebVoyager** — benchmark padrao para agentes de browser. Isso e significativamente acima da baseline humana e de outros agentes comparaveis.

---

## 8. Stagehand (stagehand.dev)

[Stagehand](https://www.stagehand.dev/) e um framework alternativo de automacao de browser com IA, criado pela **Browserbase, Inc.** e open-source (MIT). Diferente do browser-use (Python), Stagehand e primariamente **TypeScript/JavaScript**, com ports emergindo para outras linguagens (Python, Go, Java, Ruby, Rust) no v3.

**Repositorio:** https://github.com/browserbase/stagehand
**Documentacao:** https://docs.stagehand.dev

### 8.1 Filosofia: Melhor dos Dois Mundos

O problema que Stagehand resolve: automacao tradicional (Playwright/Puppeteer/Selenium) e precisa mas fragil. Agentes autonomos completos sao poderosos mas impredeviveis em producao.

A aposta do Stagehand: **voce decide quando usar codigo vs. linguagem natural**. Use AI para navegar paginas desconhecidas; use codigo quando sabe exatamente o que quer.

### 8.2 Primitivas Core

#### `act(instruction)` — Acao Natural Language
```typescript
await stagehand.act("click the sign in button");
await stagehand.act("fill in the email field with test@example.com");
```

Internamente: Stagehand analisa a Accessibility Tree do Chrome, identifica o elemento correto, e executa a acao via Playwright. Se o elemento mudar (ex: "Login" virar "Sign In"), ainda funciona.

#### `extract(instruction, schema)` — Extracao Estruturada com Zod
```typescript
import { z } from "zod";

const result = await stagehand.extract(
  "extract product details",
  z.object({
    name: z.string(),
    price: z.number(),
    inStock: z.boolean()
  })
);
// result: { name: "Teclado Mecanico", price: 299.90, inStock: true }

// Arrays funcionam igual:
const products = await stagehand.extract(
  "extract all products",
  z.array(z.object({
    title: z.string(),
    price: z.string(),
  }))
);
```

#### `observe()` — Preview + Caching
```typescript
const actions = await stagehand.observe("find the search input");
// Retorna: [{ selector: "#search", description: "search input field", method: "fill", arguments: [] }]

// Reusar o resultado em act() — sem nova chamada ao LLM:
await stagehand.act(actions[0]);
```

#### `agent(goal)` — Autonomo Multi-Step
```typescript
const agent = stagehand.agent();
await agent.execute("Go to the latest PR on the stagehand repo and get me the author");
```

Suporta Computer Use Agents (CUA) especializados de OpenAI, Anthropic, Google, Microsoft.

### 8.3 Arquitetura Tecnica

#### Accessibility Tree (em vez de DOM bruto)

A inovacao mais significativa do Stagehand v2+: em vez de parsear o HTML, usa a **Accessibility Tree do Chrome** via Playwright.

Vantagens:
- Reduz volume de dados em **80-90%** comparado ao DOM bruto
- Representacao semantica: apenas elementos interativos e significativos
- Melhor para LLMs: dados ja estruturados semanticamente
- Mais resiliente a mudancas de CSS/layout

#### Multi-Model Routing

Diferentes LLMs para diferentes tarefas:
- Claude: raciocinio de alto nivel e planejamento
- GPT-4o: execucao de acoes especificas no browser
- Gemini: observacao (custo-beneficio superior)

#### Observe-Act Caching

O padrao `observe()` -> `act()` permite:
1. Validar o que o AI vai fazer antes de executar
2. Cachear acoes validadas para replay deterministico
3. Zero custo de LLM nas execucoes subsequentes (usa cache)
4. Auto-healing: se a pagina mudar, detecta e re-executa o LLM apenas quando necessario

### 8.4 Stagehand v3 Highlights

- **44.11% mais rapido** em iframes e shadow-root
- Reescrito do zero com CDP direto (sem Playwright obrigatorio — suporta Puppeteer tambem)
- Self-healing nativo: adapta-se a mudancas de DOM em tempo real
- Context builder otimizado: alimenta o LLM apenas com o essencial
- Portavel: funciona em Bun, CI/CD, serverless

### 8.5 Instalacao e Uso

```bash
npm install @browserbasehq/stagehand zod
npx playwright install  # para rodar local
```

```typescript
import { Stagehand } from "@stagehand/core";

// Self-hosted (local):
const stagehand = new Stagehand({
  env: "LOCAL",
  modelName: "gpt-4.1",
  modelClientOptions: { apiKey: process.env.OPENAI_API_KEY }
});

// Com Browserbase (cloud gerenciado):
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
});

await stagehand.init();
const page = stagehand.page; // Playwright page normal
await page.goto("https://example.com");
await stagehand.act("click the login button");
```

### 8.6 Stagehand vs. Browser-Use

| Aspecto | Stagehand | browser-use |
|---|---|---|
| Linguagem primaria | TypeScript / JavaScript | Python |
| Abordagem | Primitivas atomicas + agent opcional | Loop de agente autonomo |
| Fonte de contexto | Accessibility Tree (80-90% menor) | DOM processado + screenshot |
| Caching | Observe-Act cache nativo | Nao tem por padrao |
| Controle do dev | Alto (voce escolhe AI vs. codigo) | Medio (agente decide) |
| Melhor para | Workflows hibridos, extracao estruturada | Tarefas multi-step autonomas |
| Self-heal | Automatico (v3) | Parcial (hybrid DOM+vision) |
| GitHub Stars | 10.000+ | 60.000+ |
| Plataforma cloud | Browserbase | Browser Use Cloud |

---

## 9. Comparacao com Playwright MCP

### 9.1 O que e Playwright MCP

Lançado pela Microsoft em marco de 2025, o Playwright MCP e um servidor Model Context Protocol que expoe o Playwright para LLMs como Claude ou GitHub Copilot.

Opera em dois modos:
- **Snapshot Mode** (padrao): usa a Accessibility Tree do browser para representacao textual — sem processamento visual
- **Vision Mode**: fallback com screenshots quando a Accessibility Tree nao e suficiente

### 9.2 Comparacao Direta

| Dimensao | Playwright MCP | browser-use | Stagehand |
|---|---|---|---|
| Paradigma | Ferramenta para LLM | Agente autonomo | SDK hibrido |
| Entrada para o LLM | Accessibility Tree (texto) | DOM indexado + screenshot | Accessibility Tree otimizada |
| Tokens por acao | Alto (26+ ferramentas, arvore completa) | Medio (DOM + vision) | Baixo (filtrado, cacheado) |
| Velocidade | < 2 segundos | 15-30 segundos (tarefas complexas) | 5-10 segundos |
| Resiliencia a mudancas | Baixa (depende de selectors) | Alta (LLM re-raciocina) | Alta (self-healing) |
| Controle programatico | Total | Baixo (agente decide) | Alto (primitivas atomicas) |
| Ideal para | Testing deterministico, CI/CD | Automacao autonoma multi-step | Workflows hibridos |
| Custo de tokens | Alto | Medio | Baixo |
| LLMs suportados | Claude, Copilot | Multi-provider | Multi-provider |

### 9.3 O Problema do Playwright MCP com Tokens

Uma critica central ao Playwright MCP: expoe 26+ ferramentas e despeja a arvore de acessibilidade completa a cada acao. Em paginas complexas, isso sao milhares de nos por clique.

Alternativas emergiram:
- `@playwright/cli`: modo CLI reduz consumo de tokens em ~4x (salva snapshots em disco em vez de enviar ao LLM)
- `agent-browser` (Vercel): usa "Snapshot + Refs" (`@e1`, `@e2` em vez de arvores completas) — alega 93% menos contexto que Playwright MCP

### 9.4 Quando Usar Cada Um

**Use Playwright MCP quando:**
- Voce ja tem scripts Playwright e quer adicionar IA pontualmente
- Fluxos deterministicos em ambiente controlado (CI/CD, testes E2E)
- Integracao direta com Claude via MCP sem codigo Python/JS adicional
- Velocidade e prioridade (#1 em velocidade)

**Use browser-use quando:**
- Precisa de um agente verdadeiramente autonomo que tome decisoes
- Tarefas complexas que requerem raciocinio sobre multiplas paginas
- Voce quer escolher livremente entre GPT-4o, Claude, Gemini, LLaMA
- Pesquisa web autonoma, preenchimento de formularios complexos, scraping adaptativo

**Use Stagehand quando:**
- Stack e TypeScript/JavaScript
- Quer controle granular (primitivas atomicas vs. agente completo)
- Extracao de dados estruturados e core (extract + Zod e excepcional)
- Quer caching deterministo com fallback inteligente de AI
- Automacao em producao onde confiabilidade importa mais que velocidade de desenvolvimento

---

## 10. Implicacoes para o Projeto remote-browser

O projeto remote-browser atual usa WebRTC para streaming de video do browser remoto ao cliente. A abordagem e diferente de browser-use/Stagehand:

| Aspecto | remote-browser (atual) | browser-use / Stagehand |
|---|---|---|
| Objetivo | Streaming visual do browser para humano | Controle autonomo por IA |
| Protocolo | WebRTC (video) + CDP (input) | Playwright/CDP direto |
| Quem controla | Usuario humano via mouse/teclado remoto | LLM via loop de agente |
| Latencia alvo | < 50ms (interativo) | Segundos por acao (ok para IA) |
| Screenshots | Video continuo H.264 | Snapshot por acao |
| Uso de LLM | Nenhum no fluxo principal | Central |

**Possivel integracao:** O remote-browser poderia expor uma API que browser-use ou Stagehand conectem como "browser backend", permitindo:
1. Agentes de IA executarem tarefas de forma autonoma no browser remoto
2. Humano poder observar / intervir via stream de video
3. Combinacao "AI faz a tarefa, humano monitora" com possibilidade de override

Isso se alinharia com a tendencia de "supervised AI automation" — onde o agente e autonomo mas o humano pode retomar o controle a qualquer momento.

---

## 11. Resumo Executivo

| Framework | Linguagem | Abordagem | Stars | Melhor Caso |
|---|---|---|---|---|
| **browser-use** | Python | Agente autonomo, DOM+vision, loop LLM | 60k+ | Automacao web multi-step, scraping adaptativo |
| **Stagehand** | TypeScript | Primitivas atomicas + agent opcional, Accessibility Tree | 10k+ | Extracao estruturada, workflows hibridos prod |
| **Playwright MCP** | Qualquer (via MCP) | Ferramenta MCP deterministica | N/A | Testing, CI/CD, rapido e deterministico |

Os tres convergem em uma direcao: **browser automation que sobrevive a mudancas de UI** — usando IA para localizar elementos semanticamente em vez de XPath/CSS fragil.

A tendencia de 2025-2026 aponta para browsers "AI-native" onde o LLM e um cidadao de primeira classe: ve o browser, decide acoes, e opera com minima fricao entre raciocinio e execucao.

---

## Fontes

- [GitHub browser-use/browser-use](https://github.com/browser-use/browser-use)
- [Browser Use Documentation](https://docs.browser-use.com)
- [InfoWorld: Browser Use open-source AI agent](https://www.infoworld.com/article/3812644/browser-use-an-open-source-ai-agent-to-automate-web-based-tasks.html)
- [DeepWiki: Vision Capabilities](https://deepwiki.com/browser-use/browser-use/6.4-vision-capabilities)
- [LabellerR: Browser-Use Open-Source AI Agent](https://www.labellerr.com/blog/browser-use-agent/)
- [Sensitive Data docs - Browser Use](https://docs.browser-use.com/examples/templates/sensitive-data)
- [GitHub browser-use/agent-sdk](https://github.com/browser-use/agent-sdk)
- [Stagehand - stagehand.dev](https://www.stagehand.dev/)
- [GitHub browserbase/stagehand](https://github.com/browserbase/stagehand)
- [Stagehand v3 blog post](https://www.browserbase.com/blog/stagehand-v3)
- [Stagehand extract docs](https://docs.stagehand.dev/v3/basics/extract)
- [Stagehand act docs](https://docs.stagehand.dev/v3/basics/act)
- [Stagehand agent docs](https://docs.stagehand.dev/v3/basics/agent)
- [NxCode: Stagehand vs Browser Use vs Playwright 2026](https://www.nxcode.io/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026)
- [Playwright MCP Medium Guide](https://medium.com/@bluudit/playwright-mcp-comprehensive-guide-to-ai-powered-browser-automation-in-2025-712c9fd6cffa)
- [APIdog: Browser Use Cloud](https://apidog.com/blog/browser-use-cloud/)
- [Fireworks AI: Building open-source Browser Agent](https://fireworks.ai/blog/opensource-browser-agent)
- [Speakeasy: Playwright proliferation problem](https://www.speakeasy.com/blog/playwright-tool-proliferation)
- [Medium: AI automation frameworks comparison](https://medium.com/@chriswhp04/how-can-ai-use-your-browser-a-deep-dive-into-automation-frameworks-da3447196087)
- [Stagehand Cloudflare Docs](https://developers.cloudflare.com/browser-rendering/stagehand/)
