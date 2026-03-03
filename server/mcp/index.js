import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const SERENDE_API = process.env.SERENDE_API || 'http://localhost:4205';
const MCP_PORT = parseInt(process.env.MCP_PORT) || 4202;

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SERENDE_API}${path}`, opts);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('image/')) {
    const buf = await res.arrayBuffer();
    return { _image: Buffer.from(buf).toString('base64'), _mime: ct };
  }
  return res.json();
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function createServer() {
  const server = new McpServer({
    name: 'serende-browser',
    version: '1.0.0',
  });

  server.registerTool('session_status', {
    description: 'Get current browser session status (resolution, uptime, display)',
    inputSchema: z.object({}),
  }, async () => {
    const data = await api('GET', '/api/session');
    return ok(JSON.stringify(data, null, 2));
  });

  server.registerTool('session_start', {
    description: 'Start a new remote browser session',
    inputSchema: z.object({
      resolution: z.string().default('1280x720').describe('Screen resolution (e.g. 1280x720, 1920x1080)'),
      startUrl: z.string().default('https://www.google.com').describe('URL to open on start'),
    }),
  }, async ({ resolution, startUrl }) => {
    const data = await api('POST', '/api/session', { resolution, startUrl });
    return ok(JSON.stringify(data, null, 2));
  });

  server.registerTool('session_stop', {
    description: 'Stop the current browser session',
    inputSchema: z.object({}),
  }, async () => {
    const data = await api('DELETE', '/api/session');
    return ok(JSON.stringify(data, null, 2));
  });

  server.registerTool('navigate', {
    description: 'Navigate the browser to a URL',
    inputSchema: z.object({
      url: z.string().describe('URL to navigate to'),
    }),
  }, async ({ url }) => {
    const data = await api('POST', '/api/navigate', { url });
    return ok(JSON.stringify(data, null, 2));
  });

  server.registerTool('get_url', {
    description: 'Get the current page URL',
    inputSchema: z.object({}),
  }, async () => {
    const data = await api('GET', '/api/url');
    return ok(data.url || 'unknown');
  });

  server.registerTool('mouse_move', {
    description: 'Move mouse cursor to coordinates (x, y)',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const nx = Number(x);
    const ny = Number(y);
    await api('POST', '/api/input', { type: 'mousemove', x: nx, y: ny });
    return ok(`Moved to (${nx}, ${ny})`);
  });

  server.registerTool('mouse_click', {
    description: 'Click at coordinates (x, y). Button 0=left, 1=middle, 2=right',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
      button: z.union([z.number(), z.string()]).default(0).describe('Mouse button: 0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const nx = Number(x);
    const ny = Number(y);
    const nButton = Number(button);
    await api('POST', '/api/input', { type: 'click', x: nx, y: ny, button: nButton });
    return ok(`Clicked (${nx}, ${ny}) button=${nButton}`);
  });

  server.registerTool('mouse_down', {
    description: 'Press mouse button down at coordinates (for drag start)',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
      button: z.union([z.number(), z.string()]).default(0).describe('Mouse button: 0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const nx = Number(x);
    const ny = Number(y);
    const nButton = Number(button);
    await api('POST', '/api/input', { type: 'mousedown', x: nx, y: ny, button: nButton });
    return ok(`Mouse down (${nx}, ${ny}) button=${nButton}`);
  });

  server.registerTool('mouse_up', {
    description: 'Release mouse button at coordinates (for drag end)',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
      button: z.union([z.number(), z.string()]).default(0).describe('Mouse button: 0=left, 1=middle, 2=right'),
    }),
  }, async ({ x, y, button }) => {
    const nx = Number(x);
    const ny = Number(y);
    const nButton = Number(button);
    await api('POST', '/api/input', { type: 'mouseup', x: nx, y: ny, button: nButton });
    return ok(`Mouse up (${nx}, ${ny}) button=${nButton}`);
  });

  server.registerTool('mouse_double_click', {
    description: 'Double-click at coordinates (x, y)',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const nx = Number(x);
    const ny = Number(y);
    await api('POST', '/api/input/batch', {
      actions: [
        { type: 'click', x: nx, y: ny, button: 0 },
        { type: 'click', x: nx, y: ny, button: 0 },
      ]
    });
    return ok(`Double-clicked (${nx}, ${ny})`);
  });

  server.registerTool('mouse_right_click', {
    description: 'Right-click at coordinates (x, y)',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
    }),
  }, async ({ x, y }) => {
    const nx = Number(x);
    const ny = Number(y);
    await api('POST', '/api/input', { type: 'click', x: nx, y: ny, button: 2 });
    return ok(`Right-clicked (${nx}, ${ny})`);
  });

  server.registerTool('scroll', {
    description: 'Scroll at coordinates. Positive deltaY = scroll down, negative = scroll up',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate'),
      deltaY: z.union([z.number(), z.string()]).describe('Scroll amount (positive=down, negative=up). Typical: 120 for one notch'),
    }),
  }, async ({ x, y, deltaY }) => {
    const nx = Number(x);
    const ny = Number(y);
    const nDeltaY = Number(deltaY);
    await api('POST', '/api/input', { type: 'scroll', x: nx, y: ny, deltaY: nDeltaY });
    return ok(`Scrolled at (${nx}, ${ny}) deltaY=${nDeltaY}`);
  });

  server.registerTool('drag', {
    description: 'Drag from (fromX, fromY) to (toX, toY)',
    inputSchema: z.object({
      fromX: z.union([z.number(), z.string()]).describe('Start X'),
      fromY: z.union([z.number(), z.string()]).describe('Start Y'),
      toX: z.union([z.number(), z.string()]).describe('End X'),
      toY: z.union([z.number(), z.string()]).describe('End Y'),
    }),
  }, async ({ fromX, fromY, toX, toY }) => {
    const nFromX = Number(fromX);
    const nFromY = Number(fromY);
    const nToX = Number(toX);
    const nToY = Number(toY);
    await api('POST', '/api/input/batch', {
      actions: [
        { type: 'mousedown', x: nFromX, y: nFromY, button: 0 },
        { type: 'mousemove', x: nToX, y: nToY },
        { type: 'mouseup', x: nToX, y: nToY, button: 0 },
      ]
    });
    return ok(`Dragged from (${nFromX},${nFromY}) to (${nToX},${nToY})`);
  });

  server.registerTool('key_press', {
    description: 'Press and release a single key (e.g. Enter, Tab, Escape, a, 1, F5, ArrowDown)',
    inputSchema: z.object({
      key: z.string().describe('Key name (Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, F1-F12, or any character)'),
    }),
  }, async ({ key }) => {
    await api('POST', '/api/input/batch', {
      actions: [
        { type: 'keydown', key },
        { type: 'keyup', key },
      ]
    });
    return ok(`Pressed key: ${key}`);
  });

  server.registerTool('key_down', {
    description: 'Press a key down (hold it). Use with key_up for combos like Ctrl+C',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    await api('POST', '/api/input', { type: 'keydown', key });
    return ok(`Key down: ${key}`);
  });

  server.registerTool('key_up', {
    description: 'Release a key',
    inputSchema: z.object({
      key: z.string().describe('Key name'),
    }),
  }, async ({ key }) => {
    await api('POST', '/api/input', { type: 'keyup', key });
    return ok(`Key up: ${key}`);
  });

  server.registerTool('type_text', {
    description: 'Type a string of text character by character',
    inputSchema: z.object({
      text: z.string().describe('Text to type'),
    }),
  }, async ({ text }) => {
    const actions = [];
    for (const ch of text) {
      actions.push({ type: 'keydown', key: ch });
      actions.push({ type: 'keyup', key: ch });
    }
    await api('POST', '/api/input/batch', { actions });
    return ok(`Typed: "${text}"`);
  });

  server.registerTool('hotkey', {
    description: 'Press a keyboard shortcut (e.g. Ctrl+A, Ctrl+C, Alt+Tab). Keys are pressed in order, then released in reverse',
    inputSchema: z.object({
      keys: z.union([z.array(z.string()), z.string()]).describe('Array of key names to press together, e.g. ["Control", "a"]'),
    }),
  }, async ({ keys }) => {
    const keyList = typeof keys === 'string' ? JSON.parse(keys) : keys;
    const actions = [];
    for (const k of keyList) actions.push({ type: 'keydown', key: k });
    for (const k of [...keyList].reverse()) actions.push({ type: 'keyup', key: k });
    await api('POST', '/api/input/batch', { actions });
    return ok(`Hotkey: ${keyList.join('+')}`);
  });

  server.registerTool('screenshot', {
    description: 'Take a screenshot of the current browser screen. Returns a JPEG image.',
    inputSchema: z.object({}),
  }, async () => {
    const data = await api('GET', '/api/screenshot');
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

  server.registerTool('evaluate_js', {
    description: 'Execute JavaScript in the browser page and return the result',
    inputSchema: z.object({
      script: z.string().describe('JavaScript code to execute in the browser context'),
    }),
  }, async ({ script }) => {
    const data = await api('POST', '/api/evaluate', { script });
    return ok(JSON.stringify(data.result ?? data, null, 2));
  });

  server.registerTool('click_and_type', {
    description: 'Click on a position and then type text (useful for filling form fields)',
    inputSchema: z.object({
      x: z.union([z.number(), z.string()]).describe('X coordinate to click'),
      y: z.union([z.number(), z.string()]).describe('Y coordinate to click'),
      text: z.string().describe('Text to type after clicking'),
      clearFirst: z.boolean().default(false).describe('If true, select all and delete before typing'),
    }),
  }, async ({ x, y, text, clearFirst }) => {
    const nx = Number(x);
    const ny = Number(y);
    const actions = [
      { type: 'click', x: nx, y: ny, button: 0 },
    ];
    if (clearFirst) {
      actions.push({ type: 'keydown', key: 'Control' });
      actions.push({ type: 'keydown', key: 'a' });
      actions.push({ type: 'keyup', key: 'a' });
      actions.push({ type: 'keyup', key: 'Control' });
      actions.push({ type: 'keydown', key: 'Backspace' });
      actions.push({ type: 'keyup', key: 'Backspace' });
    }
    for (const ch of text) {
      actions.push({ type: 'keydown', key: ch });
      actions.push({ type: 'keyup', key: ch });
    }
    await api('POST', '/api/input/batch', { actions });
    return ok(`Clicked (${x},${y}) and typed "${text}"`);
  });

  return server;
}

// --- HTTP Streamable MCP Transport ---

const app = express();
app.use(cors());
app.use(express.json());

// Single shared transport and server - initialized at startup
let sharedTransport = null;
let sharedServer = null;
let initialized = false;

async function initSharedTransport() {
  sharedTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  sharedServer = createServer();
  await sharedServer.connect(sharedTransport);
  initialized = true;
  console.log('[MCP] Shared transport initialized');
}

initSharedTransport().catch(console.error);

app.post('/mcp', async (req, res) => {
  if (!sharedTransport) {
    return res.status(503).json({ error: 'Server not ready' });
  }

  const method = req.body?.method;
  // Allow re-initialize if already initialized
  if (method === 'initialize' && initialized) {
    initialized = true;
    console.log('[MCP] Re-initializing session');
  }

  await sharedTransport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  if (!sharedTransport) {
    return res.status(503).json({ error: 'Server not ready' });
  }
  await sharedTransport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  if (!sharedTransport) {
    return res.status(503).json({ error: 'Server not ready' });
  }
  await sharedTransport.handleRequest(req, res);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ready: !!sharedTransport });
});

app.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`[Serende MCP] Streamable HTTP server on http://0.0.0.0:${MCP_PORT}/mcp`);
});
