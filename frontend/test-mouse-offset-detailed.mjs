import { chromium } from 'playwright';
import fs from 'fs';

const API_KEY = process.env.KEY;
if (!API_KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node frontend/test-mouse-offset-detailed.mjs');
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

  log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const results = {
    canvas: null,
    renderedRect: null,
    resolution: null,
    sessionId: null,
    tests: [],
    errors: []
  };

  try {
    // Navigate and authenticate
    await page.goto('https://serende.ddw1sl.easypanel.host', { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    const authResult = await page.evaluate(async (key) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key })
      });
      const data = await res.json();
      localStorage.setItem('serende_token', data.token);
      localStorage.setItem('serende_tenantId', data.tenantId || data.userId);
      return data;
    }, API_KEY);
    log(`Auth: tenantId=${authResult.tenantId}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Create session with explicit resolution
    log('Creating session (1280x720)...');
    const sessionResult = await page.evaluate(async () => {
      const token = localStorage.getItem('serende_token');
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ width: 1280, height: 720, startUrl: 'https://www.google.com' })
      });
      return res.json();
    });

    results.sessionId = sessionResult.sessionId;
    results.resolution = sessionResult.resolution;
    log(`Session: ${results.sessionId}, resolution: ${JSON.stringify(results.resolution)}`);

    // Wait for canvas
    await sleep(5000);

    // Get detailed canvas info including the rendered rect calculation
    const canvasDetails = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return { error: 'Canvas not found' };

      const rect = canvas.getBoundingClientRect();
      const container = canvas.parentElement;
      const containerRect = container ? container.getBoundingClientRect() : null;

      // Calculate what getRenderedCanvasRect does
      const cw = canvas.width;
      const ch = canvas.height;
      const canvasAspect = cw / ch;
      const containerAspect = containerRect ? (containerRect.width / containerRect.height) : (rect.width / rect.height);

      let renderW, renderH, offsetX, offsetY;
      if (canvasAspect > containerAspect) {
        renderW = rect.width;
        renderH = rect.width / canvasAspect;
        offsetX = 0;
        offsetY = (rect.height - renderH) / 2;
      } else {
        renderH = rect.height;
        renderW = rect.height * canvasAspect;
        offsetX = (rect.width - renderW) / 2;
        offsetY = 0;
      }

      return {
        canvas: {
          width: cw,
          height: ch,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight
        },
        boundingRect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        renderedRect: {
          left: Math.round(rect.left + offsetX),
          top: Math.round(rect.top + offsetY),
          width: Math.round(renderW),
          height: Math.round(renderH)
        },
        container: containerRect ? {
          left: Math.round(containerRect.left),
          top: Math.round(containerRect.top),
          width: Math.round(containerRect.width),
          height: Math.round(containerRect.height)
        } : null,
        offsetX: Math.round(offsetX),
        offsetY: Math.round(offsetY)
      };
    });

    results.canvas = canvasDetails.canvas;
    results.renderedRect = canvasDetails.renderedRect;
    log(`Canvas: ${canvasDetails.canvas.width}x${canvasDetails.canvas.height}`);
    log(`Bounding Rect: ${canvasDetails.boundingRect.left},${canvasDetails.boundingRect.top} ${canvasDetails.boundingRect.width}x${canvasDetails.boundingRect.height}`);
    log(`Rendered Rect: ${canvasDetails.renderedRect.left},${canvasDetails.renderedRect.top} ${canvasDetails.renderedRect.width}x${canvasDetails.renderedRect.height}`);
    log(`Offset: x=${canvasDetails.offsetX}, y=${canvasDetails.offsetY}`);

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/final-video-loaded.png` });
    log('Screenshot: final-video-loaded.png');

    // Test clicks using the RENDERED rect (not bounding rect)
    const { renderedRect, canvas: canvasInfo } = canvasDetails;

    const testPositions = [
      { name: 'Top Left', xPercent: 0.05, yPercent: 0.05 },
      { name: 'Top Right', xPercent: 0.95, yPercent: 0.05 },
      { name: 'Center', xPercent: 0.5, yPercent: 0.5 },
      { name: 'Bottom Left', xPercent: 0.05, yPercent: 0.95 },
      { name: 'Bottom Right', xPercent: 0.95, yPercent: 0.95 }
    ];

    for (const pos of testPositions) {
      // Use rendered rect coordinates
      const pageX = Math.round(renderedRect.left + (renderedRect.width * pos.xPercent));
      const pageY = Math.round(renderedRect.top + (renderedRect.height * pos.yPercent));
      const canvasX = Math.round(canvasInfo.width * pos.xPercent);
      const canvasY = Math.round(canvasInfo.height * pos.yPercent);

      log(`Testing ${pos.name}: page(${pageX}, ${pageY}) -> canvas(${canvasX}, ${canvasY})`);

      await page.mouse.click(pageX, pageY);
      await sleep(1500);

      const filename = `final-click-${pos.name.toLowerCase().replace(/\s+/g, '-')}.png`;
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/${filename}` });

      results.tests.push({
        name: pos.name,
        pagePos: { x: pageX, y: pageY },
        canvasPos: { x: canvasX, y: canvasY },
        screenshot: filename
      });
    }

    // Check console for errors
    const consoleLogs = await page.evaluate(() => {
      const logs = [];
      return logs;
    });

  } catch (error) {
    log(`ERROR: ${error.message}`);
    results.errors.push(error.message);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/final-error.png` }).catch(() => {});
  } finally {
    log('Keeping browser open for 20s...');
    await sleep(20000);
    await browser.close();
  }

  log('\n===== FINAL RESULTS =====');
  log(`Session: ${results.sessionId}`);
  log(`Resolution: ${JSON.stringify(results.resolution)}`);
  log(`Canvas: ${JSON.stringify(results.canvas)}`);
  log(`Rendered Rect: ${JSON.stringify(results.renderedRect)}`);
  log(`Tests: ${results.tests.length}`);
  for (const t of results.tests) {
    log(`  ${t.name}: page(${t.pagePos.x},${t.pagePos.y}) -> canvas(${t.canvasPos.x},${t.canvasPos.y})`);
  }

  return results;
}

testMouseOffset().catch(console.error);
