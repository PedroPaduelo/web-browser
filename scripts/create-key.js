#!/usr/bin/env node
const path = require('path');

// Caminho absoluto fixo para o key-store
const keyStorePath = '/workspace/temp-orquestrador/users/5aaf347f-952f-4355-8513-ac3f4024b43e/projetos/remote-browser/server/key-store.js';

// Carrega o keyStore
const keyStore = require(keyStorePath);

const tenantName = process.argv[2] || 'demo-tenant';
const key = keyStore.createKey(tenantName, {
  maxSessions: 10,
  maxSessionDuration: 3600,
  maxIdleTimeout: 300,
  features: { record: false, audio: false }
});

console.log('✅ Chave criada:');
console.log(JSON.stringify(key, null, 2));
console.log('\n🔒 Guarde esta chave em local seguro.');
