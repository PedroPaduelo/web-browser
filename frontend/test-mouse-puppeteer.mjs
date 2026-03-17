import puppeteer from 'puppeteer';
import fs from 'fs';

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

  log('Launching Puppeteer with Xvfb...');
  const browser = await puppeteer.launch({
    headless: false,  // false to use Xvfb
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ],
    executablePath: '/usr/bin/chromium'
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const results = {
    canvas: null,
    sessionId: null,
    tests: [],
    errors: []
  };

  try {
    // 1. Navigate to serende
    log('Step 1: Navigating to serende...');
    await page.goto('https://serende.ddw1sl.easypanel.host', { waitUntil: 'networkidle2' });
    await sleep(2000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/p-step1-landing.png` });
    log('Screenshot: p-step1-landing.png');

    // 2. Authenticate via API
    log('Step 2: Authenticating...');
    const authResult = await page.evaluate(async () => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'serende-dev-key-2024' })
      });
      const data = await res.json();
      localStorage.setItem('serende_token', data.token);
      localStorage.setItem('serende_tenantId', data.tenantId || data.userId);
      return data;
    });
    log(`Auth: tenantId=${authResult.tenantId || authResult.userId}`);

    // Reload to trigger auth state
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(2000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/p-step2-auth.png` });
    log('Screenshot: p-step2-auth.png');

    // 3. Create session
    log('Step 3: Creating session (1280x720)...');
    const sessionResult = await page.evaluate(async () => {
      const token = localStorage.getItem('serende_token');
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ width: 1280, height: 720 })
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { error: text, status: res.status };
      }
    });
    log(`Session: ${JSON.stringify(sessionResult)}`);

    if (sessionResult.error) {
      throw new Error(`Session failed: ${sessionResult.error}`);
    }

    results.sessionId = sessionResult.sessionId;

    // Wait for canvas to appear and stream to connect
    await sleep(5000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/p-step3-session.png` });
    log('Screenshot: p-step3-session.png');

    // 4. Get canvas info
    log('Step 4: Getting canvas info...');
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return { error: 'Canvas not found', html: document.body.innerHTML.substring(0, 500) };

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
        offsetLeft: canvas.offsetLeft,
        offsetTop: canvas.offsetTop
      };
    });

    if (canvasInfo.error) {
      log(`Canvas error: ${canvasInfo.error}`);
      if (canvasInfo.html) {
        log(`Page HTML: ${canvasInfo.html}`);
      }
      throw new Error(canvasInfo.error);
    }

    results.canvas = canvasInfo;
    log(`Canvas: ${canvasInfo.width}x${canvasInfo.height} (display: ${canvasInfo.rectWidth}x${canvasInfo.rectHeight})`);

    // 5. Wait for video stream
    log('Step 5: Waiting for video stream...');
    await sleep(8000);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/p-step5-stream.png` });
    log('Screenshot: p-step5-stream.png');

    // 6. Test clicks
    log('Step 6: Testing mouse clicks at various positions...');

    const { rectLeft, rectTop, rectWidth, rectHeight, width: canvasW, height: canvasH } = canvasInfo;

    const testPositions = [
      { name: 'Top Left', xPercent: 0.05, yPercent: 0.1 },
      { name: 'Center', xPercent: 0.5, yPercent: 0.5 },
      { name: 'Bottom Right', xPercent: 0.95, yPercent: 0.9 }
    ];

    for (const pos of testPositions) {
      const pageX = Math.round(rectLeft + (rectWidth * pos.xPercent));
      const pageY = Math.round(rectTop + (rectHeight * pos.yPercent));
      const canvasX = Math.round(canvasW * pos.xPercent);
      const canvasY = Math.round(canvasH * pos.yPercent);

      log(`  ${pos.name}: page(${pageX}, ${pageY}) -> canvas(${canvasX}, ${canvasY})`);

      // Click using Puppeteer
      await page.mouse.click(pageX, pageY);
      await sleep(2000);

      const filename = `p-click-${pos.name.toLowerCase().replace(/\s+/g, '-')}.png`;
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/${filename}` });

      results.tests.push({
        name: pos.name,
        pagePos: { x: pageX, y: pageY },
        canvasPos: { x: canvasX, y: canvasY },
        screenshot: filename
      });
      log(`    Saved: ${filename}`);
    }

  } catch (error) {
    log(`ERROR: ${error.message}`);
    log(error.stack);
    results.errors.push(error.message);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/p-error.png` }).catch(() => {});
  } finally {
    log('Keeping browser open for 30s...');
    await sleep(30000);
    await browser.close();
  }

  log('\n===== RESULTS =====');
  log(`Session: ${results.sessionId}`);
  log(`Canvas: ${JSON.stringify(results.canvas)}`);
  log(`Tests: ${results.tests.length}`);
  for (const t of results.tests) {
    log(`  ${t.name}: ${t.screenshot}`);
  }
  if (results.errors.length) {
    log(`Errors: ${results.errors.join(', ')}`);
  }

  return results;
}

testMouseOffset().catch(console.error);
