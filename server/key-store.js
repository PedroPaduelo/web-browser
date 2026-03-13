const crypto = require('crypto');
const db = require('./db');

function hashKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function deriveTenantId(apiKey) {
  return hashKey(apiKey).slice(0, 16);
}

function generateRawKey() {
  return 'sk_' + crypto.randomBytes(32).toString('hex').slice(0, 32);
}

function createKey(name, options = {}) {
  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);
  const id = keyHash.slice(0, 16);
  const keyPrefix = rawKey.slice(0, 10);

  const {
    maxSessions = 100,
    maxSessionDuration = 3600,
    maxIdleTimeout = 300,
    features = {},
  } = options;

  db.prepare(`
    INSERT INTO api_keys (id, key_hash, key_prefix, name, max_sessions, max_session_duration, max_idle_timeout, features)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, keyHash, keyPrefix, name, maxSessions, maxSessionDuration, maxIdleTimeout, JSON.stringify(features));

  return {
    id,
    key: rawKey,
    keyPrefix,
    name,
    enabled: true,
    maxSessions,
    maxSessionDuration,
    maxIdleTimeout,
    features,
    createdAt: new Date().toISOString(),
  };
}

function listKeys() {
  const rows = db.prepare(`
    SELECT id, key_prefix, name, enabled, max_sessions, max_session_duration, max_idle_timeout, features, created_at, last_used_at
    FROM api_keys ORDER BY created_at DESC
  `).all();

  return rows.map(r => ({
    id: r.id,
    keyPrefix: r.key_prefix,
    name: r.name,
    enabled: !!r.enabled,
    maxSessions: r.max_sessions,
    maxSessionDuration: r.max_session_duration,
    maxIdleTimeout: r.max_idle_timeout,
    features: JSON.parse(r.features || '{}'),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

function getKeyById(id) {
  const r = db.prepare(`
    SELECT id, key_prefix, name, enabled, max_sessions, max_session_duration, max_idle_timeout, features, created_at, last_used_at
    FROM api_keys WHERE id = ?
  `).get(id);

  if (!r) return null;
  return {
    id: r.id,
    keyPrefix: r.key_prefix,
    name: r.name,
    enabled: !!r.enabled,
    maxSessions: r.max_sessions,
    maxSessionDuration: r.max_session_duration,
    maxIdleTimeout: r.max_idle_timeout,
    features: JSON.parse(r.features || '{}'),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

function updateKey(id, fields) {
  const allowed = ['name', 'enabled', 'max_sessions', 'max_session_duration', 'max_idle_timeout', 'features'];
  const mapping = {
    name: 'name',
    enabled: 'enabled',
    maxSessions: 'max_sessions',
    maxSessionDuration: 'max_session_duration',
    maxIdleTimeout: 'max_idle_timeout',
    features: 'features',
  };

  const sets = [];
  const values = [];

  for (const [jsKey, dbCol] of Object.entries(mapping)) {
    if (fields[jsKey] !== undefined) {
      sets.push(`${dbCol} = ?`);
      const val = jsKey === 'features' ? JSON.stringify(fields[jsKey]) : fields[jsKey];
      values.push(val);
    }
  }

  if (sets.length === 0) return getKeyById(id);

  values.push(id);
  db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getKeyById(id);
}

function revokeKey(id) {
  db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(id);
  return { message: 'Key revoked', id };
}

function validateKey(apiKey) {
  const keyHash = hashKey(apiKey);
  const r = db.prepare(`
    SELECT id, key_prefix, name, enabled, max_sessions, max_session_duration, max_idle_timeout, features, created_at
    FROM api_keys WHERE key_hash = ?
  `).get(keyHash);

  if (!r) return null;
  if (!r.enabled) return { disabled: true, id: r.id, name: r.name };

  db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(r.id);

  return {
    id: r.id,
    keyPrefix: r.key_prefix,
    name: r.name,
    maxSessions: r.max_sessions,
    maxSessionDuration: r.max_session_duration,
    maxIdleTimeout: r.max_idle_timeout,
    features: JSON.parse(r.features || '{}'),
  };
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM api_keys').get();
  const active = db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE enabled = 1').get();
  return {
    totalKeys: total.count,
    activeKeys: active.count,
  };
}

function migrateFromEnv(apiKey) {
  const count = db.prepare('SELECT COUNT(*) as count FROM api_keys').get();
  if (count.count > 0) return null;

  const keyHash = hashKey(apiKey);
  const id = keyHash.slice(0, 16);
  const keyPrefix = apiKey.slice(0, 10);

  db.prepare(`
    INSERT INTO api_keys (id, key_hash, key_prefix, name)
    VALUES (?, ?, ?, ?)
  `).run(id, keyHash, keyPrefix, 'Legacy Key (migrated)');

  console.log(`[KeyStore] Migrated legacy AUTH_API_KEY to SQLite (tenantId: ${id})`);
  return { id, key: apiKey };
}

function regenerateKey(id) {
  const existing = db.prepare('SELECT id, name FROM api_keys WHERE id = ?').get(id);
  if (!existing) return null;

  const rawKey = generateRawKey();
  const newHash = hashKey(rawKey);
  const newPrefix = rawKey.slice(0, 10);

  db.prepare('UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE id = ?').run(newHash, newPrefix, id);

  return { id, key: rawKey, keyPrefix: newPrefix, name: existing.name };
}

module.exports = {
  createKey,
  listKeys,
  getKeyById,
  updateKey,
  revokeKey,
  validateKey,
  getStats,
  regenerateKey,
  migrateFromEnv,
  deriveTenantId,
};
