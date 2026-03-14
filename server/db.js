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
    last_used_at TEXT
  )
`);

module.exports = db;
