#!/usr/bin/env node
/**
 * Playwright script to investigate mouse offset in Serende frontend
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', '.claude-images');

const SERENDE_URL = 'https://serende.ddw1sl.easypanel.host';
const API_KEY = process.env.KEY;
if (!API_KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node scripts/investigate-mouse-offset.mjs');
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiLogin(page) {
  return page.evaluate(({ url, key }) => {
    return fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    }).then(r => r.json());
  }, { url: SERENDE_URL, key: API_KEY });
}

async function apiCreateSession(page, token) {
  return page.evaluate(({ url, token }) => {
    return fetch(`${url}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    }).then(r => r.json());
  }, { url: SERENDE_URL, token });
}

async function apiGetSession(page, token, sessionId) {
  return page.evaluate(({ url, token, sid }) => {
    return fetch(`${url}/api/sessions/${sid}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).then(r => r.json());
  }, { url: SERENDE_URL, token, sid: sessionId });
}

async function apiScreenshot(page, token, sessionId) {
  return page.evaluate(({ url, token, sid }) => {
    return fetch(`${url}/api/sessions/${sid}/screenshot`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }).then(async r => {
      if (!r.ok) return { error: `${r.status}: ${await r.text()}` };
      const buffer = await r.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return { base64: btoa(binary), size: buffer.byteLength };
    });
  }, { url: SERENDE_URL, token, sid: sessionId });
}

async function apiCDP(page, token, sessionId, method, params = {}) {
  return page.evaluate(({ url, token, sid, method, params }) => {
    return fetch(`${url}/api/sessions/${sid}/cdp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ method, params }),
    }).then(r => r.json());
  }, { url: SERENDE_URL, token, sid: sessionId, method, params });
}

async function saveRemoteScreenshot(data, filename) {
  if (data.base64) {
    const buf = Buffer.from(data.base64, 'base64');
    writeFileSync(join(OUTPUT_DIR, filename), buf);
    log(`Remote screenshot saved: ${filename} (${data.size} bytes)`);
    return true;
  } else {
    log(`Screenshot error: ${JSON.stringify(data)}`);
    return false;
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', msg => {
    const text = `[CONSOLE ${msg.type()}] ${msg.text()}`;
    consoleLogs.push(text);
    log(text);
  });

  try {
    // ============================================================
    // PART A: Login and create session via API
    // ============================================================
    log('=== PART A: Login and Session Creation ===');

    await page.goto(SERENDE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);
    await page.screenshot({ path: join(OUTPUT_DIR, '01-initial.png') });

    // Login via API
    log('Logging in via API...');
    const loginResult = await apiLogin(page);
    log(`Login result: ${JSON.stringify(loginResult)}`);
    if (!loginResult.token) throw new Error(`Login failed: ${JSON.stringify(loginResult)}`);
    const authToken = loginResult.token;
    log(`Auth token: ${authToken.substring(0, 20)}...`);

    // Create session
    log('Creating session...');
    const sessionResult = await apiCreateSession(page, authToken);
    log(`Session: ${JSON.stringify(sessionResult)}`);
    const sessionId = sessionResult.id || sessionResult.sessionId;
    if (!sessionId) throw new Error('No session ID');
    log(`Session ID: ${sessionId}`);

    // Wait for session to be ready
    log('Waiting for session to be ready...');
    let sessionStatus = null;
    for (let i = 0; i < 30; i++) {
      sessionStatus = await apiGetSession(page, authToken, sessionId);
      log(`Status [${i}]: ${JSON.stringify(sessionStatus)}`);
      if (sessionStatus.status === 'running' || sessionStatus.fps > 0 || sessionStatus.streamActive) {
        break;
      }
      await sleep(2000);
    }

    // Get remote browser screenshot
    const ss1 = await apiScreenshot(page, authToken, sessionId);
    await saveRemoteScreenshot(ss1, '02-remote-initial.png');

    // Navigate to Google in the remote browser
    log('Navigating remote browser to Google...');
    await apiCDP(page, authToken, sessionId, 'Page.navigate', { url: 'https://www.google.com' });
    await sleep(4000);

    const ss2 = await apiScreenshot(page, authToken, sessionId);
    await saveRemoteScreenshot(ss2, '03-remote-google.png');

    // Get layout metrics from remote browser
    log('Getting remote browser metrics...');
    const layoutMetrics = await apiCDP(page, authToken, sessionId, 'Page.getLayoutMetrics', {});
    log(`Layout metrics: ${JSON.stringify(layoutMetrics)}`);

    // Get window bounds
    const windowBounds = await apiCDP(page, authToken, sessionId, 'Browser.getWindowBounds', { windowId: 1 });
    log(`Window bounds: ${JSON.stringify(windowBounds)}`);

    // ============================================================
    // PART B: UI-based investigation - open the session viewer
    // ============================================================
    log('\n=== PART B: UI Investigation ===');

    // Login via UI
    log('Logging in via UI...');
    await page.goto(SERENDE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    const apiInput = await page.$('input[placeholder*="API"]') || await page.$('input[type="password"]');
    if (apiInput) {
      await apiInput.fill(API_KEY);
      log('Filled API key input');
    }

    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      log('Clicked submit');
    }
    await sleep(3000);
    await page.screenshot({ path: join(OUTPUT_DIR, '04-after-login.png') });

    // Check what we see now
    log('Checking page after login...');
    const pageStructure = await page.evaluate(() => {
      const body = document.body.innerText.substring(0, 500);
      const canvases = document.querySelectorAll('canvas').length;
      const videos = document.querySelectorAll('video').length;
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).slice(0, 10);
      const links = Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.textContent.trim() })).slice(0, 10);
      return { bodyText: body, canvases, videos, buttons, links };
    });
    log(`Page structure: ${JSON.stringify(pageStructure)}`);

    // Try to click on the session to connect
    log('Looking for session to connect...');

    // Check for "New Session" button or existing session
    const allButtons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, [role="button"], [class*="clickable"]')).map(el => ({
        text: el.textContent.trim().substring(0, 100),
        tag: el.tagName,
        className: el.className,
        id: el.id,
      }));
    });
    log(`All buttons: ${JSON.stringify(allButtons)}`);

    // Try clicking on session or "New Session" button
    for (const { text } of allButtons) {
      if (text.includes(sessionId?.substring(0, 8)) || text.toLowerCase().includes('nova') || text.toLowerCase().includes('new') || text.toLowerCase().includes('connect')) {
        log(`Clicking button: "${text}"`);
        await page.click(`button:has-text("${text.substring(0, 30)}")`).catch(() => null);
        await sleep(3000);
        break;
      }
    }

    await page.screenshot({ path: join(OUTPUT_DIR, '05-after-connect.png') });

    // Check for canvas
    let canvas = await page.$('canvas');
    log(`Canvas found: ${!!canvas}`);

    if (!canvas) {
      // Maybe we need to create session from the UI
      log('Trying to create session from UI...');

      // Click any "create"/"new" type button
      for (const sel of ['button:has-text("Nova")', 'button:has-text("New")', 'button:has-text("Create")', 'button:has-text("Criar")']) {
        try {
          const el = await page.$(sel);
          if (el) {
            log(`Clicking: ${sel}`);
            await el.click();
            await sleep(5000);
            break;
          }
        } catch (e) { /* ignore */ }
      }

      await page.screenshot({ path: join(OUTPUT_DIR, '06-after-create.png') });
      canvas = await page.$('canvas');
      log(`Canvas after create: ${!!canvas}`);
    }

    if (!canvas) {
      // Wait for canvas to appear
      log('Waiting for canvas to appear...');
      try {
        await page.waitForSelector('canvas', { timeout: 30000 });
        canvas = await page.$('canvas');
        log(`Canvas appeared: ${!!canvas}`);
      } catch (e) {
        log('Canvas did not appear within timeout');
      }
    }

    if (canvas) {
      // ============================================================
      // PART C: Canvas diagnostic
      // ============================================================
      log('\n=== PART C: Canvas Diagnostic ===');

      await sleep(3000); // Let the stream stabilize
      await page.screenshot({ path: join(OUTPUT_DIR, '07-canvas-visible.png') });

      const diagResult = await page.evaluate(() => {
        const viewer = document.querySelector('canvas');
        if (!viewer) return { error: 'Canvas NOT found' };

        const rect = viewer.getBoundingClientRect();
        const cw = viewer.width;
        const ch = viewer.height;

        const containerAspect = rect.width / rect.height;
        const canvasAspect = cw / ch;

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

        // Also check CSS object-fit property
        const computedStyle = window.getComputedStyle(viewer);
        const objectFit = computedStyle.objectFit;
        const objectPosition = computedStyle.objectPosition;

        // Get all canvas-related styles
        const styles = {
          objectFit,
          objectPosition,
          display: computedStyle.display,
          position: computedStyle.position,
          width: computedStyle.width,
          height: computedStyle.height,
          maxWidth: computedStyle.maxWidth,
          maxHeight: computedStyle.maxHeight,
        };

        // Check parent container
        const parent = viewer.parentElement;
        const parentRect = parent ? parent.getBoundingClientRect() : null;

        return {
          cssSizeW: rect.width,
          cssSizeH: rect.height,
          internalW: cw,
          internalH: ch,
          containerAspect,
          canvasAspect,
          renderedW: renderW,
          renderedH: renderH,
          offsetX,
          offsetY,
          canvasAbsX: rect.left + offsetX,
          canvasAbsY: rect.top + offsetY,
          rectLeft: rect.left,
          rectTop: rect.top,
          rectRight: rect.right,
          rectBottom: rect.bottom,
          styles,
          parentRect: parentRect ? {
            left: parentRect.left,
            top: parentRect.top,
            width: parentRect.width,
            height: parentRect.height,
          } : null,
        };
      });

      console.log('\n========================================');
      console.log('       CANVAS DIAGNOSTIC RESULTS');
      console.log('========================================');
      console.log(`Canvas CSS size: ${diagResult.cssSizeW?.toFixed(1)} x ${diagResult.cssSizeH?.toFixed(1)}`);
      console.log(`Canvas internal size: ${diagResult.internalW} x ${diagResult.internalH}`);
      console.log(`Container aspect: ${diagResult.containerAspect?.toFixed(3)}`);
      console.log(`Canvas aspect: ${diagResult.canvasAspect?.toFixed(3)}`);
      console.log(`Rendered area: ${diagResult.renderedW?.toFixed(1)} x ${diagResult.renderedH?.toFixed(1)}`);
      console.log(`Offset: ${diagResult.offsetX?.toFixed(1)} , ${diagResult.offsetY?.toFixed(1)}`);
      console.log(`Canvas absolute pos: ${diagResult.canvasAbsX?.toFixed(1)} , ${diagResult.canvasAbsY?.toFixed(1)}`);
      console.log(`Canvas rect: left=${diagResult.rectLeft?.toFixed(1)}, top=${diagResult.rectTop?.toFixed(1)}, right=${diagResult.rectRight?.toFixed(1)}, bottom=${diagResult.rectBottom?.toFixed(1)}`);
      console.log(`CSS styles: ${JSON.stringify(diagResult.styles, null, 2)}`);
      console.log(`Parent rect: ${JSON.stringify(diagResult.parentRect, null, 2)}`);
      console.log('========================================\n');

      // ============================================================
      // PART D: Mouse movement and click test
      // ============================================================
      log('\n=== PART D: Mouse Click Test ===');

      const canvasBox = await canvas.boundingBox();
      log(`Canvas bounding box: ${JSON.stringify(canvasBox)}`);

      if (canvasBox) {
        // Move mouse to center
        const cx = canvasBox.x + canvasBox.width / 2;
        const cy = canvasBox.y + canvasBox.height / 2;
        log(`Moving mouse to center: ${cx}, ${cy}`);
        await page.mouse.move(cx, cy);
        await sleep(500);
        await page.screenshot({ path: join(OUTPUT_DIR, '08-mouse-center.png') });

        // Move to top-left area
        const tlx = canvasBox.x + canvasBox.width * 0.1;
        const tly = canvasBox.y + canvasBox.height * 0.1;
        log(`Moving mouse to top-left: ${tlx}, ${tly}`);
        await page.mouse.move(tlx, tly);
        await sleep(500);
        await page.screenshot({ path: join(OUTPUT_DIR, '09-mouse-topleft.png') });

        // Move to bottom-right
        const brx = canvasBox.x + canvasBox.width * 0.9;
        const bry = canvasBox.y + canvasBox.height * 0.9;
        log(`Moving mouse to bottom-right: ${brx}, ${bry}`);
        await page.mouse.move(brx, bry);
        await sleep(500);
        await page.screenshot({ path: join(OUTPUT_DIR, '10-mouse-bottomright.png') });

        // Click at center (where Google search box should be roughly)
        log('Clicking at center of canvas...');
        await page.mouse.click(cx, cy);
        await sleep(2000);
        await page.screenshot({ path: join(OUTPUT_DIR, '11-after-click-center.png') });

        // Get remote screenshot to see where click went
        const ss3 = await apiScreenshot(page, authToken, sessionId);
        await saveRemoteScreenshot(ss3, '12-remote-after-click.png');

        // Try clicking on Google's search bar area (upper center area)
        const searchBarX = canvasBox.x + canvasBox.width * 0.5;
        const searchBarY = canvasBox.y + canvasBox.height * 0.42;
        log(`Clicking at estimated search bar: ${searchBarX}, ${searchBarY}`);
        await page.mouse.click(searchBarX, searchBarY);
        await sleep(2000);
        await page.screenshot({ path: join(OUTPUT_DIR, '13-after-click-searchbar.png') });

        const ss4 = await apiScreenshot(page, authToken, sessionId);
        await saveRemoteScreenshot(ss4, '14-remote-after-searchbar-click.png');

        // Type something to see where input goes
        log('Typing "hello world" to test input...');
        await page.keyboard.type('hello world', { delay: 50 });
        await sleep(1000);
        await page.screenshot({ path: join(OUTPUT_DIR, '15-after-typing.png') });

        const ss5 = await apiScreenshot(page, authToken, sessionId);
        await saveRemoteScreenshot(ss5, '16-remote-after-typing.png');
      }

      // ============================================================
      // PART E: Check the useInputRelay source code for offset logic
      // ============================================================
      log('\n=== PART E: Check frontend JS for offset logic ===');

      const inputRelayCode = await page.evaluate(() => {
        // Try to find the bundled JS and look for mouse/offset/coordinate-related code
        const scripts = document.querySelectorAll('script[src]');
        const scriptSrcs = Array.from(scripts).map(s => s.src);

        // Look for event listeners on the canvas
        const canvas = document.querySelector('canvas');
        if (!canvas) return { error: 'no canvas' };

        // Check if there are event listeners
        const listeners = typeof getEventListeners !== 'undefined' ?
          getEventListeners(canvas) : 'getEventListeners not available';

        return {
          scriptSrcs,
          canvasAttributes: {
            width: canvas.width,
            height: canvas.height,
            style: canvas.getAttribute('style'),
            className: canvas.className,
          },
          listeners: typeof listeners === 'string' ? listeners : 'found',
        };
      });
      log(`Frontend code info: ${JSON.stringify(inputRelayCode)}`);

      // Check the JS bundle for coordinate/offset logic
      if (inputRelayCode.scriptSrcs && inputRelayCode.scriptSrcs.length > 0) {
        for (const src of inputRelayCode.scriptSrcs) {
          log(`Fetching JS bundle: ${src}`);
          const jsContent = await page.evaluate(async (url) => {
            const res = await fetch(url);
            const text = await res.text();
            // Search for coordinate/offset related code
            const lines = text.split('\n');
            const relevantSnippets = [];
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.match(/offsetX|offsetY|clientX|clientY|getBoundingClientRect|canvasX|canvasY|scaleX|scaleY|mouseMove|mousemove|relayMouse|inputRelay|x11.*mouse/i)) {
                relevantSnippets.push({
                  lineNum: i + 1,
                  content: line.substring(Math.max(0, line.indexOf('offset') - 100, line.indexOf('clientX') - 100, line.indexOf('mouse') - 100), 300),
                });
              }
            }
            return {
              totalLength: text.length,
              snippetCount: relevantSnippets.length,
              snippets: relevantSnippets.slice(0, 20),
            };
          }, src);
          log(`JS analysis: ${JSON.stringify(jsContent)}`);
        }
      }

    } else {
      log('WARNING: Canvas never appeared in the UI');
      log('Checking page HTML for clues...');
      const html = await page.content();
      log(`Page HTML length: ${html.length}`);
      log(`Has canvas: ${html.includes('canvas')}`);
      log(`Has video: ${html.includes('video')}`);

      // Get a full page screenshot
      await page.screenshot({ path: join(OUTPUT_DIR, '99-no-canvas-final.png'), fullPage: true });
    }

    // ============================================================
    // PART F: Check the server-side input handling code
    // ============================================================
    log('\n=== PART F: Server-side X11 input info ===');

    // Get the X11 display resolution
    const x11Info = await apiCDP(page, authToken, sessionId, 'Runtime.evaluate', {
      expression: `JSON.stringify({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: screen.width, screenHeight: screen.height, devicePixelRatio: window.devicePixelRatio })`,
      returnByValue: true,
    });
    log(`Remote browser window info: ${JSON.stringify(x11Info)}`);

    // Summary
    console.log('\n========================================');
    console.log('       INVESTIGATION COMPLETE');
    console.log('========================================');
    console.log(`Session ID: ${sessionId}`);
    console.log(`Total console logs captured: ${consoleLogs.length}`);
    console.log('Screenshots saved to .claude-images/');
    console.log('========================================\n');

  } catch (error) {
    log(`FATAL ERROR: ${error.message}`);
    log(error.stack);
    await page.screenshot({ path: join(OUTPUT_DIR, 'error-state.png') }).catch(() => null);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
