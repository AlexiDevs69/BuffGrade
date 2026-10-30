'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, bodyOf } = require('./util');
const { WEAR, TIERS, CATEGORIES, marketPrice, makeInstance, itemPrice } = require('./catalog');

const WEAR_BY = new Map(WEAR.map((w, i) => [w.k, { ...w, order: i }]));
const CAT_IDS = new Set(CATEGORIES.map((c) => c.id));
const TIER_SET = new Set(TIERS);
const bad = (m) => new HttpError(400, 'invalid_input', m);

const byName = (a, b) => (a.it.name < b.it.name ? -1 : a.it.name > b.it.name ? 1 : 0) || a.w.order - b.w.order || Number(a.st) - Number(b.st);
const SORTS = {
  price_asc: (a, b) => a.price - b.price || byName(a, b),
  price_desc: (a, b) => b.price - a.price || byName(a, b),
  name: byName,
};

// Query values must be single strings (repeated keys would arrive as arrays) and are validated strictly.
function str(v, max) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad('Некоректний параметр');
  return v;
}
function list(v, allowed) {
  const s = str(v, 60);
  if (s === undefined || s === '') return null;
  const out = new Set(s.split(','));
  if (out.size > allowed.size) throw bad('Некоректний параметр');
  for (const x of out) if (!allowed.has(x)) throw bad('Некоректний параметр');
  return out;
}
function int(v, lo, hi, def) {
  const s = str(v, 12);
  if (s === undefined || s === '') return def;
  if (!/^\d+$/.test(s)) throw bad('Некоректне число');
  const n = Number(s);
  if (n < lo || n > hi) throw bad('Число поза межами');
  return n;
}

function createMarket({ db, catalog, limiters, requireAuth }) {
  const r = express.Router();
  const q = {
    debit: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
    balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
    insItem: db.prepare(`INSERT INTO items(id, user_id, item_key, name, image, tier, wear, wear_float, stattrak, price, created_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
    ledger: db.prepare('INSERT INTO ledger(user_id, kind, delta, balance_after, meta, created_at) VALUES(?,?,?,?,?,?)'),
  };

  // Public: anyone can browse. Listings are generated from the catalog (item x wear x StatTrak) and filtered on the server.
  r.get('/market', (req, res) => {
    const f = {
      q: (str(req.query.q, 60) || '').trim().toLowerCase(),
      cat: str(req.query.cat, 20) || '',
      tier: list(req.query.tier, TIER_SET),
      wear: list(req.query.wear, new Set(WEAR_BY.keys())),
      st: str(req.query.st, 3) || 'any',
      case: str(req.query.case, 80) || '',
      sort: str(req.query.sort, 20) || 'price_asc',
      min: int(req.query.min, 0, 1e9, 0),
      max: int(req.query.max, 0, 1e9, Infinity),
      page: int(req.query.page, 1, 100000, 1),
      per: int(req.query.per, 12, 48, 24),
    };
    if (f.cat && !CAT_IDS.has(f.cat)) throw bad('Невідома категорія');
    if (!['any', 'yes', 'no'].includes(f.st)) throw bad('Некоректний StatTrak');
    if (!Object.hasOwn(SORTS, f.sort)) throw bad('Некоректне сортування');
    if (f.case && !catalog.cases.has(f.case)) throw bad('Невідомий кейс');

    const hits = [];
    for (const it of catalog.itemList) {
      if (f.cat && it.category !== f.cat) continue;
      if (f.tier && !f.tier.has(it.tier)) continue;
      if (f.case && !it.caseIds.has(f.case)) continue;
      if (f.q && !it.lname.includes(f.q)) continue;
      for (const w of WEAR_BY.values()) {
        if (f.wear && !f.wear.has(w.k)) continue;
        for (const st of it.canST ? [false, true] : [false]) {
          if (f.st === 'yes' && !st) continue;
          if (f.st === 'no' && st) continue;
          const price = marketPrice(it, w, st);
          if (price < f.min || price > f.max) continue;
          hits.push({ it, w, st, price });
        }
      }
    }
    hits.sort(SORTS[f.sort]);
    const total = hits.length;
    const pages = Math.max(1, Math.ceil(total / f.per));
    const listings = hits.slice((f.page - 1) * f.per, f.page * f.per).map(({ it, w, st, price }) => ({
      key: it.key, name: it.name, image: it.image, tier: it.tier, category: it.category,
      wear: w.k, stattrak: st, price, value: itemPrice(it, w, st),
    }));
    res.json({ total, page: f.page, pages, listings });
  });

  const buyTx = db.transaction((uid, it, w, st, now) => {
    const cost = marketPrice(it, w, st);
    if (q.debit.run(cost, uid, cost).changes !== 1) throw new HttpError(402, 'insufficient_funds', 'Не вистачає монет');
    const inst = makeInstance(it, w, st); // price of the instance is its sell value, not what was paid
    const id = crypto.randomBytes(12).toString('base64url');
    q.insItem.run(id, uid, inst.key, inst.name, inst.image, inst.tier, inst.wear, inst.float, inst.stattrak ? 1 : 0, inst.price, now);
    const after = q.balance.get(uid).balance;
    q.ledger.run(uid, 'market_buy', -cost, after, JSON.stringify({ item: id, key: inst.key, wear: inst.wear, st: inst.stattrak, value: inst.price }), now);
    return { item: { id, ...inst }, cost, balance: after };
  });

  r.post('/market/buy', requireAuth, limiters.game, (req, res) => {
    const b = bodyOf(req);
    if (typeof b.key !== 'string' || b.key.length > 100) throw bad('Невідомий предмет');
    const it = catalog.items.get(b.key);                     // the price is always computed here, never taken from the client
    const w = typeof b.wear === 'string' ? WEAR_BY.get(b.wear) : undefined;
    if (!it || !w) throw bad('Невідомий предмет або знос');
    if (typeof b.stattrak !== 'boolean') throw bad('Вкажи StatTrak: true або false');
    if (b.stattrak && !it.canST) throw bad('Для цього предмета StatTrak недоступний');
    res.json(buyTx.immediate(req.user.id, it, w, b.stattrak, Date.now()));
  });

  return r;
}

module.exports = { createMarket };
