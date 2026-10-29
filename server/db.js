'use strict';
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
      daily_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',            -- 'c:<0-11>' colour preset or 'i:<catalog item key>'
      best_drop TEXT,                             -- JSON snapshot of the most valuable case drop ever (survives selling)
      best_price INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY,                       -- sha256(token), the raw token is never stored
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS items(
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      tier TEXT NOT NULL,
      wear TEXT NOT NULL,
      wear_float REAL NOT NULL,
      stattrak INTEGER NOT NULL DEFAULT 0,
      price INTEGER NOT NULL CHECK(price > 0),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_user ON items(user_id);
    CREATE TABLE IF NOT EXISTS ledger(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      meta TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
    CREATE TABLE IF NOT EXISTS history(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('case','upgrade')),
      data TEXT NOT NULL,                         -- JSON snapshot written by the server only
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_user ON history(user_id, id);
  `);
  // Migration for databases created before profiles existed.
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('best_drop')) db.exec('ALTER TABLE users ADD COLUMN best_drop TEXT');
  if (!cols.includes('best_price')) db.exec('ALTER TABLE users ADD COLUMN best_price INTEGER NOT NULL DEFAULT 0');
  return db;
}

module.exports = { openDb };
