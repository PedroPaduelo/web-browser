# ANÁLISE COMPLETA DO PROJETO SERENDE
**Data:** 2026-03-17
**Status atual:** QUEBRADO (WebRTC bloqueando MJPEG por 5-9s)
**Objetivo:** Remote browser controlável por IA (MCP), baixa latência, profile persistente

---

## 1. OBJETIVO REAL DO PROJETO

O Serende é um **Remote Browser as a Service** (tipo Browserbase/BrowserStack mas self-hosted):
- Usuário acessa um Chrome via browser (interface web)
- A IA (via MCP) controla esse mesmo Chrome
- O profile do usuário persiste entre sessões (login salvo)
- Latência deve ser baixa o suficiente para uso real (~100ms aceitável, <50ms ideal)

---

## 2. O QUE EXISTE HOJE (estado atual)

### Stack atual:
```
[Xvfb virtual display]
    ↓
[Chrome --remote-debugging-port=CDP]
    ↓ (dois processos ffmpeg no mesmo display)
[ffmpeg x11grab → MJPEG → stdout → WebSocket → Canvas no browser]
[ffmpeg x11grab → rawvideo yuv420p → @roamhq/wrtc RTCVideoSource → WebRTC]
```

### Problemas identificados:
1. **WebRTC NAT fail**: Servidor atrás de NAT (10.11.7.190), ICE só encontra host candidates privados. Browser público não consegue chegar. SEM TURN = nunca funciona.
2. **Loading 5s**: Frontend tenta WebRTC (leva 4s ICE + 1s timeout = 5-9s de tela branca)
3. **Dois ffmpeg por sessão**: Dobra CPU/memória desnecessariamente
4. **MCP existe mas está separado**: `server/mcp/index.js` já existe como processo separado
5. **Profile persiste**: já implementado via `tenantManager.mergeProfileFromSession()`

---

## 3. ANÁLISE DAS OPÇÕES DE STREAMING (pesquisa)

### Opção A: MJPEG via WebSocket (atual)
- **Latência real:** 100-300ms (TCP + JPEG encode + decode)
- **Funciona sem TURN:** ✅ SIM (WebSocket simples)
- **CPU:** Moderada (ffmpeg MJPEG)
- **Implementado hoje:** ✅ SIM — e estava funcionando antes do WebRTC quebrar tudo
- **Veredicto:** Funciona, aceitável para uso real, é o que estava rodando

### Opção B: WebRTC com @roamhq/wrtc (tentativa atual)
- **Latência:** 20-50ms (ideal)
- **Funciona sem TURN:** ❌ NÃO — servidor atrás de NAT, ICE falha sempre
- **Precisa de TURN server:** SIM (coturn)
- **CPU:** Alta (2 ffmpeg por sessão)
- **Veredicto:** Não funciona neste ambiente sem TURN. Ideia certa, implementação incompleta.

### Opção C: CDP Page.screencastFrames (melhor trade-off!)
- **Como funciona:** Chrome envia frames JPEG via CDP WebSocket nativo, sem ffmpeg
- **Latência:** 80-150ms (melhor que MJPEG via x11grab)
- **CPU:** MUITO menor (Chrome já renderiza, só comprime para JPEG)
- **Funciona sem TURN:** ✅ SIM (WebSocket simples)
- **Sem ffmpeg:** ✅ Menos processos por sessão
- **API:** `Page.startScreencast({ format: 'jpeg', quality: 80 })`
- **Como Puppeteer usa:** `cdp.on('Page.screencastFrame', handler)`
- **Veredicto:** MELHOR OPÇÃO para o curto prazo. Elimina ffmpeg, menos CPU, latência melhor

### Opção D: WebRTC com TURN server (solução definitiva de latência)
- **Latência:** 20-50ms
- **Requer:** coturn rodando em IP público acessível
- **Complexidade:** Alta (coturn + config)
- **Veredicto:** Solução definitiva de latência mas requer infraestrutura adicional

### Opção E: mediasoup SFU
- **Descrição:** SFU Node.js profissional, usado por empresas sérias
- **Vantagem:** Escala, baixíssima latência, sem TURN em muitos casos (injeta mídia direto no SFU)
- **Complexidade:** Alta (worker threads, transports, producers/consumers)
- **Veredicto:** Melhor solução profissional de longo prazo, mas complexa de implementar

---

## 4. O QUE MERCADO ESTÁ USANDO (benchmarks reais)

| Produto | Protocolo | Latência típica |
|---------|-----------|-----------------|
| Browserbase | CDP via WebSocket | ~100-200ms |
| BrowserStack | RFB (VNC-like) + WebSocket | ~100-300ms |
| Google Chrome Remote Desktop | WebRTC + TURN | ~50-100ms |
| AnyDesk | DeskRT codec proprietário | ~50ms |
| noVNC | RFB/VNC via WebSocket | ~100-200ms |

**Conclusão:** 100-200ms via WebSocket/CDP é o padrão da indústria. WebRTC é melhor mas precisa de TURN.

---

## 5. ANÁLISE DO MCP ATUAL

O MCP já existe em `server/mcp/index.js` — é um servidor Express com StreamableHTTP usando `@modelcontextprotocol/sdk`.

### O que já tem:
- Autenticação via X-API-Key
- Gestão de sessões (auto-cria sessão Chrome se não existir)
- Tools: `browser_navigate`, `browser_screenshot`, `browser_get_url`, `browser_evaluate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `browser_get_page_info`, `browser_back`, `browser_forward`, `browser_refresh`, `browser_manage_session`

### Problemas do MCP atual:
- Roda como processo **separado** na porta 4202 — funciona mas precisa estar no pm2
- Depende da API do Serende via HTTP local (`SERENDE_API=http://localhost:4201`)
- Verifica se o processo está rodando e funcional

---

## 6. ANÁLISE DO PROFILE/SESSÃO

Sistema de profile já implementado:
- `tenantManager.copyProfileToSession()` — copia profile salvo para nova sessão
- `tenantManager.mergeProfileFromSession()` — salva de volta ao encerrar
- Chrome usa `--user-data-dir` apontando para diretório do tenant
- **Problema**: não salva em timeout — só em parada manual

---

## 7. DIAGNÓSTICO DO PROBLEMA ATUAL (por que "quebrou")

### Sequência de eventos:
1. WebRTC foi implementado no frontend como **camada principal** (não fallback)
2. Frontend faz `POST /api/webrtc/:sessionId/offer` que leva 4s (ICE gathering no servidor)
3. Durante esses 4s, o loading overlay cobre TUDO
4. Após 5s de timeout no frontend, `rtcState` vai para `'failed'`
5. Só aí o canvas MJPEG aparece
6. Total: 5-9 segundos de tela preta antes de ver qualquer coisa

### Fix imediato já feito (mas não buildado/deployado):
- Removido `useWebRTC` de `BrowserViewer.tsx`
- Canvas MJPEG volta como elemento principal, sem loading overlay

---

## 8. PLANO RECOMENDADO (em fases)

### FASE 1 — Restaurar funcionamento IMEDIATO (hoje)
1. Fazer build do frontend (com WebRTC removido da UI)
2. Reiniciar pm2 do serende-backend
3. Validar que o app abre imediatamente sem loading
4. Verificar que o MCP server está rodando

### FASE 2 — Migrar streaming para CDP screencast (semana 1)
**Por que?** Elimina ffmpeg completamente, menor CPU, latência melhor que MJPEG atual
```javascript
// No session-manager.js, em vez de spawnar ffmpeg:
const { startScreencast } = require('./cdp-screencast');
startScreencast(cdpPort, ws); // Chrome já envia frames via CDP
```
- Implementar `cdp-screencast.js` que conecta via CDP e faz `Page.startScreencast`
- Modificar `stream-manager.js` para receber frames do CDP em vez de ffmpeg stdout
- Remover spawn do ffmpeg do `session-manager.js`

### FASE 3 — WebRTC com TURN server (semana 2)
**Por que?** Latência real de 50ms em vez de 100-200ms
- Subir coturn no EasyPanel ou usar serviço TURN gratuito para testes
- Configurar ICE servers com TURN credentials
- Reabilitar WebRTC no frontend mas só como UPGRADE depois que MJPEG já está visível

### FASE 4 — MCP melhorias (semana 1-2)
- Garantir que `server/mcp/` está no pm2 como `serende-mcp`
- Adicionar tool `browser_screenshot_url` que retorna URL de imagem em vez de base64
- Adicionar tool `browser_wait_for_element` com CSS selector
- Documentar como usar o MCP no Claude/Cursor

---

## 9. QUICK WINS IMEDIATOS

### 9a. CDP Screencast (substitui ffmpeg)
```javascript
// Conectar via CDP WebSocket
const ws = new WebSocket(cdpWsUrl);

// Habilitar Page domain
ws.send({ method: 'Page.enable' });

// Iniciar screencast
ws.send({ method: 'Page.startScreencast', params: {
  format: 'jpeg',
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1  // cada frame
}});

// Receber frames
ws.on('Page.screencastFrame', ({ data, sessionId }) => {
  const frameBuffer = Buffer.from(data, 'base64');
  // Confirmar recebimento (obrigatório!)
  ws.send({ method: 'Page.screencastFrameAck', params: { sessionId } });
  // Fazer broadcast para clientes WebSocket
  broadcastFrame(frameBuffer);
});
```

**Vantagens sobre ffmpeg x11grab:**
- Sem processo extra por sessão
- Chrome já renderiza — só manda JPEG
- Menor CPU total
- Latência melhor (sem pipe intermediário)
- Captura só quando há mudança na tela (eficiente)

---

## 10. DECISÃO FINAL RECOMENDADA

### Streaming: CDP Screencast > WebRTC (por agora)
WebRTC sem TURN não funciona neste ambiente. CDP Screencast funciona agora, sem ffmpeg, com latência aceitável.

### Input: CDP Input.dispatch (atual) ✅ já correto
Não mexer. Já funciona via `cdp-input-handler.js`.

### MCP: Garantir que está rodando ✅
Já existe, só precisa estar no pm2.

### Profile: Já funciona ✅
Já implementado, só validar que está salvando em timeout também.

---

## 11. REFERÊNCIAS TÉCNICAS COLETADAS

- **CDP screencastFrame**: https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame
- **Playwright MCP**: https://github.com/microsoft/playwright-mcp
- **Browserbase MCP**: https://github.com/browserbase/mcp-server-browserbase
- **mediasoup**: https://mediasoup.org/
- **coturn TURN server**: https://github.com/coturn/coturn
- **@roamhq/wrtc vs node-webrtc**: @roamhq/wrtc é o fork ativo (M98), usar para futura impl WebRTC
- **WebRTC NAT**: Sem TURN server, connections `host` type não chegam em IP público
- **Latência real do mercado**: 50-200ms é o padrão — WebRTC resolve para <100ms

---

## 12. ARQUIVOS A MODIFICAR (ordem de prioridade)

### Prioridade MÁXIMA (fix imediato):
1. Build + restart PM2 → app volta a funcionar

### Prioridade ALTA (semana 1):
2. `server/cdp-screencast.js` — novo módulo CDP screencast
3. `server/session-manager.js` — remover ffmpeg spawn, usar CDP screencast
4. `server/stream-manager.js` — adaptar para receber frames de CDP em vez de ffmpeg stdout
5. `server/index.js` — remover webrtcSession, usar novo fluxo

### Prioridade MÉDIA (semana 2):
6. TURN server config + WebRTC reativado como upgrade
7. MCP tools adicionais

---

**AÇÃO IMEDIATA:** Build frontend + restart pm2 + validar que app abre SEM loading overlay.
