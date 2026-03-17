#!/usr/bin/env node

/**
 * Test script for Serende application
 * This script tests the browser automation functionality
 */

const SERENDE_URL = 'https://serende.ddw1sl.easypanel.host';
const API_KEY = 'serende-dev-key-2024';

let authToken = null;
let sessionId = null;

async function login() {
  console.log('🔑 Logging in...');
  const res = await fetch(`${SERENDE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: API_KEY }),
  });

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`);
  }

  const data = await res.json();
  authToken = data.token;
  console.log(`✅ Logged in. Tenant ID: ${data.tenantId}`);
  return data;
}

async function createSession() {
  console.log('🚀 Creating browser session...');
  const res = await fetch(`${SERENDE_URL}/api/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create session: ${res.status} - ${text}`);
  }

  const session = await res.json();
  sessionId = session.id || session.sessionId;
  console.log(`✅ Session created: ${sessionId}`);
  return session;
}

async function getSessionStatus() {
  const res = await fetch(`${SERENDE_URL}/api/sessions/${sessionId}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to get session status: ${res.status}`);
  }

  return await res.json();
}

async function takeScreenshot() {
  console.log('📸 Taking screenshot...');
  const res = await fetch(`${SERENDE_URL}/api/sessions/${sessionId}/screenshot`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to take screenshot: ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  console.log(`✅ Screenshot taken (${buffer.byteLength} bytes)`);
  return base64;
}

async function waitForStream(timeout = 10000) {
  console.log('⏳ Waiting for video stream to start...');
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const status = await getSessionStatus();
    console.log(`   Status: ${JSON.stringify(status).substring(0, 200)}...`);

    if (status.streamActive || status.fps > 0) {
      console.log(`✅ Stream is active! FPS: ${status.fps || 'unknown'}`);
      return status;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Stream did not start within timeout');
}

async function executeCDP(method, params = {}) {
  const res = await fetch(`${SERENDE_URL}/api/sessions/${sessionId}/cdp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({ method, params }),
  });

  if (!res.ok) {
    throw new Error(`CDP command failed: ${res.status}`);
  }

  return await res.json();
}

async function getConsoleLogs() {
  try {
    const result = await executeCDP('Runtime.getHeapUsage');
    return result;
  } catch (error) {
    console.error('Failed to get console logs:', error.message);
    return null;
  }
}

async function saveScreenshot(base64, filename) {
  const buffer = Buffer.from(base64, 'base64');
  const fs = await import('fs');
  fs.writeFileSync(filename, buffer);
  console.log(`💾 Screenshot saved: ${filename}`);
}

async function main() {
  try {
    console.log('=== Serende Test Script ===\n');

    // 1. Login
    await login();

    // 2. Create session
    await createSession();

    // Wait a bit for the browser to start
    console.log('⏳ Waiting 5 seconds for browser to start...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 3. Check session status
    const status = await getSessionStatus();
    console.log('📊 Session Status:', JSON.stringify(status, null, 2));

    // 4. Take initial screenshot
    const screenshot1 = await takeScreenshot();
    await saveScreenshot(screenshot1, '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/screenshot-initial.png');

    // 5. Navigate to a test page
    console.log('🌐 Navigating to example.com...');
    await executeCDP('Page.navigate', { url: 'https://example.com' });

    // Wait for navigation
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 6. Take screenshot after navigation
    const screenshot2 = await takeScreenshot();
    await saveScreenshot(screenshot2, '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/screenshot-after-nav.png');

    // 7. Check for stream
    await waitForStream(15000);

    // 8. Final screenshot
    const screenshot3 = await takeScreenshot();
    await saveScreenshot(screenshot3, '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/screenshot-final.png');

    // 9. Get console logs (if available)
    const logs = await getConsoleLogs();
    if (logs) {
      console.log('📋 Console logs:', JSON.stringify(logs, null, 2));
    }

    console.log('\n✅ All tests passed!');
    console.log('\n📸 Screenshots saved:');
    console.log('   - screenshot-initial.png');
    console.log('   - screenshot-after-nav.png');
    console.log('   - screenshot-final.png');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();
