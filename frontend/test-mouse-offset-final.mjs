import { chromium } from 'playwright';
import fs from 'fs';

const API_KEY = process.env.KEY;
if (!API_KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node frontend/test-mouse-offset-final.mjs');
  process.exit(1);
}

const SCREENSHOTS_DIR = '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/frontend/.claude-images';

function log(msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testMouseOffset() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  log('Launching browser in headful mode...');
  const browser = await chromium.launch({
    headless: false,
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
    log('Step 1: Navigating to serende...');
    await page.goto('https://serende.ddw1sl.easypanel.host', { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/step1-landing.png` });
    log('Screenshot: step1-landing.png');

    // 2. Authenticate via API directly (set token in localStorage)
    log('Step 2: Getting auth token...');
    const tokenResponse = await page.evaluate(async (key) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key })
      });
      return res.json();
    }, API_KEY);
    log(`Auth response: ${JSON.stringify(tokenResponse)}`);

    // Set token in localStorage
    await page.evaluate((data) => {
      localStorage.setItem('serende_token', data.token);
      localStorage.setItem('serende_tenantId', data.tenantId || data.userId);
    }, tokenResponse);

    // Reload page to trigger authentication
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/step2-authenticated.png` });
    log('Screenshot: step2-authenticated.png');

    // 3. Create session
    log('Step 3: Creating session...');

    // The session is created via POST to /api/sessions
    const sessionResponse = await page.evaluate(async () => {
      const token = localStorage.getItem('serende_token');
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ width: 1280, height: 720, startUrl: 'https://www.google.com' })
      });
      if (!res.ok) {
        const text = await res.text();
        return { error: text, status: res.status };
      }
      return res.json();
    });
    log(`Session creation: ${JSON.stringify(sessionResponse)}`);

    if (sessionResponse.error) {
      throw new Error(`Failed to create session: ${sessionResponse.error}`);
    }

    results.sessionId = sessionResponse.sessionId;
    log(`Session ID: ${results.sessionId}`);

    // Wait for the browser component to load
    await sleep(3000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/step3-session-created.png` });
    log('Screenshot: step3-session-created.png');

    // 4. Check canvas dimensions
    log('Step 4: Checking canvas dimensions...');
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return { error: 'Canvas not found' };
      const rect = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        rectLeft: Math.round(rect.left),
        rectTop: Math.round(rect.top),
        rectWidth: Math.round(rect.width),
        rectHeight: Math.round(rect.height),
        styleWidth: canvas.style.width,
        styleHeight: canvas.style.height
      };
    });
    log(`Canvas: ${JSON.stringify(canvasInfo)}`);
    results.canvas = canvasInfo;

    if (canvasInfo.error) {
      throw new Error(canvasInfo.error);
    }

    // 5. Wait for some video frames to load
    log('Step 5: Waiting for video stream...');
    await sleep(5000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/step5-video-loaded.png` });
    log('Screenshot: step5-video-loaded.png');

    // 6. Test clicks at various positions
    log('Step 6: Testing mouse clicks...');

    const { rectLeft, rectTop, rectWidth, rectHeight, width: canvasW, height: canvasH } = canvasInfo;

    const testPositions = [
      { name: 'Top Left', xPercent: 0.05, yPercent: 0.1 },
      { name: 'Top Right', xPercent: 0.95, yPercent: 0.1 },
      { name: 'Center', xPercent: 0.5, yPercent: 0.5 },
      { name: 'Bottom Left', xPercent: 0.05, yPercent: 0.9 },
      { name: 'Bottom Right', xPercent: 0.95, yPercent: 0.9 },
      { name: 'Google Bar', xPercent: 0.35, yPercent: 0.5 },
      { name: 'Search Button', xPercent: 0.6, yPercent: 0.5 }
    ];

    for (const pos of testPositions) {
      const pageX = rectLeft + (rectWidth * pos.xPercent);
      const pageY = rectTop + (rectHeight * pos.yPercent);
      const canvasX = Math.round(canvasW * pos.xPercent);
      const canvasY = Math.round(canvasH * pos.yPercent);

      log(`  Testing ${pos.name} at page(${Math.round(pageX)}, ${Math.round(pageY)}) -> canvas(${canvasX}, ${canvasY})`);

      // Perform the click
      await page.mouse.click(pageX, pageY);
      await sleep(1500);

      // Screenshot
      const filename = `click-${pos.name.toLowerCase().replace(/\s+/g, '-')}.png`;
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/${filename}` });

      results.tests.push({
        name: pos.name,
        pagePos: { x: Math.round(pageX), y: Math.round(pageY) },
        canvasPos: { x: canvasX, y: canvasY },
        screenshot: filename
      });
      log(`    Screenshot: ${filename}`);
    }

    // 7. Check browser console for any errors
    log('Step 7: Checking console...');
    const consoleLogs = await page.evaluate(() => {
      return (window._consoleLogs || []).slice(-10);
    });
    if (consoleLogs.length > 0) {
      log(`Recent console logs: ${JSON.stringify(consoleLogs)}`);
    }

  } catch (error) {
    log(`ERROR: ${error.message}`);
    log(error.stack);
    results.errors.push(error.message);
    try {
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/error.png` });
    } catch (e2) {}
  } finally {
    // Keep browser open for manual inspection if needed
    log('Browser will stay open for 30 seconds for manual inspection...');
    await sleep(30000);
    await browser.close();
  }

  log('\n===== FINAL RESULTS =====');
  log(`Session ID: ${results.sessionId}`);
  log(`Canvas: ${JSON.stringify(results.canvas, null, 2)}`);
  log(`Tests: ${results.tests.length}`);
  for (const t of results.tests) {
    log(`  ${t.name}: page(${t.pagePos.x}, ${t.pagePos.y}) -> canvas(${t.canvasPos.x}, ${t.canvasPos.y}) -> ${t.screenshot}`);
  }
  if (results.errors.length > 0) {
    log(`Errors: ${results.errors.join(', ')}`);
  }

  return results;
}

testMouseOffset().catch(console.error);
