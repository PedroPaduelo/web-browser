const API_KEY = process.env.KEY;
if (!API_KEY) {
  console.error('KEY não definida — este script precisa da chave do cliente no ambiente.');
  console.error('Ex.: KEY=<chave> node frontend/test-mouse-offset.mjs');
  process.exit(1);
}

const { chromium } = require('playwright');

async function testMouseOffset() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  const results = {
    canvas: null,
    tests: []
  };

  try {
    // 1. Navigate to serende
    console.log('1. Navigating to https://serende.ddw1sl.easypanel.host...');
    await page.goto('https://serende.ddw1sl.easypanel.host', { waitUntil: 'networkidle' });

    // 2. Login with API key
    console.log('2. Logging in with API key...');
    await page.waitForSelector('input[type="text"], input[type="password"], input[type="email"]', { timeout: 10000 }).catch(() => null);

    const inputs = await page.$$('input');
    for (const input of inputs) {
      const type = await input.getAttribute('type');
      const placeholder = await input.getAttribute('placeholder') || '';
      if (type === 'text' || type === 'password' || type === 'email' || placeholder.toLowerCase().includes('key') || placeholder.toLowerCase().includes('api')) {
        await input.fill(API_KEY);
        break;
      }
    }

    // Try to find and click submit button
    const buttons = await page.$$('button, input[type="submit"]');
    for (const btn of buttons) {
      const text = await btn.textContent() || await btn.getAttribute('value') || '';
      const type = await btn.getAttribute('type');
      if (text.toLowerCase().includes('login') || text.toLowerCase().includes('entrar') || text.toLowerCase().includes('submit') || type === 'submit') {
        await btn.click();
        break;
      }
    }

    await page.waitForTimeout(3000);

    // Check if logged in
    console.log('Current URL after login:', page.url());

    // 3. Create new session with 1280x720
    console.log('3. Creating new session with 1280x720...');

    // Look for resolution inputs or create session button
    const createBtnSelectors = [
      'button:has-text("Nova sessão")',
      'button:has-text("New Session")',
      'button:has-text("Create")',
      'button:has-text("Criar")',
      '[class*="session"] button',
      '[class*="create"] button'
    ];

    let createBtn = null;
    for (const sel of createBtnSelectors) {
      createBtn = await page.$(sel);
      if (createBtn) break;
    }

    if (createBtn) {
      await createBtn.click();
      await page.waitForTimeout(2000);
    }

    // Set resolution to 1280x720 if there's a way to do it
    const widthInputs = await page.$$('input[name="width"], input[placeholder*="width"], input[placeholder*="Width"]');
    const heightInputs = await page.$$('input[name="height"], input[placeholder*="height"], input[placeholder*="Height"]');

    if (widthInputs.length > 0 && heightInputs.length > 0) {
      await widthInputs[0].fill('1280');
      await heightInputs[0].fill('720');
    }

    // Look for confirm/start button
    const startBtnSelectors = [
      'button:has-text("Iniciar")',
      'button:has-text("Start")',
      'button:has-text("Confirmar")',
      'button:has-text("Confirm")'
    ];

    for (const sel of startBtnSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        break;
      }
    }

    console.log('Waiting for session to start...');
    await page.waitForTimeout(5000);

    console.log('URL after session start:', page.url());

    // 4. Navigate to Google
    console.log('4. Navigating to https://www.google.com...');

    // Wait for any input field to appear (like address bar in the browser viewer)
    await page.waitForTimeout(2000);

    // Take initial screenshot
    await page.screenshot({ path: '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/frontend/test-serende-01-initial.png' });
    console.log('Screenshot saved: test-serende-01-initial.png');

    // Try to find address bar or URL input
    const urlInputs = await page.$$('input[type="url"], input[type="text"][placeholder*="url"], input[placeholder*="URL"], input[placeholder*="address"]');
    if (urlInputs.length > 0) {
      await urlInputs[0].fill('https://www.google.com');
      await urlInputs[0].press('Enter');
    } else {
      // Maybe there's a different way to navigate
      await page.goto('https://www.google.com', { waitUntil: 'networkidle' });
    }

    await page.waitForTimeout(3000);

    // Check canvas dimensions via console
    console.log('5. Checking canvas dimensions...');
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas) {
        return {
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          styleWidth: canvas.style.width,
          styleHeight: canvas.style.height
        };
      }
      return null;
    });
    console.log('Canvas info:', canvasInfo);
    results.canvas = canvasInfo;

    await page.screenshot({ path: '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/frontend/test-serende-02-google-loaded.png' });
    console.log('Screenshot saved: test-serende-02-google-loaded.png');

    // 5. Test clicks at various positions
    console.log('6. Testing clicks at various positions...');

    const testPositions = [
      { name: 'Google Search Bar', description: 'Search bar input', xPercent: 0.35, yPercent: 0.15 },
      { name: 'Search Button', description: 'Google search button', xPercent: 0.55, yPercent: 0.15 },
      { name: 'Top Left Corner', description: 'Top left corner of page', xPercent: 0.05, yPercent: 0.1 },
      { name: 'Bottom Right Corner', description: 'Bottom right corner of page', xPercent: 0.95, yPercent: 0.9 },
      { name: 'Top Right Corner', description: 'Top right corner of page', xPercent: 0.95, yPercent: 0.1 },
      { name: 'Bottom Left Corner', description: 'Bottom left corner of page', xPercent: 0.05, yPercent: 0.9 },
      { name: 'Center of Screen', description: 'Center of screen', xPercent: 0.5, yPercent: 0.5 }
    ];

    for (const test of testPositions) {
      console.log(`\nTesting: ${test.name}...`);

      // Get canvas dimensions
      const canvasDims = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return { width: canvas?.width || 0, height: canvas?.height || 0 };
      });

      const x = Math.round(canvasDims.width * test.xPercent);
      const y = Math.round(canvasDims.height * test.yPercent);

      console.log(`  Clicking at position: ${x}, ${y} (${test.xPercent * 100}%, ${test.yPercent * 100}%)`);

      // Perform click using CDP or dispatch event
      await page.evaluate(({ x, y }) => {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          // Try to dispatch mouse events
          const rect = canvas.getBoundingClientRect();
          const event = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + x,
            clientY: rect.top + y,
            button: 0,
            buttons: 1
          });
          canvas.dispatchEvent(event);

          const eventUp = new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + x,
            clientY: rect.top + y,
            button: 0,
            buttons: 0
          });
          canvas.dispatchEvent(eventUp);
        }
      }, { x, y });

      await page.waitForTimeout(1000);

      // Take screenshot after click
      const screenshotNum = results.tests.length + 3;
      const filename = `test-serende-${String(screenshotNum).padStart(2, '0')}-${test.name.toLowerCase().replace(/\s+/g, '-')}.png`;
      await page.screenshot({ path: `/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/frontend/${filename}` });

      // Record result
      results.tests.push({
        name: test.name,
        position: { x, y, xPercent: test.xPercent, yPercent: test.yPercent },
        screenshot: filename,
        passed: true // Will be determined by visual inspection
      });

      console.log(`  Screenshot saved: ${filename}`);
    }

  } catch (error) {
    console.error('Error during test:', error);
  } finally {
    await browser.close();
  }

  console.log('\n=== TEST RESULTS ===');
  console.log('Canvas dimensions:', results.canvas);
  console.log('\nTest positions:');
  for (const test of results.tests) {
    console.log(`  - ${test.name}: ${test.position.x}, ${test.position.y} -> ${test.screenshot}`);
  }

  return results;
}

testMouseOffset().then(console.log).catch(console.error);
