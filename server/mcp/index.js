import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import dotenv from 'dotenv';

import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env'), override: true });

const SERENDE_API = process.env.SERENDE_API || 'http://localhost:4201';
const SERENDE_PUBLIC_URL = process.env.SERENDE_PUBLIC_URL || 'https://serende.ddw1sl.easypanel.host';
const MCP_PORT = parseInt(process.env.MCP_PORT) || 4202;

// --- State ---
// tokenCache é global (cache de autenticação, seguro compartilhar)
// tenantSessions é por-instância (movido para dentro de createServer)
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
    throw new Error(`API ${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
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

function createServer() {
  // Isolado por instância — cada conexão MCP tem seu próprio estado de sessão
  const tenantSessions = new Map();  // tenantId → sessionId

  function requireSession() {
    const tenantId = getCurrentTenantId();
    const sessionId = tenantSessions.get(tenantId);
    if (!sessionId) throw new Error('No active session for this tenant. Use session_start first.');
    return sessionId;
  }

  const server = new McpServer({
    name: 'serende-browser',
    version: '3.0.0',
  });

  // ========== SESSION TOOLS ==========

  server.registerTool('session_start', {
    description: 'Start a new remote browser session. Must be called before any other tool. Returns sessionId.',
    inputSchema: z.object({
      resolution: z.string().default('1280x720').describe('Screen resolution WxH'),
      startUrl: z.string().default('https://www.google.com').describe('URL to open on start'),
    }),
  }, async ({ resolution, startUrl }) => {
    const tenantId = getCurrentTenantId();
    if (tenantSessions.has(tenantId)) {
      const existingId = tenantSessions.get(tenantId);
      const viewerUrl = `${SERENDE_PUBLIC_URL}?session=${existingId}`;
      return ok(JSON.stringify({ sessionId: existingId, status: 'already_active', viewerUrl, message: 'Session already active. Stop it first or use this one.' }, null, 2));
    }
    const data = await api('POST', '/api/session', { resolution, startUrl });
    tenantSessions.set(tenantId, data.sessionId);
    const viewerUrl = `${SERENDE_PUBLIC_URL}?session=${data.sessionId}`;
    return ok(JSON.stringify({ sessionId: data.sessionId, status: data.status, resolution: data.resolution, viewerUrl }, null, 2));
  });

  server.registerTool('session_stop', {
    description: 'Stop the current browser session and free resources.',
    inputSchema: z.object({}),
  }, async () => {
    const tenantId = getCurrentTenantId();
    const sid = requireSession();
    const data = await api('DELETE', `/api/session/${sid}`);
    tenantSessions.delete(tenantId);
    return ok(data.message || 'Session stopped');
  });

  server.registerTool('session_status', {
    description: 'Get status of current session (resolution, uptime, display).',
    inputSchema: z.object({}),
  }, async () => {
    const sid = requireSession();
    const data = await api('GET', `/api/session/${sid}`);
    return ok(JSON.stringify(data, null, 2));
  });

  server.registerTool('list_sessions', {
    description: 'List all active browser sessions for the current user.',
    inputSchema: z.object({}),
  }, async () => {
    const data = await api('GET', '/api/session');
    return ok(JSON.stringify(data, null, 2));
  });

  // ========== NAVIGATION TOOLS ==========

  server.registerTool('navigate', {
    description: 'Navigate the browser to a URL. Automatically waits for page load to complete before returning.',
    inputSchema: z.object({
      url: z.string().describe('Full URL to navigate to (e.g. https://google.com)'),
      waitForLoad: z.boolean().default(true).describe('Wait for page load (default true)'),
    }),
  }, async ({ url, waitForLoad }) => {
    const sid = requireSession();
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

  server.registerTool('get_url', {
    description: 'Get the current page URL.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = requireSession();
    const data = await api('GET', `/api/url/${sid}`);
    return ok(data.url || 'unknown');
  });

  // ========== SCREENSHOT ==========

  server.registerTool('screenshot', {
    description: 'Take a screenshot of the current browser screen. Returns JPEG image. Use this to see what is on screen before interacting.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = requireSession();
    const data = await api('GET', `/api/screenshot/${sid}`);
    if (data._image) {
      return {
        content: [{
          type: 'image',
          data: data._image,
          mimeType: data._mime || 'image/jpeg',
        }],
      };
    }
    return ok(JSON.stringify(data));
  });

  // ========== MOUSE TOOLS ==========

  server.registerTool('mouse_move', {
    description: 'Move mouse cursor to (x, y) coordinates.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'mousemove', x, y });
    return ok(`Moved to (${x}, ${y})`);
  });

  server.registerTool('mouse_click', {
    description: 'Click at (x, y). Use button 0=left, 1=middle, 2=right. Always take a screenshot first to know where to click.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x, y, button });
    return ok(`Clicked (${x}, ${y}) button=${button}`);
  });

  server.registerTool('mouse_double_click', {
    description: 'Double-click at (x, y).',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const sid = requireSession();
    await api('POST', '/api/input/batch', {
      sessionId: sid,
      actions: [
        { type: 'click', x, y, button: 0 },
        { type: 'click', x, y, button: 0 },
      ]
    });
    return ok(`Double-clicked (${x}, ${y})`);
  });

  server.registerTool('mouse_right_click', {
    description: 'Right-click at (x, y) to open context menu.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x, y, button: 2 });
    return ok(`Right-clicked (${x}, ${y})`);
  });

  server.registerTool('mouse_down', {
    description: 'Press mouse button down (for drag start).',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'mousedown', x, y, button });
    return ok(`Mouse down (${x}, ${y}) button=${button}`);
  });

  server.registerTool('mouse_up', {
    description: 'Release mouse button (for drag end).',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'mouseup', x, y, button });
    return ok(`Mouse up (${x}, ${y}) button=${button}`);
  });

  server.registerTool('scroll', {
    description: 'Scroll at (x, y). Positive deltaY = scroll down, negative = scroll up. One notch = 120.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      deltaY: z.number().describe('Scroll amount. 120=one notch down, -120=one notch up'),
    }),
  }, async ({ x, y, deltaY }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'scroll', x, y, deltaY });
    return ok(`Scrolled at (${x}, ${y}) deltaY=${deltaY}`);
  });

  server.registerTool('drag', {
    description: 'Drag from (fromX, fromY) to (toX, toY) with smooth interpolation. Generates intermediate mousemove events so canvas, sliders, and drag-and-drop work correctly.',
    inputSchema: z.object({
      fromX: z.number().describe('Start X'),
      fromY: z.number().describe('Start Y'),
      toX: z.number().describe('End X'),
      toY: z.number().describe('End Y'),
      steps: z.number().default(0).describe('Number of intermediate points (0 = auto-calculate based on distance, ~1 point per 15px)'),
    }),
  }, async ({ fromX, fromY, toX, toY, steps }) => {
    const sid = requireSession();
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

  server.registerTool('key_press', {
    description: 'Press and release a key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, F1-F12, or any character).',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    const sid = requireSession();
    await api('POST', '/api/input/batch', {
      sessionId: sid,
      actions: [
        { type: 'keydown', key },
        { type: 'keyup', key },
      ]
    });
    return ok(`Pressed: ${key}`);
  });

  server.registerTool('key_down', {
    description: 'Hold a key down. Use with key_up for combos like Ctrl+C.',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'keydown', key });
    return ok(`Key down: ${key}`);
  });

  server.registerTool('key_up', {
    description: 'Release a held key.',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'keyup', key });
    return ok(`Key up: ${key}`);
  });

  server.registerTool('type_text', {
    description: 'Type text into the focused field. For texts > 3 chars, uses clipboard paste (fast). For short texts or when humanized=true, types char-by-char with realistic delay. Always verifies the result.',
    inputSchema: z.object({
      text: z.string().describe('Text to type'),
      humanized: z.boolean().default(false).describe('Force char-by-char typing with delay (for autocomplete fields)'),
      delayMs: z.number().default(80).describe('Delay between chars in humanized mode (ms)'),
    }),
  }, async ({ text, humanized, delayMs }) => {
    const sid = requireSession();

    if (!humanized && text.length > 3) {
      const result = await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
          ${REACT_SET_VALUE_JS}
          const el = document.activeElement;
          if (!el || (!el.value && el.value !== '' && !el.isContentEditable)) return { ok: false, reason: 'no_active_input' };
          if (el.isContentEditable) {
            document.execCommand('insertText', false, ${JSON.stringify(text)});
            return { ok: true, method: 'execCommand' };
          }
          reactSetValue(el, el.value + ${JSON.stringify(text)});
          return { ok: true, method: 'react_set', value: el.value };
        })()`,
      });
      if (result.result?.ok) {
        return ok(`Typed (paste): "${text}" — method: ${result.result.method}`);
      }
    }

    for (const ch of text) {
      await api('POST', '/api/input/batch', {
        sessionId: sid,
        actions: [
          { type: 'keydown', key: ch },
          { type: 'keyup', key: ch },
        ]
      });
      if (humanized) await new Promise(r => setTimeout(r, delayMs));
    }
    return ok(`Typed (keys): "${text}"`);
  });

  server.registerTool('hotkey', {
    description: 'Press a keyboard shortcut. Keys pressed in order, released in reverse. Example: ["Control", "a"] for Ctrl+A.',
    inputSchema: z.object({
      keys: z.array(z.string()).describe('Array of key names, e.g. ["Control", "c"]'),
    }),
  }, async ({ keys }) => {
    const sid = requireSession();
    const actions = [];
    for (const k of keys) actions.push({ type: 'keydown', key: k });
    for (const k of [...keys].reverse()) actions.push({ type: 'keyup', key: k });
    await api('POST', '/api/input/batch', { sessionId: sid, actions });
    return ok(`Hotkey: ${keys.join('+')}`);
  });

  // ========== JS EXECUTION ==========

  server.registerTool('evaluate_js', {
    description: 'Execute JavaScript in the browser page and return the result. Powerful for complex interactions, reading DOM, etc.',
    inputSchema: z.object({
      script: z.string().describe('JavaScript to execute in browser context'),
    }),
  }, async ({ script }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, { script });
    return ok(JSON.stringify(data.result ?? data, null, 2));
  });

  // ========== PAGE INSPECTION TOOLS ==========

  server.registerTool('get_page_title', {
    description: 'Get the current page title.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, { script: 'document.title' });
    return ok(data.result ?? 'untitled');
  });

  server.registerTool('get_page_text', {
    description: 'Get all visible text from the page. Useful to understand page content without a screenshot.',
    inputSchema: z.object({
      maxLength: z.number().default(5000).describe('Max chars to return (default 5000)'),
    }),
  }, async ({ maxLength }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `document.body.innerText.substring(0, ${maxLength})`,
    });
    return ok(data.result ?? '');
  });

  server.registerTool('get_page_html', {
    description: 'Get HTML of the page or a specific element. Useful for understanding DOM structure.',
    inputSchema: z.object({
      selector: z.string().default('body').describe('CSS selector (default: body)'),
      outer: z.boolean().default(false).describe('Return outerHTML (true) or innerHTML (false)'),
    }),
  }, async ({ selector, outer }) => {
    const sid = requireSession();
    const prop = outer ? 'outerHTML' : 'innerHTML';
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.${prop}.substring(0, 10000) : null; })()`,
    });
    if (data.result === null) return ok(`Element not found: ${selector}`);
    return ok(data.result);
  });

  server.registerTool('find_element', {
    description: 'Find an element by CSS selector. Returns position (x, y, width, height), text, tag, and attributes. Automatically scrolls element into view if off-screen.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector (e.g. "#login-btn", ".submit", "input[name=email]")'),
      scrollToView: z.boolean().default(true).describe('Scroll element into view if off-screen (default true)'),
    }),
  }, async ({ selector, scrollToView }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const wasOffscreen = r.top < 0 || r.bottom > window.innerHeight;
        if (${scrollToView} && wasOffscreen) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
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
      })()`,
    });
    if (data.result === null) return ok(`Element not found: ${selector}`);
    return ok(JSON.stringify(data.result, null, 2));
  });

  server.registerTool('find_all_elements', {
    description: 'Find all elements matching a CSS selector. Returns array of {tag, text, x, y, width, height}. Max 20 results.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector'),
      maxResults: z.number().default(20).describe('Max results (default 20)'),
    }),
  }, async ({ selector, maxResults }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
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
      })()`,
    });
    return ok(JSON.stringify(data.result ?? { count: 0, results: [] }, null, 2));
  });

  server.registerTool('find_element_by_text', {
    description: 'Find a clickable element by its visible text. Searches buttons, links, and other interactive elements. Returns coordinates for clicking.',
    inputSchema: z.object({
      text: z.string().describe('Text to search for (case-insensitive, partial match)'),
      tag: z.string().default('*').describe('Optional tag filter: button, a, input, * for any'),
    }),
  }, async ({ text, tag }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
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
      })()`,
    });
    if (data.result === null) return ok(`No clickable element found with text: "${text}"`);
    return ok(JSON.stringify(data.result, null, 2));
  });

  server.registerTool('wait_for_element', {
    description: 'Wait for an element to appear on the page (polls every 500ms). Returns element info when found or error on timeout.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector to wait for'),
      timeoutMs: z.number().default(10000).describe('Max wait time in ms (default 10000)'),
    }),
  }, async ({ selector, timeoutMs }) => {
    const sid = requireSession();
    const maxAttempts = Math.ceil(timeoutMs / 500);
    for (let i = 0; i < maxAttempts; i++) {
      const data = await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
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
        })()`,
      });
      if (data.result) return ok(JSON.stringify(data.result, null, 2));
      await new Promise(r => setTimeout(r, 500));
    }
    return ok(`Timeout: element "${selector}" not found after ${timeoutMs}ms`);
  });

  // ========== HIGH-LEVEL TOOLS ==========

  server.registerTool('wait_for_page_ready', {
    description: 'Wait for page to be fully loaded and interactive. Checks document.readyState, DOM stability, pending fetches, React hydration, and SPA routing. Works with Next.js, React Router, Vue Router, etc.',
    inputSchema: z.object({
      timeoutMs: z.number().default(15000).describe('Max wait time (ms)'),
      checkNetwork: z.boolean().default(true).describe('Wait for network idle (default true)'),
      stabilityMs: z.number().default(500).describe('DOM stability duration (ms)'),
    }),
  }, async ({ timeoutMs, checkNetwork, stabilityMs }) => {
    const sid = requireSession();
    const start = Date.now();
    let lastDomState = '';
    let stableSince = null;

    while (Date.now() - start < timeoutMs) {
      const result = await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
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
        })()`,
      });

      const state = result.result;
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
    return ok(JSON.stringify({ ready: false, timeout: true, elapsed: timeoutMs }));
  });

  server.registerTool('click_element', {
    description: 'Click an element by CSS selector. Scrolls element into view first, then clicks. Waits a bit after click for UI to respond.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of element to click'),
      button: z.number().default(0).describe('0=left, 1=middle, 2=right'),
    }),
  }, async ({ selector, button }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
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
      })()`,
    });
    if (!data.result?.found) return ok(`Element not found: ${selector}`);

    if (data.result.method === 'x11') {
      await api('POST', '/api/input', {
        sessionId: sid,
        type: 'click',
        x: data.result.x,
        y: data.result.y,
        button,
      });
    }
    await new Promise(r => setTimeout(r, 300));
    return ok(`Clicked "${selector}" at (${data.result.x}, ${data.result.y})`);
  });

  server.registerTool('scroll_to_element', {
    description: 'Scroll the page to bring an element into view. Does NOT click.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of element'),
      block: z.string().default('center').describe('vertical align: start, center, end, nearest'),
    }),
  }, async ({ selector, block }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(block)} });
        const r = el.getBoundingClientRect();
        return {
          found: true,
          nowVisible: r.top >= 0 && r.top <= window.innerHeight,
          y: Math.round(r.top)
        };
      })()`,
    });
    if (!data.result?.found) return ok(`Element not found: ${selector}`);
    return ok(`Scrolled to "${selector}" (now visible: ${data.result.nowVisible}, y: ${data.result.y})`);
  });

  server.registerTool('clipboard_write', {
    description: 'Write text to clipboard via JavaScript. Useful for copy/paste workflows.',
    inputSchema: z.object({
      text: z.string().describe('Text to copy to clipboard'),
    }),
  }, async ({ text }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => ({ ok: true, method: 'async' })).catch(e => ({ ok: false, error: String(e) }));
        }
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = ${JSON.stringify(text)};
        document.body.appendChild(ta);
        ta.select();
        const success = document.execCommand('copy');
        document.body.removeChild(ta);
        return { ok: success, method: 'execCommand' };
      })()`,
    });
    if (data.result?.ok) return ok(`Copied to clipboard: "${text}"`);
    return ok(`Failed to copy: ${data.result?.error || 'unknown'}`);
  });

  server.registerTool('clipboard_read', {
    description: 'Read text from clipboard via JavaScript.',
    inputSchema: z.object({}),
  }, async () => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        if (navigator.clipboard && navigator.clipboard.readText) {
          return navigator.clipboard.readText().then(text => ({ ok: true, text })).catch(e => ({ ok: false, error: String(e) }));
        }
        return { ok: false, error: 'clipboard API not available' };
      })()`,
    });
    if (data.result?.ok) return ok(`Clipboard: "${data.result.text}"`);
    return ok(`Failed to read: ${data.result?.error || 'unknown'}`);
  });

  server.registerTool('fill_form', {
    description: 'Fill multiple form fields at once. React/Vue/Angular compatible. Each field: { selector, value, type } where type=text|select|checkbox|radio. For text fields, clicks first then sets value with proper React event simulation.',
    inputSchema: z.object({
      fields: z.array(z.object({
        selector: z.string().describe('CSS selector'),
        value: z.union([z.string(), z.boolean(), z.array(z.string())]).describe('Value to set'),
        type: z.string().default('text').describe('text, select, checkbox, radio'),
      })).describe('Array of fields to fill'),
    }),
  }, async ({ fields }) => {
    const sid = requireSession();
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
            ${REACT_SET_VALUE_JS}
            const el = document.querySelector(${JSON.stringify(field.selector)});
            if (!el) return { ok: false, error: 'not_found' };
            if (el.tagName === 'SELECT') {
              reactSetValue(el, ${JSON.stringify(value)});
              return { ok: true, value: el.value };
            }
            // Custom select — click to open, find option by text
            el.click();
            return { ok: true, method: 'click_to_open', note: 'Custom select opened. Use click_by_text to pick option.' };
          })()`,
        });
        results.push({ selector: field.selector, ok: r.result?.ok, value });
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

  server.registerTool('click_and_type', {
    description: 'Click at (x, y), wait for focus, then type text. Use clearFirst=true to clear existing text first. Better than separate click+type.',
    inputSchema: z.object({
      x: z.number().describe('X coordinate to click'),
      y: z.number().describe('Y coordinate to click'),
      text: z.string().describe('Text to type'),
      clearFirst: z.boolean().default(false).describe('Select all and delete before typing'),
      focusDelayMs: z.number().default(200).describe('Wait after click before typing (ms)'),
    }),
  }, async ({ x, y, text, clearFirst, focusDelayMs }) => {
    const sid = requireSession();
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x, y, button: 0 });
    await new Promise(r => setTimeout(r, focusDelayMs));

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
        ]
      });
      await new Promise(r => setTimeout(r, 100));
    }

    if (text.length > 3) {
      const result = await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
          ${REACT_SET_VALUE_JS}
          const el = document.activeElement;
          if (!el || (!el.value && el.value !== '' && !el.isContentEditable)) return { ok: false, reason: 'no_active_input' };
          if (el.isContentEditable) {
            document.execCommand('insertText', false, ${JSON.stringify(text)});
            return { ok: true, method: 'execCommand' };
          }
          reactSetValue(el, (clearFirst ? '' : el.value) + ${JSON.stringify(text)});
          return { ok: true, method: 'react_set' };
        })()`,
      });
      if (result.result?.ok) {
        return ok(`Clicked (${x},${y}) and pasted "${text}"`);
      }
    }

    for (const ch of text) {
      await api('POST', '/api/input/batch', {
        sessionId: sid,
        actions: [
          { type: 'keydown', key: ch },
          { type: 'keyup', key: ch },
        ]
      });
    }
    return ok(`Clicked (${x},${y}) and typed "${text}"`);
  });

  // ========== NEW: CLICK BY TEXT (robust) ==========

  server.registerTool('click_by_text', {
    description: 'Find an element by visible text and click it. Searches ALL elements (not just buttons/links). Much more robust than find_element_by_text + mouse_click. Supports data-testid fallback.',
    inputSchema: z.object({
      text: z.string().describe('Text to search for (case-insensitive, partial match)'),
      tag: z.string().default('*').describe('Optional tag filter: button, a, div, span, * for any'),
      exact: z.boolean().default(false).describe('Require exact text match (not partial)'),
      index: z.number().default(0).describe('Which match to click if multiple found (0-based)'),
    }),
  }, async ({ text, tag, exact, index }) => {
    const sid = requireSession();
    // Find + scroll + click all in one JS evaluation for reliability
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
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
      })()`,
    });
    if (!data.result) return ok(`No element found with text: "${text}"`);
    await new Promise(r => setTimeout(r, 300));
    return ok(JSON.stringify(data.result));
  });

  // ========== NEW: WAIT FOR URL ==========

  server.registerTool('wait_for_url', {
    description: 'Wait for the URL to change or match a pattern. Essential for SPA navigation (React Router, Next.js, etc.) where page doesn\'t reload.',
    inputSchema: z.object({
      url: z.string().default('').describe('URL or partial URL to match. Empty = wait for any URL change.'),
      timeoutMs: z.number().default(10000).describe('Max wait time (ms)'),
    }),
  }, async ({ url, timeoutMs }) => {
    const sid = requireSession();
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
    return ok(JSON.stringify({ timeout: true, currentUrl: finalUrl, elapsed: timeoutMs }));
  });

  // ========== NEW: WAIT FOR TEXT ==========

  server.registerTool('wait_for_text', {
    description: 'Wait for specific text to appear on the page. Useful after form submissions, navigation, or async data loads.',
    inputSchema: z.object({
      text: z.string().describe('Text to wait for (case-insensitive)'),
      timeoutMs: z.number().default(10000).describe('Max wait time (ms)'),
      selector: z.string().default('body').describe('Scope search to this CSS selector (default: body)'),
    }),
  }, async ({ text, timeoutMs, selector }) => {
    const sid = requireSession();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          const content = el.innerText || el.textContent || '';
          return { found: content.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}), length: content.length };
        })()`,
      });
      if (data.result?.found) return ok(JSON.stringify({ found: true, elapsed: Date.now() - start }));
      await new Promise(r => setTimeout(r, 400));
    }
    return ok(JSON.stringify({ found: false, timeout: true, elapsed: timeoutMs }));
  });

  // ========== NEW: WAIT FOR SELECTOR GONE ==========

  server.registerTool('wait_for_selector_gone', {
    description: 'Wait for an element to disappear from the page (e.g., loading spinners, modals, overlays).',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of element to wait for disappearance'),
      timeoutMs: z.number().default(10000).describe('Max wait time (ms)'),
    }),
  }, async ({ selector, timeoutMs }) => {
    const sid = requireSession();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await api('POST', `/api/evaluate/${sid}`, {
        script: `!document.querySelector(${JSON.stringify(selector)})`,
      });
      if (data.result === true) return ok(JSON.stringify({ gone: true, elapsed: Date.now() - start }));
      await new Promise(r => setTimeout(r, 400));
    }
    return ok(JSON.stringify({ gone: false, timeout: true, elapsed: timeoutMs }));
  });

  // ========== NEW: GET CONSOLE MESSAGES ==========

  server.registerTool('get_console_messages', {
    description: 'Start capturing or retrieve browser console messages (log, error, warn, info). Call first to start capture, then call again to retrieve. Essential for debugging.',
    inputSchema: z.object({
      action: z.enum(['start', 'get', 'clear']).default('get').describe('start=begin capture, get=retrieve messages, clear=clear buffer'),
      maxMessages: z.number().default(50).describe('Max messages to return'),
    }),
  }, async ({ action, maxMessages }) => {
    const sid = requireSession();
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

  // ========== NEW: GET/SET COOKIES ==========

  server.registerTool('get_cookies', {
    description: 'Get all cookies for the current page. Returns array of {name, value, domain, path, expires}.',
    inputSchema: z.object({
      name: z.string().default('').describe('Filter by cookie name (empty = all)'),
    }),
  }, async ({ name }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        const pairs = document.cookie.split(';').map(c => c.trim()).filter(Boolean);
        const cookies = pairs.map(p => {
          const [n, ...v] = p.split('=');
          return { name: n.trim(), value: v.join('=') };
        });
        const filter = ${JSON.stringify(name)};
        return filter ? cookies.filter(c => c.name === filter) : cookies;
      })()`,
    });
    return ok(JSON.stringify(data.result || [], null, 2));
  });

  server.registerTool('set_cookie', {
    description: 'Set a cookie on the current page.',
    inputSchema: z.object({
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
      maxAge: z.number().default(86400).describe('Max age in seconds (default 1 day)'),
      path: z.string().default('/').describe('Cookie path'),
    }),
  }, async ({ name, value, maxAge, path }) => {
    const sid = requireSession();
    await api('POST', `/api/evaluate/${sid}`, {
      script: `document.cookie = ${JSON.stringify(`${name}=${value};max-age=${maxAge};path=${path}`)}`,
    });
    return ok(`Cookie set: ${name}=${value}`);
  });

  server.registerTool('delete_cookie', {
    description: 'Delete a cookie by name.',
    inputSchema: z.object({
      name: z.string().describe('Cookie name to delete'),
    }),
  }, async ({ name }) => {
    const sid = requireSession();
    await api('POST', `/api/evaluate/${sid}`, {
      script: `document.cookie = ${JSON.stringify(`${name}=;max-age=0;path=/`)}`,
    });
    return ok(`Cookie deleted: ${name}`);
  });

  // ========== NEW: GET ELEMENTS (structured) ==========

  server.registerTool('get_elements', {
    description: 'Get structured data about all elements matching a selector. Returns full attributes, computed styles, visibility, and hierarchy. Much richer than find_all_elements.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector'),
      maxResults: z.number().default(20).describe('Max results'),
      includeAttributes: z.boolean().default(true).describe('Include all HTML attributes'),
    }),
  }, async ({ selector, maxResults, includeAttributes }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
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
      })()`,
    });
    return ok(JSON.stringify(data.result || { total: 0, returned: 0, results: [] }, null, 2));
  });

  // ========== NEW: REACT FILL INPUT ==========

  server.registerTool('react_fill_input', {
    description: 'Fill an input field using React-compatible event simulation. Works with React Hook Form, Formik, controlled components, Radix UI, etc. Clicks the element, clears it, sets value, and triggers all necessary React events.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of the input (or data-testid like [data-testid="email"])'),
      value: z.string().describe('Value to set'),
      clearFirst: z.boolean().default(true).describe('Clear existing value first'),
    }),
  }, async ({ selector, value, clearFirst }) => {
    const sid = requireSession();
    // Find and click
    const findResult = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName, type: el.type };
      })()`,
    });
    if (!findResult.result) return ok(JSON.stringify({ ok: false, error: 'Element not found: ' + selector }));

    // Click to focus
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x: findResult.result.x, y: findResult.result.y, button: 0 });
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
    return ok(JSON.stringify(setResult.result || { ok: false, error: 'unknown' }));
  });

  // ========== NEW: SUBMIT FORM (React-aware) ==========

  server.registerTool('submit_form', {
    description: 'Submit a form by clicking its submit button. Finds the submit button automatically or by selector. Works with React onSubmit handlers.',
    inputSchema: z.object({
      formSelector: z.string().default('form').describe('CSS selector of the form'),
      buttonSelector: z.string().default('').describe('CSS selector of submit button (empty = auto-find)'),
    }),
  }, async ({ formSelector, buttonSelector }) => {
    const sid = requireSession();
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        const form = document.querySelector(${JSON.stringify(formSelector)});
        if (!form) return { ok: false, error: 'Form not found: ${formSelector}' };
        let btn;
        if (${JSON.stringify(buttonSelector)}) {
          btn = form.querySelector(${JSON.stringify(buttonSelector)}) || document.querySelector(${JSON.stringify(buttonSelector)});
        } else {
          btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        }
        if (!btn) return { ok: false, error: 'Submit button not found' };
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = btn.getBoundingClientRect();
        return { ok: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), tag: btn.tagName, text: btn.innerText?.substring(0,50) };
      })()`,
    });
    if (!data.result?.ok) return ok(JSON.stringify(data.result));
    // Click the submit button (triggers React onSubmit)
    await api('POST', '/api/input', { sessionId: sid, type: 'click', x: data.result.x, y: data.result.y, button: 0 });
    await new Promise(r => setTimeout(r, 500));
    return ok(JSON.stringify({ submitted: true, button: data.result.text, x: data.result.x, y: data.result.y }));
  });

  // ========== NEW: GET NETWORK REQUESTS ==========

  server.registerTool('get_network_activity', {
    description: 'Get recent network requests/responses from the browser. Must call with action="start" first to begin capture, then action="get" to retrieve.',
    inputSchema: z.object({
      action: z.enum(['start', 'get', 'clear']).default('get').describe('start=begin capture, get=retrieve, clear=reset'),
      filterUrl: z.string().default('').describe('Filter by URL pattern (empty = all)'),
      maxEntries: z.number().default(30).describe('Max entries to return'),
    }),
  }, async ({ action, filterUrl, maxEntries }) => {
    const sid = requireSession();
    if (action === 'start') {
      await api('POST', `/api/evaluate/${sid}`, {
        script: `(() => {
          if (window.__serende_network) return { ok: true, already: true };
          window.__serende_network = [];
          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            const method = args[1]?.method || 'GET';
            const entry = { type: 'fetch', method, url: url.substring(0,200), timestamp: Date.now() };
            try {
              const res = await origFetch.apply(this, args);
              entry.status = res.status;
              entry.ok = res.ok;
              window.__serende_network.push(entry);
              if (window.__serende_network.length > 100) window.__serende_network.shift();
              return res;
            } catch(e) {
              entry.error = e.message;
              window.__serende_network.push(entry);
              throw e;
            }
          };
          const origXHR = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__serende_info = { type: 'xhr', method, url: String(url).substring(0,200), timestamp: Date.now() };
            return origXHR.apply(this, arguments);
          };
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function() {
            this.addEventListener('loadend', () => {
              if (this.__serende_info) {
                this.__serende_info.status = this.status;
                this.__serende_info.ok = this.status >= 200 && this.status < 300;
                window.__serende_network.push(this.__serende_info);
                if (window.__serende_network.length > 100) window.__serende_network.shift();
              }
            });
            return origSend.apply(this, arguments);
          };
          return { ok: true };
        })()`,
      });
      return ok('Network capture started. Use action="get" to retrieve.');
    }
    if (action === 'clear') {
      await api('POST', `/api/evaluate/${sid}`, { script: 'window.__serende_network = []; true' });
      return ok('Network buffer cleared.');
    }
    const data = await api('POST', `/api/evaluate/${sid}`, {
      script: `(() => {
        let entries = window.__serende_network || [];
        const filter = ${JSON.stringify(filterUrl)};
        if (filter) entries = entries.filter(e => e.url.includes(filter));
        return { count: entries.length, entries: entries.slice(-${maxEntries}) };
      })()`,
    });
    return ok(JSON.stringify(data.result || { count: 0, entries: [] }, null, 2));
  });

  // ========== NEW: SCREENSHOT WITH DELAY ==========

  server.registerTool('screenshot_after', {
    description: 'Take a screenshot after waiting a specified delay. Useful for capturing after animations, transitions, or async renders.',
    inputSchema: z.object({
      delayMs: z.number().default(1000).describe('Delay before screenshot (ms)'),
    }),
  }, async ({ delayMs }) => {
    const sid = requireSession();
    await new Promise(r => setTimeout(r, delayMs));
    const data = await api('GET', `/api/screenshot/${sid}`);
    if (data._image) {
      return {
        content: [{
          type: 'image',
          data: data._image,
          mimeType: data._mime || 'image/jpeg',
        }],
      };
    }
    return ok(JSON.stringify(data));
  });

  // ========== UTILITY TOOLS ==========

  server.registerTool('health', {
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
      return ok(JSON.stringify({
        backend: healthData,
        auth: authStatus,
        tenantId,
        currentSession: tenantSessions.get(tenantId) || 'none',
        activeTenants: tenantSessions.size,
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

const transports = new Map(); // sessionId → { transport, server }

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || process.env.AUTH_API_KEY;
  if (!apiKey) {
    return res.status(401).json({ error: 'X-API-Key header required' });
  }
  req.apiKey = apiKey;
  req.tenantId = deriveTenantId(apiKey);
  next();
}

function withTenantContext(handler) {
  return (req, res) => {
    tenantContext.run({ apiKey: req.apiKey, tenantId: req.tenantId }, () => handler(req, res));
  };
}

app.post('/mcp', requireApiKey, withTenantContext(async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && transports.has(sessionId)) {
    const { transport } = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
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
      transports.delete(sid);
      console.log(`[MCP] Session closed: ${sid} (active: ${transports.size})`);
    }
  };

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    transports.set(transport.sessionId, { transport, server });
    console.log(`[MCP] New session: ${transport.sessionId} (active: ${transports.size})`);
  }
}));

app.get('/mcp', requireApiKey, withTenantContext(async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing session. Send initialize first via POST.' });
  }
  const { transport } = transports.get(sessionId);
  await transport.handleRequest(req, res);
}));

app.delete('/mcp', requireApiKey, withTenantContext(async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing session.' });
  }
  const { transport } = transports.get(sessionId);
  await transport.handleRequest(req, res);
  transports.delete(sessionId);
}));

// JSON-RPC proxy: intercept SSE and return plain JSON (for orquestrador compatibility)
app.post('/mcp/json', async (req, res) => {
  try {
    // Forward all headers from the original request
    const forwardHeaders = {
      'Content-Type': 'application/json',
      'X-API-Key': req.headers['x-api-key'] || process.env.AUTH_API_KEY || 'serende-dev-key-2024',
    };

    const resp = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(req.body),
    });
    const text = await resp.text();
    // Parse SSE: extract data lines
    const lines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    if (lines.length > 0) {
      const parsed = JSON.parse(lines[lines.length - 1]);
      return res.json(parsed);
    }
    // Try direct JSON parse
    const json = JSON.parse(text);
    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: transports.size });
});

app.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`[Serende MCP] http://0.0.0.0:${MCP_PORT}/mcp`);
  console.log(`[Serende MCP] Backend: ${SERENDE_API}`);
});
