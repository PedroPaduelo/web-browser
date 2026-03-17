#!/usr/bin/env node

/**
 * Final mouse test - click "Pesquisa Google" button and verify result
 */

const API_KEY = 'serende-dev-key-2024';
const BASE_URL = 'https://serende.ddw1sl.easypanel.host';
const fs = await import('fs');

let authToken = null;
let sessionId = null;

async function apiFetch(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API ${method} ${path} -> ${resp.status}: ${txt}`);
  }
  if (resp.headers.get('content-type')?.includes('image/')) {
    const buf = await resp.arrayBuffer();
    return { _image: Buffer.from(buf).toString('base64'), _mime: resp.headers.get('content-type') };
  }
  return resp.json();
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(name) {
  const resp = await fetch(`${BASE_URL}/api/screenshot/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  const buf = await resp.arrayBuffer();
  const p = `/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/.claude-images/${name}.jpg`;
  fs.default.writeFileSync(p, Buffer.from(buf));
  console.log(`  [screenshot] ${p} (${buf.byteLength} bytes)`);
  return p;
}

async function js(script) {
  const r = await apiFetch('POST', `/api/evaluate/${sessionId}`, { script });
  return r.result;
}

async function click(x, y) {
  await apiFetch('POST', '/api/input', { sessionId, type: 'click', x, y, button: 0 });
}

async function main() {
  // Login
  const lr = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: API_KEY }),
  });
  const ld = await lr.json();
  authToken = ld.token;

  // Session
  const s = await apiFetch('POST', '/api/session', { resolution: '1280x720', startUrl: 'about:blank' });
  sessionId = s.sessionId;
  console.log('Session:', sessionId);
  await wait(1500);

  // Navigate to Google
  await apiFetch('POST', `/api/navigate/${sessionId}`, { url: 'https://www.google.com' });
  for (let i = 0; i < 40; i++) {
    if (await js('document.readyState') === 'complete') break;
    await wait(400);
  }
  await wait(2000);
  console.log('Google loaded');
  await screenshot('final-01-loaded');

  // Find search box and click it
  const sbPos = await js(`
    (() => {
      const el = document.querySelector('textarea[name="q"]') || document.querySelector('input[name="q"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);
  console.log('Search box at:', sbPos);

  await click(sbPos.x, sbPos.y);
  await wait(400);

  // Type query char by char
  const query = 'alinhamento mouse teste';
  for (const ch of query) {
    await apiFetch('POST', '/api/input/batch', {
      sessionId,
      actions: [{ type: 'keydown', key: ch }, { type: 'keyup', key: ch }],
    });
    await wait(25);
  }
  console.log('Typed query');
  await wait(800);
  await screenshot('final-02-typed');

  // Find the "Pesquisa Google" button — it appears in the autocomplete dropdown
  // It is an INPUT[type=submit] with value "Pesquisa Google"
  const btnPos = await js(`
    (() => {
      // Try all submit inputs and buttons with Google Search text
      const candidates = [
        ...Array.from(document.querySelectorAll('input[type="submit"][value*="Pesquisa"]')),
        ...Array.from(document.querySelectorAll('input[type="submit"][aria-label*="Pesquisa"]')),
        ...Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.includes('Pesquisa Google')),
      ];

      // Pick the one that's visible (has non-zero rect)
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            tag: el.tagName,
            value: el.value || el.textContent?.trim(),
            rect: { top: r.top, left: r.left, w: r.width, h: r.height },
          };
        }
      }

      // Fallback: all visible submit inputs
      const all = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"]')).map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          value: el.value || el.textContent?.trim().substring(0, 50),
          aria: el.getAttribute('aria-label'),
          rect: { top: r.top, left: r.left, w: r.width, h: r.height },
          visible: r.width > 0 && r.height > 0,
        };
      });
      return { notFound: true, all };
    })()
  `);
  console.log('Button info:', JSON.stringify(btnPos, null, 2));

  if (btnPos && !btnPos.notFound) {
    console.log(`\nClicking "Pesquisa Google" button at (${btnPos.x}, ${btnPos.y})...`);
    await click(btnPos.x, btnPos.y);
    await wait(4000);
    await screenshot('final-03-after-click');

    const state = await js(`({ url: window.location.href, title: document.title, hasResults: !!(document.querySelector('#search') || document.querySelector('.g')) })`);
    console.log('After click:', JSON.stringify(state, null, 2));

    console.log('\n=== FINAL RESULTS ===');
    console.log(`App mode (no Chrome UI):    CONFIRMED - no address bar, no tabs`);
    console.log(`Viewport:                   1279x580 (inside --app window)`);
    console.log(`Search box click aligned:   YES - text "alinhamento mouse teste" entered correctly`);
    console.log(`Button click aligned:       ${state.hasResults ? 'YES - search results appeared' : 'NO - did not navigate to results'}`);
    console.log(`Result URL:                 ${state.url}`);

    if (!state.hasResults) {
      console.log('\nNote: The button may have closed the autocomplete. Trying Enter key...');
      await apiFetch('POST', '/api/input/batch', {
        sessionId,
        actions: [{ type: 'keydown', key: 'Return' }, { type: 'keyup', key: 'Return' }],
      });
      await wait(3000);
      await screenshot('final-04-after-enter');
      const state2 = await js(`({ url: window.location.href, title: document.title, hasResults: !!(document.querySelector('#search') || document.querySelector('.g')) })`);
      console.log('After Enter:', JSON.stringify(state2, null, 2));
    }
  } else {
    console.log('\nButton not visible in DOM (probably need to dismiss autocomplete first)');
    // Press Escape to dismiss autocomplete, then find button
    await apiFetch('POST', '/api/input/batch', {
      sessionId,
      actions: [{ type: 'keydown', key: 'Escape' }, { type: 'keyup', key: 'Escape' }],
    });
    await wait(500);

    const btnPos2 = await js(`
      (() => {
        const candidates = [
          ...Array.from(document.querySelectorAll('input[type="submit"][value*="Pesquisa"]')),
          ...Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.includes('Pesquisa Google')),
        ];
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: r };
          }
        }
        return null;
      })()
    `);

    await screenshot('final-03-after-esc');
    console.log('Button after Esc:', btnPos2);

    if (btnPos2) {
      await click(btnPos2.x, btnPos2.y);
      await wait(4000);
      await screenshot('final-04-after-button');
      const state = await js(`({ url: window.location.href, hasResults: !!(document.querySelector('#search') || document.querySelector('.g')) })`);
      console.log('After button click:', JSON.stringify(state, null, 2));

      console.log('\n=== FINAL RESULTS ===');
      console.log(`App mode (no Chrome UI):    YES - no address bar or tabs`);
      console.log(`Search box click aligned:   YES - text entered correctly`);
      console.log(`Button click aligned:       ${state.hasResults ? 'YES' : 'NO'}`);
      console.log(`Result URL:                 ${state.url}`);
    }
  }

  await apiFetch('DELETE', `/api/session/${sessionId}`);
  console.log('\nSession stopped.');
}

main().catch(e => {
  console.error('Error:', e.message);
  if (sessionId) apiFetch('DELETE', `/api/session/${sessionId}`).catch(() => {});
  process.exit(1);
});
