const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use /tmp for writable database (container-friendly)
const DB_PATH = process.env.DB_PATH || '/tmp/serende.db';

// Ensure directory exists
const DB_DIR = path.dirname(DB_PATH);
fs.mkdirSync(DB_DIR, { recursive: true });

console.log('[DB] Using database at:', DB_PATH);

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    max_sessions INTEGER DEFAULT 100,
    max_session_duration INTEGER DEFAULT 3600,
    max_idle_timeout INTEGER DEFAULT 300,
    features TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    version INTEGER DEFAULT 1
  )
`);

// Migração idempotente: bancos criados antes da coluna `version` ganham ela
// com DEFAULT 1 (tokens pré-migração não têm `kv` e continuam válidos —
// política documentada no authMiddleware).
try {
  const cols = db.prepare(`PRAGMA table_info(api_keys)`).all().map((c) => c.name);
  if (!cols.includes('version')) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN version INTEGER DEFAULT 1`);
    console.log('[DB] Migrated api_keys: added version column');
  }
} catch (e) {
  console.warn('[DB] version migration check failed:', e.message);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT DEFAULT (datetime('now')),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    request_id TEXT,
    detail TEXT
  )
`);
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`);
} catch {}

module.exports = db;
