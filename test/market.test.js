'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const { categoryOf, WEAR } = require('../server/catalog');

const count = (t, sql, ...a) => t.db.prepare(sql).get(...a).n;

test('multi-open: N cases cost exactly N x price, one transaction, N drops, N history rows', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  t.setBal('alice', 100000);
  const r = await a.post('/api/cases/crate-1/open', { count: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 5);
  assert.deepEqual(r.json.item, r.json.items[0]);
  assert.equal(r.json.balance, 100000 - price * 5);
  assert.equal(t.balance('alice'), 100000 - price * 5);
  assert.equal(count(t, 'SELECT COUNT(*) n FROM items'), 5);
  assert.equal(count(t, 'SELECT COUNT(*) n FROM history'), 5);
  assert.equal(count(t, "SELECT COUNT(*) n FROM ledger WHERE kind='case_open'"), 1);
  const best = (await a.get('/api/profile')).json.bestDrop;
  assert.equal(best.price, Math.max(...r.json.items.map((i) => i.price)));
  assert.equal((await a.post('/api/cases/crate-1/open', {})).json.items.length, 1); // default count = 1
  t.close();
});

test('multi-open: count is validated', async () => {
  const t = await boot();
  const a = await t.signup('alice'); t.setBal('alice', 1e6);
  for (const c of [0, -1, 11, 100, 1.5, '3', null, [], {}, true, NaN, 1e9])
    assert.equal((await a.post('/api/cases/crate-1/open', { count: c })).status, 400, String(c));
  assert.equal(count(t, 'SELECT COUNT(*) n FROM items'), 0);
  assert.equal(t.balance('alice'), 1e6);
  t.close();
});

test('multi-open: not enough money for the whole batch means NOTHING happens', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  t.setBal('alice', price * 9 + price - 1);
  const r = await a.post('/api/cases/crate-1/open', { count: 10 });
  assert.equal(r.status, 402);
  assert.equal(t.balance('alice'), price * 10 - 1);
  assert.equal(count(t, 'SELECT COUNT(*) n FROM items'), 0);
  assert.equal(count(t, 'SELECT COUNT(*) n FROM history'), 0);
  assert.equal((await a.post('/api/cases/crate-1/open', { count: 9 })).status, 200);
  t.close();
});

test('multi-open: parallel batches cannot overspend', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  t.setBal('alice', price * 15 + 3);
  const rs = await Promise.all(Array.from({ length: 6 }, () => a.post('/api/cases/crate-1/open', { count: 5 })));
  assert.equal(rs.filter((r) => r.status === 200).length, 3);
  assert.equal(rs.filter((r) => r.status === 402).length, 3);
  assert.equal(t.balance('alice'), 3);
  assert.equal(count(t, 'SELECT COUNT(*) n FROM items'), 15);
  t.close();
});

test('categories: weapons map to the right type', () => {
  const cases = { 'AK-47 | Redline': 'rifle', 'AWP | Asiimov': 'sniper', 'Glock-18 | Fade': 'pistol', 'MP9 | Hot Rod': 'smg', 'XM1014 | Tranquility': 'heavy',
    '★ Karambit | Doppler': 'knife', '★ Survival Knife': 'knife', '★ Sport Gloves | Vice': 'gloves', '★ Hand Wraps | Slaughter': 'gloves', 'StatTrak™ AK-47 | Vulcan': 'rifle', 'Zeus x27 | Olympus': 'other', 'Weird | Thing': 'other', '__proto__ | x': 'other' };
  for (const [n, c] of Object.entries(cases)) assert.equal(categoryOf(n), c, n);
});

test('market: public browsing, filters really filter, sort and pagination are consistent', async () => {
  const t = await boot();
  const g = t.mkClient();
  const all = (await g.get('/api/market?per=48')).json;
  assert.equal(all.page, 1); assert.ok(all.total >= 20 && all.listings.length > 0);
  for (const l of all.listings) { assert.ok(l.price > l.value, 'market price must exceed sell value'); assert.match(l.image, /^https:\/\//); }
  const get = async (qs) => (await g.get('/api/market?' + qs)).json;
  const tier = await get('tier=cov,rare&per=48'); assert.ok(tier.total > 0);
  assert.ok(tier.listings.every((l) => ['cov', 'rare'].includes(l.tier)));
  const wear = await get('wear=FN&per=48'); assert.ok(wear.listings.every((l) => l.wear === 'FN') && wear.total > 0);
  const stY = await get('st=yes&per=48'); assert.ok(stY.listings.every((l) => l.stattrak) && stY.total > 0);
  assert.ok(!stY.listings.some((l) => /gloves/i.test(l.name)), 'no StatTrak gloves');
  const stN = await get('st=no&per=48'); assert.ok(stN.listings.every((l) => !l.stattrak));
  assert.equal(stY.total + stN.total, all.total);
  const cat = await get('cat=gloves&per=48'); assert.ok(cat.total > 0 && cat.listings.every((l) => l.category === 'gloves'));
  const rng = await get('min=50&max=500&per=48'); assert.ok(rng.listings.every((l) => l.price >= 50 && l.price <= 500));
  assert.equal((await get('min=900&max=100')).total, 0);
  const q = await get('q=KNIFE&per=48'); assert.ok(q.total > 0 && q.listings.every((l) => /knife/i.test(l.name)));
  assert.equal((await get('q=zzz-nothing')).total, 0);
  const only1 = await get('case=crate-1&per=48'); const only2 = await get('case=crate-2&per=48');
  assert.ok(only1.total > 0 && only1.total === only2.total && only1.total === all.total / 2);
  const asc = (await get('sort=price_asc&per=48')).listings.map((l) => l.price);
  assert.deepEqual(asc, [...asc].sort((x, y) => x - y));
  const desc = (await get('sort=price_desc&per=48')).listings.map((l) => l.price);
  assert.deepEqual(desc, [...desc].sort((x, y) => y - x));
  const seen = new Set(); let page = 1, pages = 1;
  do { const p = await get(`per=12&page=${page}`); pages = p.pages; for (const l of p.listings) seen.add(l.key + l.wear + l.stattrak); page++; } while (page <= pages);
  assert.equal(seen.size, all.total);                                   // pages cover every listing exactly once
  assert.equal((await get('page=99999')).listings.length, 0);
  t.close();
});

test('market: hostile or malformed query params are rejected, never crash', async () => {
  const t = await boot();
  const g = t.mkClient();
  const bad = ['tier=bad', 'wear=XX', 'wear=FN,,FT', 'st=maybe', 'min=-1', 'min=abc', 'min=1e3', 'max=99999999999', 'page=0', 'page=x', 'per=1', 'per=1000',
    'sort=__proto__', 'sort=constructor', 'sort=bad', 'cat=nope', 'cat=__proto__', 'case=nope', 'case=__proto__', 'q=' + 'x'.repeat(61),
    'tier=mil&tier=res', 'q=a&q=b', "q='; DROP TABLE users;--&tier=mil'"];
  for (const qs of bad) {
    const r = await g.get('/api/market?' + qs);
    assert.ok(r.status === 400, qs + ' -> ' + r.status);
  }
  assert.equal((await g.get('/api/market?q=' + encodeURIComponent("'; DROP TABLE users;--"))).status, 200); // plain text search is fine
  assert.equal((await g.get('/api/market?q=.*(a+)+$')).json.total, 0);                                      // no regex, no ReDoS
  assert.equal((await g.get('/api/market?q[x]=1')).json.total, (await g.get('/api/market')).json.total); // bracket syntax is not parsed into objects, key is ignored
  assert.equal((await g.get('/api/market?tier=mil,mil,mil,mil,mil,mil,mil')).json.total, (await g.get('/api/market?tier=mil')).json.total); // duplicates collapse, same answer
  assert.equal(count(t, "SELECT COUNT(*) n FROM sqlite_master WHERE name='users'"), 1);
  t.close();
});

test('market buy: server prices, exact debit, item sells for LESS than it cost', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const l = (await a.get('/api/market?per=12&wear=FT&st=no')).json.listings[0];
  const r = await a.post('/api/market/buy', { key: l.key, wear: l.wear, stattrak: l.stattrak, price: 1, cost: 0, balance: 999999 });
  assert.equal(r.status, 200);
  assert.equal(r.json.cost, l.price);
  assert.equal(r.json.balance, 1000 - l.price);
  assert.equal(t.balance('alice'), 1000 - l.price);
  assert.equal(r.json.item.price, l.value);
  assert.ok(r.json.item.price < r.json.cost);
  assert.equal(r.json.item.wear, 'FT');
  const w = WEAR.find((x) => x.k === 'FT');
  assert.ok(r.json.item.float >= w.lo && r.json.item.float <= w.hi);
  const inv = (await a.get('/api/inventory')).json.items;
  assert.equal(inv.length, 1); assert.equal(inv[0].id, r.json.item.id);
  const sold = await a.post('/api/inventory/sell', { ids: [r.json.item.id] });
  assert.ok(sold.json.balance < 1000, 'buy + sell must never profit');
  assert.equal(count(t, 'SELECT COUNT(*) n FROM history'), 0);                         // purchases are not "drops"
  assert.equal((await a.get('/api/profile')).json.bestDrop, null);
  assert.equal(count(t, "SELECT COUNT(*) n FROM ledger WHERE kind='market_buy'"), 1);
  t.close();
});

test('market buy: no profit loop for ANY listing (cost > sell value, always)', async () => {
  const t = await boot();
  const g = t.mkClient();
  let p = 1, checked = 0, pages = 1;
  do { const r = (await g.get(`/api/market?per=48&page=${p}`)).json; pages = r.pages; for (const l of r.listings) { assert.ok(l.price > l.value, l.name); checked++; } p++; } while (p <= pages);
  assert.ok(checked > 50);
  t.close();
});

test('market buy: validation, ownership of money, StatTrak rules', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const item = [...t.catalog.items.values()].find((i) => i.canST);
  const glove = [...t.catalog.items.values()].find((i) => !i.canST);
  const ok = { key: item.key, wear: 'FN', stattrak: true };
  assert.equal((await t.mkClient().post('/api/market/buy', ok)).status, 401);
  for (const body of [{}, { key: 'nope', wear: 'FN', stattrak: false }, { key: '__proto__', wear: 'FN', stattrak: false }, { key: item.key, wear: 'XX', stattrak: false }, { key: item.key, wear: '__proto__', stattrak: false },
    { key: item.key, wear: 'FN' }, { key: item.key, wear: 'FN', stattrak: 'true' }, { key: item.key, wear: 'FN', stattrak: 1 }, { key: 5, wear: 'FN', stattrak: false }, { key: item.key, wear: ['FN'], stattrak: false },
    { key: glove.key, wear: 'FN', stattrak: true }, { key: 'x'.repeat(101), wear: 'FN', stattrak: false }])
    assert.equal((await a.post('/api/market/buy', body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal(t.balance('alice'), 1000);
  t.setBal('alice', 1e6);
  assert.equal((await a.post('/api/market/buy', { key: glove.key, wear: 'FN', stattrak: false })).status, 200);       // gloves without StatTrak are fine
  t.close();
});

test('market buy: cannot overspend with parallel requests, poor users get 402 and nothing changes', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const l = (await a.get('/api/market?sort=price_asc&per=12')).json.listings[0];
  t.setBal('alice', l.price * 2 + 1);
  const rs = await Promise.all(Array.from({ length: 10 }, () => a.post('/api/market/buy', { key: l.key, wear: l.wear, stattrak: l.stattrak })));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.equal(rs.filter((r) => r.status === 402).length, 8);
  assert.equal(t.balance('alice'), 1);
  assert.equal(count(t, 'SELECT COUNT(*) n FROM items'), 2);
  const expensive = (await a.get('/api/market?sort=price_desc&per=12')).json.listings[0];
  const r = await a.post('/api/market/buy', { key: expensive.key, wear: expensive.wear, stattrak: expensive.stattrak });
  assert.equal(r.status, 402); assert.equal(t.balance('alice'), 1); assert.equal(count(t, 'SELECT COUNT(*) n FROM items'), 2);
  t.close();
});
