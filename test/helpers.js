'use strict';
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp, loadConfig } = require('../server/index');
const { buildCatalog } = require('../server/catalog');

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
  const db = openDb(':memory:');
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
  const uid = (name) => db.prepare('SELECT id FROM users WHERE username=?').get(name).id;
  const give = (name, price, key) => {
    const id = 'it' + Math.random().toString(36).slice(2, 12);
    const k = key || catalog.items.keys().next().value;
    db.prepare('INSERT INTO items(id,user_id,item_key,name,image,tier,wear,wear_float,stattrak,price,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, uid(name), k, 'x', img('x'), 'mil', 'FT', 0.2, 0, price, Date.now());
    return id;
  };
  const setBal = (name, b) => db.prepare('UPDATE users SET balance=? WHERE username=?').run(b, name);
  const balance = (name) => db.prepare('SELECT balance FROM users WHERE username=?').get(name).balance;
  return { db, catalog, base, mkClient, signup, give, setBal, balance, uid, close: () => { server.closeAllConnections(); server.close(); db.close(); } };
}


module.exports = { boot, FIXTURE, img };
