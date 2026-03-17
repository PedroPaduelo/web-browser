#!/usr/bin/env node

const BASE_URL = 'https://serende.ddw1sl.easypanel.host';
const API_KEY = 'serende-dev-key-2024';

async function apiCall(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function main() {
  console.log('Testing Serende API endpoints...\n');

  // 1. Login
  console.log('1. POST /auth/login');
  const login = await apiCall('POST', '/api/auth/login', { apiKey: API_KEY });
  console.log(`   Status: ${login.status}`);
  console.log(`   Data: ${JSON.stringify(login.data, null, 2).substring(0, 300)}`);
  const token = login.data.token;
  console.log(`   Token: ${token ? token.substring(0, 30) + '...' : 'none'}\n`);

  if (!token) {
    console.log('ERROR: No token, cannot continue');
    return;
  }

  // 2. List sessions (GET)
  console.log('2. GET /sessions');
  const list = await apiCall('GET', '/sessions', null, token);
  console.log(`   Status: ${list.status}`);
  console.log(`   Data: ${JSON.stringify(list.data, null, 2).substring(0, 300)}\n`);

  // 3. Create session (POST)
  console.log('3. POST /sessions');
  const create = await apiCall('POST', '/sessions', null, token);
  console.log(`   Status: ${create.status}`);
  console.log(`   Data: ${JSON.stringify(create.data, null, 2).substring(0, 500)}\n`);

  const sessionId = create.data.id || create.data.sessionId;
  console.log(`   Session ID: ${sessionId || 'none'}\n`);

  if (sessionId) {
    // 4. Get session info
    console.log(`4. GET /sessions/${sessionId}`);
    const info = await apiCall('GET', `/sessions/${sessionId}`, null, token);
    console.log(`   Status: ${info.status}`);
    console.log(`   Data: ${JSON.stringify(info.data, null, 2).substring(0, 500)}\n`);

    // 5. Try screenshot endpoint
    console.log(`5. GET /sessions/${sessionId}/screenshot`);
    const screenshot = await fetch(`${BASE_URL}/sessions/${sessionId}/screenshot`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`   Status: ${screenshot.status}`);
  }
}

main().catch(console.error);
