'use strict';
const crypto = require('node:crypto');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const { openDb, readCa } = require('../server/db');
const { createApp, loadConfig } = require('../server/index');
const { buildCatalog } = require('../server/catalog');

// Integration tests need a real PostgreSQL: set TEST_DATABASE_URL (e.g. postgres://user:pass@localhost:5432/buffgrade_test).
// Every test gets its own schema that is dropped afterwards, so the database can be shared and nothing else is touched.
const DB_URL = process.env.TEST_DATABASE_URL;
const dbTest = DB_URL ? nodeTest : (name, fn) => nodeTest.skip(name + ' [set TEST_DATABASE_URL to run]', fn);

const img = (n) => `https://raw.githubusercontent.com/x/y/${n}.png`;
function crate(id) {
  const mk = (rarity, i) => ({ id: `${id}-${rarity[0]}${i}`, name: `Gun${i} | ${rarity}${id}`, rarity: { name: rarity }, image: img(id + rarity + i) });
  return {
    id, type: 'Case', name: 'Case ' + id, image: img(id), first_sale_date: '2020-01-01',
    contains: [0, 1, 2].map((i) => mk('Mil-Spec Grade', i)).concat([0, 1].map((i) => mk('Restricted', i)), [mk('Classified', 0), mk('Covert', 0)]),
    contains_rare: [
      { id: id + '-knife', name: '★ Knife ' + id, rarity: { name: 'Extraordinary' }, image: img(id + 'k') },
      { id: id + '-glove', name: '★ Sport Gloves | G' + id, rarity: { name: 'Extraordinary' }, image: img(id + 'g') },
    ],
  };
}
const FIXTURE = [
  crate('crate-1'), crate('crate-2'),
  { ...crate('crate-evil'), image: 'http://evil.example/x.png' },                       // bad image: case dropped
  { ...crate('crate-3'), type: 'Souvenir' },                                           // not a case: dropped
];
FIXTURE[0].contains.push({ id: 'evil-item', name: 'Evil', rarity: { name: 'Covert' }, image: 'https://evil.example/a.png' }); // item dropped

async function boot(over = {}) {
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const db = await openDb({ url: DB_URL, ca: readCa(), schema, poolMax: 5, quiet: true });
  const catalog = buildCatalog(FIXTURE);
  const config = { ...loadConfig({}), scryptN: 1024, ...over };
  config.limits = { ...config.limits, api: { windowMs: 60e3, limit: 100000 }, game: { windowMs: 60e3, limit: 100000 }, register: { windowMs: 60e3, limit: 100000 }, ...(over.limits || {}) };
  const app = await createApp({ db, catalog, config });
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const mkClient = () => {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const r = await fetch(base + path, {
        method,
        headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      });
      const sc = r.headers.getSetCookie();
      for (const c of sc) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
      let json = null; try { json = await r.json(); } catch { /* empty body */ }
      return { status: r.status, json, sc, headers: r.headers };
    };
    return { call, get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), get cookie() { return cookie; } };
  };
  const signup = async (name, pw = 'correct-horse-9') => { const c = mkClient(); const r = await c.post('/api/auth/register', { username: name, password: pw }); assert.equal(r.status, 201, JSON.stringify(r.json)); return c; };
  const uid = async (name) => (await db.get('SELECT id FROM users WHERE lower(username) = lower($1)', [name])).id;
  const give = async (name, price, key) => {
    const id = 'it' + Math.random().toString(36).slice(2, 12);
    const k = key || catalog.items.keys().next().value;
    await db.run('INSERT INTO items(id,user_id,item_key,name,image,tier,wear,wear_float,stattrak,price,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, await uid(name), k, 'x', img('x'), 'mil', 'FT', 0.2, 0, price, Date.now()]);
    return id;
  };
  const setBal = (name, b) => db.run('UPDATE users SET balance=$1 WHERE lower(username) = lower($2)', [b, name]);
  const balance = async (name) => (await db.get('SELECT balance FROM users WHERE lower(username) = lower($1)', [name])).balance;
  const one = (sql, ...params) => db.get(sql, params);   // first row
  const count = async (sql, ...params) => (await db.get(sql, params)).n; // SELECT COUNT(*) n ...
  return {
    db, catalog, base, mkClient, signup, give, setBal, balance, uid, one, count,
    close: async () => { server.closeAllConnections(); server.close(); await db.dropSchema(); await db.close(); },
  };
}


module.exports = { boot, dbTest, FIXTURE, img };
