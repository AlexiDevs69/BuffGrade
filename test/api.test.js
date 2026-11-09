'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, rollDrop } = require('../server/catalog');
const { boot, dbTest, FIXTURE } = require('./helpers');

test('catalog drops unsafe images and non-cases', () => {
  const c = buildCatalog(FIXTURE);
  assert.deepEqual([...c.cases.keys()].sort(), ['crate-1', 'crate-2']);
  assert.ok(![...c.items.values()].some((i) => i.name === 'Evil'));
  for (const it of c.items.values()) assert.match(it.image, /^https:\/\/raw\.githubusercontent\.com\//);
});

test('economy: a case always costs more than it pays back on average', () => {
  const c = buildCatalog(FIXTURE).cases.get('crate-1');
  let sum = 0; const N = 100000;
  for (let i = 0; i < N; i++) sum += rollDrop(c).price;
  assert.ok(sum / N < c.price * 0.95, `avg drop ${sum / N} vs price ${c.price}`);
});

dbTest('register: validation, cookie flags, duplicates', async () => {
  const t = await boot({ isProd: true });
  const c = t.mkClient();
  for (const username of ['ab', 'a b', '<script>', "x'; DROP TABLE users;--", 'admin', 'a'.repeat(21), 123, null, ['arr']]) {
    const r = await c.post('/api/auth/register', { username, password: 'correct-horse-9' });
    assert.equal(r.status, 400, String(username));
  }
  for (const password of ['short', 'password', 'x'.repeat(129), 12345678, null]) {
    assert.equal((await c.post('/api/auth/register', { username: 'okname', password })).status, 400, String(password));
  }
  const ok = await c.post('/api/auth/register', { username: 'Player_1', password: 'correct-horse-9' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.balance, 1000);
  const sc = ok.sc[0];
  assert.match(sc, /^__Host-bg_sid=/); assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i); assert.match(sc, /Secure/i); assert.match(sc, /Path=\//);
  assert.equal((await t.mkClient().post('/api/auth/register', { username: 'player_1', password: 'another-pass-1' })).status, 409);
  await t.close();
});

dbTest('login: no user enumeration, passwords hashed, session tokens not stored raw', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const hash = (await t.one('SELECT pass_hash FROM users WHERE lower(username) = lower($1)', 'alice')).pass_hash;
  assert.match(hash, /^scrypt\$/); assert.ok(!hash.includes('correct-horse-9'));
  const token = a.cookie.split('=')[1];
  assert.equal((await t.one('SELECT COUNT(*) n FROM sessions WHERE id=$1', token)).n, 0);
  const wrong = await t.mkClient().post('/api/auth/login', { username: 'alice', password: 'wrong-password' });
  const none = await t.mkClient().post('/api/auth/login', { username: 'nobody', password: 'wrong-password' });
  assert.equal(wrong.status, 401); assert.equal(none.status, 401);
  assert.deepEqual(wrong.json, none.json);
  assert.equal((await t.mkClient().post('/api/auth/login', { username: "' OR 1=1 --", password: 'x' })).status, 401);
  assert.equal((await t.mkClient().post('/api/auth/login', { username: 'alice', password: 'correct-horse-9' })).status, 200);
  await t.close();
});

dbTest('protected routes need a valid session; forged cookies fail', async () => {
  const t = await boot();
  const g = t.mkClient();
  assert.equal((await g.get('/api/auth/me')).json.user, null);
  for (const [m, p] of [['GET', '/api/inventory'], ['POST', '/api/daily'], ['POST', '/api/cases/crate-1/open'], ['POST', '/api/inventory/sell'], ['POST', '/api/upgrade']])
    assert.equal((await g.call(m, p, {})).status, 401, p);
  for (const bad of ['bg_sid=' + 'A'.repeat(43), 'bg_sid=abc', "bg_sid=' OR 1=1--"]) {
    const r = await fetch(t.base + '/api/inventory', { headers: { cookie: bad } });
    assert.equal(r.status, 401, bad);
  }
  await t.close();
});

dbTest('open case: server decides price, balance and drop', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  const r = await a.post('/api/cases/crate-1/open', { price: 0, item: 'hack', balance: 999999 });
  assert.equal(r.status, 200);
  assert.equal(r.json.balance, 1000 - price);
  assert.equal((await t.balance('alice')), 1000 - price);
  assert.equal((await a.get('/api/inventory')).json.items.length, 1);
  assert.equal((await a.post('/api/cases/nope/open', {})).status, 404);
  assert.equal((await a.post('/api/cases/__proto__/open', {})).status, 404);
  assert.equal((await t.one("SELECT COUNT(*) n FROM ledger WHERE kind='case_open'")).n, 1);
  await t.close();
});

dbTest('no double-spend: 20 parallel opens with money for exactly 2', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  await t.setBal('alice', price * 2 + 1);
  const rs = await Promise.all(Array.from({ length: 20 }, () => a.post('/api/cases/crate-1/open', {})));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.equal(rs.filter((r) => r.status === 402).length, 18);
  assert.equal((await t.balance('alice')), 1);
  assert.equal((await t.one('SELECT COUNT(*) n FROM items')).n, 2);
  await t.close();
});

dbTest('sell: only own items, only once, ids validated', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  const ia = await t.give('alice', 100), ib = await t.give('bob', 100);
  const r1 = await b.post('/api/inventory/sell', { ids: [ia] });
  assert.equal(r1.status, 404);
  assert.equal((await t.balance('bob')), 1000);
  assert.equal((await b.post('/api/inventory/sell', { ids: [ib, ia] })).status, 404); // all-or-nothing
  assert.equal((await t.one('SELECT COUNT(*) n FROM items WHERE id=$1', ib)).n, 1);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => a.post('/api/inventory/sell', { ids: [ia] })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal((await t.balance('alice')), 1100);
  for (const ids of [[], 'x', null, [1], [ia, ia], ["a' OR '1'='1"], Array(101).fill('a')])
    assert.equal((await a.post('/api/inventory/sell', { ids })).status, 400, JSON.stringify(ids).slice(0, 40));
  await t.close();
});

dbTest('upgrade: chance is computed on the server and bounded', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  const top = t.catalog.targets[t.catalog.targets.length - 1];
  // 1) cheap ingredient vs expensive target: chance < 0.5%, refused (not clamped up)
  const tiny = await t.give('alice', 1);
  let r = await a.post('/api/upgrade', { ids: [tiny], target: top.key });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'chance_too_low');
  assert.equal((await t.one('SELECT COUNT(*) n FROM items WHERE id=$1', tiny)).n, 1);
  // 2) target cheaper than stake
  const rich = await t.give('alice', top.price + 5);
  r = await a.post('/api/upgrade', { ids: [rich], target: top.key });
  assert.equal(r.json.error, 'target_too_cheap');
  // 3) foreign item / unknown target / duplicates / too many
  const foreign = await t.give('bob', Math.ceil(top.price / 50));
  assert.equal((await a.post('/api/upgrade', { ids: [foreign], target: top.key })).status, 404);
  assert.equal((await a.post('/api/upgrade', { ids: [rich], target: 'nope' })).status, 400);
  assert.equal((await a.post('/api/upgrade', { ids: [rich, rich], target: top.key })).status, 400);
  assert.equal((await a.post('/api/upgrade', { ids: Array(11).fill('a'), target: top.key })).status, 400);
  assert.equal((await t.one('SELECT COUNT(*) n FROM items WHERE id=$1', foreign)).n, 1);
  // 4) valid: result is consistent with roll < chance, items consumed, winner gets the target
  let wins = 0;
  for (let i = 0; i < 40; i++) {
    const stake = Math.ceil(top.price / 4);
    const id = await t.give('alice', stake);
    const res = await a.post('/api/upgrade', { ids: [id], target: top.key });
    assert.equal(res.status, 200);
    const expected = Math.min(90, (stake * 95) / top.price);
    assert.ok(Math.abs(res.json.chance - expected) < 0.01);
    assert.equal(res.json.win, res.json.roll < res.json.chance);
    assert.equal((await t.one('SELECT COUNT(*) n FROM items WHERE id=$1', id)).n, 0);
    if (res.json.win) { wins++; assert.equal(res.json.item.key, top.key); assert.equal(res.json.item.price > 0, true); }
    else assert.equal(res.json.item, null);
  }
  assert.ok(wins > 0 && wins < 40, 'wins ' + wins);
  const tg = await a.get('/api/upgrade/targets?sum=100');
  assert.equal(tg.status, 200);
  for (const x of tg.json.targets) assert.ok(x.price > 100 && x.chance >= 0.5 && x.chance <= 90);
  assert.equal((await a.get('/api/upgrade/targets?sum=-5')).status, 400);
  assert.equal((await a.get('/api/upgrade/targets?sum=abc')).status, 400);
  void b; await t.close();
});

dbTest('upgrade targets: any dearer skin down to 0.5%, with search, chance filter, sort and paging', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const all = t.catalog.targets;
  const top = all[all.length - 1];
  const sum = Math.ceil(top.price / 150); // the dearest skin sits at about 0.63%
  const base = '/api/upgrade/targets?sum=' + sum;
  const r = (await a.get(base + '&per=48')).json;
  assert.equal(r.page, 1);
  assert.equal(r.total, all.filter((x) => x.price > sum && Math.floor((sum * 950000) / x.price) >= 5000).length);
  assert.ok(r.targets.length > 0 && r.targets.every((x) => x.chance >= 0.5 && x.chance <= 90 && x.price > sum));
  for (let i = 1; i < r.targets.length; i++) assert.ok(r.targets[i].chance <= r.targets[i - 1].chance); // best odds first
  assert.equal(r.targets[r.targets.length - 1].key === top.key || r.pages > 1, true);
  // refusal below the floor still holds even if a client asks for such a target directly
  const tiny = await t.give('alice', Math.floor(top.price / 400));
  assert.equal((await a.post('/api/upgrade', { ids: [tiny], target: top.key })).json.error, 'chance_too_low');
  // desc order, chips (min inclusive / max exclusive), search, paging
  const d = (await a.get(base + '&sort=price_desc&per=48')).json; assert.equal(d.targets[0].price >= d.targets[d.targets.length - 1].price, true);
  const band = (await a.get(base + '&min=0.5&max=0.6&per=48')).json; assert.ok(band.targets.every((x) => x.chance >= 0.5 && x.chance < 0.6));
  const s = (await a.get(base + '&q=' + encodeURIComponent(top.name.slice(0, 5).toUpperCase()))).json; assert.ok(s.targets.every((x) => x.name.toLowerCase().includes(top.name.slice(0, 5).toLowerCase())));
  const p1 = (await a.get(base + '&per=1&page=1')).json, p2 = (await a.get(base + '&per=1&page=2')).json;
  assert.equal(p1.targets.length, 1); if (p1.pages > 1) assert.notEqual(p1.targets[0].key, p2.targets[0].key);
  assert.equal((await a.get(base + '&page=9999')).json.page, p1.pages); // clamped to the last page
  for (const bad of ['&min=abc', '&max=101', '&min=-1']) assert.equal((await a.get(base + bad)).status, 400, bad);
  assert.equal((await t.mkClient().get(base)).status, 401);
  await t.close();
});

dbTest('daily bonus: once per 24h even under parallel requests', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => a.post('/api/daily', {})));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.find((r) => r.status === 429).json.error, 'daily_cooldown');
  assert.equal((await t.balance('alice')), 1500);
  await t.db.run('UPDATE users SET daily_at = daily_at - 86400001');
  assert.equal((await a.post('/api/daily', {})).status, 200);
  await t.close();
});

dbTest('CSRF: foreign origin and non-JSON are rejected, even with a valid cookie', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const evil = await a.post('/api/daily', {}, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const form = await fetch(t.base + '/api/daily', { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  const cross = await a.post('/api/daily', {}, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.equal((await t.balance('alice')), 1000);
  const same = await a.post('/api/daily', {}, { origin: t.base });
  assert.equal(same.status, 200);
  await t.close();
});

dbTest('login brute force is throttled per IP+username, and a good login is not punished', async () => {
  const t = await boot({ limits: { login: { windowMs: 60e3, limit: 3 }, loginIp: { windowMs: 60e3, limit: 100 } } });
  await t.signup('alice'); await t.signup('carol');
  const c = t.mkClient();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login', { username: 'alice', password: 'bad-guess-' + i })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  assert.equal((await c.post('/api/auth/login', { username: 'alice', password: 'correct-horse-9' })).status, 429); // locked for this IP+nick
  assert.equal((await c.post('/api/auth/login', { username: 'carol', password: 'correct-horse-9' })).status, 200); // other nick unaffected
  await t.close();
});

dbTest('sessions: logout and password change invalidate old cookies', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const other = t.mkClient(); await other.post('/api/auth/login', { username: 'alice', password: 'correct-horse-9' });
  const old = other.cookie;
  assert.equal((await a.post('/api/auth/password', { current: 'WRONG-pass-1', newPassword: 'brand-new-pass-1' })).status, 401);
  assert.equal((await a.post('/api/auth/password', { current: 'correct-horse-9', newPassword: 'short' })).status, 400);
  assert.equal((await a.post('/api/auth/password', { current: 'correct-horse-9', newPassword: 'brand-new-pass-1' })).status, 200);
  const r = await fetch(t.base + '/api/auth/me', { headers: { cookie: old } });
  assert.equal((await r.json()).user, null);                                  // other device logged out
  assert.equal((await a.get('/api/auth/me')).json.user.username, 'alice');     // current device still in
  assert.equal((await t.mkClient().post('/api/auth/login', { username: 'alice', password: 'correct-horse-9' })).status, 401);
  const saved = a.cookie;
  await a.post('/api/auth/logout', {});
  const r2 = await fetch(t.base + '/api/auth/me', { headers: { cookie: saved } });
  assert.equal((await r2.json()).user, null);                                  // server-side session is gone
  await t.close();
});

dbTest('hardening: body limits, bad JSON, security headers, no stack leaks, static not traversable', async () => {
  const t = await boot();
  const c = t.mkClient();
  assert.equal((await c.post('/api/auth/login', 'x'.repeat(20000))).status, 413);
  assert.equal((await c.post('/api/auth/login', '{"username":')).status, 400);
  const arr = await c.post('/api/auth/register', '[1,2,3]');
  assert.equal(arr.status, 400);
  const r = await fetch(t.base + '/api/cases');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.ok(!/unsafe-eval/.test(csp));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(t.base + '/api/nope')).status, 404);
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/server/index.js', '/.env'])
    assert.notEqual((await fetch(t.base + p)).status, 200, p);
  const list = await (await fetch(t.base + '/api/cases')).json();
  assert.equal(list.cases.length, 2);
  assert.ok(!JSON.stringify(list).includes('byTier'));
  await t.close();
});
