const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'serende.db');
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
