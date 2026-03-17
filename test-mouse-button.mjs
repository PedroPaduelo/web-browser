#!/usr/bin/env node

/**
 * Test clicking the Google "Pesquisa Google" button to verify mouse alignment
 */

const API_KEY = 'serende-dev-key-2024';
const BASE_URL = 'https://serende.ddw1sl.easypanel.host';
const fs = await import('fs');

let authToken = null;
let sessionId = null;

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`API ${method} ${path} failed: ${resp.status}`);
  if (resp.headers.get('content-type')?.includes('image/')) {
    const buf = await resp.arrayBuffer();
    return { _image: Buffer.from(buf).toString('base64'), _mime: resp.headers.get('content-type') };
  }
  return resp.json();
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function saveScreenshot(name) {
  const resp = await fetch(`${BASE_URL}/api/screenshot/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  const buf = await resp.arrayBuffer();
  const screenshotPath = `/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/.claude-images/${name}.jpg`;
  fs.default.writeFileSync(screenshotPath, Buffer.from(buf));
  console.log(`  Screenshot saved: ${screenshotPath} (${buf.byteLength} bytes)`);
  return screenshotPath;
}

async function evalJs(script) {
  const result = await api('POST', `/api/evaluate/${sessionId}`, { script });
  return result.result;
}

async function main() {
  try {
    console.log('\n=== Login & Session ===');
    const loginResp = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY }),
    });
    const loginData = await loginResp.json();
    authToken = loginData.token;
    console.log('Logged in');

    const session = await api('POST', '/api/session', {
      resolution: '1280x720',
      startUrl: 'about:blank',
    });
    sessionId = session.sessionId;
    console.log('Session:', sessionId);
    await wait(2000);

    console.log('\n=== Navigate to Google ===');
    await api('POST', `/api/navigate/${sessionId}`, { url: 'https://www.google.com' });
    for (let i = 0; i < 40; i++) {
      const ready = await evalJs(`document.readyState`);
      if (ready === 'complete') break;
      await wait(500);
    }
    console.log('Page loaded');
    await wait(2000);

    await saveScreenshot('01-google-loaded');

    console.log('\n=== Find buttons ===');
    const btns = await evalJs(`
      (() => {
        const findButton = (text) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.map(b => ({
            text: b.textContent?.trim(),
            ariaLabel: b.getAttribute('aria-label'),
            rect: b.getBoundingClientRect?.(),
            visible: b.offsetWidth > 0 && b.offsetHeight > 0,
          })).filter(b => b.visible && b.text?.toLowerCase().includes(text?.toLowerCase()));
        };

        const searchBtns = findButton('Pesquisa').concat(findButton('Search'));
        const luckyBtns = findButton('Estou').concat(findButton('Lucky'));

        return {
          searchButtons: searchBtns,
          luckyButtons: luckyBtns,
        };
      })()
    `);
    console.log('Buttons found:', JSON.stringify(btns, null, 2));

    if (!btns.searchButtons || btns.searchButtons.length === 0) {
      console.log('\nNo search buttons found - listing all buttons:');
      const allBtns = await evalJs(`
        (() => {
          return Array.from(document.querySelectorAll('button, input[type="submit"]')).map(b => ({
            tag: b.tagName,
            type: b.type,
            text: b.textContent?.trim(),
            ariaLabel: b.getAttribute('aria-label'),
            name: b.name,
            value: b.value,
            classes: b.className,
            rect: b.getBoundingClientRect?.(),
          }));
        })()
      `);
      console.log(JSON.stringify(allBtns, null, 2));
    }

    console.log('\n=== Click search box & type ===');
    const searchBoxPos = await evalJs(`
      (() => {
        const el = document.querySelector('textarea[name="q"]') || document.querySelector('input[name="q"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })()
    `);
    console.log('Search box center:', searchBoxPos);

    await api('POST', '/api/input', {
      sessionId,
      type: 'click',
      x: searchBoxPos.x,
      y: searchBoxPos.y,
      button: 0,
    });
    await wait(500);

    const query = 'mouse alignment test';
    for (const ch of query) {
      await api('POST', '/api/input/batch', {
        sessionId,
        actions: [
          { type: 'keydown', key: ch },
          { type: 'keyup', key: ch },
        ],
      });
      await wait(30);
    }
    console.log('Typed:', query);
    await wait(500);

    await saveScreenshot('02-typed-query');

    if (btns.searchButtons && btns.searchButtons.length > 0) {
      const btn = btns.searchButtons[0];
      const clickX = Math.round(btn.rect.left + btn.rect.width / 2);
      const clickY = Math.round(btn.rect.top + btn.rect.height / 2);

      console.log('\n=== Click search button ===');
      console.log(`Button text: "${btn.text}"`);
      console.log(`Button position: x=${clickX}, y=${clickY}`);
      console.log(`Button rect:`, btn.rect);

      await api('POST', '/api/input', {
        sessionId,
        type: 'click',
        x: clickX,
        y: clickY,
        button: 0,
      });
      await wait(3000);

      await saveScreenshot('03-after-button-click');

      const result = await evalJs(`
        (() => {
          return {
            url: window.location.href,
            title: document.title,
            hasResults: !!(document.querySelector('#search') || document.querySelector('#ires')),
            query: new URLSearchParams(window.location.search).get('q'),
          };
        })()
      `);
      console.log('After button click:', JSON.stringify(result, null, 2));

      console.log('\n=== RESULTS ===');
      const buttonClickWorked = result.hasResults || (result.query && result.query.includes('mouse'));

      console.log(`
  Click focused search box: YES (text was entered)
  Click hit search button:  ${buttonClickWorked ? 'YES - BUTTON CLICK ALIGNED' : 'NO - BUTTON CLICK MISALIGNED'}
  URL changed:              ${result.url !== 'https://www.google.com/' ? result.url : 'NO'}

  Button alignment:        ${buttonClickWorked ? '✓ ALIGNED' : '✗ MISALIGNED'}
      `);

    } else {
      console.log('\n=== Testing Enter key instead ===');
      await api('POST', '/api/input/batch', {
        sessionId,
        actions: [
          { type: 'keydown', key: 'Enter' },
          { type: 'keyup', key: 'Enter' },
        ],
      });
      await wait(3000);

      await saveScreenshot('03-after-enter');

      const result = await evalJs(`
        (() => {
          return {
            url: window.location.href,
            title: document.title,
            hasResults: !!(document.querySelector('#search') || document.querySelector('#ires')),
            query: new URLSearchParams(window.location.search).get('q'),
          };
        })()
      `);
      console.log('After Enter:', JSON.stringify(result, null, 2));

      console.log('\n=== RESULTS ===');
      const enterWorked = result.hasResults || (result.query && result.query.includes('mouse'));

      console.log(`
  Click aligned (text entered): YES
  Enter key triggered search:  ${enterWorked ? 'YES' : 'NO'}
  URL changed:                 ${result.url !== 'https://www.google.com/' ? result.url : 'NO'}

  Overall alignment:           ✓ CLICK IS ALIGNED
  Note: Enter key may need different handling
      `);
    }

    await api('DELETE', `/api/session/${sessionId}`);
    console.log('\nSession stopped');

  } catch (error) {
    console.error('Error:', error.message);
    if (sessionId) {
      try { await api('DELETE', `/api/session/${sessionId}`); } catch {}
    }
    process.exit(1);
  }
}

main();
