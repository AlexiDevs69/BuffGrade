'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, rollDrop } = require('../server/catalog');
const { boot, FIXTURE } = require('./helpers');

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

test('register: validation, cookie flags, duplicates', async () => {
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
  t.close();
});

test('login: no user enumeration, passwords hashed, session tokens not stored raw', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const hash = t.db.prepare('SELECT pass_hash FROM users WHERE username=?').get('alice').pass_hash;
  assert.match(hash, /^scrypt\$/); assert.ok(!hash.includes('correct-horse-9'));
  const token = a.cookie.split('=')[1];
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(token).n, 0);
  const wrong = await t.mkClient().post('/api/auth/login', { username: 'alice', password: 'wrong-password' });
  const none = await t.mkClient().post('/api/auth/login', { username: 'nobody', password: 'wrong-password' });
  assert.equal(wrong.status, 401); assert.equal(none.status, 401);
  assert.deepEqual(wrong.json, none.json);
  assert.equal((await t.mkClient().post('/api/auth/login', { username: "' OR 1=1 --", password: 'x' })).status, 401);
  assert.equal((await t.mkClient().post('/api/auth/login', { username: 'alice', password: 'correct-horse-9' })).status, 200);
  t.close();
});

test('protected routes need a valid session; forged cookies fail', async () => {
  const t = await boot();
  const g = t.mkClient();
  assert.equal((await g.get('/api/auth/me')).json.user, null);
  for (const [m, p] of [['GET', '/api/inventory'], ['POST', '/api/daily'], ['POST', '/api/cases/crate-1/open'], ['POST', '/api/inventory/sell'], ['POST', '/api/upgrade']])
    assert.equal((await g.call(m, p, {})).status, 401, p);
  for (const bad of ['bg_sid=' + 'A'.repeat(43), 'bg_sid=abc', "bg_sid=' OR 1=1--"]) {
    const r = await fetch(t.base + '/api/inventory', { headers: { cookie: bad } });
    assert.equal(r.status, 401, bad);
  }
  t.close();
});

test('open case: server decides price, balance and drop', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  const r = await a.post('/api/cases/crate-1/open', { price: 0, item: 'hack', balance: 999999 });
  assert.equal(r.status, 200);
  assert.equal(r.json.balance, 1000 - price);
  assert.equal(t.balance('alice'), 1000 - price);
  assert.equal((await a.get('/api/inventory')).json.items.length, 1);
  assert.equal((await a.post('/api/cases/nope/open', {})).status, 404);
  assert.equal((await a.post('/api/cases/__proto__/open', {})).status, 404);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='case_open'").get().n, 1);
  t.close();
});

test('no double-spend: 20 parallel opens with money for exactly 2', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const price = t.catalog.cases.get('crate-1').price;
  t.setBal('alice', price * 2 + 1);
  const rs = await Promise.all(Array.from({ length: 20 }, () => a.post('/api/cases/crate-1/open', {})));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.equal(rs.filter((r) => r.status === 402).length, 18);
  assert.equal(t.balance('alice'), 1);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items').get().n, 2);
  t.close();
});

test('sell: only own items, only once, ids validated', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  const ia = t.give('alice', 100), ib = t.give('bob', 100);
  const r1 = await b.post('/api/inventory/sell', { ids: [ia] });
  assert.equal(r1.status, 404);
  assert.equal(t.balance('bob'), 1000);
  assert.equal((await b.post('/api/inventory/sell', { ids: [ib, ia] })).status, 404); // all-or-nothing
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items WHERE id=?').get(ib).n, 1);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => a.post('/api/inventory/sell', { ids: [ia] })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(t.balance('alice'), 1100);
  for (const ids of [[], 'x', null, [1], [ia, ia], ["a' OR '1'='1"], Array(101).fill('a')])
    assert.equal((await a.post('/api/inventory/sell', { ids })).status, 400, JSON.stringify(ids).slice(0, 40));
  t.close();
});

test('upgrade: chance is computed on the server and bounded', async () => {
  const t = await boot();
  const a = await t.signup('alice'); const b = await t.signup('bob');
  const top = t.catalog.targets[t.catalog.targets.length - 1];
  // 1) cheap ingredient vs expensive target: chance < 1%, refused (not clamped up)
  const tiny = t.give('alice', 1);
  let r = await a.post('/api/upgrade', { ids: [tiny], target: top.key });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'chance_too_low');
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items WHERE id=?').get(tiny).n, 1);
  // 2) target cheaper than stake
  const rich = t.give('alice', top.price + 5);
  r = await a.post('/api/upgrade', { ids: [rich], target: top.key });
  assert.equal(r.json.error, 'target_too_cheap');
  // 3) foreign item / unknown target / duplicates / too many
  const foreign = t.give('bob', Math.ceil(top.price / 50));
  assert.equal((await a.post('/api/upgrade', { ids: [foreign], target: top.key })).status, 404);
  assert.equal((await a.post('/api/upgrade', { ids: [rich], target: 'nope' })).status, 400);
  assert.equal((await a.post('/api/upgrade', { ids: [rich, rich], target: top.key })).status, 400);
  assert.equal((await a.post('/api/upgrade', { ids: Array(11).fill('a'), target: top.key })).status, 400);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items WHERE id=?').get(foreign).n, 1);
  // 4) valid: result is consistent with roll < chance, items consumed, winner gets the target
  let wins = 0;
  for (let i = 0; i < 40; i++) {
    const stake = Math.ceil(top.price / 4);
    const id = t.give('alice', stake);
    const res = await a.post('/api/upgrade', { ids: [id], target: top.key });
    assert.equal(res.status, 200);
    const expected = Math.min(90, (stake * 95) / top.price);
    assert.ok(Math.abs(res.json.chance - expected) < 0.01);
    assert.equal(res.json.win, res.json.roll < res.json.chance);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM items WHERE id=?').get(id).n, 0);
    if (res.json.win) { wins++; assert.equal(res.json.item.key, top.key); assert.equal(res.json.item.price > 0, true); }
    else assert.equal(res.json.item, null);
  }
  assert.ok(wins > 0 && wins < 40, 'wins ' + wins);
  const tg = await a.get('/api/upgrade/targets?sum=100');
  assert.equal(tg.status, 200);
  for (const x of tg.json.targets) assert.ok(x.price > 100 && x.chance >= 1 && x.chance <= 90);
  assert.equal((await a.get('/api/upgrade/targets?sum=-5')).status, 400);
  assert.equal((await a.get('/api/upgrade/targets?sum=abc')).status, 400);
  void b; t.close();
});

test('daily bonus: once per 24h even under parallel requests', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => a.post('/api/daily', {})));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.find((r) => r.status === 429).json.error, 'daily_cooldown');
  assert.equal(t.balance('alice'), 1500);
  t.db.prepare('UPDATE users SET daily_at = daily_at - 86400001').run();
  assert.equal((await a.post('/api/daily', {})).status, 200);
  t.close();
});

test('CSRF: foreign origin and non-JSON are rejected, even with a valid cookie', async () => {
  const t = await boot();
  const a = await t.signup('alice');
  const evil = await a.post('/api/daily', {}, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const form = await fetch(t.base + '/api/daily', { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  const cross = await a.post('/api/daily', {}, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.equal(t.balance('alice'), 1000);
  const same = await a.post('/api/daily', {}, { origin: t.base });
  assert.equal(same.status, 200);
  t.close();
});

test('login brute force is throttled per IP+username, and a good login is not punished', async () => {
  const t = await boot({ limits: { login: { windowMs: 60e3, limit: 3 }, loginIp: { windowMs: 60e3, limit: 100 } } });
  await t.signup('alice'); await t.signup('carol');
  const c = t.mkClient();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login', { username: 'alice', password: 'bad-guess-' + i })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  assert.equal((await c.post('/api/auth/login', { username: 'alice', password: 'correct-horse-9' })).status, 429); // locked for this IP+nick
  assert.equal((await c.post('/api/auth/login', { username: 'carol', password: 'correct-horse-9' })).status, 200); // other nick unaffected
  t.close();
});

test('sessions: logout and password change invalidate old cookies', async () => {
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
  t.close();
});

test('hardening: body limits, bad JSON, security headers, no stack leaks, static not traversable', async () => {
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
  t.close();
});
