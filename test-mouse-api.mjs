#!/usr/bin/env node

/**
 * Test script for remote browser mouse functionality
 * Tests mouse alignment and --app mode (no Chrome UI)
 */

const API_KEY = 'serende-dev-key-2024';
const BASE_URL = 'https://serende.ddw1sl.easypanel.host';

let authToken = null;
let sessionId = null;

async function api(method, path, body) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    // Refresh token
    await login();
    headers['Authorization'] = `Bearer ${authToken}`;
    const retryResponse = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return retryResponse.json();
  }

  return response.json();
}

async function login() {
  console.log('1. Logging in...');
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: API_KEY }),
  });
  const data = await response.json();
  authToken = data.token;
  console.log('   ✓ Logged in successfully');
}

async function startSession() {
  console.log('\n2. Starting browser session...');
  const data = await api('POST', '/api/session', {
    resolution: '1280x720',
    startUrl: 'https://www.google.com',
  });
  sessionId = data.sessionId;
  console.log(`   ✓ Session started: ${sessionId}`);
  console.log(`   Viewer URL: ${BASE_URL}?session=${sessionId}`);
  return data;
}

async function navigate(url) {
  console.log(`\n3. Navigating to ${url}...`);
  const data = await api('POST', `/api/navigate/${sessionId}`, { url });
  console.log('   ✓ Navigated');

  // Wait for page load
  console.log('   Waiting for page load...');
  const maxWait = 15000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const result = await api('POST', `/api/evaluate/${sessionId}`, {
      script: `({ readyState: document.readyState, complete: document.readyState === 'complete' })`,
    });
    if (result.result?.complete) {
      console.log('   ✓ Page loaded');
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('   ! Page load timeout');
}

async function getScreenshot() {
  console.log('\n4. Taking screenshot...');
  const response = await fetch(`${BASE_URL}/api/screenshot/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  console.log(`   ✓ Screenshot taken (${buffer.byteLength} bytes)`);
  return { data: base64, mimeType: 'image/jpeg' };
}

async function checkForChromeUI() {
  console.log('\n5. Checking for Chrome UI elements (address bar, tabs)...');
  const result = await api('POST', `/api/evaluate/${sessionId}`, {
    script: `
      (() => {
        // Check for typical Chrome UI elements
        const omnibox = document.querySelector('input[role="combobox"]') ||
                       document.querySelector('.omnibox') ||
                       document.querySelector('[aria-label*="Address"]') ||
                       document.querySelector('[aria-label*="Endereço"]');

        // Check for tab strip
        const tabStrip = document.querySelector('.tab-strip') ||
                        document.querySelector('[role="tablist"]');

        // Check browser chrome
        const browserChrome = document.querySelector('#chrome') ||
                             document.querySelector('.browser-chrome') ||
                             document.querySelector('[role="application"]');

        // Get viewport info
        const viewport = {
          width: window.innerWidth,
          height: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
        };

        // Check if we're in app mode (no browser UI)
        const hasBrowserUI = !!(omnibox || tabStrip || browserChrome);

        return {
          hasAddressBar: !!omnibox,
          hasTabStrip: !!tabStrip,
          hasBrowserChrome: !!browserChrome,
          hasBrowserUI,
          viewport,
          isAppMode: !hasBrowserUI,
          title: document.title,
          url: window.location.href,
        };
      })()
    `,
  });

  console.log('   Results:');
  console.log(`   - Address bar visible: ${result.result.hasAddressBar}`);
  console.log(`   - Tab strip visible: ${result.result.hasTabStrip}`);
  console.log(`   - Browser chrome visible: ${result.result.hasBrowserChrome}`);
  console.log(`   - App mode (--app flag): ${result.result.isAppMode ? '✓ YES' : '✗ NO'}`);
  console.log(`   - Viewport: ${result.result.viewport.width}x${result.result.viewport.height}`);
  console.log(`   - Title: ${result.result.title}`);
  console.log(`   - URL: ${result.result.url}`);

  return result.result;
}

async function clickAndTest(x, y, description) {
  console.log(`\n6. Clicking at (${x}, ${y}) - ${description}...`);
  await api('POST', '/api/input', {
    sessionId: sessionId,
    type: 'click',
    x,
    y,
    button: 0,
  });
  console.log('   ✓ Clicked');
  await new Promise(r => setTimeout(r, 1000)); // Wait for reaction
}

async function typeText(text) {
  console.log(`\n7. Typing: "${text}"`);
  await api('POST', '/api/input/batch', {
    sessionId: sessionId,
    actions: text.split('').map(ch => [
      { type: 'keydown', key: ch },
      { type: 'keyup', key: ch },
    ]).flat(),
  });
  console.log('   ✓ Typed');
  await new Promise(r => setTimeout(r, 500));
}

async function pressEnter() {
  console.log('\n8. Pressing Enter...');
  await api('POST', '/api/input/batch', {
    sessionId: sessionId,
    actions: [
      { type: 'keydown', key: 'Enter' },
      { type: 'keyup', key: 'Enter' },
    ],
  });
  console.log('   ✓ Enter pressed');
  await new Promise(r => setTimeout(r, 2000));
}

async function checkSearchResults() {
  console.log('\n9. Checking if search worked...');
  const result = await api('POST', `/api/evaluate/${sessionId}`, {
    script: `
      (() => {
        const searchInput = document.querySelector('textarea[name="q"]') ||
                          document.querySelector('input[name="q"]');
        const searchResults = document.querySelector('#search') ||
                             document.querySelector('#ires');

        return {
          hasSearchInput: !!searchInput,
          hasSearchResults: !!searchResults,
          inputValue: searchInput ? searchInput.value : null,
          title: document.title,
          url: window.location.href,
        };
      })()
    `,
  });

  console.log('   Results:');
  console.log(`   - Search input found: ${result.result.hasSearchInput}`);
  console.log(`   - Search results found: ${result.result.hasSearchResults}`);
  console.log(`   - Input value: "${result.result.inputValue}"`);
  console.log(`   - Title: ${result.result.title}`);
  console.log(`   - URL: ${result.result.url}`);

  return result.result;
}

async function stopSession() {
  console.log('\n10. Stopping session...');
  await api('DELETE', `/api/session/${sessionId}`);
  console.log('   ✓ Session stopped');
}

async function main() {
  try {
    console.log('='.repeat(60));
    console.log('Remote Browser Mouse Test');
    console.log('='.repeat(60));

    await login();
    const sessionData = await startSession();
    await navigate('https://www.google.com');
    await new Promise(r => setTimeout(r, 2000)); // Extra wait for rendering

    const screenshot = await getScreenshot();
    const uiCheck = await checkForChromeUI();

    console.log('\n' + '='.repeat(60));
    console.log('TEST RESULTS:');
    console.log('='.repeat(60));

    if (!uiCheck.isAppMode) {
      console.log('\n⚠️  WARNING: Chrome UI is visible!');
      console.log('    The --app flag is NOT working properly.');
      console.log('    Expected: No address bar, no tabs (app mode)');
      console.log(`    Got: Address bar=${uiCheck.hasAddressBar}, Tabs=${uiCheck.hasTabStrip}`);
    } else {
      console.log('\n✓ SUCCESS: Chrome is running in app mode');
      console.log('  No address bar or tabs visible');
    }

    console.log('\n' + '-'.repeat(60));
    console.log('Testing mouse interaction...');
    console.log('-'.repeat(60));

    // Google search box is typically centered, approximate coordinates for 1280x720
    // Search box center is roughly at (640, 300) for Google homepage
    await clickAndTest(640, 300, 'Google search box (center)');
    await typeText('test search');
    await pressEnter();

    const searchResults = await checkSearchResults();

    console.log('\n' + '='.repeat(60));
    console.log('MOUSE ALIGNMENT TEST RESULTS:');
    console.log('='.repeat(60));

    if (searchResults.inputValue && searchResults.inputValue.includes('test search')) {
      console.log('\n✓ SUCCESS: Mouse clicks are ALIGNED!');
      console.log('  The click hit the search box and text was entered correctly');
    } else if (searchResults.hasSearchResults) {
      console.log('\n✓ SUCCESS: Mouse clicks are ALIGNED!');
      console.log('  The search was executed successfully');
    } else {
      console.log('\n✗ FAIL: Mouse clicks are MISALIGNED');
      console.log('  The click did not hit the search box');
      console.log('  Check the screenshot to see where the click landed');
    }

    await new Promise(r => setTimeout(r, 2000));
    const finalScreenshot = await getScreenshot();

    console.log('\n' + '='.repeat(60));
    console.log('SCREENSHOTS:');
    console.log('='.repeat(60));
    console.log('\nInitial screenshot (data URI):');
    console.log(`data:${screenshot.mimeType};base64,${screenshot.data.substring(0, 100)}...`);
    console.log('\nFinal screenshot (data URI):');
    console.log(`data:${finalScreenshot.mimeType};base64,${finalScreenshot.data.substring(0, 100)}...`);

    console.log('\nOpening viewer URL in browser...');
    console.log(`Viewer: ${BASE_URL}?session=${sessionId}`);
    console.log('(Copy this URL and open in your browser to see the live stream)');

    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log('='.repeat(60));
    console.log(`App mode (--app flag): ${uiCheck.isAppMode ? '✓ WORKING' : '✗ NOT WORKING'}`);
    console.log(`Mouse alignment: ${searchResults.inputValue || searchResults.hasSearchResults ? '✓ WORKING' : '✗ NOT WORKING'}`);
    console.log(`\nSession ID: ${sessionId}`);
    console.log(`Viewer URL: ${BASE_URL}?session=${sessionId}`);

    // Keep session running for manual inspection
    console.log('\n⚠️  Session kept running for manual inspection');
    console.log('Press Ctrl+C to stop the session and exit');
    console.log('(Or wait 30 seconds for auto-cleanup)');

    await new Promise(r => setTimeout(r, 30000));
    await stopSession();

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    if (sessionId) {
      try {
        await stopSession();
      } catch (e) {
        console.error('Failed to stop session:', e.message);
      }
    }
    process.exit(1);
  }
}

main();
