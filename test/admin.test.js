'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, img } = require('./helpers');

const admins = new Set(['boss']);

test('admin API is invisible to anonymous users and regular players', async () => {
  const t = await boot({ admins });
  const anon = t.mkClient();
  assert.equal((await anon.get('/api/admin/items')).status, 401);

  const alice = await t.signup('alice');
  assert.equal((await alice.get('/api/auth/me')).json.user.admin, false);
  for (const [m, p] of [['GET', '/api/admin/items'], ['GET', '/api/admin/search?q=gun'], ['GET', '/api/admin/cases'], ['POST', '/api/admin/give'], ['POST', '/api/admin/items'], ['POST', '/api/admin/cases'], ['POST', '/api/admin/balance']]) {
    const r = await alice.call(m, p, {});
    assert.equal(r.status, 404, m + ' ' + p); // same answer as for an unknown path
  }
  const boss = await t.signup('Boss'); // nick match is case-insensitive
  assert.equal((await boss.get('/api/auth/me')).json.user.admin, true);
  assert.equal((await boss.get('/api/admin/items')).status, 200);
  t.close();
});

test('admin: custom skin, exact float, price override, StatTrak', async () => {
  const t = await boot({ admins });
  const boss = await t.signup('boss');
  const bad = await boss.post('/api/admin/items', { name: 'X', image: 'http://evil.example/x.png', tier: 'cov', price: 100 });
  assert.equal(bad.status, 400);
  const mk = await boss.post('/api/admin/items', { name: 'AK-47 | Моя Кара', image: img('mine'), tier: 'cov', price: 5000, canST: true });
  assert.equal(mk.status, 201);
  const key = mk.json.item.key;
  assert.equal(mk.json.item.price, 5000);

  const found = (await boss.get('/api/admin/search?q=' + encodeURIComponent('моя кара'))).json;
  assert.equal(found.items[0].key, key);

  const g = await boss.post('/api/admin/give', { key, float: 0.0123, stattrak: true });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.items[0].wear, 'FN');
  assert.equal(g.json.items[0].float, 0.0123);
  assert.equal(g.json.items[0].price, Math.round(5000 * 1.6 * 1.8));
  const inv = (await boss.get('/api/inventory')).json.items;
  assert.equal(inv.length, 1); assert.equal(inv[0].stattrak, true); assert.equal(inv[0].float, 0.0123);

  const bob = await t.signup('bob');
  const g2 = await boss.post('/api/admin/give', { username: 'bob', key, wear: 'WW', count: 2, price: 77 });
  assert.equal(g2.status, 200);
  const bobInv = (await bob.get('/api/inventory')).json.items;
  assert.equal(bobInv.length, 2); assert.ok(bobInv.every((i) => i.wear === 'WW' && i.price === 77));

  for (const body of [{ key: 'nope' }, { key, float: 2 }, { key, wear: 'ZZ' }, { key, count: 0 }, { key, username: 'ghost' }, { key, price: -5 }])
    assert.equal((await boss.post('/api/admin/give', body)).status === 200, false, JSON.stringify(body));

  // a custom skin can be an avatar, but only for someone who owns it
  assert.equal((await bob.post('/api/profile/avatar', { avatar: 'i:' + key })).status, 200);
  const carol = await t.signup('carol');
  assert.equal((await carol.post('/api/profile/avatar', { avatar: 'i:' + key })).status, 403);

  // custom skins are NOT sold on the market and are not upgrade targets
  assert.equal((await boss.post('/api/market/buy', { key, wear: 'FT', stattrak: false })).status, 400);
  t.close();
});

test('admin: custom case with weights, free price, deleting', async () => {
  const t = await boot({ admins });
  const boss = await t.signup('boss');
  const key = (await boss.post('/api/admin/items', { name: 'Only Drop', image: img('od'), tier: 'rare', price: 1234 })).json.item.key;

  for (const body of [
    { name: 'C', image: img('c'), price: -1, items: [{ key, w: 1 }] },
    { name: 'C', image: img('c'), price: 10, items: [] },
    { name: 'C', image: img('c'), price: 10, items: [{ key, w: 0 }] },
    { name: 'C', image: img('c'), price: 10, items: [{ key, w: 1 }, { key, w: 1 }] },
    { name: 'C', image: 'http://evil.example/c.png', price: 10, items: [{ key, w: 1 }] },
  ]) assert.equal((await boss.post('/api/admin/cases', body)).status, 400, JSON.stringify(body));

  const real = [...t.catalog.items.keys()][0];
  const mk = await boss.post('/api/admin/cases', { name: 'Мій кейс', image: img('mc'), price: 250, items: [{ key, w: 1 }, { key: real, w: 99 }] });
  assert.equal(mk.status, 201, JSON.stringify(mk.json));
  const id = mk.json.case.id;

  // public view: listed first, odds and per-item chance are exposed
  const list = (await t.mkClient().get('/api/cases')).json.cases;
  assert.equal(list[0].id, id);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'image', 'kind', 'name', 'price']);
  const detail = (await t.mkClient().get('/api/cases/' + id)).json;
  assert.equal(detail.items.find((i) => i.key === key).chance, 1);
  assert.equal(detail.items.find((i) => i.key === real).chance, 99);

  // a single-item free case always drops that item and costs nothing
  const free = (await boss.post('/api/admin/cases', { name: 'Free', image: img('fc'), price: 0, items: [{ key, w: 5 }] })).json.case.id;
  const before = t.balance('boss');
  const open = await boss.post('/api/cases/' + free + '/open', { count: 3 });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  assert.ok(open.json.items.every((i) => i.key === key));
  assert.equal(t.balance('boss'), before);

  // paid custom case debits the price
  const bob = await t.signup('bob');
  const only = (await boss.post('/api/admin/cases', { name: 'Paid', image: img('pc'), price: 400, items: [{ key, w: 1 }] })).json.case.id;
  const o2 = await bob.post('/api/cases/' + only + '/open', {});
  assert.equal(o2.status, 200); assert.equal(t.balance('bob'), 600);

  // a restart restores the content from the DB
  const { buildCatalog } = require('../server/catalog');
  const { createAdminService } = require('../server/admin');
  const { FIXTURE } = require('./helpers');
  const fresh = buildCatalog(FIXTURE);
  createAdminService({ db: t.db, catalog: fresh }).restore();
  assert.ok(fresh.cases.get(id).custom && fresh.customItems.has(key));

  // delete: gone for everybody; real cases cannot be deleted
  assert.equal((await boss.post('/api/admin/cases/' + id + '/delete', {})).status, 200);
  assert.equal((await t.mkClient().get('/api/cases/' + id)).status, 404);
  assert.equal((await boss.post('/api/admin/cases/crate-1/delete', {})).status, 404);
  assert.ok(t.catalog.cases.has('crate-1'));
  t.close();
});

test('admin: balance changes are guarded and audited', async () => {
  const t = await boot({ admins });
  const boss = await t.signup('boss');
  await t.signup('bob');
  const r = await boss.post('/api/admin/balance', { username: 'bob', delta: 500 });
  assert.equal(r.json.balance, 1500);
  assert.equal((await boss.post('/api/admin/balance', { username: 'bob', delta: -1501 })).status, 400);
  assert.equal(t.balance('bob'), 1500);
  assert.equal((await boss.post('/api/admin/balance', { delta: 100 })).json.balance, 1100); // no nick = yourself
  for (const body of [{ username: 'bob', delta: 0 }, { username: 'bob', delta: 1.5 }, { username: 'bob', delta: '5' }, { username: 'ghost', delta: 5 }, { username: 'bob' }])
    assert.equal((await boss.post('/api/admin/balance', body)).status === 200, false, JSON.stringify(body));
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='admin_balance'").get().n, 2);
  t.close();
});
