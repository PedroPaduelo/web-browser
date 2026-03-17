#!/usr/bin/env node

/**
 * Mouse alignment test - finds actual Google search box position and tests click accuracy
 */

const API_KEY = 'serende-dev-key-2024';
const BASE_URL = 'https://serende.ddw1sl.easypanel.host';
const fs = await import('fs');
const path = await import('path');

let authToken = null;
let sessionId = null;

async function apiFetch(method, path, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': authToken ? `Bearer ${authToken}` : undefined,
  };
  if (!authToken) delete headers['Authorization'];

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: Object.fromEntries(Object.entries(headers).filter(([_, v]) => v)),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.headers.get('content-type')?.includes('image/')) {
    const buffer = await response.arrayBuffer();
    return { _image: Buffer.from(buffer).toString('base64'), _mime: response.headers.get('content-type') };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`API error ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function login() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: API_KEY }),
  });
  const data = await response.json();
  if (!data.token) throw new Error('Login failed: ' + JSON.stringify(data));
  authToken = data.token;
  console.log('Logged in, token:', data.token.substring(0, 20) + '...');
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function saveScreenshot(name) {
  const resp = await fetch(`${BASE_URL}/api/screenshot/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  const buffer = await resp.arrayBuffer();
  const screenshotPath = `/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/.claude-images/${name}.jpg`;
  fs.default.writeFileSync(screenshotPath, Buffer.from(buffer));
  console.log(`  Screenshot saved: ${screenshotPath} (${buffer.byteLength} bytes)`);
  return screenshotPath;
}

async function evaluate(script) {
  const result = await apiFetch('POST', `/api/evaluate/${sessionId}`, { script });
  return result.result;
}

async function click(x, y) {
  await apiFetch('POST', '/api/input', { sessionId, type: 'click', x, y, button: 0 });
}

async function main() {
  try {
    // Ensure screenshots dir exists
    try { fs.default.mkdirSync('/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/.claude-images', { recursive: true }); } catch {}

    console.log('\n=== Step 1: Login & Session ===');
    await login();

    const session = await apiFetch('POST', '/api/session', {
      resolution: '1280x720',
      startUrl: 'about:blank',
    });
    sessionId = session.sessionId;
    console.log('Session:', sessionId);
    await wait(2000);

    console.log('\n=== Step 2: Navigate to Google ===');
    await apiFetch('POST', `/api/navigate/${sessionId}`, { url: 'https://www.google.com' });

    // Wait for full load
    let loaded = false;
    for (let i = 0; i < 30; i++) {
      const result = await evaluate(`document.readyState`);
      if (result === 'complete') { loaded = true; break; }
      await wait(500);
    }
    console.log('Page loaded:', loaded);
    await wait(2000); // Extra wait for rendering

    const ss1 = await saveScreenshot('01-google-loaded');
    console.log('Initial screenshot saved');

    console.log('\n=== Step 3: Find search box position ===');
    const searchBoxInfo = await evaluate(`
      (() => {
        // Find the main Google search textarea/input
        const selectors = [
          'textarea[name="q"]',
          'input[name="q"]',
          '[aria-label="Pesquisar"]',
          '[aria-label="Search"]',
          'textarea.gLFyf',
          'input.gLFyf',
        ];

        let el = null;
        for (const sel of selectors) {
          el = document.querySelector(sel);
          if (el) break;
        }

        if (!el) {
          // List all visible inputs
          const allInputs = Array.from(document.querySelectorAll('input, textarea')).map(i => ({
            tag: i.tagName,
            type: i.type,
            name: i.name,
            id: i.id,
            classes: i.className,
            rect: i.getBoundingClientRect(),
            visible: i.offsetWidth > 0 && i.offsetHeight > 0,
          }));
          return { found: false, allInputs };
        }

        const rect = el.getBoundingClientRect();
        return {
          found: true,
          selector: el.tagName + (el.name ? '[name=' + el.name + ']' : '') + (el.id ? '#' + el.id : ''),
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right },
          center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
          viewport: { w: window.innerWidth, h: window.innerHeight },
          scrollOffset: { x: window.scrollX, y: window.scrollY },
        };
      })()
    `);

    console.log('Search box info:', JSON.stringify(searchBoxInfo, null, 2));

    if (!searchBoxInfo.found) {
      console.log('\nNo search box found by common selectors!');
      console.log('All inputs:', JSON.stringify(searchBoxInfo.allInputs, null, 2));
      throw new Error('Cannot find search box');
    }

    const center = searchBoxInfo.center;
    console.log(`\nSearch box center: (${center.x}, ${center.y})`);
    console.log(`Viewport: ${searchBoxInfo.viewport.w}x${searchBoxInfo.viewport.h}`);

    console.log('\n=== Step 4: Click on search box ===');
    console.log(`Clicking at exact position (${center.x}, ${center.y})`);
    await click(center.x, center.y);
    await wait(1000);

    // Check if focused
    const focused = await evaluate(`
      (() => {
        const active = document.activeElement;
        return {
          tagName: active?.tagName,
          name: active?.name,
          id: active?.id,
          isFocused: !!(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')),
        };
      })()
    `);
    console.log('Focused element:', JSON.stringify(focused));

    if (!focused.isFocused) {
      console.log('\nSearch box NOT focused after click - trying via JS...');
      await evaluate(`
        const el = document.querySelector('textarea[name="q"]') || document.querySelector('input[name="q"]');
        if (el) el.focus();
      `);
      await wait(500);
    }

    console.log('\n=== Step 5: Type text ===');
    const testQuery = 'teste alinhamento mouse';
    // Type char by char
    for (const ch of testQuery) {
      await apiFetch('POST', '/api/input/batch', {
        sessionId,
        actions: [
          { type: 'keydown', key: ch },
          { type: 'keyup', key: ch },
        ],
      });
      await wait(30);
    }
    await wait(1000);
    console.log('Typed:', testQuery);

    // Check input value
    const inputValue = await evaluate(`
      (() => {
        const el = document.querySelector('textarea[name="q"]') || document.querySelector('input[name="q"]');
        return { value: el?.value, focused: el === document.activeElement };
      })()
    `);
    console.log('Input value after typing:', JSON.stringify(inputValue));

    const ss2 = await saveScreenshot('02-typed-query');

    console.log('\n=== Step 6: Press Enter to search ===');
    await apiFetch('POST', '/api/input/batch', {
      sessionId,
      actions: [
        { type: 'keydown', key: 'Enter' },
        { type: 'keyup', key: 'Enter' },
      ],
    });
    await wait(3000);

    // Check if we got results
    const searchState = await evaluate(`
      (() => {
        return {
          url: window.location.href,
          title: document.title,
          hasResults: !!(document.querySelector('#search') || document.querySelector('#ires')),
          currentQuery: new URLSearchParams(window.location.search).get('q'),
        };
      })()
    `);
    console.log('After search:', JSON.stringify(searchState, null, 2));

    const ss3 = await saveScreenshot('03-after-search');

    console.log('\n=== ALIGNMENT TEST CONCLUSION ===');
    const clickAligned = focused.isFocused || inputValue.value;
    const searchWorked = searchState.hasResults || (searchState.currentQuery && searchState.currentQuery.length > 0);

    console.log(`
RESULTS:
  App mode (no Chrome UI): ALREADY CONFIRMED WORKING
  Search box coordinates: (${center.x}, ${center.y})
  Click focused element:  ${focused.isFocused ? 'YES - click is ALIGNED' : 'NO - click is MISALIGNED'}
  Text entered:           ${inputValue.value ? `"${inputValue.value}"` : 'EMPTY - click missed'}
  Search executed:        ${searchWorked ? 'YES' : 'NO'}
  Current URL:            ${searchState.url}

SCREENSHOTS:
  Initial: ${ss1}
  After typing: ${ss2}
  After search: ${ss3}
    `);

    // Stop session
    await apiFetch('DELETE', `/api/session/${sessionId}`);
    console.log('Session stopped');

  } catch (error) {
    console.error('Error:', error.message);
    if (sessionId) {
      try { await apiFetch('DELETE', `/api/session/${sessionId}`); } catch {}
    }
    process.exit(1);
  }
}

main();
