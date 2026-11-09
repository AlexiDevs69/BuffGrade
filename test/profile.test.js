'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, dbTest } = require('./helpers');

const histCount = async (t, name) => t.count('SELECT COUNT(*) n FROM history WHERE user_id=$1', await t.uid(name));

dbTest('history: every case opening is recorded with case + item snapshot', async () => {
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
  await t.close();
});

dbTest('history is private: each user only ever sees their own', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  await a.post('/api/cases/crate-1/open', {}); await a.post('/api/cases/crate-2/open', {});
  assert.equal((await b.get('/api/history')).json.entries.length, 0);
  await b.post('/api/cases/crate-1/open', {});
  assert.equal((await a.get('/api/history')).json.entries.length, 2);
  assert.equal((await b.get('/api/history')).json.entries.length, 1);
  assert.equal((await t.mkClient().get('/api/history')).status, 401);
  assert.equal((await t.mkClient().get('/api/profile')).status, 401);
  await t.close();
});

dbTest('history: upgrade entry keeps the stake even though those items are gone', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const top = t.catalog.targets[t.catalog.targets.length - 1];
  const stake = Math.ceil(top.price / 3);
  const id1 = await t.give('alice', stake);
  const r = await a.post('/api/upgrade', { ids: [id1], target: top.key });
  assert.equal(r.status, 200);
  assert.equal((await t.one('SELECT COUNT(*) n FROM items WHERE id=$1', id1)).n, 0);
  const e = (await a.get('/api/history')).json.entries[0];
  assert.equal(e.kind, 'upgrade');
  assert.equal(e.data.stake.length, 1);
  assert.equal(e.data.stake[0].price, stake);
  assert.equal(e.data.target.key, top.key);
  assert.equal(e.data.win, r.json.win);
  assert.equal(e.data.chance, r.json.chance);
  assert.equal(e.data.result === null, !r.json.win);
  if (r.json.win) assert.equal(e.data.result.key, top.key);
  await t.close();
});

dbTest('history pagination, validation and newest-first order', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  await t.setBal('alice', 100000);
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
  await t.close();
});

dbTest('history is capped per user, newest rows survive', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  await t.db.run("INSERT INTO history(user_id,kind,data,created_at) SELECT $1, 'case', '{}', g FROM generate_series(0, 509) AS g", [await t.uid('alice')]);
  await a.post('/api/cases/crate-1/open', {});
  assert.equal(await histCount(t, 'alice'), 500);
  const newest = (await t.one('SELECT data FROM history WHERE user_id=$1 ORDER BY id DESC LIMIT 1', await t.uid('alice'))).data;
  assert.match(newest, /crate-1/);
  await t.close();
});

dbTest('best drop: tracks the maximum, never decreases, survives selling', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  assert.equal((await a.get('/api/profile')).json.bestDrop, null);
  await t.setBal('alice', 1e6);
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
  await t.give('alice', Math.ceil(top.price / 2)); await t.setBal('alice', 0);
  assert.equal((await a.get('/api/profile')).json.bestDrop.price, max);
  await t.close();
});

dbTest('avatar: presets validated, item avatars require ownership, never a URL', async () => {
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
  await t.give('alice', 50, key);
  const ok = await a.post('/api/profile/avatar', { avatar: 'i:' + key });
  assert.equal(ok.status, 200); assert.equal(ok.json.avatar.type, 'item');
  assert.match(ok.json.avatar.image, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal((await b.post('/api/profile/avatar', { avatar: 'i:' + key })).status, 403); // bob doesn't own it
  assert.equal((await a.get('/api/profile')).json.avatar.key, key);
  // a tampered DB value can't smuggle an arbitrary URL out either
  await t.db.run("UPDATE users SET avatar='https://evil.example/x.png' WHERE username='alice'");
  assert.equal((await a.get('/api/profile')).json.avatar.type, 'color');
  await t.close();
});

dbTest('schema: opening the database twice is harmless and usernames are unique case-insensitively', async () => {
  const t = await boot();
  const { openDb } = require('../server/db');
  const again = await openDb({ url: process.env.TEST_DATABASE_URL, ca: require('../server/db').readCa(), schema: t.db.schema, quiet: true, poolMax: 2 }).catch((e) => e);
  assert.ok(!(again instanceof Error), String(again));
  await again.close();
  await t.db.run("INSERT INTO users(username, pass_hash, balance, created_at) VALUES('Legacy', 'x', 42, 1)");
  await assert.rejects(t.db.run("INSERT INTO users(username, pass_hash, balance, created_at) VALUES('LEGACY', 'x', 1, 1)"), { code: '23505' });
  await t.close();
});
