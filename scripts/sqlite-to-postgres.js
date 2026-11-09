#!/usr/bin/env node
'use strict';
/*
 * One-off copy of an old SQLite database (data/buffgrade.db) into PostgreSQL.
 *
 *   DATABASE_URL="postgres://avnadmin:...@host:port/defaultdb?sslmode=require" \
 *   DATABASE_CA="$(cat ca.pem)" \
 *   node scripts/sqlite-to-postgres.js ./data/buffgrade.db
 *
 * Needs Node 22.5+ (built-in node:sqlite), so nothing extra to install. The target must be empty
 * (pass --force to append anyway). Everything is copied in ONE transaction: it either all arrives or nothing does.
 */
const { openDb, readCa, values } = require('../server/db');

const TABLES = [
  // [table, columns, defaults for columns an older SQLite file may not have]
  ['users', ['id', 'username', 'pass_hash', 'balance', 'daily_at', 'created_at', 'avatar', 'best_drop', 'best_price'], { avatar: '', best_drop: null, best_price: 0 }],
  ['sessions', ['id', 'user_id', 'created_at', 'expires_at'], {}],
  ['items', ['id', 'user_id', 'item_key', 'name', 'image', 'tier', 'wear', 'wear_float', 'stattrak', 'price', 'created_at'], {}],
  ['ledger', ['id', 'user_id', 'kind', 'delta', 'balance_after', 'meta', 'created_at'], {}],
  ['history', ['id', 'user_id', 'kind', 'data', 'created_at'], {}],
  ['custom_items', ['key', 'name', 'image', 'tier', 'price', 'can_st', 'created_at'], {}],
  ['custom_cases', ['id', 'name', 'image', 'price', 'items', 'created_at'], {}],
];
const CHUNK = 500;

function openSqlite(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw new Error('This script needs Node 22.5 or newer (node:sqlite).'); }
  return new DatabaseSync(file);
}

async function migrate({ sqliteFile, db, force = false, log = console.log }) {
  const src = openSqlite(sqliteFile);
  const have = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  if (!have.has('users')) throw new Error('No "users" table in ' + sqliteFile + ': is this the right file?');

  const existing = await db.get('SELECT COUNT(*) AS n FROM users');
  if (existing.n > 0 && !force) throw new Error(`The target database already has ${existing.n} users. Refusing to mix data (use --force to append).`);

  const copied = {};
  await db.tx(async (t) => {
    for (const [table, cols, defaults] of TABLES) {
      if (!have.has(table)) { copied[table] = 0; continue; }
      let rows = src.prepare(`SELECT * FROM ${table}`).all();
      if (table === 'sessions') rows = rows.filter((r) => r.expires_at > Date.now()); // expired sessions are useless
      for (let i = 0; i < rows.length; i += CHUNK) {
        const v = values(rows.slice(i, i + CHUNK).map((r) => cols.map((c) => (r[c] === undefined ? (defaults[c] ?? null) : r[c]))));
        await t.run(`INSERT INTO ${table}(${cols.join(', ')}) VALUES ${v.sql}`, v.params);
      }
      copied[table] = rows.length;
      log(`  ${table}: ${rows.length} rows`);
    }
    // BIGSERIAL counters must continue after the highest copied id
    for (const table of ['users', 'ledger', 'history']) {
      const m = await t.get(`SELECT MAX(id) AS m FROM ${table}`);
      if (m.m) await t.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), $1)`, [m.m]);
    }
    // sanity check inside the same transaction: counts must match what we read
    for (const [table] of TABLES) {
      if (!have.has(table)) continue;
      const n = (await t.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
      if (n < copied[table]) throw new Error(`${table}: expected at least ${copied[table]} rows, found ${n}`);
    }
  });
  src.close();
  return copied;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('Usage: node scripts/sqlite-to-postgres.js <path/to/buffgrade.db> [--force]'); process.exit(2); }
  const db = await openDb({ url: process.env.DATABASE_URL, ca: readCa(), ssl: process.env.DATABASE_SSL });
  try {
    console.log('Copying', file, '->', 'PostgreSQL');
    await migrate({ sqliteFile: file, db, force: args.includes('--force') });
    console.log('Done.');
  } finally { await db.close(); }
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
module.exports = { migrate };
