import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import crypto from 'node:crypto';

// Auth: o MCP NÃO carrega server/.env de propósito.
// A chave de API tem um lugar só de verdade: o server/.env, lido pelo backend
// (:4201), que valida a chave do cliente e guarda o hash no key store. O proxy
// não precisa da chave no ambiente — e carregá-la aqui colocaria AUTH_API_KEY,
// JWT_SECRET e ADMIN_SECRET no processo do proxy, que é justamente o que a
// rota /mcp NÃO pode fazer: aceitar requisição sem X-API-Key do cliente.
// O cliente manda a própria chave no header X-API-Key (obrigatório, ver
// requireApiKey); o MCP só a repassa ao backend, que decide se é válida.
// O ambiente do MCP serve para porte/URL: MCP_PORT, SERENDE_API e
// SESSION_VALIDATION_TTL_MS (ver run-mcp.sh).

const SERENDE_API = process.env.SERENDE_API || 'http://localhost:4201';
const SERENDE_PUBLIC_URL = process.env.SERENDE_PUBLIC_URL || 'https://serende.ddw1sl.easypanel.host';
const MCP_PORT = parseInt(process.env.MCP_PORT) || 4202;

// --- State ---
// tokenCache é global (cache de autenticação, seguro compartilhar)
// sessionCache é por-instância (movido para dentro de createServer)
const tokenCache = new Map();      // tenantId → { token, expiresAt }

// AsyncLocalStorage to track which tenant is making the current request
import { AsyncLocalStorage } from 'node:async_hooks';
const tenantContext = new AsyncLocalStorage();

function getCurrentApiKey() {
  const ctx = tenantContext.getStore();
  if (!ctx?.apiKey) throw new Error('X-API-Key header required');
  return ctx.apiKey;
}

function getCurrentTenantId() {
  const ctx = tenantContext.getStore();
  if (!ctx?.tenantId) throw new Error('X-API-Key header required');
  return ctx.tenantId;
}

// --- Auth ---

function deriveTenantId(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

async function authenticate(apiKey) {
  if (!apiKey) throw new Error('X-API-Key header required');
  const res = await fetch(`${SERENDE_API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Auth failed (${res.status}): ${err.error || 'unknown'}`);
  }
  const data = await res.json();
  const tenantId = data.tenantId || data.userId;
  tokenCache.set(tenantId, { token: data.token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 });
  return data.token;
}

async function ensureAuth(apiKey) {
  if (!apiKey) throw new Error('X-API-Key header required');
  const tenantId = deriveTenantId(apiKey);
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  return authenticate(apiKey);
}

// --- Capturas de tela servidas por URL assinada ---
//
// Cliente MCP que descarta o bloco `image` do resultado da tool não tem como
// ver a tela. A alternativa é a imagem virar um RECURSO com URL: o MCP guarda
// os bytes da captura em memória e entrega uma URL assinada, com prazo, no
// mesmo host público que o agente já usa. O agente baixa com curl/fetch, sem
// header nenhum (a credencial está na URL) — e o arquivo é exatamente o que a
// tool descreveu, então o sha256 do texto confere com o do download.
//
// A assinatura usa um segredo ALEATÓRIO por processo: as URLs morrem junto
// com o processo, como as capturas. É o padrão de URL pré-assinada: quem tem
// a URL vê a imagem até o prazo; fora do prazo, 410.
const CAPTURE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const CAPTURE_MAX = 60;                // capturas guardadas ao mesmo tempo
const captureSecret = crypto.randomBytes(32);
const captureStore = new Map(); // captureId → { buf, mime, expiresAt, tenantId, sessionId }

function captureToken(captureId, expiresAt) {
  return crypto.createHmac('sha256', captureSecret).update(`${captureId}.${expiresAt}`).digest('hex');
}

function storeCapture(buf, mime, tenantId, sessionId) {
  const now = Date.now();
  for (const [id, c] of captureStore) if (c.expiresAt <= now) captureStore.delete(id);
  while (captureStore.size >= CAPTURE_MAX) {
    const oldest = captureStore.keys().next().value;
    captureStore.delete(oldest);
  }
  const captureId = crypto.randomBytes(16).toString('hex');
  const expiresAt = now + CAPTURE_TTL_MS;
  captureStore.set(captureId, { buf, mime, expiresAt, tenantId, sessionId });
  return { captureId, expiresAt };
}

// Host público do MCP, para montar a URL da captura. Vem da requisição que o
// agente fez (Host / x-forwarded-*): é o host que o agente JÁ alcança, sem
// configuração e sem adivinhar a porta do backend.
function publicBaseOf(req) {
  const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = fwdHost || req.headers.host;
  if (!host) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol || 'https';
  return `${proto}://${host}`;
}

function getPublicBase() {
  const ctx = tenantContext.getStore();
  if (ctx?.publicBase) return ctx.publicBase;
  return SERENDE_PUBLIC_URL || null;
}

function captureUrl(captureId, expiresAt) {
  const base = getPublicBase();
  if (!base) return null;
  const token = captureToken(captureId, expiresAt);
  return `${base}/mcp/screenshot/${captureId}?token=${token}&exp=${expiresAt}`;
}

// --- API helper (uses tenant context) ---

async function api(method, path, body) {
  const apiKey = getCurrentApiKey();
  const token = await ensureAuth(apiKey);
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  let res = await fetch(`${SERENDE_API}${path}`, opts);

  if (res.status === 401) {
    const newToken = await authenticate(apiKey);
    opts.headers['Authorization'] = `Bearer ${newToken}`;
    res = await fetch(`${SERENDE_API}${path}`, opts);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('image/')) {
    const buf = await res.arrayBuffer();
    return { _image: Buffer.from(buf).toString('base64'), _mime: ct };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`API ${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}`);
    err.status = res.status; // p/ erros de rede (TypeError) fica undefined
    throw err;
  }
  return data;
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

// Envelope de erro padronizado das tools.
//
//   - isError:true → quem decide por isError passa a tratar "não achei" e
//     "timeout" como FALHA. Antes esses casos saíam como isError:false e o
//     agente seguia como se a operação tivesse dado certo.
//   - texto em JSON → o mesmo contrato do caminho de sucesso: quem faz
//     JSON.parse(data) não quebra quando a chamada falha.
function toolError(message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
    isError: true,
  };
}

// Exceção lançada pelo script dentro da página (ex.: seletor CSS inválido).
class PageScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageScriptError';
  }
}

// --- Reusable JS snippets for React-compatible input simulation ---

const REACT_SET_VALUE_JS = `
function reactSetValue(el, value) {
  el.focus();
  // Try execCommand first — works with RHF, Formik, controlled components
  // But setSelectionRange throws on email/number/date inputs, so wrap in try
  let execOk = false;
  try {
    // Select all existing text (only works on text/search/url/tel/password)
    el.setSelectionRange(0, el.value.length);
    execOk = document.execCommand('insertText', false, value);
  } catch(e) {
    // setSelectionRange failed (email/number/date) — try selectAll + insertText
    try {
      document.execCommand('selectAll', false, null);
      execOk = document.execCommand('insertText', false, value);
    } catch(e2) { execOk = false; }
  }
  if (execOk && el.value === value) return;
  // Fallback: nativeSetter + synthetic events
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const tracker = el._valueTracker;
  if (tracker) tracker.setValue(el.value || '');
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

const REACT_CHECKBOX_JS = `
function reactToggleCheckbox(el, checked) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
  const tracker = el._valueTracker;
  if (tracker) tracker.setValue(String(!checked));
  if (nativeSetter) nativeSetter.call(el, checked);
  else el.checked = checked;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

// Sessions cache (fallback, mas tentamos buscar do backend)
//
// N sessões por tenant. Antes era Map<tenantId, sessionId> — 1 chave ⇒ 1 tenant
// ⇒ 1 sessão. Dois sub-agentes com a MESMA chave batiam no mesmo Map e
// compartilhavam a MESMA sessão de browser: um session_stop derrubava a de
// todos, e a navegação de um aparecia para o outro no get_url (testado:
// sub-agente 2 pedia https://www.iana.org/ e o get_url devolvia
// https://example.com/ — a página do sub-agente 1).
//
// O contrato do MCP é 1 sessão corrente por tenant: as ~45 tools chamam
// requireSession() e esperam UM sessionId. Então o estado passa a ser
//
//   Map<tenantId, { sessions: Map<sessionId, meta>, current: sessionId }>
//
// e `current` é a sessão que essas tools usam. As tools de sessão
// (session_start/status/stop, list_sessions, session_use) operam o mapa
// inteiro; o resto continua lendo só a corrente.
//
// POR QUE UM OBJETO POR TENANT (e não Map<tenantId, sessionId[]> + um
// Map<tenantId, current> solto): sessão e corrente precisam ser UMA estrutura
// atômica. Separados, session_stop(id) ou session_use(id) deixavam o `current`
// apontando para uma sessão que já saiu do mapa, e requireSession() passava a
// devolver um id morto — que é justamente o bug que se está corrigindo, em
// outra forma. Agrupando, toda mutação (criar / remover / trocar a corrente)
// passa pelo mesmo objeto e o invariante "current ∈ sessions" é mantido num
// lugar só (ver forgetSession).
//
// Global de propósito (como era antes): sobrevive entre requisições HTTP, e o
// isolamento continua sendo por tenantId — o mesmo hash que o backend usa
// (server/auth.js deriveTenantId), então dois tenants NUNCA se encontram aqui.
const sessionCache = new Map(); // tenantId → { sessions: Map<sessionId, meta>, current: sessionId }
const SESSION_META_MAX = 50;    // teto de sessões lembradas por tenant (o backend limita por maxSessions)

// Timestamp da última validação de sessão bem-sucedida POR (tenant, sessão).
// Sem isso, CADA tool call gastava uma requisição extra só para conferir se a
// sessão ainda existia — ou seja, metade do rate limit do tenant era consumida
// por verificação. A janela é curta (3s): cobre uma sequência de tool calls
// (navigate → wait → read) sem aceitar sessão morta por muito tempo.
//
// A chave passou a ser composta: com N sessões por tenant, validar só por
// tenant dizia "a sessão X foi validida agora" quando na verdade tinha sido a
// Y — e a corrente podia estar morta sem ninguém perceber.
const sessionValidatedAt = new Map(); // `${tenantId}:${sessionId}` → timestamp
const SESSION_VALIDATION_TTL_MS = parseInt(process.env.SESSION_VALIDATION_TTL_MS) || 3000;

function sessionValidatedKey(tenantId, sessionId) {
  return `${tenantId}:${sessionId}`;
}

function markSessionValidated(tenantId, sessionId) {
  sessionValidatedAt.set(sessionValidatedKey(tenantId, sessionId), Date.now());
}

function wasSessionValidated(tenantId, sessionId) {
  const at = sessionValidatedAt.get(sessionValidatedKey(tenantId, sessionId)) || 0;
  return Date.now() - at < SESSION_VALIDATION_TTL_MS;
}

// Pega (ou cria) o registro do tenant.
function tenantRecord(tenantId) {
  let rec = sessionCache.get(tenantId);
  if (!rec) {
    rec = { sessions: new Map(), current: null };
    sessionCache.set(tenantId, rec);
  }
  return rec;
}

// Registra uma sessão como existente e a torna a corrente. `current: true` é
// o caso comum (session_start, e a recuperação automática do requireSession);
// session_use passa false para eleger uma sessão JÁ conhecida.
function rememberSession(tenantId, sessionId, meta, { current = true } = {}) {
  const rec = tenantRecord(tenantId);
  rec.sessions.set(sessionId, meta);
  if (current) rec.current = sessionId;
  // Tetomano do registro: com sessões criadas e paradas em sequência o Map só
  // cresceria. Fica o mais recente; a corrente NUNCA é despejada.
  if (rec.sessions.size > SESSION_META_MAX) {
    for (const sid of rec.sessions.keys()) {
      if (rec.sessions.size <= SESSION_META_MAX) break;
      if (sid === rec.current) continue;
      rec.sessions.delete(sid);
    }
  }
  return rec;
}

// Esquece uma sessão e mantém o invariante current ∈ sessions: se a que saiu
// era a corrente, outra é eleita (a mais recente entre as que sobraram).
// Sem isso, requireSession() devolveria um sessionId que não existe mais.
function forgetSession(tenantId, sessionId) {
  const rec = sessionCache.get(tenantId);
  if (!rec) return;
  rec.sessions.delete(sessionId);
  sessionValidatedAt.delete(sessionValidatedKey(tenantId, sessionId));
  if (rec.current === sessionId) {
    let next = null;
    let newest = -1;
    for (const [sid, meta] of rec.sessions) {
      const at = meta && meta.at || 0;
      if (at > newest) { newest = at; next = sid; }
    }
    rec.current = next;
  }
  // Tenant sem nenhuma sessão não ocupa lugar no Map.
  if (rec.sessions.size === 0) sessionCache.delete(tenantId);
}

// Move a corrente para uma sessão que DEVE existir no registro. Devolve
// { ok: true } ou { ok: false, reason } — usar quando o chamador precisa
// distinguir "não existe" (404) de "é de outro tenant" (403).
function selectSession(tenantId, sessionId) {
  const rec = sessionCache.get(tenantId);
  if (!rec || !sessionId) return { ok: false, reason: 'not_found' };
  if (!rec.sessions.has(sessionId)) return { ok: false, reason: 'not_found' };
  rec.current = sessionId;
  return { ok: true };
}

// Sessão corrente do tenant (ou null). Usado por requireSession e pelo health.
function currentSession(tenantId) {
  const rec = sessionCache.get(tenantId);
  if (!rec || !rec.current) return null;
  return rec.sessions.has(rec.current) ? rec.current : null;
}

// --- Corrente POR CONEXÃO MCP (o pedido central da task) ---
//
// A corrente só por tenant NÃO basta: o sessionCache é global ao PROCESSO do
// MCP, então dois sub-agentes com a MESMA chave — cada um na sua conexão MCP,
// que é o caso de uso — dividiriam a mesma `current`. Resultado medido no
// baseline: agente 1 criava A, agente 2 chamava session_start e era empurrado
// para A (status:'already_active'); quando o agente 2 navegava, mexia na página
// do agente 1. É o cruzamento que o teste 4 cobra.
//
// A corrente passa a ser POR CONEXÃO: connKey = `${tenantId}:${mcpSessionId}`.
// Cada sub-agente tem a sua conexão, portanto a sua corrente, e as tools de
// automação (que chamam requireSession) operam a sessão da conexão que chamou.
//   → conexão A cria/usa sua sessão, conexão B cria/usa a sua; nenhuma das
//     duas escreve na corrente da outra.
//
// O que continua global por tenant é o REGISTRO de sessões (sessions) — é o
// que list_sessions varre, e é o que permite session_use eleger uma sessão
// criada por outra conexão do mesmo tenant.
const connCurrent = new Map(); // connKey → sessionId

function connKeyOf(tenantId, mcpSessionId) {
  return `${tenantId}:${mcpSessionId || 'no-session'}`;
}

function getCurrentConnId() {
  const ctx = tenantContext.getStore();
  if (!ctx) return null;
  const tenantId = ctx.tenantId || 'unknown';
  return connKeyOf(tenantId, ctx.connId);
}

// Corrente efetiva de quem chamou: a da conexão, e na falta dela a do tenant
// (compatível com cliente que não reenvia o mcp-session-id).
function effectiveCurrent(tenantId) {
  const ck = getCurrentConnId();
  if (ck) {
    const sid = connCurrent.get(ck);
    if (sid) {
      const rec = sessionCache.get(tenantId);
      if (rec && rec.sessions.has(sid)) return sid;
      connCurrent.delete(ck); // apontava para sessão que saiu do registro
    }
    // SEM entrada para esta conexão: NÃO cair no fallback do tenant quando a
    // conexão está identificada. Era esse fallback que fazia dois sub-agentes
    // dividirem a mesma sessão — a conexão B via a corrente que a conexão A
    // tinha gravado no registro do tenant. Conexão identificada e sem corrente
    // própria = ainda sem sessão: ela chama session_start e ganha a sua.
    // Só o cliente SEM mcp-session-id (ck === null) usa a corrente do tenant.
    return null;
  }
  return currentSession(tenantId);
}

function setCurrentSession(tenantId, sessionId) {
  rememberSession(tenantId, sessionId, { at: Date.now() });
  const ck = getCurrentConnId();
  if (ck) connCurrent.set(ck, sessionId);
}

// Esquece a sessão e limpa a corrente de TODA conexão que apontava para ela —
// senão uma conexão continuaria operando um browser que outra acabou de parar.
function forgetSessionEverywhere(tenantId, sessionId) {
  forgetSession(tenantId, sessionId);
  const prefix = `${tenantId}:`;
  for (const [ck, sid] of connCurrent) {
    if (sid === sessionId && ck.startsWith(prefix)) connCurrent.delete(ck);
  }
}

// Erros TRANSITÓRIOS não invalidam a sessão: 429 (rate limit), 5xx e falha de
// rede são momentâneos. Só 404 (sessão morta) e 401 (token inválido) significam
// que o cache está obsoleto.
function isSessionGone(err) {
  return err && (err.status === 404 || err.status === 401);
}

function createServer() {
  // Para cada conexão MCP, tentamos usar o cache global primeiro
  //
  // Devolve a sessão CORRENTE do tenant. As ~45 tools de automação chamam isto
  // e seguem operando exatamente uma sessão — a que a última session_start ou
  // session_use elegeu. Um sub-agente que precisa operar uma sessão específica
  // (para dois agentes não se cruzarem) usa session_use nela antes de chamar
  // as outras tools.
  async function requireSession() {
    const sid = await resolveSession();
    // A sessão RESOLVIDA (mesmo sem id explícito) fica no contexto, para a
    // resposta ecoar em qual sessão a operação rodou. Sem isso, no caminho
    // legado o agente não tem como saber.
    const ctx = tenantContext.getStore();
    if (ctx) ctx.resolvedSessionId = sid;
    return sid;
  }

  async function resolveSession() {
    const tenantId = getCurrentTenantId();
    const ctx = tenantContext.getStore();
    const explicit = ctx && ctx.sessionId ? String(ctx.sessionId) : null;

    // 1) ID EXPLÍCITO — opera exatamente essa sessão.
    //
    // A posse é validada pelo próprio backend: ele escopa as sessões pela
    // chave da API, então um id de outro tenant responde 404 aqui. Não existe
    // como um agente operar a sessão de outro: ou é dele, ou é erro.
    if (explicit) {
      if (wasSessionValidated(tenantId, explicit)) return explicit;
      try {
        await api('GET', `/api/session/${explicit}`);
        markSessionValidated(tenantId, explicit);
        rememberSession(tenantId, explicit, { at: Date.now() });
        return explicit;
      } catch (e) {
        // Transiente (429/5xx/rede): a sessão continua viva — não descarta o
        // cache, senão um rate limit cascateia em "cria outra sessão".
        if (!isSessionGone(e)) throw e;
        forgetSessionEverywhere(tenantId, explicit);
        throw new Error(
          `session_not_found: a sessão ${explicit} não existe ou não pertence a esta chave.`
        );
      }
    }

    // 2) SEM ID — só é unívoco se houver UMA sessão viva.
    //
    // Com duas ou mais, escolher uma no escuro é exatamente o cruzamento que
    // o QA mediu. Fail-closed: o agente precisa dizer qual sessão é dele.
    const known = knownSessions(tenantId);
    if (known.length >= 2) {
      // Pode ter morrido no meio: confirma no backend antes de recusar.
      const live = await liveSessionsOfTenant();
      if (live.length >= 2) throw ambiguousSessionError(live);
      if (live.length === 1) {
        // live[] são os OBJETOS de sessão do backend: o id é o campo sessionId.
        // Devolver o objeto inteiro fazia a URL virar "/api/cookies/[object
        // Object]" — o cookie nunca era gravado e o teste via 404.
        const unica = live[0].sessionId || live[0];
        setCurrentSession(tenantId, unica);
        markSessionValidated(tenantId, unica);
        return unica;
      }
    }

    // Corrente desta CONEXÃO (a do tenant só como fallback p/ cliente sem
    // mcp-session-id). É aqui que a isolação acontece: cada sub-agente lê a
    // própria corrente, nunca a do outro.
    let sessionId = effectiveCurrent(tenantId);
    // Se tem no cache, verifica se ainda é válida no backend
    if (sessionId) {
      // Validação recente: confia no cache e economiza 1 request por tool call.
      if (wasSessionValidated(tenantId, sessionId)) {
        return sessionId;
      }
      try {
        await api('GET', `/api/session/${sessionId}`);
        markSessionValidated(tenantId, sessionId);
        return sessionId;
      } catch (e) {
        // Erro transitório (429/5xx/rede): a sessão continua viva. Apagar o
        // cache aqui é o que transformava um rate limit em "No active session",
        // fazendo o cliente chamar session_start e agravar o rate limit.
        if (!isSessionGone(e)) throw e;
        forgetSessionEverywhere(tenantId, sessionId);
        sessionId = null;
      }
    }
    // Busca sessão ativa do backend
    try {
      const data = await api('GET', '/api/session');
      const sessions = (data.sessions || []);
      if (sessions.length === 1) {
        sessionId = sessions[0].sessionId;
        setCurrentSession(tenantId, sessionId);
        markSessionValidated(tenantId, sessionId);
        return sessionId;
      }
      if (sessions.length > 1) {
        // 2+ sessões vivas e o chamador não disse qual é a dele: recusa.
        throw ambiguousSessionError(sessions);
      }
    } catch (e) {
      // A ambiguidade é um erro de SEMÂNTICA, não de transporte: propaga.
      if (e && String(e.message || '').startsWith('ambiguous_session')) throw e;
      // idem: transiente propaga o erro real, não "no active session"
      if (!isSessionGone(e)) throw e;
    }
    throw new Error('No active session for this tenant. Use session_start first.');
  }

  // Erro de ambiguidade: o chamador precisa escolher a sessão.
  function ambiguousSessionError(sessions) {
    const ids = sessions.map(s => (s && s.sessionId) || s).join(', ');
    return new Error(
      `ambiguous_session: esta chave tem ${sessions.length} sessões abertas (${ids}). ` +
      `Passe sessionId na chamada para escolher uma — sem isso a operação seria executada ` +
      `na sessão errada (foi o que o QA mediu com 4 agentes em paralelo).`
    );
  }

  // Sessões que este MCP conhece deste tenant.
  function knownSessions(tenantId) {
    const rec = sessionCache.get(tenantId);
    if (!rec) return [];
    return [...rec.sessions.keys()];
  }

  // Sessões vivas no backend, do ponto de vista desta chave.
  async function liveSessionsOfTenant() {
    try {
      const data = await api('GET', '/api/session');
      return (data && data.sessions) || [];
    } catch (e) {
      if (!isSessionGone(e)) throw e;
      return [];
    }
  }


  // Avalia um script na página e distingue "a página lançou exceção" de "o
  // script devolveu vazio".
  //
  // O /api/evaluate devolve só {result: value}: quando o script lança (ex.:
  // querySelector com seletor CSS inválido → SyntaxError) o valor some e o
  // MCP passa a dizer "0 elementos encontrados" (falso sucesso) ou devolve
  // texto indefinido (dump de schema do SDK). O try/catch roda NO BROWSER,
  // então o erro volta como dado.
  async function evalPage(sid, script) {
    const wrapped = `(async () => { try { return { __ok: true, value: await (${script}) }; } catch (e) { return { __ok: false, error: (e && e.message) ? String(e.message) : String(e) }; } })()`;
    const data = await api('POST', `/api/evaluate/${sid}`, { script: wrapped });
    const r = data.result;
    if (r && r.__ok === false) throw new PageScriptError(r.error);
    return r ? r.value : undefined;
  }

  // ----- Digitação que diz a verdade -----
  // Campo que aceita texto: input de texto, textarea ou contenteditable, sem
  // readonly/disabled. Foco no <body> não recebe nada: antes, o type_text
  // respondia "Typed" mesmo assim.
  const FOCUS_PROBE_JS = `(() => {
    const el = document.activeElement;
    const body = !el || el === document.body || el === document.documentElement;
    let editable = false;
    if (!body) {
      if (el.isContentEditable) editable = true;
      else if (el.tagName === 'TEXTAREA') editable = !el.readOnly && !el.disabled;
      else if (el.tagName === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        editable = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t) && !el.readOnly && !el.disabled;
      }
    }
    return {
      editable,
      active: body ? 'BODY' : el.tagName + (el.id ? '#' + el.id : ''),
      value: body ? null : (el.isContentEditable ? el.innerText : el.value),
    };
  })()`;

  // Cola o texto no campo com foco. Espera o React reconciliar: um valor que
  // volta sozinho depois da mudança não conta como digitado.
  function pasteScript(text, clearFirst) {
    return `(async () => {
      ${REACT_SET_VALUE_JS}
      const el = document.activeElement;
      const before = el.isContentEditable ? el.innerText : el.value;
      const expected = ${clearFirst ? "''" : 'before'} + ${JSON.stringify(text)};
      if (el.isContentEditable) {
        ${clearFirst ? "document.execCommand('selectAll', false, null);" : ''}
        document.execCommand('insertText', false, ${JSON.stringify(text)});
      } else {
        reactSetValue(el, expected);
      }
      await new Promise((r) => setTimeout(r, 300));
      const after = el.isContentEditable ? el.innerText : el.value;
      const landed = el.isContentEditable ? after.includes(${JSON.stringify(text)}) : after === expected;
      return { landed, method: el.isContentEditable ? 'execCommand' : 'react_set', value: after };
    })()`;
  }

  // Digita no campo com foco e confirma no próprio campo que o texto entrou:
  // colagem para textos longos, teclas para curtos (ou humanized).
  async function typeIntoFocus(sid, text, { humanized = false, delayMs = 80, clearFirst = false } = {}) {
    const probe = await evalPage(sid, FOCUS_PROBE_JS);
    if (!probe.editable) return { error: 'no_editable_focus', probe };
    if (clearFirst) {
      await api('POST', '/api/input/batch', {
        sessionId: sid,
        actions: [
          { type: 'keydown', key: 'Control' },
          { type: 'keydown', key: 'a' },
          { type: 'keyup', key: 'a' },
          { type: 'keyup', key: 'Control' },
          { type: 'keydown', key: 'Backspace' },
          { type: 'keyup', key: 'Backspace' },
        ],
      });
      await new Promise((r) => setTimeout(r, 100));
    }
    const before = await evalPage(sid, FOCUS_PROBE_JS);
    if (!humanized && text.length > 3) {
      const r = await evalPage(sid, pasteScript(text, clearFirst));
      if (r.landed) return { ok: true, method: 'paste', value: r.value };
      return { error: 'not_landed', value: r.value, probe: before };
    }
    for (const ch of text) {
      await api('POST', '/api/input/batch', {
        sessionId: sid,
        actions: [{ type: 'keydown', key: ch }, { type: 'keyup', key: ch }],
      });
      // Jitter humano (caso Serpro/hCaptcha): delay fixo entre teclas é
      // assinatura mecânica. 60-140ms em torno dos 80ms de base.
      if (humanized) await new Promise((r) => setTimeout(r, delayMs * 0.75 + Math.random() * delayMs * 0.75));
    }
    const after = await evalPage(sid, FOCUS_PROBE_JS);
    const grew = (after.value || '').length - (before.value || '').length;
    if (!after.editable || grew !== text.length) {
      return { error: 'keys_not_landed', value: after.value, probe: before };
    }
    return { ok: true, method: 'keys', value: after.value };
  }

  function noEditableFocus(probe, antes) {
    return toolError(
      `Nenhum campo editável com foco (ativo: ${probe.active}). ${antes} O texto NÃO foi digitado. ` +
      'Use click_element ou click_by_text no campo antes, ou fill_form / react_fill_input.',
      { ok: false, reason: 'no_editable_focus', active: probe.active }
    );
  }

  function notLanded(value, active) {
    return toolError(
      `O campo com foco (${active}) não mostrou o texto (valor agora: ${JSON.stringify(value)}). ` +
      'O texto NÃO ficou no campo: pode ser um campo controlado que descarta a mudança.',
      { ok: false, reason: 'not_landed', value }
    );
  }

  // Clipboard: navigator.clipboard só responde com o documento focado. O script
  // SEMPRE assenta (corrida de 1,5 s): uma Promise que nunca resolve não pode
  // segurar a chamada CDP e derrubar o canal da sessão.
  const CLIPBOARD_NO_FOCUS = 'Clipboard indisponível agora: o documento não tem foco de janela, e o Chrome só libera navigator.clipboard com foco. Num navegador headless isso não se obtém sozinho. Para entrar texto use type_text ou fill_form.';

  function clipboardScript(kind, text) {
    const call = kind === 'write'
      ? `navigator.clipboard.writeText(${JSON.stringify(text)})`
      : 'navigator.clipboard.readText()';
    return `(async () => {
      if (!navigator.clipboard) return { ok: false, error: 'navigator.clipboard indisponível (contexto não seguro?)' };
      let t;
      const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('o navegador não respondeu em 1,5 s')), 1500); });
      try {
        const v = await Promise.race([${call}, limite]);
        clearTimeout(t);
        return { ok: true, text: typeof v === 'string' ? v : undefined };
      } catch (e) {
        clearTimeout(t);
        return { ok: false, error: String((e && e.message) || e) };
      }
    })()`;
  }

  // Mensagem de erro para exceção de script. Seletor CSS inválido é o caso
  // mais comum (querySelector lança SyntaxError).
  function pageErrorMessage(selector, message) {
    if (/is not a valid selector/i.test(message)) {
      return `Seletor CSS inválido: ${selector}`;
    }
    return `Erro ao avaliar o seletor "${selector}" na página: ${message}`;
  }

  const server = new McpServer({
    name: 'serende-browser',
    version: '3.0.0',
  });

  // Registro de tool com envelope de erro uniforme: qualquer exceção lançada
  // pelo handler (sem sessão, rate limit, API fora do ar) vira o mesmo formato
  // das tools — isError:true e texto JSON. Sem isso, o caminho de exceção
  // devolvia um texto solto e quem faz JSON.parse(data) quebrava justamente
  // no erro.
  //
  // Toda tool que age numa sessão aceita `sessionId` opcional, e o parâmetro é
  // injetado AQUI, uniformemente, para não depender de cada tool lembrar dele.
  //
  // POR QUE EXISTE: "qual é a minha sessão" era estado IMPLÍCITO do servidor
  // (um ponteiro). Medido no QA real — 4 sub-agentes em paralelo, mesma
  // chave — o ponteiro é compartilhado e as operações caem na sessão de outro
  // agente: evaluate_js rodou na sessão alheia, a URL ganhou a sonda de outro
  // agente e um dado foi escrito no formulário de outro. Com o id explícito a
  // operação é endereçada e a corrida some por construção.
  const SESSION_ID_PARAM = z.string().optional().describe(
    'Session to operate on. REQUIRED when this key has more than one session open. Omit = the current one (only when unambiguous).'
  );

  const registerTool = (name, config, handler) => {
    let cfg = config;
    try {
      const shape = config && config.inputSchema && config.inputSchema.shape;
      if (shape && !('sessionId' in shape)) {
        cfg = { ...config, inputSchema: config.inputSchema.extend({ sessionId: SESSION_ID_PARAM }) };
      }
    } catch {
      cfg = config; // schema sem .extend: segue como está
    }
    return server.registerTool(name, cfg, async (...handlerArgs) => {
      try {
        const args = handlerArgs[0] || {};
        // O id explícito entra no contexto da requisição: requireSession() o lê
        // e opera exatamente essa sessão. Zera quando a chamada não traz id —
        // senão um id de uma chamada anterior vazaria para a seguinte.
        const ctx = tenantContext.getStore();
        if (ctx) {
          ctx.sessionId = args.sessionId ? String(args.sessionId) : null;
          ctx.resolvedSessionId = null;
        }
        const result = await handler(...handlerArgs);
        return echoSession(result, ctx && (ctx.sessionId || ctx.resolvedSessionId));
      } catch (e) {
        return toolError(e.message || String(e));
      }
    });
  };

  // Ecoa a sessão operada na resposta, para o agente perceber um desvio sem
  // precisar de sonda externa.
  //
  // Duas formas, porque as tools respondem de duas maneiras:
  //   - resposta em JSON  → vira um campo `sessionId` (o JSON continua válido,
  //     quem faz JSON.parse não quebra);
  //   - resposta em texto  → ganha um sufixo "[session: <id>]" (texto simples
  //     não é parseado como JSON, então nada quebra).
  //
  // Sem isso o agente não tem como saber em qual sessão a operação rodou —
  // foi exatamente o que o QA precisou contornar com sentinela na página.
  function echoSession(result, sessionId) {
    if (!sessionId || !result || !Array.isArray(result.content)) return result;
    const first = result.content[0];
    if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;
    let parsed = null;
    let isJson = true;
    try { parsed = JSON.parse(first.text); } catch { isJson = false; }
    if (isJson && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.sessionId) return result;
      const pretty = first.text.includes('\n');
      const text = JSON.stringify({ ...parsed, sessionId }, null, pretty ? 2 : 0);
      return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
    }
    if (isJson) return result; // JSON que não é objeto (array/numero): não mexe
    if (first.text.includes(`[session: ${sessionId}]`)) return result;
    const text = `${first.text}\n[session: ${sessionId}]`;
    return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
  }

  // ========== SESSION TOOLS ==========

  // session_start: CRIA uma sessão nova, sempre. Se o tenant já tem sessões
  // abertas, a nova passa a ser a CORRENTE e o id novo é devolvido — era isso
  // que prendia dois sub-agentes na mesma: o segundo chamava session_start e
  // recebia status:'already_active' com o sessionId do primeiro, ou seja, era
  // empurrado para dentro do browser do outro. Agora cada pedido explicito de
  // sessão ganha a sua.
  //
  // Quando o cliente NÃO passa forceNew (o caminho de 1 sessão, que é o de
  // quase todo mundo), e já existe uma corrente viva, ela é devolvida como
  // before — um cliente antigo não passa a criar browser atoa a cada chamada.
  // Quer outra mesmo? forceNew:true (ou o default no caminho multi-sessão,
  // ver startNewSession).
  registerTool('session_start', {
    description: 'Start a remote browser session and return its sessionId. Must be called before any other tool. Keep the sessionId and pass it to EVERY other call: with more than one session open, a call without sessionId is refused (ambiguous_session). If several agents share this API key, each one must call session_start with forceNew:true. Without it, the call can return a session that is already open (status already_active), possibly one opened by another agent.',
    inputSchema: z.object({
      resolution: z.string().optional().describe('Screen resolution WxH. Omit = 1920x1080. If a session is already open with a DIFFERENT resolution, a new one is created instead of silently reusing it.'),
      startUrl: z.string().default('https://www.google.com').describe('URL to open on start'),
      forceNew: z.boolean().default(false).describe('true = always create a new session (required when several agents share this key). false (default) = reuse the session already open for this connection when its resolution matches, like a single-session client.'),
      locale: z.string().optional().describe('Browser locale, e.g. "pt-BR". Default pt-BR. Sets --lang and the profile Preferences (navigator.languages).'),
      timezone: z.string().optional().describe('Page timezone, e.g. "America/Sao_Paulo". Default America/Sao_Paulo. Applied via CDP Emulation at boot.'),
      proxyUrl: z.string().optional().describe('Proxy for this session: "http://host:port", "socks5://host:port" or "http://user:pass@host:port". Omit = direct connection. Use a residential proxy when the target blocks datacenter IPs.'),
      devicePreset: z.enum(['win', 'mac', 'linux']).optional().describe('Device emulation preset (default win): spoofs user-agent, platform, WebGL GPU vendor/renderer, CPU cores and memory so hardware fingerprinting sees a typical machine instead of the server.'),
      userAgent: z.string().optional().describe('Override the preset user-agent string.'),
      platform: z.string().optional().describe('Override the preset navigator.platform, e.g. "Win32".'),
      gpuVendor: z.string().optional().describe('Override the preset WebGL UNMASKED vendor, e.g. "NVIDIA Corporation".'),
      gpuRenderer: z.string().optional().describe('Override the preset WebGL UNMASKED renderer, e.g. "NVIDIA GeForce GTX 1050".'),
      hardwareConcurrency: z.number().optional().describe('Override the preset CPU core count.'),
      deviceMemory: z.number().optional().describe('Override the preset memory in GB.'),
      webgl: z.boolean().optional().describe('true = real WebGL via software GPU (SwiftShader), for sites that require WebGL. Default false: a real WebGL context can crash heavy pages; the emulated GPU vendor/renderer is reported regardless.'),
    }),
  }, async ({ resolution, startUrl, forceNew, locale, timezone, proxyUrl, devicePreset, userAgent, platform, gpuVendor, gpuRenderer, hardwareConcurrency, deviceMemory, webgl }) => {
    const tenantId = getCurrentTenantId();
    const cachedId = effectiveCurrent(tenantId);
    // Já tem uma corrente viva: sem pedido explícito de nova, devolve ela.
    if (cachedId && !forceNew) {
      try {
        const existing = await api('GET', `/api/session/${cachedId}`);
        // A sessão existente tem a resolução pedida?
        //
        // Medido no QA: 4 de 4 seções pediram resolution:"1440x900" e
        // receberam 1280x720. A causa era esta: sem forceNew, a sessão já
        // aberta era devolvida em silêncio e o pedido de resolução era
        // descartado — o agente passava a medir a tela errada sem nenhum aviso.
        // Agora a resolução divergente cria a sessão pedida.
        if (!resolution || sameResolution(existing, resolution)) {
          const viewerUrl = `${SERENDE_PUBLIC_URL}?session=${cachedId}`;
          return ok(JSON.stringify({ sessionId: cachedId, status: 'already_active', reused: true, resolution: existing.resolution, viewerUrl, message: 'Reused a session that was already open. If other agents use this key, call session_start with forceNew:true to get your own session.' }, null, 2));
        }
        // Resolução diferente da sessão existente: o pedido é por outra.
        return startNewSession(tenantId, { resolution, startUrl, locale, timezone, proxyUrl, devicePreset, userAgent, platform, gpuVendor, gpuRenderer, hardwareConcurrency, deviceMemory, webgl });
      } catch (e) {
        // Transiente (429/5xx/rede): a sessão pode continuar viva — não descarta
        // o cache, senão um rate limit cascateia em "cria outra sessão".
        if (!isSessionGone(e)) throw e;
        // Sessão não existe mais, limpa cache
        forgetSessionEverywhere(tenantId, cachedId);
      }
    }
    return startNewSession(tenantId, { resolution: resolution || '1440x900', startUrl, locale, timezone, proxyUrl, devicePreset, userAgent, platform, gpuVendor, gpuRenderer, hardwareConcurrency, deviceMemory, webgl });
  });

  // A resolução pedida bate com a da sessão existente?
  //
  // A sessão existe como {width, height}; o pedido vem como "WxH". Compara as
  // duas formas sem depender da ordem dos campos.
  function sameResolution(existing, wanted) {
    const cur = existing && existing.resolution;
    if (!cur) return true; // não sei a resolução atual: não recuso o pedido
    const m = String(wanted).match(/^(\d+)\s*[xX*]\s*(\d+)$/);
    if (!m) return true; // pedido em formato desconhecido: não recuso
    return Number(m[1]) === Number(cur.width) && Number(m[2]) === Number(cur.height);
  }

  // Cria a sessão no backend e a torna corrente DESTA conexão.
  async function startNewSession(tenantId, { resolution, startUrl, locale, timezone, proxyUrl, devicePreset, userAgent, platform, gpuVendor, gpuRenderer, hardwareConcurrency, deviceMemory, webgl }) {
    const data = await api('POST', '/api/session', { resolution, startUrl, locale, timezone, proxyUrl, devicePreset, userAgent, platform, gpuVendor, gpuRenderer, hardwareConcurrency, deviceMemory, webgl });
    setCurrentSession(tenantId, data.sessionId);
    markSessionValidated(tenantId, data.sessionId);
    const viewerUrl = `${SERENDE_PUBLIC_URL}?session=${data.sessionId}`;
    return ok(JSON.stringify({ sessionId: data.sessionId, status: data.status, resolution: data.resolution, viewerUrl }, null, 2));
  }

  // session_stop: aceita sessionId opcional. Sem ele, fecha a CORRENTE (é o
  // comportamento de sempre — clientes antigos seguem funcionando). Com ele,
  // fecha a indicada e só ela: era a outra metade do bug, porque parar a
  // sessão de um sub-agente derrubava a de todos.
  registerTool('session_stop', {
    description: 'Stop a browser session and free resources. Without sessionId stops the CURRENT session (default). With sessionId stops that one only — other sessions of the tenant keep running.',
    inputSchema: z.object({
      sessionId: z.string().optional().describe('Session to stop. Omit = the current one.'),
    }),
  }, async ({ sessionId }) => {
    const tenantId = getCurrentTenantId();
    let sid = sessionId;
    // Sem id: fecha a corrente (compatível com o contrato antigo).
    if (!sid) sid = await requireSession();
    else {
      // Com id: só aceita sessão que este MCP conhece deste tenant. Um id de
      // outro tenant não pode ser parado por aqui (o backend recusaria com 403,
      // mas a mensagem foi padronizada para não entregar a existência do id).
      const rec = sessionCache.get(tenantId);
      if (!rec || !rec.sessions.has(sid)) {
        return toolError(`Session not found for this tenant: ${sid}`, { sessionId: sid, stopped: false });
      }
    }
    const data = await api('DELETE', `/api/session/${sid}`);
    // Esquece em TODAS as conexões: qualquer sub-agente que apontava para ela
    // passa a não ter corrente (e cai na recuperação ou em erro claro), em vez
    // de continuar operando um browser fechado.
    forgetSessionEverywhere(tenantId, sid);
    return ok(data.message || 'Session stopped');
  });

  registerTool('session_status', {
    description: 'Get status of the current session (resolution, uptime, display).',
    inputSchema: z.object({
      sessionId: z.string().optional().describe('Session to inspect. Omit = the current one.'),
    }),
  }, async ({ sessionId }) => {
    const sid = sessionId || await requireSession();
    const data = await api('GET', `/api/session/${sid}`);
    return ok(JSON.stringify(data, null, 2));
  });

  registerTool('list_sessions', {
    description: 'List ALL active browser sessions of the tenant, marking which one is the current one. The current marker is shared by every agent that uses the same key: to act on your own session, pass sessionId on each call.',
    inputSchema: z.object({}),
  }, async () => {
    const tenantId = getCurrentTenantId();
    const data = await api('GET', '/api/session');
    // `current` = a corrente DESTA conexão (é a que as outras tools vão operar
    // quando este sub-agente chamar). As sessões que o backend lista mas este
    // MCP ainda não conhece também entram — o backend é a verdade.
    const current = effectiveCurrent(tenantId);
    const known = new Set((sessionCache.get(tenantId)?.sessions || new Map()).keys());
    const sessions = (data.sessions || []).map(s => ({
      ...s,
      current: s.sessionId === current,
      known: known.has(s.sessionId),
    }));
    return ok(JSON.stringify({ sessions, current, count: sessions.length }, null, 2));
  });

  // Troca a sessão CORRENTE. É o que permite a dois sub-agentes compartilharem
  // a chave sem se cruzarem: cada um faz session_use na SUA sessão e depois
  // choca as tools de automação, que passam a operar aquela sessão.
  registerTool('session_use', {
    description: 'Make sessionId the current session of this connection. NOT safe when several agents share this API key: another agent can change the current session between your calls. Prefer passing sessionId on every call.',
    inputSchema: z.object({
      sessionId: z.string().describe('Session id to make current (from list_sessions).'),
    }),
  }, async ({ sessionId }) => {
    const tenantId = getCurrentTenantId();
    const rec = sessionCache.get(tenantId);
    if (!rec || !rec.sessions.has(sessionId)) {
      return toolError(`Session not found for this tenant: ${sessionId}. Use list_sessions to see the available ones.`, { sessionId, switched: false });
    }
    // Confirma no backend antes de eleger: eleger uma que morreu faria o
    // requireSession dar 404 na tool seguinte.
    try {
      await api('GET', `/api/session/${sessionId}`);
    } catch (e) {
      if (!isSessionGone(e)) throw e;
      forgetSessionEverywhere(tenantId, sessionId);
      return toolError(`Session is gone: ${sessionId}`, { sessionId, switched: false });
    }
    // Elege na CONEXÃO: outra conexão do mesmo tenant (outro sub-agente) que
    // aponta para outra sessão continua intocada — é exatamente o isolamento
    // que se quer.
    const ck = getCurrentConnId();
    if (ck) connCurrent.set(ck, sessionId);
    // Fallback para cliente sem mcp-session-id: elege também no tenant.
    selectSession(tenantId, sessionId);
    markSessionValidated(tenantId, sessionId);
    const viewerUrl = `${SERENDE_PUBLIC_URL}?session=${sessionId}`;
    return ok(JSON.stringify({ sessionId, current: true, switched: true, viewerUrl, sessions: [...rec.sessions.keys()] }, null, 2));
  });

  // ========== NAVIGATION TOOLS ==========

  registerTool('navigate', {
    description: 'Navigate the browser to a URL. Automatically waits for page load to complete before returning.',
    inputSchema: z.object({
      url: z.string().describe('Full URL to navigate to (e.g. https://google.com)'),
      waitForLoad: z.boolean().default(true).describe('Wait for page load (default true)'),
    }),
  }, async ({ url, waitForLoad }) => {
    const sid = await requireSession();
    const data = await api('POST', `/api/navigate/${sid}`, { url });
    if (waitForLoad) {
      // Smart wait: check document.readyState and network
      const maxWait = 15000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const result = await api('POST', `/api/evaluate/${sid}`, {
          script: `({ readyState: document.readyState, complete: document.readyState === 'complete' })`,
        });
        if (result.result?.complete) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    return ok(`Navigated to: ${url}`);
  });

  registerTool('get_url', {
    description: 'Get the current page URL.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = await requireSession();
    const data = await api('GET', `/api/url/${sid}`);
    return ok(data.url || 'unknown');
  });

  // ========== SCREENSHOT ==========

  // Guarda a captura em memória e devolve a URL assinada com ela. O bloco
  // `image` continua sendo devolvido para os clientes que o exibem; a URL
  // assinada cobre os que o descartam: baixar por curl/fetch mostra a tela de
  // verdade, não só a prova de que ela existe.
  //
  // O eco da sessão ([session: id]) é acrescentado pelo echoSession, no
  // wrapper de todas as tools: aqui não se repete.
  function screenshotResult(data, sid) {
    if (!data.screenshot) return ok(JSON.stringify(data));
    const buf = Buffer.from(data.screenshot, 'base64');
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const info = data.info || {};
    const dims = info.image && info.image.width ? `${info.image.width}x${info.image.height}` : 'size unknown';
    const vp = info.viewport && info.viewport.width ? ` (viewport ${info.viewport.width}x${info.viewport.height})` : '';
    const lines = [
      `URL: ${info.url || 'unknown'}`,
      `Title: ${info.title || 'Unknown'}`,
      `Image: JPEG ${dims}${vp}, ${buf.length} bytes, sha256:${hash}`,
    ];
    const { captureId, expiresAt } = storeCapture(buf, 'image/jpeg', getCurrentTenantId(), sid);
    const url = captureUrl(captureId, expiresAt);
    if (url) {
      const mins = Math.round((expiresAt - Date.now()) / 60000);
      lines.push(`Image link (valid ~${mins} min, no API key needed): ${url}`);
      lines.push(`If this link is expired or the MCP restarted, take a new screenshot. The downloaded file must match the sha256 above.`);
    }
    return {
      content: [
        { type: 'text', text: lines.join('\n') },
        {
          type: 'image',
          data: data.screenshot,
          mimeType: 'image/jpeg',
        },
      ],
    };
  }

  registerTool('screenshot', {
    description: 'Take a screenshot of the current browser screen. Returns the JPEG image, plus a text block with the image size, byte count, sha256 prefix and an image link (valid ~10 minutes, no API key needed) for downloading the capture with curl or fetch. If your client drops image blocks, download the link: the file bytes must match the sha256 in the text. Use this to see what is on screen before interacting.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = await requireSession();
    const data = await api('GET', `/api/screenshotWithInfo/${sid}`);
    return screenshotResult(data, sid);
  });

  // ========== MOUSE TOOLS ==========

  registerTool('mouse_move', {
    description: 'Move mouse cursor to (x, y) coordinates.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'mousemove', x, y });
    return ok(`Moved to (${x}, ${y})`);
  });

  registerTool('mouse_click', {
    description: 'Click at (x, y). Use button 0=left, 1=middle, 2=right. Always take a screenshot first to know where to click.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x, y, button });
    return ok(`Clicked (${x}, ${y}) button=${button}`);
  });

  registerTool('mouse_double_click', {
    description: 'Double-click at (x, y).',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const sid = await requireSession();
    // dblclick: o handler CDP (server/cdp-input-handler.js) trata o tipo
    // 'dblclick' como press+release com clickCount=2 — é esse par que o Chrome
    // usa para sintetizar o evento dblclick no DOM. Dois 'click' separados
    // (clickCount=1) NUNCA geram dblclick (medido: dblclick:0 no DOM).
    await api('POST', '/api/input', { sessionId: sid, type: 'dblclick', x, y, button: 0 });
    return ok(`Double-clicked (${x}, ${y})`);
  });

  registerTool('mouse_right_click', {
    description: 'Right-click at (x, y) to open context menu.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x, y, button: 2 });
    return ok(`Right-clicked (${x}, ${y})`);
  });

  registerTool('mouse_down', {
    description: 'Press mouse button down (for drag start).',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'mousedown', x, y, button });
    return ok(`Mouse down (${x}, ${y}) button=${button}`);
  });

  registerTool('mouse_up', {
    description: 'Release mouse button (for drag end).',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'mouseup', x, y, button });
    return ok(`Mouse up (${x}, ${y}) button=${button}`);
  });

  registerTool('scroll', {
    description: 'Scroll at (x, y). Positive deltaY = scroll down, negative = scroll up. One notch = 120.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      deltaY: z.number().describe('Scroll amount. 120=one notch down, -120=one notch up'),
    }),
  }, async ({ x, y, deltaY }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'scroll', x, y, deltaY });
    return ok(`Scrolled at (${x}, ${y}) deltaY=${deltaY}`);
  });

  registerTool('drag', {
    description: 'Drag from (fromX, fromY) to (toX, toY) with smooth interpolation. Generates intermediate mousemove events so canvas, sliders, and drag-and-drop work correctly.',
    inputSchema: z.object({
      fromX: z.number().describe('Start X'),
      fromY: z.number().describe('Start Y'),
      toX: z.number().describe('End X'),
      toY: z.number().describe('End Y'),
      steps: z.number().default(0).describe('Number of intermediate points (0 = auto-calculate based on distance, ~1 point per 15px)'),
    }),
  }, async ({ fromX, fromY, toX, toY, steps }) => {
    const sid = await requireSession();
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const numSteps = steps > 0 ? steps : Math.max(5, Math.ceil(dist / 15));

    const actions = [{ type: 'mousedown', x: fromX, y: fromY, button: 0 }];
    for (let i = 1; i <= numSteps; i++) {
      const t = i / numSteps;
      actions.push({
        type: 'mousemove',
        x: Math.round(fromX + dx * t),
        y: Math.round(fromY + dy * t),
      });
    }
    actions.push({ type: 'mouseup', x: toX, y: toY, button: 0 });

    await api('POST', '/api/input/batch', { sessionId: sid, actions });
    return ok(`Dragged (${fromX},${fromY}) → (${toX},${toY}) with ${numSteps} steps`);
  });

  // ========== KEYBOARD TOOLS ==========

  registerTool('key_press', {
    description: 'Press and release a key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, F1-F12, or any character).',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    const sid = await requireSession();
    await api('POST', '/api/input/batch', {
      sessionId: sid,
      actions: [
        { type: 'keydown', key },
        { type: 'keyup', key },
      ]
    });
    return ok(`Pressed: ${key}`);
  });

  registerTool('key_down', {
    description: 'Hold a key down. Use with key_up for combos like Ctrl+C.',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'keydown', key });
    return ok(`Key down: ${key}`);
  });

  registerTool('key_up', {
    description: 'Release a held key.',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'keyup', key });
    return ok(`Key up: ${key}`);
  });

  registerTool('type_text', {
    description: 'Type text into the focused field. Answers isError when the focused element does not accept text (for example the page body), so "Typed" always means the text is in a field. Texts longer than 3 chars are pasted (React-compatible: fires input/change but NO keydown/keyup); shorter ones or humanized=true are typed key by key with real key events, so use humanized=true when the page listens to keys. The answer says which path ran: "Typed (paste)" or "Typed (keys)". Checks the field value before answering.',
    inputSchema: z.object({
      text: z.string().describe('Text to type'),
      humanized: z.boolean().default(false).describe('Force char-by-char typing with delay (for autocomplete fields)'),
      delayMs: z.number().default(80).describe('Delay between chars in humanized mode (ms)'),
    }),
  }, async ({ text, humanized, delayMs }) => {
    const sid = await requireSession();
    const r = await typeIntoFocus(sid, text, { humanized, delayMs });
    if (r.error === 'no_editable_focus') return noEditableFocus(r.probe, 'Com o foco fora de campo, nenhuma tecla chega a lugar nenhum.');
    if (r.error) return notLanded(r.value, r.probe.active);
    return ok(r.method === 'paste' ? `Typed (paste): "${text}" — method: react_set` : `Typed (keys): "${text}"`);
  });

  registerTool('hotkey', {
    description: 'Press a keyboard shortcut. Keys pressed in order, released in reverse. Example: ["Control", "a"] for Ctrl+A.',
    inputSchema: z.object({
      keys: z.array(z.string()).describe('Array of key names, e.g. ["Control", "c"]'),
    }),
  }, async ({ keys }) => {
    const sid = await requireSession();

    // Mapeia nomes de tecla (case-insensitive) para o modificador canônico.
    // Aliases because a user may type "ctrl" instead of "Control".
    const TO_CANONICAL_MODIFIER = {
      control: 'Control', ctrl: 'Control',
      alt: 'Alt', shift: 'Shift', meta: 'Meta',
    };

    // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
    // Must go in EVERY action, because the handler's getModifiers only reads
    // msg.modifiers / ctrlKey per action — no state is carried between them.
    const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

    const activeMods = new Set();
    for (const k of keys) {
      const canon = TO_CANONICAL_MODIFIER[String(k).toLowerCase()];
      if (canon) activeMods.add(canon);
    }

    let modifierMask = 0;
    for (const m of activeMods) modifierMask |= MOD_BIT[m];

    const actions = [];
    for (const k of keys) {
      actions.push({ type: 'keydown', key: k, modifiers: modifierMask });
    }
    for (const k of [...keys].reverse()) {
      actions.push({ type: 'keyup', key: k, modifiers: modifierMask });
    }
    await api('POST', '/api/input/batch', { sessionId: sid, actions });
    return ok(`Hotkey: ${keys.join('+')}`);
  });

  // ========== JS EXECUTION ==========

  registerTool('evaluate_js', {
    description: 'Execute JavaScript in the browser page and return the result. Powerful for complex interactions, reading DOM, etc.',
    inputSchema: z.object({
      script: z.string().describe('JavaScript to execute in browser context'),
    }),
  }, async ({ script }) => {
    const sid = await requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, { script });
    return ok(JSON.stringify(data.result ?? data, null, 2));
  });

  // ========== PAGE INSPECTION TOOLS ==========

  registerTool('get_page_title', {
    description: 'Get the current page title.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = await requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, { script: 'document.title' });
    return ok(data.result ?? 'untitled');
  });

  registerTool('get_page_text', {
    description: 'Get all visible text from the page. Useful to understand page content without a screenshot.',
    inputSchema: z.object({
      maxLength: z.number().default(5000).describe('Max chars to return (default 5000)'),
    }),
  }, async ({ maxLength }) => {
    const sid = await requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `document.body.innerText.substring(0, ${maxLength})`,
    });
    return ok(data.result ?? '');
  });

  registerTool('get_page_html', {
    description: 'Get HTML of the page or a specific element. Useful for understanding DOM structure.',
    inputSchema: z.object({
      selector: z.string().default('body').describe('CSS selector (default: body)'),
      outer: z.boolean().default(false).describe('Return outerHTML (true) or innerHTML (false)'),
    }),
  }, async ({ selector, outer }) => {
    const sid = await requireSession();
    const prop = outer ? 'outerHTML' : 'innerHTML';
    let html;
    try {
      html = await evalPage(sid, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.${prop}.substring(0, 10000) : null; })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector, found: false });
    }
    if (html === null || html === undefined) {
      return toolError(`Element not found: ${selector}`, { selector, found: false });
    }
    return ok(html);
  });

  registerTool('find_element', {
    description: 'Find an element by CSS selector. Returns position (x, y, width, height), text, tag, and attributes. Automatically scrolls element into view if off-screen.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector (e.g. "#login-btn", ".submit", "input[name=email]")'),
      scrollToView: z.boolean().default(true).describe('Scroll element into view if off-screen (default true)'),
    }),
  }, async ({ selector, scrollToView }) => {
    const sid = await requireSession();
    let value;
    try {
      value = await evalPage(sid, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const wasOffscreen = r.top < 0 || r.bottom > window.innerHeight;
        if (${scrollToView} && wasOffscreen) {
          // 'instant', e NÃO 'smooth': o scroll suave é ASSÍNCRONO, então o
          // rect lido em seguida era o PRÉ-scroll (a coordenada apontava para
          // outro pixel da tela — erro medido de até 414px). Com 'instant' o
          // scroll é síncrono e o rect abaixo já é o final.
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
        // Rect RELIDO depois do scroll: esta é a posição real do elemento.
        const r2 = el.getBoundingClientRect();
        return {
          found: true,
          tag: el.tagName.toLowerCase(),
          text: el.innerText?.substring(0, 200) || '',
          value: el.value || '',
          href: el.href || '',
          type: el.type || '',
          placeholder: el.placeholder || '',
          x: Math.round(r2.x + r2.width / 2),
          y: Math.round(r2.y + r2.height / 2),
          width: Math.round(r2.width),
          height: Math.round(r2.height),
          visible: r2.width > 0 && r2.height > 0,
          wasScrolled: wasOffscreen
        };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector, found: false });
    }
    if (value === null) return toolError(`Element not found: ${selector}`, { selector, found: false });
    return ok(JSON.stringify(value, null, 2));
  });

  registerTool('find_all_elements', {
    description: 'Find all elements matching a CSS selector. Returns array of {tag, text, x, y, width, height}. Max 20 results.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector'),
      maxResults: z.number().default(20).describe('Max results (default 20)'),
    }),
  }, async ({ selector, maxResults }) => {
    const sid = await requireSession();
    let value;
    try {
      value = await evalPage(sid, `(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        const results = [];
        for (let i = 0; i < Math.min(els.length, ${maxResults}); i++) {
          const el = els[i];
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          results.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || '').substring(0, 100),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            width: Math.round(r.width),
            height: Math.round(r.height)
          });
        }
        return { count: els.length, results };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector });
    }
    return ok(JSON.stringify(value ?? { count: 0, results: [] }, null, 2));
  });

  registerTool('find_element_by_text', {
    description: 'Find a clickable element by its visible text. Searches buttons, links, and other interactive elements. Returns coordinates for clicking.',
    inputSchema: z.object({
      text: z.string().describe('Text to search for (case-insensitive, partial match)'),
      tag: z.string().default('*').describe('Optional tag filter: button, a, input, * for any'),
    }),
  }, async ({ text, tag }) => {
    const sid = await requireSession();
    let value;
    try {
      value = await evalPage(sid, `(() => {
        const searchText = ${JSON.stringify(text)}.toLowerCase();
        const tagFilter = ${JSON.stringify(tag)};
        const selector = tagFilter === '*' ? 'a, button, input, [role="button"], [onclick], label, select, textarea, [tabindex]' : tagFilter;
        const els = document.querySelectorAll(selector);
        const results = [];
        for (const el of els) {
          const elText = (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').toLowerCase();
          if (!elText.includes(searchText)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          results.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || '').substring(0, 100),
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            width: Math.round(r.width),
            height: Math.round(r.height)
          });
          if (results.length >= 5) break;
        }
        return results.length ? results : null;
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(tag, e.message), { text, tag });
    }
    if (value === null) {
      return toolError(`No clickable element found with text: "${text}"`, { text, tag, found: false });
    }
    return ok(JSON.stringify(value, null, 2));
  });

  registerTool('wait_for_element', {
    description: 'Wait for an element to appear on the page (polls every 500ms). Returns element info when found or error on timeout.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector to wait for'),
      timeoutMs: z.number().default(10000).describe('Max wait time in ms (default 10000)'),
    }),
  }, async ({ selector, timeoutMs }) => {
    const sid = await requireSession();
    const maxAttempts = Math.ceil(timeoutMs / 500);
    for (let i = 0; i < maxAttempts; i++) {
      let value;
      try {
        value = await evalPage(sid, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            found: true,
            tag: el.tagName.toLowerCase(),
            text: el.innerText?.substring(0, 200) || '',
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            width: Math.round(r.width),
            height: Math.round(r.height)
          };
        })()`);
      } catch (e) {
        return toolError(pageErrorMessage(selector, e.message), { selector, found: false });
      }
      if (value) return ok(JSON.stringify(value, null, 2));
      await new Promise(r => setTimeout(r, 500));
    }
    return toolError(`Timeout: element "${selector}" not found after ${timeoutMs}ms`, {
      selector, found: false, timeout: true, elapsed: timeoutMs,
    });
  });

  // ========== HIGH-LEVEL TOOLS ==========

  registerTool('wait_for_page_ready', {
    description: 'Wait for page to be fully loaded and interactive. Checks document.readyState, DOM stability, pending fetches, React hydration, and SPA routing. Works with Next.js, React Router, Vue Router, etc.',
    inputSchema: z.object({
      timeoutMs: z.number().default(15000).describe('Max wait time (ms)'),
      checkNetwork: z.boolean().default(true).describe('Wait for network idle (default true)'),
      stabilityMs: z.number().default(500).describe('DOM stability duration (ms)'),
    }),
  }, async ({ timeoutMs, checkNetwork, stabilityMs }) => {
    const sid = await requireSession();
    const start = Date.now();
    let lastDomState = '';
    let stableSince = null;

    while (Date.now() - start < timeoutMs) {
      let state;
      try {
        state = await evalPage(sid, `(() => {
          const loaderSelectors = '.loader, .spinner, .loading, [aria-busy="true"], .skeleton, [data-loading]:not(img):not(iframe), .animate-pulse, .nprogress-busy';
          const reactRoot = document.getElementById('__next') || document.getElementById('root') || document.getElementById('app');
          const isHydrating = reactRoot && reactRoot.hasAttribute('data-reactroot') && document.querySelectorAll('[data-reactid]').length === 0;
          return {
            readyState: document.readyState,
            complete: document.readyState === 'complete',
            bodyLen: document.body.innerHTML.length,
            childCount: document.body.querySelectorAll('*').length,
            loading: !!document.querySelector(loaderSelectors),
            url: location.href,
            hydrating: !!isHydrating,
            pendingFetches: typeof window.__NEXT_DATA__ !== 'undefined' ? 0 : (performance.getEntriesByType?.('resource')?.filter(r => !r.responseEnd)?.length || 0)
          };
        })()`);
      } catch (e) {
        return toolError(`Erro ao avaliar a página: ${e.message}`);
      }

      if (state?.complete && !state?.loading && !state?.hydrating) {
        const currentState = `${state.bodyLen}:${state.childCount}:${state.url}`;
        if (currentState === lastDomState) {
          if (!stableSince) stableSince = Date.now();
          else if (Date.now() - stableSince >= stabilityMs) {
            return ok(JSON.stringify({ ready: true, elapsed: Date.now() - start, url: state.url }));
          }
        } else {
          lastDomState = currentState;
          stableSince = null;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return toolError(`Timeout: page not ready after ${timeoutMs}ms`, {
      ready: false, timeout: true, elapsed: timeoutMs,
    });
  });

  registerTool('click_element', {
    description: 'Click an element by CSS selector. Scrolls element into view first, then clicks. Waits a bit after click for UI to respond.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of element to click'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ selector, button }) => {
    const sid = await requireSession();
    let found;
    try {
      found = await evalPage(sid, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        const small = r.width < 20 || r.height < 20;
        if (small || ${button} === 0) {
          el.focus();
          el.click();
          return { found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), method: 'js_click' };
        }
        return {
          found: true,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          method: 'x11'
        };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector, found: false });
    }
    if (!found?.found) return toolError(`Element not found: ${selector}`, { selector, found: false });

    if (found.method === 'x11') {
      await api('POST', '/api/input', {
        sessionId: sid,
        type: 'click',
        x: found.x,
        y: found.y,
        button,
      });
    }
    await new Promise(r => setTimeout(r, 300));
    return ok(`Clicked "${selector}" at (${found.x}, ${found.y})`);
  });

  registerTool('scroll_to_element', {
    description: 'Scroll the page to bring an element into view. Does NOT click.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of element'),
      block: z.string().default('center').describe('vertical align: start, center, end, nearest'),
    }),
  }, async ({ selector, block }) => {
    const sid = await requireSession();
    let res;
    try {
      res = await evalPage(sid, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        // 'instant', e NÃO 'smooth': o scroll suave é ASSÍNCRONO — o rect lido
        // em seguida era o PRÉ-scroll, e a resposta dizia "now visible: false"
        // para um elemento que já estava visível.
        el.scrollIntoView({ behavior: 'instant', block: ${JSON.stringify(block)} });
        // Rect relido DEPOIS do scroll.
        const r = el.getBoundingClientRect();
        return {
          found: true,
          // Visível = o retângulo do elemento intersecta o viewport.
          nowVisible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
          y: Math.round(r.top),
          scrollY: Math.round(window.scrollY)
        };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector, found: false });
    }
    if (!res?.found) return toolError(`Element not found: ${selector}`, { selector, found: false });
    return ok(`Scrolled to "${selector}" (now visible: ${res.nowVisible}, y: ${res.y})`);
  });

  registerTool('clipboard_write', {
    description: 'Write text to clipboard via JavaScript. Needs window focus on the page (click on the page first): without it, answers isError with the reason at once. The call always settles within 1.5 s, so it cannot hang the session.',
    inputSchema: z.object({
      text: z.string().describe('Text to copy to clipboard'),
    }),
  }, async ({ text }) => {
    const sid = await requireSession();
    const foco = await evalPage(sid, '({ focused: document.hasFocus() })');
    if (!foco.focused) return toolError(CLIPBOARD_NO_FOCUS, { ok: false, reason: 'document_not_focused' });
    const r = await evalPage(sid, clipboardScript('write', text));
    if (r.ok) return ok(`Copied to clipboard: "${text}"`);
    return toolError(`Failed to copy: ${r.error}`, { ok: false });
  });

  registerTool('clipboard_read', {
    description: 'Read text from clipboard via JavaScript. Needs window focus on the page: without it, answers isError with the reason at once. The call always settles within 1.5 s.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = await requireSession();
    const foco = await evalPage(sid, '({ focused: document.hasFocus() })');
    if (!foco.focused) return toolError(CLIPBOARD_NO_FOCUS, { ok: false, reason: 'document_not_focused' });
    const r = await evalPage(sid, clipboardScript('read'));
    if (r.ok) return ok(`Clipboard: "${r.text ?? ''}"`);
    return toolError(`Failed to read: ${r.error}`, { ok: false });
  });


  registerTool('fill_form', {
    description: 'Fill multiple form fields at once. React/Vue/Angular compatible. Each field: { selector, value, type } where type=text|select|checkbox|radio. For text fields, clicks first then sets value with proper React event simulation.',
    inputSchema: z.object({
      fields: z.array(z.object({
        selector: z.string().describe('CSS selector'),
        value: z.union([z.string(), z.boolean(), z.array(z.string())]).describe('Value to set'),
        type: z.string().default('text').describe('text, select, checkbox, radio'),
      })).describe('Array of fields to fill'),
    }),
  }, async ({ fields }) => {
    const sid = await requireSession();
    const results = [];

    for (const field of fields) {
      if (field.type === 'checkbox' || field.type === 'radio') {
        const checked = Boolean(field.value);
        const sel = JSON.stringify(field.selector);
        const r = await api('POST', `/api/evaluate/${sid}`, {
          script: `(() => {
            try {
              ${REACT_CHECKBOX_JS}
              const sel = ${sel};
              let el = document.querySelector(sel);
              if (!el) return { ok: false, error: 'not_found: ' + sel };

              // Case 1: native checkbox/radio
              if (el.type === 'checkbox' || el.type === 'radio') {
                if (el.checked !== ${checked}) reactToggleCheckbox(el, ${checked});
                return { ok: true, checked: el.checked, method: 'native' };
              }

              // Case 2: Radix/HeadlessUI/Base UI — element has role="checkbox|radio|switch"
              const role = el.getAttribute('role');
              if (role === 'checkbox' || role === 'radio' || role === 'switch') {
                const isChecked = el.getAttribute('aria-checked') === 'true';
                if (isChecked !== ${checked}) el.click();
                return { ok: true, checked: ${checked}, method: 'role_click' };
              }

              // Case 3: label or container — find checkbox/role inside or associated
              const inner = el.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]');
              if (inner) {
                if (inner.type === 'checkbox' || inner.type === 'radio') {
                  if (inner.checked !== ${checked}) reactToggleCheckbox(inner, ${checked});
                  return { ok: true, checked: inner.checked, method: 'inner_native' };
                }
                const ic = inner.getAttribute('aria-checked') === 'true';
                if (ic !== ${checked}) inner.click();
                return { ok: true, checked: ${checked}, method: 'inner_role' };
              }

              // Case 4: fallback — just click
              el.click();
              return { ok: true, method: 'fallback_click' };
            } catch(e) { return { ok: false, error: e.message }; }
          })()`,
        });
        results.push({ selector: field.selector, ok: r.result?.ok, method: r.result?.method, error: r.result?.error });
      } else if (field.type === 'select') {
        const value = String(field.value);
        const r = await api('POST', `/api/evaluate/${sid}`, {
          script: `(() => {
            const el = document.querySelector(${JSON.stringify(field.selector)});
            if (!el) return { ok: false, error: 'not_found' };
            if (el.tagName === 'SELECT') {
              // <select> nativo: NAO passa por reactSetValue. Aquele helper
              // faz el.focus() + execCommand('insertText') — num select o
              // insertText vai para o ULTIMO INPUT EDITAVEL focado (outro
              // campo qualquer), e o fallback usa HTMLInputElement.prototype,
              // que não seta value de <select>. Medido: o valor do select ia
              // parar num campo de texto vizinho.
              const opts = Array.from(el.options);
              const byValue = opts.find(o => o.value === ${JSON.stringify(value)});
              const byText = opts.find(o => o.text.trim() === ${JSON.stringify(value)});
              const target = byValue || byText;
              if (!target) {
                return { ok: false, error: 'no_option: ' + opts.map(o => o.value).join(','), value: el.value };
              }
              el.value = target.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, value: el.value, text: target.text };
            }
            // Custom select — click to open, find option by text
            el.click();
            return { ok: true, method: 'click_to_open', note: 'Custom select opened. Use click_by_text to pick option.' };
          })()`,
        });
        results.push({ selector: field.selector, ok: r.result?.ok, value, method: r.result?.method, error: r.result?.error });
      } else {
        // Text: focus element directly via JS, then set value with React events
        const value = String(field.value);
        const setResult = await api('POST', `/api/evaluate/${sid}`, {
          script: `(() => {
            ${REACT_SET_VALUE_JS}
            const el = document.querySelector(${JSON.stringify(field.selector)});
            if (!el) return { ok: false, error: 'not_found' };
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            el.focus();
            if (el.isContentEditable) {
              el.innerHTML = '';
              document.execCommand('insertText', false, ${JSON.stringify(value)});
              return { ok: true, method: 'execCommand', value: el.innerText };
            }
            reactSetValue(el, ${JSON.stringify(value)});
            return { ok: true, value: el.value, method: 'react_set' };
          })()`,
        });
        results.push({ selector: field.selector, ok: setResult.result?.ok, value, method: setResult.result?.method, error: setResult.result?.error });
      }
    }
    return ok(JSON.stringify({ filled: results.length, results }, null, 2));
  });

  registerTool('click_and_type', {
    description: 'Click at (x, y), wait for focus, then type text. Answers isError when the click does not leave a text field focused. Texts longer than 3 chars are pasted (input/change, NO keydown/keyup); for real key events click first, then use type_text with humanized=true. The answer says "pasted" or "typed". Use clearFirst=true to clear existing text first.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate to click'),
      y: z.number().describe('Y coordinate to click'),
      text: z.string().describe('Text to type'),
      clearFirst: z.boolean().default(false).describe('Select all and delete before typing'),
      focusDelayMs: z.number().default(200).describe('Wait after click before typing (ms)'),
    }),
  }, async ({ x, y, text, clearFirst, focusDelayMs }) => {
    const sid = await requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x, y, button: 0 });
    await new Promise(r => setTimeout(r, focusDelayMs));
    const r = await typeIntoFocus(sid, text, { clearFirst });
    if (r.error === 'no_editable_focus') return noEditableFocus(r.probe, `O clique em (${x},${y}) não deixou um campo de texto com foco.`);
    if (r.error) return notLanded(r.value, r.probe.active);
    return ok(r.method === 'paste' ? `Clicked (${x},${y}) and pasted "${text}"` : `Clicked (${x},${y}) and typed "${text}"`);
  });

  // ========== NEW: CLICK BY TEXT (robust) ==========

  registerTool('click_by_text', {
    description: 'Find an element by visible text and click it. Searches ALL elements (not just buttons/links). Much more robust than find_element_by_text + mouse_click. Supports data-testid fallback.',
    inputSchema: z.object({
      text: z.string().describe('Text to search for (case-insensitive, partial match)'),
      tag: z.string().default('*').describe('Optional tag filter: button, a, div, span, * for any'),
      exact: z.boolean().default(false).describe('Require exact text match (not partial)'),
      index: z.number().default(0).describe('Which match to click if multiple found (0-based)'),
    }),
  }, async ({ text, tag, exact, index }) => {
    const sid = await requireSession();
    // Find + scroll + click all in one JS evaluation for reliability
    let clicked;
    try {
      clicked = await evalPage(sid, `(() => {
        const searchText = ${JSON.stringify(text)}.toLowerCase();
        const isExact = ${exact};
        const tagFilter = ${JSON.stringify(tag)};
        const targetIndex = ${index};
        const all = document.querySelectorAll(tagFilter === '*' ? '*' : tagFilter);
        const matches = [];
        for (const el of all) {
          if (['SCRIPT','STYLE','META','LINK','HEAD','NOSCRIPT','BR','HR'].includes(el.tagName)) continue;
          const elText = (el.innerText || el.textContent || el.value || el.placeholder || el.title || el.getAttribute('aria-label') || '').trim();
          if (!elText) continue;
          const lc = elText.toLowerCase();
          const match = isExact ? lc === searchText : lc.includes(searchText);
          if (!match) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          matches.push({
            el,
            tag: el.tagName.toLowerCase(),
            text: elText.substring(0, 100),
            textLen: elText.length,
            clickable: el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button' || el.onclick || el.hasAttribute('tabindex'),
            width: r.width,
            height: r.height,
          });
        }
        matches.sort((a, b) => (b.clickable - a.clickable) || (a.textLen - b.textLen));
        if (matches.length === 0) return null;
        const target = matches[Math.min(targetIndex, matches.length - 1)];
        // Scroll into view and click via JS
        target.el.scrollIntoView({ behavior: 'instant', block: 'center' });
        target.el.click();
        const r = target.el.getBoundingClientRect();
        return { clicked: true, text: target.text, tag: target.tag, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), totalMatches: matches.length };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(tag, e.message), { text, tag });
    }
    if (!clicked) return toolError(`No element found with text: "${text}"`, { text, tag, found: false });
    await new Promise(r => setTimeout(r, 300));
    return ok(JSON.stringify(clicked));
  });

  // ========== NEW: WAIT FOR URL ==========

  registerTool('wait_for_url', {
    description: 'Wait for the URL to change or match a pattern. Essential for SPA navigation (React Router, Next.js, etc.) where page doesn\'t reload.',
    inputSchema: z.object({
      url: z.string().default('').describe('URL or partial URL to match. Empty = wait for any URL change.'),
      timeoutMs: z.number().default(10000).describe('Max wait time (ms)'),
    }),
  }, async ({ url, timeoutMs }) => {
    const sid = await requireSession();
    // Get current URL first
    const initial = await api('POST', `/api/evaluate/${sid}`, { script: 'location.href' });
    const initialUrl = initial.result || '';
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const current = await api('POST', `/api/evaluate/${sid}`, { script: 'location.href' });
      const currentUrl = current.result || '';
      if (url) {
        if (currentUrl.includes(url)) return ok(JSON.stringify({ matched: true, url: currentUrl, elapsed: Date.now() - start }));
      } else {
        if (currentUrl !== initialUrl) return ok(JSON.stringify({ changed: true, from: initialUrl, to: currentUrl, elapsed: Date.now() - start }));
      }
      await new Promise(r => setTimeout(r, 300));
    }
    const finalUrl = (await api('POST', `/api/evaluate/${sid}`, { script: 'location.href' })).result;
    return toolError(`Timeout: URL ${url ? `"${url}" ` : ''}not matched after ${timeoutMs}ms`, {
      timeout: true, currentUrl: finalUrl, elapsed: timeoutMs,
    });
  });

  // ========== NEW: WAIT FOR TEXT ==========

  registerTool('wait_for_text', {
    description: 'Wait for specific text to appear on the page. Useful after form submissions, navigation, or async data loads.',
    inputSchema: z.object({
      text: z.string().describe('Text to wait for (case-insensitive)'),
      timeoutMs: z.number().default(10000).describe('Max wait time (ms)'),
      selector: z.string().default('body').describe('Scope search to this CSS selector (default: body)'),
    }),
  }, async ({ text, timeoutMs, selector }) => {
    const sid = await requireSession();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let state;
      try {
        state = await evalPage(sid, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          const content = el.innerText || el.textContent || '';
          return { found: content.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}), length: content.length };
        })()`);
      } catch (e) {
        return toolError(pageErrorMessage(selector, e.message), { text, selector, found: false });
      }
      if (state?.found) return ok(JSON.stringify({ found: true, elapsed: Date.now() - start }));
      await new Promise(r => setTimeout(r, 400));
    }
    return toolError(`Timeout: text "${text}" not found after ${timeoutMs}ms`, {
      text, found: false, timeout: true, elapsed: timeoutMs,
    });
  });

  // ========== NEW: WAIT FOR SELECTOR GONE ==========

  registerTool('wait_for_selector_gone', {
    description: 'Wait for an element to disappear from the page (e.g., loading spinners, modals, overlays).',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of element to wait for disappearance'),
      timeoutMs: z.number().default(10000).describe('Max wait time (ms)'),
    }),
  }, async ({ selector, timeoutMs }) => {
    const sid = await requireSession();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let gone;
      try {
        gone = await evalPage(sid, `!document.querySelector(${JSON.stringify(selector)})`);
      } catch (e) {
        return toolError(pageErrorMessage(selector, e.message), { selector, gone: false });
      }
      if (gone === true) return ok(JSON.stringify({ gone: true, elapsed: Date.now() - start }));
      await new Promise(r => setTimeout(r, 400));
    }
    return toolError(`Timeout: element "${selector}" still present after ${timeoutMs}ms`, {
      selector, gone: false, timeout: true, elapsed: timeoutMs,
    });
  });

  // ========== NEW: GET CONSOLE MESSAGES ==========

  registerTool('get_console_messages', {
    description: 'Start capturing or retrieve browser console messages (log, error, warn, info). Call first to start capture, then call again to retrieve. Essential for debugging.',
    inputSchema: z.object({
      action: z.enum(['start', 'get', 'clear']).default('get').describe('start=begin capture, get=retrieve messages, clear=clear buffer'),
      maxMessages: z.number().default(50).describe('Max messages to return'),
    }),
  }, async ({ action, maxMessages }) => {
    const sid = await requireSession();
    if (action === 'start') {
      await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
          if (window.__serende_console) return { ok: true, already: true };
          window.__serende_console = [];
          const orig = {};
          ['log','error','warn','info','debug'].forEach(level => {
            orig[level] = console[level];
            console[level] = function(...args) {
              window.__serende_console.push({
                level, message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
                timestamp: Date.now()
              });
              if (window.__serende_console.length > 200) window.__serende_console.shift();
              orig[level].apply(console, args);
            };
          });
          window.addEventListener('error', e => {
            window.__serende_console.push({ level: 'exception', message: e.message + ' at ' + e.filename + ':' + e.lineno, timestamp: Date.now() });
          });
          window.addEventListener('unhandledrejection', e => {
            window.__serende_console.push({ level: 'rejection', message: String(e.reason), timestamp: Date.now() });
          });
          return { ok: true };
        })()`,
      });
      return ok('Console capture started. Use action="get" to retrieve messages.');
    }
    if (action === 'clear') {
      await api('POST', `/api/evaluate/${sid}`, { script: 'window.__serende_console = []; true' });
      return ok('Console buffer cleared.');
    }
    // get
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        const msgs = window.__serende_console || [];
        return { count: msgs.length, messages: msgs.slice(-${maxMessages}) };
      })()`,
    });
    return ok(JSON.stringify(data.result || { count: 0, messages: [] }, null, 2));
  });

  // ========== NEW: GET/SET COOKIES (CDP-based) ==========

  registerTool('get_cookies', {
    description: 'Get all cookies for the current page. Returns array of {name, value, domain, path, expires}.',
    inputSchema: z.object({
      name: z.string().default('').describe('Filter by cookie name (empty = all)'),
    }),
  }, async ({ name }) => {
    const sid = await requireSession();
    // Use CDP-based endpoint for proper cookie retrieval
    const data = await api('GET', `/api/cookies/${sid}`);
    let cookies = data.cookies || [];

    // Filter by name if specified
    if (name) {
      cookies = cookies.filter(c => c.name === name);
    }

    return ok(JSON.stringify(cookies, null, 2));
  });

  registerTool('set_cookie', {
    description: 'Set a cookie on the current page.',
    inputSchema: z.object({
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
      maxAge: z.number().default(86400).describe('Max age in seconds (default 1 day)'),
      path: z.string().default('/').describe('Cookie path'),
    }),
  }, async ({ name, value, maxAge, path }) => {
    const sid = await requireSession();
    // Calculate expires from maxAge
    const expires = maxAge ? Math.floor(Date.now() / 1000) + maxAge : undefined;

    // Use CDP-based endpoint
    const data = await api('POST', `/api/cookies/${sid}`, {
      name,
      value,
      path,
      expires
    });

    if (data.success) {
      return ok(`Cookie set: ${name}=${value}`);
    }
    return ok(`Cookie set (CDP response): ${JSON.stringify(data)}`);
  });

  registerTool('delete_cookie', {
    description: 'Delete a cookie by name. O domínio/url é derivado da página atual quando não informado.',
    inputSchema: z.object({
      name: z.string().describe('Cookie name to delete'),
      domain: z.string().optional().describe('Cookie domain (ex.: example.com). Omitido = domínio da página atual.'),
      url: z.string().optional().describe('Cookie URL (ex.: https://example.com/). Alternativa ao domain.'),
    }),
  }, async ({ name, domain, url }) => {
    const sid = await requireSession();
    // O CDP (Network.deleteCookies) RECUSA um delete sem url/domain — devolve
    // 500 "At least one of the url and domain needs to be specified". Sem
    // informá-lo aqui, delete_cookie falhava SEMPRE e o handler antigo ainda
    // devolvia "Cookie deleted" (falso sucesso, isError:false).
    //
    // O domínio já é conhecido pelo backend: é o host da página atual (o
    // mesmo que set_cookie usa em server/index.js). Reaproveita.
    const qs = new URLSearchParams({ name });
    if (domain) qs.set('domain', domain);
    if (url) qs.set('url', url);

    const data = await api('DELETE', `/api/cookies/${sid}?${qs.toString()}`);

    // Nega o sucesso: a tool tem de falhar alto quando o backend não apagou.
    if (data && data.success === true) return ok(`Cookie deleted: ${name}`);
    if (data && data.success === false) {
      return toolError(`Cookie not deleted: ${name} (backend devolveu success=false)`, { name, deleted: false });
    }
    return ok(`Cookie deleted: ${name}`);
  });

  // ========== NEW: GET ELEMENTS (structured) ==========

  registerTool('get_elements', {
    description: 'Get structured data about all elements matching a selector. Returns full attributes, computed styles, visibility, and hierarchy. Much richer than find_all_elements.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector'),
      maxResults: z.number().default(20).describe('Max results'),
      includeAttributes: z.boolean().default(true).describe('Include all HTML attributes'),
    }),
  }, async ({ selector, maxResults, includeAttributes }) => {
    const sid = await requireSession();
    let value;
    try {
      value = await evalPage(sid, `(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        const results = [];
        for (let i = 0; i < Math.min(els.length, ${maxResults}); i++) {
          const el = els[i];
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const item = {
            index: i,
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: el.className || undefined,
            text: (el.innerText || '').substring(0, 200),
            value: el.value || undefined,
            type: el.type || undefined,
            href: el.href || undefined,
            src: el.src || undefined,
            placeholder: el.placeholder || undefined,
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
            disabled: el.disabled || false,
            checked: el.checked || undefined,
            visible: r.top >= -10 && r.top <= window.innerHeight + 10,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
          if (${includeAttributes}) {
            const attrs = {};
            for (const attr of el.attributes) {
              if (!['class','id','style'].includes(attr.name)) attrs[attr.name] = attr.value;
            }
            if (Object.keys(attrs).length) item.attributes = attrs;
          }
          // Remove undefined keys
          Object.keys(item).forEach(k => item[k] === undefined && delete item[k]);
          results.push(item);
        }
        return { total: els.length, returned: results.length, results };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector });
    }
    return ok(JSON.stringify(value ?? { total: 0, returned: 0, results: [] }, null, 2));
  });

  // ========== NEW: REACT FILL INPUT ==========

  registerTool('react_fill_input', {
    description: 'Fill an input field using React-compatible event simulation. Works with React Hook Form, Formik, controlled components, Radix UI, etc. Clicks the element, clears it, sets value, and triggers all necessary React events.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of the input (or data-testid like [data-testid="email"])'),
      value: z.string().describe('Value to set'),
      clearFirst: z.boolean().default(true).describe('Clear existing value first'),
    }),
  }, async ({ selector, value, clearFirst }) => {
    const sid = await requireSession();
    // Find and click
    let found;
    try {
      found = await evalPage(sid, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName, type: el.type };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(selector, e.message), { selector, ok: false });
    }
    if (!found) return toolError(`Element not found: ${selector}`, { selector, ok: false });

    // Click to focus
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x: found.x, y: found.y, button: 0 });
    await new Promise(r => setTimeout(r, 200));

    // Clear + set value with full React event chain
    const setResult = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        ${REACT_SET_VALUE_JS}
        const el = document.querySelector(${JSON.stringify(selector)}) || document.activeElement;
        if (!el || (!el.value && el.value !== '' && !el.isContentEditable)) {
          return { ok: false, error: 'Cannot set value on: ' + (el?.tagName || 'null') };
        }
        if (el.isContentEditable) {
          if (${clearFirst}) el.innerHTML = '';
          document.execCommand('insertText', false, ${JSON.stringify(value)});
          return { ok: true, method: 'execCommand', value: el.innerText };
        }
        const finalValue = ${clearFirst} ? ${JSON.stringify(value)} : (el.value + ${JSON.stringify(value)});
        reactSetValue(el, finalValue);
        return { ok: true, value: el.value, method: 'react_set' };
      })()`,
    });
    const payload = setResult.result || { ok: false, error: 'unknown' };
    if (!payload.ok) {
      return toolError(payload.error || 'unknown', { selector, ok: false });
    }
    return ok(JSON.stringify(payload));
  });

  // ========== NEW: SUBMIT FORM (React-aware) ==========

  registerTool('submit_form', {
    description: 'Submit a form by clicking its submit button. Finds the submit button automatically or by selector. Works with React onSubmit handlers.',
    inputSchema: z.object({
      formSelector: z.string().default('form').describe('CSS selector of the form'),
      buttonSelector: z.string().default('').describe('CSS selector of submit button (empty = auto-find)'),
    }),
  }, async ({ formSelector, buttonSelector }) => {
    const sid = await requireSession();

    // 1) Clica o botao NO DOM (nao por coordenada) e captura a evidencia:
    //    se o submit aconteceu mesmo, marca o form com um flag.
    //    Antes o handler media o rect do botao, devolvia x/y, e so depois
    //    mandava o clique por coordenada noutra chamada. Entre as duas o
    //    layout podia mudar (banner que aparece, scroll, re-render) e o clique
    //    caia em outro elemento — medido na Wikipedia: 3/3 tentativas com
    //    `submitted:true` e a URL nao mudou.
    let data;
    try {
      data = await evalPage(sid, `(() => {
        const form = document.querySelector(${JSON.stringify(formSelector)});
        if (!form) return { ok: false, error: 'Form not found: ${formSelector}' };
        let btn;
        if (${JSON.stringify(buttonSelector)}) {
          btn = form.querySelector(${JSON.stringify(buttonSelector)}) || document.querySelector(${JSON.stringify(buttonSelector)});
        } else {
          btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        }
        if (!btn) return { ok: false, error: 'Submit button not found' };

        form.__qaSubmitSeen = false;
        form.addEventListener('submit', () => { form.__qaSubmitSeen = true; }, true);

        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();

        return {
          ok: true,
          submitFired: form.__qaSubmitSeen === true,
          tag: btn.tagName,
          text: btn.innerText?.substring(0,50),
        };
      })()`);
    } catch (e) {
      return toolError(pageErrorMessage(formSelector, e.message), { formSelector, ok: false });
    }
    if (!data?.ok) {
      return toolError(data?.error || 'Submit failed', { formSelector, ok: false });
    }

    await new Promise(r => setTimeout(r, 300));

    // 2) Confirma o resultado: submit disparou de verdade, ou a URL mudou, ou
    //    um alvo/visitante de requestStart (fetch/XHR) saiu do form.
    //    Se nao houve evidencia nenhuma, a tool NAO mente: reporta que o
    //    submit nao aconteceu.
    let after = null;
    try {
      after = await evalPage(sid, `(() => ({
        submitFired: document.querySelector(${JSON.stringify(formSelector)})?.__qaSubmitSeen === true,
        url: location.href,
        pending: !!window.__qaFormRequests,
      }))()`);
    } catch { /* ignora: a evidencia principal é o submitFired */ }

    const submitFired = Boolean(data.submitFired || after?.submitFired);
    if (!submitFired) {
      return toolError('Submit did not fire — no submit event on the form', {
        formSelector, ok: false, button: data.text,
      });
    }

    return ok(JSON.stringify({
      submitted: true,
      button: data.text,
      evidence: submitFired ? 'submit_event' : 'none',
      url: after?.url,
    }));
  });

  // ========== NEW: GET NETWORK REQUESTS ==========

  registerTool('get_network_activity', {
    description: 'Get recent network requests from the browser, one entry per request: requestId, method, url, resourceType, status, state, headersMs, durationMs, size, bytesReceived, postData. Call action="start" first, then action="get". state: sent (no response yet) | receiving (headers arrived, but Chrome has not reported the end of loading; this is what happens to a fetch POST whose body the page never reads, so durationMs/size stay empty and headersMs/bytesReceived tell what is known) | finished | failed | redirected (a redirect hop; redirectedTo has the next URL). Times come from the Chrome clock: headersMs = request sent to response headers, durationMs = request sent to end of loading.',
    inputSchema: z.object({
      action: z.enum(['start', 'get', 'clear', 'stop']).default('get').describe('start=begin capture (empties the buffer), get=retrieve, clear=empty the buffer and keep capturing, stop=stop capturing'),
      filterUrl: z.string().default('').describe('Filter by URL pattern (empty = all)'),
      maxEntries: z.number().default(30).describe('Max entries to return'),
    }),
  }, async ({ action, filterUrl, maxEntries }) => {
    const sid = await requireSession();

    // Use backend endpoints for network tracking (CDP-based)
    if (action === 'start') {
      const data = await api('POST', `/api/network/${sid}/start`);
      return ok(data.message || 'Network capture started');
    }
    // clear esvazia e segue capturando; stop desliga. Antes o clear chamava o
    // /stop e respondia "buffer cleared" sem esvaziar nada.
    if (action === 'clear') {
      const data = await api('POST', `/api/network/${sid}/clear`);
      return ok(data.message || 'Network buffer cleared');
    }
    if (action === 'stop') {
      const data = await api('POST', `/api/network/${sid}/stop`);
      return ok(data.message || 'Network tracking stopped');
    }

    // action === 'get' - retrieve network activity
    const data = await api('GET', `/api/network/${sid}`);
    if (!data || !data.enabled) {
      return ok(JSON.stringify({ count: 0, entries: [], message: 'Network tracking not enabled. Use action="start" first.' }, null, 2));
    }

    // Uma entrada por requisição. O backend atualiza a MESMA entrada quando a
    // resposta e o fim do carregamento chegam. A chave inclui o timestamp do
    // Chrome porque um redirect REUSA o requestId: só pelo id, o salto e o
    // destino viravam uma entrada só (e o destino sumia).
    const seen = new Set();
    let entries = [];
    for (const req of (data.requests || [])) {
      const key = req.requestId ? `${req.requestId}|${req.cdpTimestamp ?? req.timestamp}` : `${req.url}|${req.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        requestId: req.requestId || null,
        method: req.method || '',
        url: req.url || req.urlFragment || '',
        resourceType: req.type || '',
        timestamp: req.timestamp,
        state: req.state || (req.failed ? 'failed' : req.finished ? 'finished' : req.status ? 'receiving' : 'sent'),
        status: req.status ?? null,
        statusText: req.statusText || undefined,
        mimeType: req.mimeType || undefined,
        headersMs: req.headersMs,
        durationMs: req.durationMs,
        size: req.size,
        bytesReceived: req.bytesReceived,
        ...(req.redirectedTo ? { redirectedTo: req.redirectedTo } : {}),
        ...(req.postData ? { postData: req.postData } : {}),
        ...(req.failed ? { failed: true, errorText: req.errorText } : {}),
      });
    }

    // Filter and limit entries
    if (filterUrl) {
      entries = entries.filter(e => e.url.includes(filterUrl));
    }
    entries = entries.slice(-maxEntries);

    const out = { count: entries.length, entries };
    const open = entries.filter((e) => e.state === 'receiving').length;
    if (open) {
      out.note = `${open} request(s) in state "receiving": the response headers arrived but Chrome has not reported the end of loading. A fetch POST whose response body the page never reads stays like this forever. headersMs and bytesReceived are what is known.`;
    }
    return ok(JSON.stringify(out, null, 2));
  });

  // ========== NEW: SCREENSHOT WITH DELAY ==========

  registerTool('screenshot_after', {
    description: 'Take a screenshot after waiting a specified delay. Useful for capturing after animations, transitions, or async renders. Returns the JPEG image plus a text block with the image size, byte count, sha256 prefix and an image link (valid ~10 minutes, no API key needed) — same as screenshot.',
    inputSchema: z.object({
      delayMs: z.number().default(1000).describe('Delay before screenshot (ms)'),
    }),
  }, async ({ delayMs }) => {
    const sid = await requireSession();
    await new Promise(r => setTimeout(r, delayMs));
    const data = await api('GET', `/api/screenshotWithInfo/${sid}`);
    return screenshotResult(data, sid);
  });

  // ========== UTILITY TOOLS ==========

  registerTool('health', {
    description: 'Check if backend is online and auth is valid. Use to diagnose connection issues.',
    inputSchema: z.object({}),
  }, async () => {
    try {
      const healthRes = await fetch(`${SERENDE_API}/api/health`);
      const healthData = await healthRes.json();
      let authStatus = 'not_authenticated';
      let tenantId = 'unknown';
      try {
        const apiKey = getCurrentApiKey();
        tenantId = deriveTenantId(apiKey);
        await ensureAuth(apiKey);
        authStatus = 'authenticated';
      } catch (e) {
        authStatus = `auth_failed: ${e.message}`;
      }
      // Multi-sessão: o health passa a informar quantas sessões do tenant este
      // MCP conhece e qual é a corrente (antes cravava o id único).
      const rec = sessionCache.get(tenantId);
      const cur = effectiveCurrent(tenantId);
      return ok(JSON.stringify({
        backend: healthData,
        auth: authStatus,
        tenantId,
        currentSession: cur || 'none',
        tenantSessions: rec ? rec.sessions.size : 0,
        activeTenants: sessionCache.size,
        apiUrl: SERENDE_API,
      }, null, 2));
    } catch (e) {
      return ok(`Backend unreachable: ${e.message}. API URL: ${SERENDE_API}`);
    }
  });

  return server;
}

// --- HTTP Streamable MCP Transport (per-session) ---

const app = express();
app.use(cors());
app.use(express.json());

// sessionId → { transport, server, tenantId }. O tenantId é o DONO da sessão:
// sem ele, qualquer X-API-Key válida reaproveitaria a sessão de outro tenant.
const transports = new Map();

function requireApiKey(req, res, next) {
  // Header obrigatório, sem fallback de ambiente: o MCP não guarda chave
  // própria (não carrega o .env do server), então requisição sem X-API-Key
  // é recusada com 401.
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'X-API-Key header required' });
  }
  req.apiKey = apiKey;
  req.tenantId = deriveTenantId(apiKey);
  next();
}

function withTenantContext(handler) {
  return (req, res) => {
    // connId = o mcp-session-id desta requisição. É o que faz a "sessão
    // corrente" ser por CONEXÃO (ver o bloco connCurrent): dois sub-agentes
    // com a mesma chave, cada um no seu mcp-session-id, têm correntes
    // separadas — e por isso não se cruzam. No initialize o header ainda não
    // existe, e o fallback é 'no-session' (a corrente por tenant).
    const connId = req.headers['mcp-session-id'] || null;
    // publicBase: host público pelo qual o agente chegou (Host / x-forwarded-*).
    // É com ele que a URL da captura de tela é montada.
    const publicBase = publicBaseOf(req);
    tenantContext.run({ apiKey: req.apiKey, tenantId: req.tenantId, connId, publicBase }, () => handler(req, res));
  };
}

// Isolamento por tenant: cada sessão MCP pertence ao tenant que a criou.
// Reaproveitar a sessão de outro tenant seria session hijacking — o tenant B
// passaria a operar o browser do tenant A (e GET/DELETE ainda derrubariam a
// sessão alheia). Sessão sem dono legível (sem tenantId) também é recusada.
//   → { ok: true, entry }                  sessão existe e é do tenant da requisição
//   → { ok: false, reason: 'not_found' }  sessão não existe
//   → { ok: false, reason: 'not_owner' }  sessão existe, mas é de outro tenant
function lookupSession(sessionId, tenantId) {
  if (!sessionId) return { ok: false, reason: 'not_found' };
  const entry = transports.get(sessionId);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (!entry.tenantId || entry.tenantId !== tenantId) return { ok: false, reason: 'not_owner' };
  return { ok: true, entry };
}

app.post('/mcp', requireApiKey, withTenantContext(async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const found = lookupSession(sessionId, req.tenantId);

  if (found.ok) {
    await found.entry.transport.handleRequest(req, res, req.body);
    return;
  }
  if (found.reason === 'not_owner') {
    // A sessão existe mas é de outro tenant: recusa sem entregar nada dela.
    return res.status(403).json({ error: 'Session does not belong to this tenant' });
  }

  // New session — create transport + server
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = createServer();
  await server.connect(transport);

  // Store by the session ID that the transport generates
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      // Dono lido ANTES do delete (depois a entrada já saiu do Map).
      const ownerTenant = transports.get(sid)?.tenantId;
      transports.delete(sid);
      // A conexão morreu: a corrente dela não pode ficar no Map — viraria
      // vazamento (e, se o mcp-session-id for reaproveitado, ressuscitaria uma
      // escolha antiga). As SESSÕES em si ficam: são do tenant, não da conexão.
      // Aqui NÃO há tenantContext (o onclose roda fora do request), por isso a
      // limpeza é pelo dono registrado no `transports`.
      if (ownerTenant) connCurrent.delete(connKeyOf(ownerTenant, sid));
      console.log(`[MCP] Session closed: ${sid} (active: ${transports.size})`);
    }
  };

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    transports.set(transport.sessionId, { transport, server, tenantId: req.tenantId });
    console.log(`[MCP] New session: ${transport.sessionId} (active: ${transports.size})`);
  }
}));

app.get('/mcp', requireApiKey, withTenantContext(async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const found = lookupSession(sessionId, req.tenantId);
  if (!found.ok) {
    if (found.reason === 'not_owner') {
      return res.status(403).json({ error: 'Session does not belong to this tenant' });
    }
    return res.status(400).json({ error: 'Invalid or missing session. Send initialize first via POST.' });
  }
  await found.entry.transport.handleRequest(req, res);
}));

app.delete('/mcp', requireApiKey, withTenantContext(async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const found = lookupSession(sessionId, req.tenantId);
  if (!found.ok) {
    if (found.reason === 'not_owner') {
      return res.status(403).json({ error: 'Session does not belong to this tenant' });
    }
    return res.status(400).json({ error: 'Invalid or missing session.' });
  }
  await found.entry.transport.handleRequest(req, res);
  // Só o dono encerra a sessão — o delete de outro tenant nem chega aqui.
  transports.delete(sessionId);
}));

// JSON-RPC proxy: intercept SSE and return plain JSON (for orquestrador compatibility)

// Sessões MCP criadas por este proxy. O cliente reenvia o mcp-session-id na
// chamada seguinte; o proxy repassa esse id ao transporte interno para que a
// mesma sessão seja reutilizada. Só ids emitidos por aqui são aceitos — um id
// arbitrário é recusado, não repassado cegamente. Cada id guarda o tenant que
// o criou: reenviar o id de outro tenant é recusado (403), senão o proxy
// entregaria a sessão alheia.
const proxySessions = new Map(); // sessionId → tenantId

app.post('/mcp/json', async (req, res) => {
  // Auth: o cliente precisa enviar a própria chave (mesma exigência da rota /mcp).
  // Sem fallback de ambiente ou chave hardcoded: o proxy não pode se autenticar
  // como o próprio servidor.
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'X-API-Key header required' });
  }
  const tenantId = deriveTenantId(apiKey);

  // Sessão: id emitido pelo proxy numa chamada anterior (o initialize não traz).
  const clientSessionId = req.headers['mcp-session-id'];
  if (clientSessionId) {
    const owner = proxySessions.get(clientSessionId);
    if (!owner) {
      return res.status(404).json({
        error: 'Unknown mcp-session-id. Send initialize first via POST /mcp/json.',
      });
    }
    if (owner !== tenantId) {
      // A sessão pertence a outro tenant: recusa sem repassar o id ao
      // transporte interno (lá a checagem de dono é a mesma).
      return res.status(403).json({ error: 'Session does not belong to this tenant' });
    }
  }

  try {
    // Forward all headers from the original request
    const forwardHeaders = {
      'Content-Type': 'application/json',
      // O transporte StreamableHTTP do SDK exige que o Accept liste application/json
      // E text/event-stream. Repassa o Accept do cliente quando ele já cumpre o
      // requisito; caso contrário usa o par canônico.
      'Accept':
        req.headers.accept &&
        req.headers.accept.includes('application/json') &&
        req.headers.accept.includes('text/event-stream')
          ? req.headers.accept
          : 'application/json, text/event-stream',
      'X-API-Key': apiKey,
    };

    // Repassa o id da sessão: sem ele o transporte interno abriria uma sessão
    // nova a cada chamada e a seguinte seria rejeitada ("Server not initialized").
    if (clientSessionId) {
      forwardHeaders['mcp-session-id'] = clientSessionId;
    }

    const resp = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(req.body),
    });
    const text = await resp.text();

    // Devolve ao cliente o mcp-session-id emitido pelo transporte interno: é o
    // id que ele precisa reenviar para continuar na mesma sessão.
    const issuedSessionId = resp.headers.get('mcp-session-id') || clientSessionId;
    if (issuedSessionId) {
      // Sessão encerrada no servidor interno não pode ser reusada: descarta os
      // ids mortos para o registro não crescer sem limite. (A entrada do
      // transporte é criada antes de a resposta chegar, então um id novo nunca
      // é descartado aqui.)
      for (const sid of proxySessions.keys()) {
        if (!transports.has(sid)) proxySessions.delete(sid);
      }
      proxySessions.set(issuedSessionId, tenantId);
      res.setHeader('Mcp-Session-Id', issuedSessionId);
    }

    // Parse SSE: extract data lines
    const lines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    if (lines.length > 0) {
      const parsed = JSON.parse(lines[lines.length - 1]);
      return res.json(parsed);
    }
    // Notificação (ex.: notifications/initialized) não tem corpo: o transporte
    // responde 202. Repassa o status em vez de tentar parsear um JSON vazio.
    if (!text.trim()) {
      return res.status(resp.status).end();
    }
    // Try direct JSON parse
    const json = JSON.parse(text);
    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /mcp/screenshot/:captureId?token=...&exp=...
//
// Serve a captura que a tool `screenshot` criou. A URL é a credencial (padrão
// de URL pré-assinada): quem tiver o token válido vê a imagem até o prazo,
// sem header e sem chave de API — é o que permite ao agente baixar a tela
// quando o cliente dele descarta o bloco `image` do resultado da tool.
//
// Fora do prazo: 410 com instrução de tirar um novo screenshot.
app.get('/mcp/screenshot/:captureId', (req, res) => {
  const { captureId } = req.params;
  const token = String(req.query.token || '');
  const exp = Number(req.query.exp);

  if (!/^[0-9a-f]{32}$/.test(String(captureId)) || !token || !Number.isFinite(exp)) {
    return res.status(400).json({ error: 'Invalid image link' });
  }
  if (exp <= Date.now()) {
    return res.status(410).json({ error: 'This image link has expired. Take a new screenshot.' });
  }

  // Comparação em tempo constante: o token é a credencial.
  const expected = Buffer.from(captureToken(captureId, exp));
  const given = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(403).json({ error: 'Invalid image token' });
  }

  const cap = captureStore.get(captureId);
  if (!cap) {
    return res.status(410).json({ error: 'Image no longer available (expired, or the MCP restarted). Take a new screenshot.' });
  }
  if (cap.expiresAt <= Date.now()) {
    captureStore.delete(captureId);
    return res.status(410).json({ error: 'Image expired. Take a new screenshot.' });
  }

  // Se o cliente mandar a chave de API junto, ela tem que ser a MESMA que
  // criou a captura. Sem header, basta o token (padrão de URL pré-assinada).
  const apiKey = req.headers['x-api-key'];
  if (apiKey && deriveTenantId(apiKey) !== cap.tenantId) {
    return res.status(403).json({ error: 'Image belongs to another tenant' });
  }

  res.set('Content-Type', cap.mime || 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(cap.buf);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: transports.size });
});

app.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`[Serende MCP] http://0.0.0.0:${MCP_PORT}/mcp`);
  console.log(`[Serende MCP] Backend: ${SERENDE_API}`);
});
