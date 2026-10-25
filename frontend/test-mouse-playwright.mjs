import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.KEY;
if (!API_KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node frontend/test-mouse-playwright.mjs');
  process.exit(1);
}

const SCREENSHOTS_DIR = '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/frontend/.claude-images';

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testMouseOffset() {
  // Create screenshots dir if needed
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  const results = {
    canvas: null,
    sessionId: null,
    tests: [],
    errors: []
  };

  try {
    // 1. Navigate to serende
    log('Navigating to https://serende.ddw1sl.easypanel.host...');
    await page.goto('https://serende.ddw1sl.easypanel.host', { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(2000);
    log(`URL: ${page.url()}`);

    // Screenshot after load
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-initial.png` });
    log('Screenshot: 01-initial.png');

    // 2. Authenticate
    log('Looking for API key input...');
    const pageContent = await page.content();

    // Log all inputs
    const inputInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type,
        placeholder: i.placeholder,
        name: i.name,
        id: i.id,
        value: i.value
      }));
    });
    log(`Found ${inputInfo.length} inputs: ${JSON.stringify(inputInfo)}`);

    // Try to fill API key
    const inputFilled = await page.evaluate((key) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        const ph = (input.placeholder || '').toLowerCase();
        const nm = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        if (ph.includes('key') || ph.includes('api') || nm.includes('key') || nm.includes('api') || id.includes('key') || id.includes('api')) {
          input.value = key;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return `Filled input: ${input.placeholder || input.name || input.id}`;
        }
      }
      // Try the first text/password input
      for (const input of inputs) {
        if (input.type === 'text' || input.type === 'password') {
          input.value = key;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return `Filled first text input: ${input.placeholder || input.name || input.id || '(none)'}`;
        }
      }
      return null;
    }, API_KEY);
    log(`Input fill result: ${inputFilled}`);

    if (inputFilled) {
      await sleep(500);

      // Submit/login
      const submitted = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || btn.value || '').toLowerCase();
          if (text.includes('login') || text.includes('entrar') || text.includes('submit') || text.includes('confirm') || text.includes('acessar')) {
            btn.click();
            return `Clicked: ${btn.textContent || btn.value || btn.type}`;
          }
        }
        // Try form submit
        const forms = document.querySelectorAll('form');
        for (const form of forms) {
          form.submit();
          return 'Submitted form';
        }
        // Try first button
        const firstBtn = document.querySelector('button');
        if (firstBtn) {
          firstBtn.click();
          return `Clicked first button: ${firstBtn.textContent}`;
        }
        return null;
      });
      log(`Submit result: ${submitted}`);
      await sleep(3000);
    }

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/02-after-login.png` });
    log('Screenshot: 02-after-login.png');
    log(`URL after login: ${page.url()}`);

    // 3. Look for session creation UI
    log('Looking for session creation UI...');
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    log(`Page text: ${pageText}`);

    // Log all buttons
    const btns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent?.trim(),
        classes: b.className
      }));
    });
    log(`Buttons: ${JSON.stringify(btns)}`);

    // 4. Try to create session via API
    log('Trying to create session via API...');
    const sessionResponse = await page.evaluate(async (key) => {
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': key,
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({ width: 1280, height: 720 })
        });
        const text = await res.text();
        return { status: res.status, body: text };
      } catch (e) {
        return { error: e.message };
      }
    }, API_KEY);
    log(`Session API response: ${JSON.stringify(sessionResponse)}`);

    // Also try without /api prefix
    const sessionResponse2 = await page.evaluate(async (key) => {
      try {
        const res = await fetch('/sessions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': key,
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({ width: 1280, height: 720 })
        });
        const text = await res.text();
        return { status: res.status, body: text };
      } catch (e) {
        return { error: e.message };
      }
    }, API_KEY);
    log(`Session API response (/sessions): ${JSON.stringify(sessionResponse2)}`);

    // Check available API endpoints
    const apiPaths = ['/api/sessions', '/sessions', '/api/session', '/session'];
    for (const apiPath of apiPaths) {
      const r = await page.evaluate(async (p, key) => {
        try {
          const res = await fetch(p, { headers: { 'X-API-Key': key } });
          return { status: res.status, path: p };
        } catch (e) {
          return { error: e.message, path: p };
        }
      }, apiPath, API_KEY);
      log(`GET ${apiPath}: ${JSON.stringify(r)}`);
    }

    // 5. Navigate to the UI and interact
    // Find any existing sessions or session links
    const sessionLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a, [href]')).map(a => ({
        text: a.textContent?.trim(),
        href: a.href || a.getAttribute('href')
      })).filter(a => a.href);
    });
    log(`Links on page: ${JSON.stringify(sessionLinks.slice(0, 20))}`);

    // Click on first session or create button
    const createClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sessão') || text.includes('session') || text.includes('nova') || text.includes('new') || text.includes('criar') || text.includes('create')) {
          btn.click();
          return `Clicked: ${btn.textContent.trim()}`;
        }
      }
      return null;
    });
    log(`Create session click: ${createClicked}`);
    await sleep(3000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/03-session-ui.png` });
    log('Screenshot: 03-session-ui.png');

    // Check for resolution inputs
    const resInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type,
        placeholder: i.placeholder,
        name: i.name,
        id: i.id,
        value: i.value
      }));
    });
    log(`Resolution inputs: ${JSON.stringify(resInputs)}`);

    // Set resolution
    const resSet = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      let widthSet = false, heightSet = false;
      for (const input of inputs) {
        const ph = (input.placeholder || '').toLowerCase();
        const nm = (input.name || '').toLowerCase();
        const val = input.value || '';
        if (ph.includes('width') || nm.includes('width') || (ph.includes('largura'))) {
          input.value = '1280';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          widthSet = true;
        }
        if (ph.includes('height') || nm.includes('height') || ph.includes('altura')) {
          input.value = '720';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          heightSet = true;
        }
      }
      return { widthSet, heightSet };
    });
    log(`Resolution set: ${JSON.stringify(resSet)}`);

    // Click start/confirm button
    const startClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('iniciar') || text.includes('start') || text.includes('confirm') || text.includes('confirmar') || text.includes('criar')) {
          btn.click();
          return `Clicked: ${btn.textContent.trim()}`;
        }
      }
      return null;
    });
    log(`Start click: ${startClicked}`);
    await sleep(5000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/04-session-started.png` });
    log('Screenshot: 04-session-started.png');
    log(`Current URL: ${page.url()}`);

    // 6. Check for canvas and navigate to Google
    log('Checking for canvas...');
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        offsetLeft: canvas.offsetLeft,
        offsetTop: canvas.offsetTop,
        styleWidth: canvas.style.width,
        styleHeight: canvas.style.height,
        rectLeft: rect.left,
        rectTop: rect.top,
        rectWidth: rect.width,
        rectHeight: rect.height
      };
    });
    log(`Canvas info: ${JSON.stringify(canvasInfo)}`);
    results.canvas = canvasInfo;

    // 7. Check for navigation address bar
    log('Looking for address/URL bar...');
    const addressBarInfo = await page.evaluate(() => {
      const urlInputs = Array.from(document.querySelectorAll('input')).filter(i => {
        const ph = (i.placeholder || '').toLowerCase();
        const nm = (i.name || '').toLowerCase();
        const id = (i.id || '').toLowerCase();
        return ph.includes('url') || ph.includes('address') || ph.includes('http') || nm.includes('url') || id.includes('url') || id.includes('address');
      });
      return urlInputs.map(i => ({
        placeholder: i.placeholder,
        name: i.name,
        id: i.id,
        value: i.value
      }));
    });
    log(`Address bar inputs: ${JSON.stringify(addressBarInfo)}`);

    // Try to navigate to Google via address bar if it exists
    const navigated = await page.evaluate(async () => {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        const ph = (input.placeholder || '').toLowerCase();
        if (ph.includes('url') || ph.includes('address') || ph.includes('http') || ph.includes('navegue')) {
          input.value = 'https://www.google.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
          return `Navigated via: ${input.placeholder}`;
        }
      }
      return null;
    });
    log(`Navigation: ${navigated}`);
    await sleep(5000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-google-navigation.png` });
    log('Screenshot: 05-google-navigation.png');

    // 8. Check if canvas is showing google
    const canvasInfoAfterNav = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        rectLeft: Math.round(rect.left),
        rectTop: Math.round(rect.top),
        rectWidth: Math.round(rect.width),
        rectHeight: Math.round(rect.height)
      };
    });
    log(`Canvas after navigation: ${JSON.stringify(canvasInfoAfterNav)}`);
    results.canvas = canvasInfoAfterNav || results.canvas;

    // 9. Test clicks at various positions via the canvas
    log('Testing clicks on canvas...');

    if (canvasInfoAfterNav) {
      const { rectLeft, rectTop, rectWidth, rectHeight, width: cw, height: ch } = canvasInfoAfterNav;

      const testPositions = [
        { name: 'Google Search Bar', xPercent: 0.35, yPercent: 0.45 },
        { name: 'Top Left Corner', xPercent: 0.03, yPercent: 0.05 },
        { name: 'Top Right Corner', xPercent: 0.97, yPercent: 0.05 },
        { name: 'Bottom Left Corner', xPercent: 0.03, yPercent: 0.95 },
        { name: 'Bottom Right Corner', xPercent: 0.97, yPercent: 0.95 },
        { name: 'Center of Screen', xPercent: 0.5, yPercent: 0.5 },
        { name: 'Search Button', xPercent: 0.5, yPercent: 0.55 }
      ];

      for (const pos of testPositions) {
        const canvasX = Math.round(cw * pos.xPercent);
        const canvasY = Math.round(ch * pos.yPercent);

        // Map canvas coords to page coords
        const pageX = rectLeft + (rectWidth * pos.xPercent);
        const pageY = rectTop + (rectHeight * pos.yPercent);

        log(`Clicking: ${pos.name} at canvas(${canvasX}, ${canvasY}) / page(${Math.round(pageX)}, ${Math.round(pageY)})`);

        // Perform click via Playwright (real mouse event)
        await page.mouse.click(pageX, pageY);
        await sleep(1500);

        const screenshotFile = `${SCREENSHOTS_DIR}/click-${pos.name.toLowerCase().replace(/\s+/g, '-')}.png`;
        await page.screenshot({ path: screenshotFile });

        results.tests.push({
          name: pos.name,
          canvasPos: { x: canvasX, y: canvasY },
          pagePos: { x: Math.round(pageX), y: Math.round(pageY) },
          screenshot: path.basename(screenshotFile)
        });
        log(`  Screenshot saved: ${path.basename(screenshotFile)}`);
      }
    } else {
      log('No canvas found - cannot test mouse clicks!');
      results.errors.push('Canvas not found');
    }

  } catch (error) {
    log(`ERROR: ${error.message}`);
    log(error.stack);
    results.errors.push(error.message);
    try {
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/error.png` });
    } catch (e2) {}
  } finally {
    await browser.close();
  }

  log('\n=== FINAL RESULTS ===');
  log(`Canvas: ${JSON.stringify(results.canvas, null, 2)}`);
  log(`Tests: ${results.tests.length}`);
  for (const t of results.tests) {
    log(`  ${t.name}: canvas(${t.canvasPos?.x}, ${t.canvasPos?.y}) page(${t.pagePos?.x}, ${t.pagePos?.y})`);
  }
  if (results.errors.length > 0) {
    log(`Errors: ${results.errors.join(', ')}`);
  }

  return results;
}

testMouseOffset().catch(console.error);
