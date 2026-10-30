'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, ah, bodyOf } = require('./util');
const { rollDrop, makeInstance, randInt, FT } = require('./catalog');
const { DAY } = require('./auth');

const MAX_UP_ITEMS = 10;
const MAX_SELL = 100;
const MAX_OPEN = 10; // cases per request
const MAX_HISTORY = 500; // per user; older rows are pruned (best drop is stored separately, so it is never lost)
const MIN_CHANCE_PPM = 10000;  // 1%: below this the upgrade is refused (never clamped upwards, that would be an exploit)
const MAX_CHANCE_PPM = 900000; // 90%
const FEE_PPM = 950000;        // 5% house fee: chance = sum / price * 0.95

const bad = (m) => new HttpError(400, 'invalid_input', m);
const newId = () => crypto.randomBytes(12).toString('base64url');
const itemView = (r) => ({
  id: r.id, key: r.item_key, name: r.name, image: r.image, tier: r.tier,
  wear: r.wear, float: r.wear_float, stattrak: !!r.stattrak, price: r.price,
});

function validIds(v, max) {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) throw bad('Обери від 1 до ' + max + ' предметів');
  for (const x of v) if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(x)) throw bad('Некоректний ідентифікатор предмета');
  if (new Set(v).size !== v.length) throw bad('Предмети не можуть повторюватися');
  return v;
}
const snapRow = (r) => { const { id, ...rest } = itemView(r); return rest; };
const snapDrop = (d) => ({ key: d.key, name: d.name, image: d.image, tier: d.tier, wear: d.wear, float: d.float, stattrak: !!d.stattrak, price: d.price });
const rawChancePpm = (sum, price) => Math.floor((sum * FEE_PPM) / price);

function createGame({ db, catalog, cfg, limiters, requireAuth }) {
  const q = {
    balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
    debit: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
    credit: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
    insItem: db.prepare(`INSERT INTO items(id, user_id, item_key, name, image, tier, wear, wear_float, stattrak, price, created_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
    item: db.prepare('SELECT * FROM items WHERE id = ?'),
    inv: db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY price DESC, created_at DESC'),
    ledger: db.prepare('INSERT INTO ledger(user_id, kind, delta, balance_after, meta, created_at) VALUES(?,?,?,?,?,?)'),
    daily: db.prepare('SELECT daily_at FROM users WHERE id = ?'),
    insHist: db.prepare('INSERT INTO history(user_id, kind, data, created_at) VALUES(?,?,?,?)'),
    pruneHist: db.prepare(`DELETE FROM history WHERE user_id = ? AND id NOT IN
                           (SELECT id FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ${MAX_HISTORY})`),
    bestPrice: db.prepare('SELECT best_price FROM users WHERE id = ?'),
    setBest: db.prepare('UPDATE users SET best_drop = ?, best_price = ? WHERE id = ?'),
    setDaily: db.prepare('UPDATE users SET balance = balance + ?, daily_at = ? WHERE id = ?'),
  };
  const bal = (uid) => q.balance.get(uid).balance;
  const insert = (uid, d, now) => {
    const id = newId();
    q.insItem.run(id, uid, d.key, d.name, d.image, d.tier, d.wear, d.float, d.stattrak ? 1 : 0, d.price, now);
    return id;
  };
  const inList = (ids) => ids.map(() => '?').join(',');

  // Every money-moving operation is ONE immediate transaction: check + debit + result + audit, all or nothing.
  const openTx = db.transaction((uid, c, count, now) => {
    const total = c.price * count;
    if (q.debit.run(total, uid, total).changes !== 1) throw new HttpError(402, 'insufficient_funds', 'Не вистачає монет');
    const from = { id: c.id, name: c.name, image: c.image };
    let bestPrice = q.bestPrice.get(uid).best_price, best = null;
    const items = [];
    for (let i = 0; i < count; i++) {
      const drop = rollDrop(c);
      const id = insert(uid, drop, now);
      const snap = snapDrop(drop);
      q.insHist.run(uid, 'case', JSON.stringify({ case: from, item: snap }), now);
      if (drop.price > bestPrice) { bestPrice = drop.price; best = { ...snap, case: from, at: now }; }
      items.push(itemView(q.item.get(id)));
    }
    if (best) q.setBest.run(JSON.stringify(best), bestPrice, uid);
    const after = bal(uid);
    q.ledger.run(uid, 'case_open', -total, after, JSON.stringify({ case: c.id, count, items: items.map((i) => i.id), value: items.reduce((a, i) => a + i.price, 0) }), now);
    q.pruneHist.run(uid, uid);
    return { items, item: items[0], balance: after }; // `item` = first drop, kept for single-open clients
  });

  const sellTx = db.transaction((uid, ids, now) => {
    const rows = db.prepare(`SELECT id, price FROM items WHERE user_id = ? AND id IN (${inList(ids)})`).all(uid, ...ids);
    if (rows.length !== ids.length) throw new HttpError(404, 'item_not_found', 'Предмет не знайдено');
    const del = db.prepare(`DELETE FROM items WHERE user_id = ? AND id IN (${inList(ids)})`).run(uid, ...ids);
    if (del.changes !== ids.length) throw new HttpError(409, 'conflict', 'Інвентар змінився, спробуй ще раз');
    const sum = rows.reduce((a, r) => a + r.price, 0);
    q.credit.run(sum, uid);
    const after = bal(uid);
    q.ledger.run(uid, 'sell', sum, after, JSON.stringify({ count: ids.length }), now);
    return { sold: sum, balance: after };
  });

  const upgradeTx = db.transaction((uid, ids, target, now) => {
    const rows = db.prepare(`SELECT * FROM items WHERE user_id = ? AND id IN (${inList(ids)})`).all(uid, ...ids);
    if (rows.length !== ids.length) throw new HttpError(404, 'item_not_found', 'Предмет не знайдено');
    const sum = rows.reduce((a, r) => a + r.price, 0);
    if (target.price <= sum) throw new HttpError(400, 'target_too_cheap', 'Ціль має бути дорожчою за ставку');
    const raw = rawChancePpm(sum, target.price);
    if (raw < MIN_CHANCE_PPM) throw new HttpError(400, 'chance_too_low', 'Шанс менший за 1%, додай більше скінів');
    const chance = Math.min(MAX_CHANCE_PPM, raw);
    const roll = randInt(1000000);
    const win = roll < chance;
    const stake = rows.map(snapRow);
    db.prepare(`DELETE FROM items WHERE user_id = ? AND id IN (${inList(ids)})`).run(uid, ...ids);
    let item = null;
    if (win) item = itemView(q.item.get(insert(uid, makeInstance(target, FT), now)));
    q.ledger.run(uid, 'upgrade', 0, bal(uid), JSON.stringify({ sum, target: target.key, price: target.price, chance, roll, win }), now);
    q.insHist.run(uid, 'upgrade', JSON.stringify({
      stake,
      target: { key: target.key, name: target.name, image: target.image, tier: target.tier, price: target.price },
      chance: chance / 10000, roll: roll / 10000, win,
      result: item ? (({ id, ...rest }) => rest)(item) : null,
    }), now);
    q.pruneHist.run(uid, uid);
    return { win, item, chance: chance / 10000, roll: roll / 10000, balance: bal(uid) };
  });

  const dailyTx = db.transaction((uid, now) => {
    const last = q.daily.get(uid).daily_at;
    if (now - last < DAY) {
      const wait = last + DAY - now;
      throw new HttpError(429, 'daily_cooldown', 'Бонус ще не готовий', { retryInMs: wait });
    }
    q.setDaily.run(cfg.dailyBonus, now, uid);
    const after = bal(uid);
    q.ledger.run(uid, 'daily', cfg.dailyBonus, after, null, now);
    return { balance: after, bonus: cfg.dailyBonus };
  });

  const r = express.Router();

  // ---- public catalog ----
  r.get('/cases', (req, res) => res.json({ cases: catalog.summaries }));
  r.get('/cases/:id', (req, res) => {
    const c = catalog.cases.get(String(req.params.id));
    if (!c) throw new HttpError(404, 'case_not_found', 'Кейс не знайдено');
    res.json({
      id: c.id, name: c.name, kind: c.kind, image: c.image, price: c.price, odds: c.odds,
      items: c.items.map(({ key, name, image, tier, chance }) => (chance === undefined ? { key, name, image, tier } : { key, name, image, tier, chance })),
    });
  });

  // ---- authenticated game actions ----
  const guard = [requireAuth, limiters.game]; // applied per route, so unknown paths still return 404

  r.post('/cases/:id/open', guard, ah(async (req, res) => {
    const c = catalog.cases.get(String(req.params.id));
    if (!c) throw new HttpError(404, 'case_not_found', 'Кейс не знайдено');
    const count = bodyOf(req).count === undefined ? 1 : bodyOf(req).count;
    if (!Number.isInteger(count) || count < 1 || count > MAX_OPEN) throw bad('Кількість кейсів: від 1 до ' + MAX_OPEN);
    res.json(openTx.immediate(req.user.id, c, count, Date.now())); // price comes from the server catalog, never from the client
  }));

  r.get('/inventory', guard, (req, res) => {
    const items = q.inv.all(req.user.id).map(itemView);
    res.json({ items, balance: bal(req.user.id) });
  });

  r.post('/inventory/sell', guard, (req, res) => {
    const ids = validIds(bodyOf(req).ids, MAX_SELL);
    res.json(sellTx.immediate(req.user.id, ids, Date.now()));
  });

  r.get('/upgrade/targets', guard, (req, res) => {
    const sum = Number(req.query.sum);
    if (!Number.isSafeInteger(sum) || sum < 1 || sum > 1e9) throw bad('Некоректна сума');
    const targets = [];
    for (const t of catalog.targets) {
      if (t.price <= sum) continue;
      const raw = rawChancePpm(sum, t.price);
      if (raw < MIN_CHANCE_PPM) break; // sorted by price ascending, so every next one is worse
      targets.push({ key: t.key, name: t.name, image: t.image, tier: t.tier, price: t.price, chance: Math.min(MAX_CHANCE_PPM, raw) / 10000 });
      if (targets.length >= 30) break;
    }
    res.json({ targets });
  });

  r.post('/upgrade', guard, (req, res) => {
    const b = bodyOf(req);
    const ids = validIds(b.ids, MAX_UP_ITEMS);
    const target = typeof b.target === 'string' ? catalog.items.get(b.target) : null;
    if (!target) throw bad('Невідома ціль');
    res.json(upgradeTx.immediate(req.user.id, ids, target, Date.now()));
  });

  r.post('/daily', guard, (req, res) => res.json(dailyTx.immediate(req.user.id, Date.now())));

  return r;
}

module.exports = { createGame };
