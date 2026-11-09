'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool, types } = require('pg');

// BIGINT / COUNT(*) arrive as strings by default. All our values (ms timestamps, coins, ids) are far below 2^53.
types.setTypeParser(20, (v) => Number(v));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0),
    daily_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',            -- 'c:<0-11>' colour preset or 'i:<item key>'
    best_drop TEXT,                             -- JSON snapshot of the most valuable case drop ever (survives selling)
    best_price BIGINT NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username)); -- nicks are case-insensitive
  CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,                        -- sha256(token), the raw token is never stored
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS items(
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    tier TEXT NOT NULL,
    wear TEXT NOT NULL,
    wear_float DOUBLE PRECISION NOT NULL,
    stattrak SMALLINT NOT NULL DEFAULT 0,
    price BIGINT NOT NULL CHECK(price > 0),
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_user ON items(user_id);
  CREATE TABLE IF NOT EXISTS ledger(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    delta BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    meta TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
  CREATE TABLE IF NOT EXISTS history(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('case','upgrade')),
    data TEXT NOT NULL,                         -- JSON snapshot written by the server only
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_user ON history(user_id, id);
  CREATE TABLE IF NOT EXISTS custom_items(      -- skins invented in the admin panel
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    tier TEXT NOT NULL,
    price BIGINT NOT NULL CHECK(price > 0),     -- price of the Field-Tested, non-StatTrak version
    can_st SMALLINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custom_cases(      -- cases built in the admin panel
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    price BIGINT NOT NULL CHECK(price >= 0),
    items TEXT NOT NULL,                        -- JSON: self-contained item snapshots with weights
    created_at BIGINT NOT NULL
  );
`;

const wrap = (c) => ({
  all: async (sql, params) => (await c.query(sql, params)).rows,
  get: async (sql, params) => (await c.query(sql, params)).rows[0],
  run: async (sql, params) => (await c.query(sql, params)).rowCount, // rows touched by INSERT / UPDATE / DELETE
});

// Managed Postgres (Aiven) always uses TLS. With the CA certificate we verify the server; without it the link is
// still encrypted, only the server identity is not checked.
function sslOption(o, url, sslmode) {
  if (o.ssl === 'off') return false;
  if (o.ca) return { ca: o.ca, rejectUnauthorized: true };
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (local && !sslmode && o.ssl !== 'no-verify') return false;
  if (!o.quiet && o.ssl !== 'no-verify') console.warn('[db] DATABASE_CA is not set: the connection is encrypted but the server certificate is NOT verified');
  return { rejectUnauthorized: false };
}

// DATABASE_CA holds the PEM text (a literal "\n" is accepted); DATABASE_CA_FILE points to a file, e.g. a Render secret file.
function readCa(env = process.env) {
  if (env.DATABASE_CA) return env.DATABASE_CA.replace(/\\n/g, '\n');
  if (env.DATABASE_CA_FILE) return fs.readFileSync(env.DATABASE_CA_FILE, 'utf8');
  return undefined;
}

/**
 * o: { url, ca?, ssl?: 'off'|'no-verify', poolMax?, schema?, quiet? }
 * `schema` (tests only) isolates everything in its own Postgres schema.
 */
async function openDb(o = {}) {
  if (!o.url) throw new Error('DATABASE_URL is not set. Put the Aiven "Service URI" into this environment variable.');
  const url = new URL(o.url);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode'); // we build the ssl options ourselves (pg would otherwise override them)
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: sslOption(o, url, sslmode),
    max: o.poolMax || 10,
    idleTimeoutMillis: 30e3,
    connectionTimeoutMillis: 15e3,
    keepAlive: true,
  });
  // A dropped idle connection must never crash the process; the pool simply opens a new one.
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));

  if (o.schema) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(o.schema)) throw new Error('bad schema name');
    pool.on('connect', (c) => { c.query(`SET search_path TO "${o.schema}"`).catch(() => {}); });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${o.schema}"`);
  }
  await pool.query(SCHEMA);

  return {
    ...wrap(pool),
    pool,
    schema: o.schema,
    // One transaction on one connection: use ONLY the `t` you get here inside fn, never the outer db.
    async tx(fn) {
      const c = await pool.connect();
      let broken = false;
      try {
        await c.query('BEGIN');
        const r = await fn(wrap(c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { broken = true; }
        throw e;
      } finally {
        c.release(broken);
      }
    },
    async close() { await pool.end(); },
    async dropSchema() { if (o.schema) await pool.query(`DROP SCHEMA IF EXISTS "${o.schema}" CASCADE`); },
  };
}

/* ---------- small SQL helpers shared by game / market / admin ---------- */

// [[a,b],[c,d]] -> { sql: '($1,$2),($3,$4)', params: [a,b,c,d] }
function values(rows) {
  let n = 0;
  return { sql: rows.map((r) => '(' + r.map(() => '$' + (++n)).join(',') + ')').join(','), params: rows.flat() };
}

// Inserts item instances ({key,name,image,tier,wear,float,stattrak,price}) and returns the stored rows in the same order.
async function insertItems(t, uid, drops, now) {
  const ids = drops.map(() => crypto.randomBytes(12).toString('base64url'));
  const v = values(drops.map((d, i) => [ids[i], uid, d.key, d.name, d.image, d.tier, d.wear, d.float, d.stattrak ? 1 : 0, d.price, now]));
  const rows = await t.all(
    `INSERT INTO items(id, user_id, item_key, name, image, tier, wear, wear_float, stattrak, price, created_at) VALUES ${v.sql} RETURNING *`, v.params);
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id));
}

const addLedger = (t, uid, kind, delta, after, meta, now) =>
  t.run('INSERT INTO ledger(user_id, kind, delta, balance_after, meta, created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [uid, kind, delta, after, meta == null ? null : JSON.stringify(meta), now]);

const addHistory = (t, uid, kind, data, now) =>
  t.run('INSERT INTO history(user_id, kind, data, created_at) VALUES($1,$2,$3,$4)', [uid, kind, JSON.stringify(data), now]);

const UNIQUE_VIOLATION = '23505'; // Postgres error code

module.exports = { openDb, readCa, values, insertItems, addLedger, addHistory, SCHEMA, UNIQUE_VIOLATION };
