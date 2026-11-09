'use strict';
const express = require('express');
const { HttpError, ah, bodyOf } = require('./util');
const { rollDrop, makeInstance, randInt, FT } = require('./catalog');
const { DAY } = require('./auth');
const { values, insertItems, addLedger, addHistory } = require('./db');

const MAX_UP_ITEMS = 10;
const MAX_SELL = 100;
const MAX_OPEN = 10; // cases per request
const MAX_HISTORY = 500; // per user; older rows are pruned (best drop is stored separately, so it is never lost)
const MIN_CHANCE_PPM = 5000;   // 0.5%: below this the upgrade is refused (never clamped upwards, that would be an exploit)
const MAX_CHANCE_PPM = 900000; // 90%
const FEE_PPM = 950000;        // 5% house fee: chance = sum / price * 0.95

const bad = (m) => new HttpError(400, 'invalid_input', m);
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
  const SQL = {
    debit: 'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
    credit: 'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
    pruneHist: `DELETE FROM history WHERE user_id = $1 AND id NOT IN
                (SELECT id FROM history WHERE user_id = $1 ORDER BY id DESC LIMIT ${MAX_HISTORY})`,
  };

  // Every money-moving operation is ONE transaction: check + debit + result + audit, all or nothing.
  // The balance UPDATE locks the user's row until COMMIT, so two parallel requests of one player run one after another.
  const openTx = (uid, c, count, now) => db.tx(async (t) => {
    const total = c.price * count;
    const paid = await t.get(SQL.debit, [total, uid]);
    if (!paid) throw new HttpError(402, 'insufficient_funds', 'Не вистачає монет');
    const from = { id: c.id, name: c.name, image: c.image };
    let { best_price: bestPrice } = await t.get('SELECT best_price FROM users WHERE id = $1', [uid]);
    let best = null;
    const drops = Array.from({ length: count }, () => rollDrop(c));
    const rows = await insertItems(t, uid, drops, now);
    const hist = values(drops.map((drop) => [uid, 'case', JSON.stringify({ case: from, item: snapDrop(drop) }), now]));
    await t.run(`INSERT INTO history(user_id, kind, data, created_at) VALUES ${hist.sql}`, hist.params);
    for (const drop of drops) {
      if (drop.price > bestPrice) { bestPrice = drop.price; best = { ...snapDrop(drop), case: from, at: now }; }
    }
    if (best) await t.run('UPDATE users SET best_drop = $1, best_price = $2 WHERE id = $3', [JSON.stringify(best), bestPrice, uid]);
    const items = rows.map(itemView);
    await addLedger(t, uid, 'case_open', -total, paid.balance, {
      case: c.id, count, items: items.map((i) => i.id), value: items.reduce((a, i) => a + i.price, 0),
    }, now);
    await t.run(SQL.pruneHist, [uid]);
    return { items, item: items[0], balance: paid.balance }; // `item` = first drop, kept for single-open clients
  });

  const sellTx = (uid, ids, now) => db.tx(async (t) => {
    // FOR UPDATE: a parallel sell of the same items waits here, then finds them gone -> 404 (no double payout).
    const rows = await t.all('SELECT id, price FROM items WHERE user_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE', [uid, ids]);
    if (rows.length !== ids.length) throw new HttpError(404, 'item_not_found', 'Предмет не знайдено');
    await t.run('DELETE FROM items WHERE user_id = $1 AND id = ANY($2::text[])', [uid, ids]);
    const sum = rows.reduce((a, r) => a + r.price, 0);
    const { balance: after } = await t.get(SQL.credit, [sum, uid]);
    await addLedger(t, uid, 'sell', sum, after, { count: ids.length }, now);
    return { sold: sum, balance: after };
  });

  const upgradeTx = (uid, ids, target, now) => db.tx(async (t) => {
    const rows = await t.all('SELECT * FROM items WHERE user_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE', [uid, ids]);
    if (rows.length !== ids.length) throw new HttpError(404, 'item_not_found', 'Предмет не знайдено');
    const sum = rows.reduce((a, r) => a + r.price, 0);
    if (target.price <= sum) throw new HttpError(400, 'target_too_cheap', 'Ціль має бути дорожчою за ставку');
    const raw = rawChancePpm(sum, target.price);
    if (raw < MIN_CHANCE_PPM) throw new HttpError(400, 'chance_too_low', 'Шанс менший за 0.5%, додай більше скінів');
    const chance = Math.min(MAX_CHANCE_PPM, raw);
    const roll = randInt(1000000);
    const win = roll < chance;
    const stake = rows.map(snapRow);
    await t.run('DELETE FROM items WHERE user_id = $1 AND id = ANY($2::text[])', [uid, ids]);
    let item = null;
    if (win) item = itemView((await insertItems(t, uid, [makeInstance(target, FT)], now))[0]);
    const { balance } = await t.get('SELECT balance FROM users WHERE id = $1', [uid]);
    await addLedger(t, uid, 'upgrade', 0, balance, { sum, target: target.key, price: target.price, chance, roll, win }, now);
    await addHistory(t, uid, 'upgrade', {
      stake,
      target: { key: target.key, name: target.name, image: target.image, tier: target.tier, price: target.price },
      chance: chance / 10000, roll: roll / 10000, win,
      result: item ? (({ id, ...rest }) => rest)(item) : null,
    }, now);
    await t.run(SQL.pruneHist, [uid]);
    return { win, item, chance: chance / 10000, roll: roll / 10000, balance };
  });

  const dailyTx = (uid, now) => db.tx(async (t) => {
    const { daily_at: last } = await t.get('SELECT daily_at FROM users WHERE id = $1 FOR UPDATE', [uid]);
    if (now - last < DAY) {
      const wait = last + DAY - now;
      throw new HttpError(429, 'daily_cooldown', 'Бонус ще не готовий', { retryInMs: wait });
    }
    const { balance: after } = await t.get('UPDATE users SET balance = balance + $1, daily_at = $2 WHERE id = $3 RETURNING balance', [cfg.dailyBonus, now, uid]);
    await addLedger(t, uid, 'daily', cfg.dailyBonus, after, null, now);
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
    res.json(await openTx(req.user.id, c, count, Date.now())); // price comes from the server catalog, never from the client
  }));

  r.get('/inventory', guard, ah(async (req, res) => {
    const [rows, me] = await Promise.all([
      db.all('SELECT * FROM items WHERE user_id = $1 ORDER BY price DESC, created_at DESC', [req.user.id]),
      db.get('SELECT balance FROM users WHERE id = $1', [req.user.id]),
    ]);
    res.json({ items: rows.map(itemView), balance: me.balance });
  }));

  r.post('/inventory/sell', guard, ah(async (req, res) => {
    const ids = validIds(bodyOf(req).ids, MAX_SELL);
    res.json(await sellTx(req.user.id, ids, Date.now()));
  }));

  // Every catalog skin that is dearer than the stake and still has at least MIN_CHANCE (0.5%) is a valid target.
  // Query: sum (required), q (name), min / max (chance in %, min inclusive, max exclusive), sort (price_asc = best odds first | price_desc), page, per.
  const pct = (v, what) => {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    if (typeof v !== 'string' || !Number.isFinite(n) || n < 0 || n > 100) throw bad(what + ': число від 0 до 100');
    return n;
  };
  r.get('/upgrade/targets', guard, (req, res) => {
    const sum = Number(req.query.sum);
    if (!Number.isSafeInteger(sum) || sum < 1 || sum > 1e9) throw bad('Некоректна сума');
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 60) : '';
    const lo = pct(req.query.min, 'Мінімальний шанс'), hi = pct(req.query.max, 'Максимальний шанс');
    const desc = req.query.sort === 'price_desc';
    const per = Math.min(48, Math.max(1, Math.floor(Number(req.query.per)) || 24));
    const hits = [];
    for (const t of catalog.targets) { // sorted by price ascending, so the chance only goes down
      if (t.price <= sum) continue;
      const raw = rawChancePpm(sum, t.price);
      if (raw < MIN_CHANCE_PPM) break;
      const chance = Math.min(MAX_CHANCE_PPM, raw) / 10000;
      if (lo !== null && chance < lo) continue;
      if (hi !== null && chance >= hi) continue;
      if (q && !t.lname.includes(q)) continue;
      hits.push({ key: t.key, name: t.name, image: t.image, tier: t.tier, price: t.price, chance });
    }
    if (desc) hits.reverse();
    const pages = Math.max(1, Math.ceil(hits.length / per));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(req.query.page)) || 1));
    res.json({ targets: hits.slice((page - 1) * per, page * per), total: hits.length, page, pages });
  });

  r.post('/upgrade', guard, ah(async (req, res) => {
    const b = bodyOf(req);
    const ids = validIds(b.ids, MAX_UP_ITEMS);
    const target = typeof b.target === 'string' ? catalog.items.get(b.target) : null;
    if (!target) throw bad('Невідома ціль');
    res.json(await upgradeTx(req.user.id, ids, target, Date.now()));
  }));

  r.post('/daily', guard, ah(async (req, res) => res.json(await dailyTx(req.user.id, Date.now()))));

  return r;
}

module.exports = { createGame };
