'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { boot } = require('./helpers');
const { openDb } = require('../server/db');

const histCount = (t, name) => t.db.prepare('SELECT COUNT(*) n FROM history WHERE user_id=?').get(t.uid(name)).n;

test('history: every case opening is recorded with case + item snapshot', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const open = await a.post('/api/cases/crate-1/open', {});
  const h = await a.get('/api/history');
  assert.equal(h.status, 200);
  assert.equal(h.json.entries.length, 1);
  const e = h.json.entries[0];
  assert.equal(e.kind, 'case');
  assert.equal(e.data.case.id, 'crate-1');
  assert.equal(e.data.case.name, 'Case crate-1');
  assert.equal(e.data.item.name, open.json.item.name);
  assert.equal(e.data.item.price, open.json.item.price);
  assert.equal(e.data.item.id, undefined); // snapshots carry no inventory ids
  t.close();
});

test('history is private: each user only ever sees their own', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  await a.post('/api/cases/crate-1/open', {}); await a.post('/api/cases/crate-2/open', {});
  assert.equal((await b.get('/api/history')).json.entries.length, 0);
  await b.post('/api/cases/crate-1/open', {});
  assert.equal((await a.get('/api/history')).json.entries.length, 2);
  assert.equal((await b.get('/api/history')).json.entries.length, 1);
  assert.equal((await t.mkClient().get('/api/history')).status, 401);
  assert.equal((await t.mkClient().get('/api/profile')).status, 401);
  t.close();
});

test('history: upgrade entry keeps the stake even though those items are gone', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const top = t.catalog.targets[t.catalog.targets.length - 1];
  const stake = Math.ceil(top.price / 3);
  const id1 = t.give('alice', stake);
  const r = await a.post('/api/upgrade', { ids: [id1], target: top.key });
  assert.equal(r.status, 200);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items WHERE id=?').get(id1).n, 0);
  const e = (await a.get('/api/history')).json.entries[0];
  assert.equal(e.kind, 'upgrade');
  assert.equal(e.data.stake.length, 1);
  assert.equal(e.data.stake[0].price, stake);
  assert.equal(e.data.target.key, top.key);
  assert.equal(e.data.win, r.json.win);
  assert.equal(e.data.chance, r.json.chance);
  assert.equal(e.data.result === null, !r.json.win);
  if (r.json.win) assert.equal(e.data.result.key, top.key);
  t.close();
});

test('history pagination, validation and newest-first order', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  t.setBal('alice', 100000);
  for (let i = 0; i < 7; i++) await a.post('/api/cases/crate-1/open', {});
  const p1 = (await a.get('/api/history?limit=3')).json;
  assert.equal(p1.entries.length, 3); assert.ok(p1.next);
  assert.ok(p1.entries[0].id > p1.entries[1].id);
  const p2 = (await a.get('/api/history?limit=3&before=' + p1.next)).json;
  assert.equal(p2.entries.length, 3); assert.ok(p2.entries[0].id < p1.entries[2].id + 0.5 && p2.entries[0].id < p1.next);
  const p3 = (await a.get('/api/history?limit=3&before=' + p2.next)).json;
  assert.equal(p3.entries.length, 1); assert.equal(p3.next, null);
  for (const qs of ['before=abc', 'before=-1', 'before=0', 'limit=0', 'limit=51', 'limit=x', 'before=1&before=2', "before=1;DROP TABLE history"])
    assert.equal((await a.get('/api/history?' + qs)).status, 400, qs);
  t.close();
});

test('history is capped per user, newest rows survive', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const ins = t.db.prepare("INSERT INTO history(user_id,kind,data,created_at) VALUES(?, 'case', '{}', ?)");
  t.db.transaction(() => { for (let i = 0; i < 510; i++) ins.run(t.uid('alice'), i); })();
  await a.post('/api/cases/crate-1/open', {});
  assert.equal(histCount(t, 'alice'), 500);
  const newest = t.db.prepare('SELECT data FROM history WHERE user_id=? ORDER BY id DESC LIMIT 1').get(t.uid('alice')).data;
  assert.match(newest, /crate-1/);
  t.close();
});

test('best drop: tracks the maximum, never decreases, survives selling', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  assert.equal((await a.get('/api/profile')).json.bestDrop, null);
  t.setBal('alice', 1e6);
  let max = 0;
  for (let i = 0; i < 25; i++) {
    const r = await a.post('/api/cases/crate-1/open', {});
    max = Math.max(max, r.json.item.price);
    const best = (await a.get('/api/profile')).json.bestDrop;
    assert.equal(best.price, max);
  }
  const inv = (await a.get('/api/inventory')).json.items;
  await a.post('/api/inventory/sell', { ids: inv.slice(0, 100).map((i) => i.id) });
  const best = (await a.get('/api/profile')).json.bestDrop;
  assert.equal(best.price, max);                    // still there after everything was sold
  assert.equal(best.case.id, 'crate-1');
  assert.equal((await a.get('/api/inventory')).json.items.length, 0);
  // upgrades do not count as a "drop"
  const top = t.catalog.targets[t.catalog.targets.length - 1];
  t.give('alice', Math.ceil(top.price / 2)); t.setBal('alice', 0);
  assert.equal((await a.get('/api/profile')).json.bestDrop.price, max);
  t.close();
});

test('avatar: presets validated, item avatars require ownership, never a URL', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  const p0 = (await a.get('/api/profile')).json;
  assert.equal(p0.avatar.type, 'color');
  assert.equal((await a.post('/api/profile/avatar', { avatar: 'c:7' })).json.avatar.index, 7);
  assert.equal((await a.get('/api/profile')).json.avatar.index, 7);
  for (const avatar of ['c:12', 'c:99', 'c:-1', 'c:', 'x', '', null, 5, ['c:1'], { a: 1 }, 'https://evil.example/a.png', 'javascript:alert(1)', 'i:' + 'x'.repeat(200), 'i:nonexistent', 'i:__proto__', 'c:1'.repeat(50)])
    assert.equal((await a.post('/api/profile/avatar', { avatar })).status, 400, JSON.stringify(avatar).slice(0, 40));
  // item avatar: ownership
  const key = t.catalog.targets[0].key;
  const r = await a.post('/api/profile/avatar', { avatar: 'i:' + key });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'not_owned');
  t.give('alice', 50, key);
  const ok = await a.post('/api/profile/avatar', { avatar: 'i:' + key });
  assert.equal(ok.status, 200); assert.equal(ok.json.avatar.type, 'item');
  assert.match(ok.json.avatar.image, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal((await b.post('/api/profile/avatar', { avatar: 'i:' + key })).status, 403); // bob doesn't own it
  assert.equal((await a.get('/api/profile')).json.avatar.key, key);
  // a tampered DB value can't smuggle an arbitrary URL out either
  t.db.prepare("UPDATE users SET avatar='https://evil.example/x.png' WHERE username='alice'").run();
  assert.equal((await a.get('/api/profile')).json.avatar.type, 'color');
  t.close();
});

test('migration: an old database without profile columns is upgraded in place', () => {
  const f = path.join(os.tmpdir(), 'bg-mig-' + process.pid + '.db');
  fs.rmSync(f, { force: true });
  const old = new Database(f);
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
            balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), daily_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
            INSERT INTO users(username,pass_hash,balance,created_at) VALUES('legacy','x',42,1);`);
  old.close();
  const db = openDb(f);
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const c of ['avatar', 'best_drop', 'best_price']) assert.ok(cols.includes(c), c);
  const u = db.prepare('SELECT balance, avatar, best_price FROM users WHERE username=?').get('legacy');
  assert.deepEqual({ ...u }, { balance: 42, avatar: '', best_price: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sqlite_master WHERE name=?').get('history').n, 1);
  db.close();
  openDb(f).close(); // idempotent
  fs.rmSync(f, { force: true });
});
