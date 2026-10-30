'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, bodyOf } = require('./util');
const C = require('./catalog');

const { TIERS, WEAR, FT, itemPrice, makeInstance, safeImage, wearForFloat, imageHosts } = C;
const bad = (m) => new HttpError(400, 'invalid_input', m);
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_MONEY = 1e9;
const MAX_CASE_ITEMS = 60;
const MAX_GIVE = 50;
const rid = (prefix) => prefix + crypto.randomBytes(6).toString('base64url');
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ---------- validation: the admin is trusted, but every field is still checked ---------- */
function text(v, max, what) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s || s.length > max) throw bad(what + ': від 1 до ' + max + ' символів');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad(what + ': недозволені символи');
  return s;
}
function image(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const u = s.length <= 500 ? safeImage(s) : null;
  if (!u) throw bad('Картинка: потрібне https-посилання на дозволений хост (' + imageHosts().join(', ') + '). Інші хости додай через EXTRA_IMG_HOSTS');
  return u;
}
function int(v, lo, hi, what) {
  if (!Number.isSafeInteger(v) || v < lo || v > hi) throw bad(what + ': ціле число від ' + lo + ' до ' + hi);
  return v;
}
const tier = (v) => { if (!TIERS.includes(v)) throw bad('Невідома рідкість'); return v; };
const present = (v) => v !== undefined && v !== null && v !== '';

function createAdminService({ db, catalog }) {
  const q = {
    insCustomItem: db.prepare('INSERT INTO custom_items(key, name, image, tier, price, can_st, created_at) VALUES(?,?,?,?,?,?,?)'),
    delCustomItem: db.prepare('DELETE FROM custom_items WHERE key = ?'),
    allCustomItems: db.prepare('SELECT * FROM custom_items ORDER BY created_at, key'),
    insCustomCase: db.prepare('INSERT INTO custom_cases(id, name, image, price, items, created_at) VALUES(?,?,?,?,?,?)'),
    delCustomCase: db.prepare('DELETE FROM custom_cases WHERE id = ?'),
    allCustomCases: db.prepare('SELECT * FROM custom_cases ORDER BY created_at, id'),
    user: db.prepare('SELECT id, username FROM users WHERE username = ?'),
    balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
    debit: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
    credit: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
    insItem: db.prepare(`INSERT INTO items(id, user_id, item_key, name, image, tier, wear, wear_float, stattrak, price, created_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
    ledger: db.prepare('INSERT INTO ledger(user_id, kind, delta, balance_after, meta, created_at) VALUES(?,?,?,?,?,?)'),
  };

  const lookup = (key) => catalog.items.get(key) || catalog.customItems.get(key);
  const itemView = (it) => ({ key: it.key, name: it.name, image: it.image, tier: it.tier, price: itemPrice(it, FT, false), canST: it.canST !== false, custom: !!it.custom });
  const caseView = (c) => ({ id: c.id, name: c.name, image: c.image, price: c.price, count: c.items.length, createdAt: c.createdAt || 0 });
  const userByName = (name) => {
    if (typeof name !== 'string' || !USER_RE.test(name.trim())) throw bad('Некоректний нік гравця');
    const u = q.user.get(name.trim());
    if (!u) throw new HttpError(404, 'user_not_found', 'Гравця з таким ніком немає');
    return u;
  };

  /* ---------- load what the admin created earlier (called once at startup) ---------- */
  function restore() {
    for (const r of q.allCustomItems.all()) {
      if (catalog.customItems.has(r.key) || !TIERS.includes(r.tier) || !safeImage(r.image)) continue;
      C.addCustomItem(catalog, { key: r.key, name: r.name, image: r.image, tier: r.tier, price: r.price, canST: !!r.can_st });
    }
    for (const r of q.allCustomCases.all()) {
      const items = safeParse(r.items);
      if (catalog.cases.has(r.id) || !Array.isArray(items) || !items.length || !safeImage(r.image)) continue;
      const ok = items.filter((i) => i && TIERS.includes(i.tier) && safeImage(i.image) && Number.isSafeInteger(i.w) && i.w > 0);
      if (ok.length) C.addCustomCase(catalog, { id: r.id, name: r.name, image: r.image, price: r.price, createdAt: r.created_at, items: ok });
    }
  }

  /* ---------- skins ---------- */
  function search(query) {
    const s = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 60) : '';
    if (s.length < 2) return { items: [], cases: [] };
    const items = [];
    for (const it of catalog.customItems.values()) if (it.lname.includes(s)) items.push(itemView(it));
    for (const it of catalog.itemList) {
      if (items.length >= 30) break;
      if (it.lname.includes(s)) items.push(itemView(it));
    }
    const cases = catalog.list.filter((c) => c.name.toLowerCase().includes(s)).slice(0, 10).map((c) => ({ id: c.id, name: c.name, image: c.image, custom: !!c.custom }));
    return { items: items.slice(0, 30), cases };
  }

  function createItem(b) {
    const d = {
      key: rid('cx_'), name: text(b.name, 120, 'Назва'), image: image(b.image), tier: tier(b.tier),
      price: int(b.price, 1, MAX_MONEY, 'Ціна'), canST: b.canST === undefined ? true : b.canST === true,
    };
    q.insCustomItem.run(d.key, d.name, d.image, d.tier, d.price, d.canST ? 1 : 0, Date.now());
    return itemView(C.addCustomItem(catalog, d));
  }

  function deleteItem(key) {
    if (!catalog.customItems.has(key)) throw new HttpError(404, 'item_not_found', 'Свого скіна з таким id немає');
    q.delCustomItem.run(key);
    C.removeCustomItem(catalog, key); // inventories and existing cases keep their own copies
    return { ok: true };
  }

  const give = db.transaction((adminId, user, it, st, count, mk, priceOverride, now) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const inst = mk();
      if (priceOverride) inst.price = priceOverride;
      const id = crypto.randomBytes(12).toString('base64url');
      q.insItem.run(id, user.id, inst.key, inst.name, inst.image, inst.tier, inst.wear, inst.float, inst.stattrak ? 1 : 0, inst.price, now);
      out.push({ id, ...inst });
    }
    const bal = q.balance.get(user.id).balance;
    q.ledger.run(user.id, 'admin_give', 0, bal, JSON.stringify({ by: adminId, key: it.key, count, items: out.map((x) => x.id) }), now);
    return out;
  });

  function giveItems(adminId, adminName, b) {
    const user = userByName(present(b.username) ? b.username : adminName);
    const it = typeof b.key === 'string' ? lookup(b.key) : null;
    if (!it) throw bad('Невідомий скін');
    const st = b.stattrak === true;
    if (b.stattrak !== undefined && typeof b.stattrak !== 'boolean') throw bad('StatTrak: true або false');
    if (st && it.canST === false) throw bad('Для цього скіна StatTrak недоступний');
    const count = present(b.count) ? int(b.count, 1, MAX_GIVE, 'Кількість') : 1;
    const priceOverride = present(b.price) ? int(b.price, 1, MAX_MONEY, 'Ціна') : 0;

    let mk;
    if (present(b.float)) {
      const f = Number(b.float);
      if (typeof b.float === 'boolean' || !Number.isFinite(f) || f < 0 || f > 1) throw bad('Флоут: число від 0 до 1');
      const fl = +f.toFixed(4), w = wearForFloat(fl);
      mk = () => ({ key: it.key, name: it.name, image: it.image, tier: it.tier, wear: w.k, float: fl, stattrak: st, price: itemPrice(it, w, st) });
    } else if (present(b.wear)) {
      const w = typeof b.wear === 'string' ? WEAR.find((x) => x.k === b.wear) : null;
      if (!w) throw bad('Невідомий знос');
      mk = () => makeInstance(it, w, st);
    } else mk = () => makeInstance(it, undefined, st);

    const items = give.immediate(adminId, user, it, st, count, mk, priceOverride, Date.now());
    return { user: user.username, count, items };
  }

  /* ---------- cases ---------- */
  function createCase(b) {
    const price = int(b.price, 0, MAX_MONEY, 'Ціна кейса');
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_CASE_ITEMS) throw bad('У кейсі має бути від 1 до ' + MAX_CASE_ITEMS + ' скінів');
    const seen = new Set();
    const items = b.items.map((e) => {
      const entry = e && typeof e === 'object' ? e : {};
      const it = typeof entry.key === 'string' ? lookup(entry.key) : null;
      if (!it) throw bad('Невідомий скін у списку');
      if (seen.has(it.key)) throw bad('Один скін не можна додати двічі: ' + it.name);
      seen.add(it.key);
      return {
        key: it.key, name: it.name, image: it.image, tier: it.tier, canST: it.canST !== false,
        ...(it.fixed != null ? { fixed: it.fixed } : {}), w: int(entry.w, 1, 1e6, 'Вага «' + it.name + '»'),
      };
    });
    const d = { id: rid('cx_'), name: text(b.name, 60, 'Назва кейса'), image: image(b.image), price, items, createdAt: Date.now() };
    q.insCustomCase.run(d.id, d.name, d.image, d.price, JSON.stringify(items), d.createdAt);
    return caseView(C.addCustomCase(catalog, d));
  }

  function deleteCase(id) {
    const c = catalog.cases.get(id);
    if (!c || !c.custom) throw new HttpError(404, 'case_not_found', 'Свого кейса з таким id немає'); // real catalog cases cannot be removed
    q.delCustomCase.run(id);
    C.removeCustomCase(catalog, id);
    return { ok: true };
  }

  /* ---------- balance ---------- */
  const adjust = db.transaction((adminId, user, delta, now) => {
    if (delta > 0) q.credit.run(delta, user.id);
    else if (q.debit.run(-delta, user.id, -delta).changes !== 1) throw bad('У гравця немає стільки монет');
    const bal = q.balance.get(user.id).balance;
    q.ledger.run(user.id, 'admin_balance', delta, bal, JSON.stringify({ by: adminId }), now);
    return bal;
  });
  function changeBalance(adminId, adminName, b) {
    const user = userByName(present(b.username) ? b.username : adminName);
    const delta = int(b.delta, -MAX_MONEY, MAX_MONEY, 'Сума');
    if (delta === 0) throw bad('Сума не може бути нулем');
    return { user: user.username, balance: adjust.immediate(adminId, user, delta, Date.now()) };
  }

  return {
    restore, search, createItem, deleteItem, giveItems, createCase, deleteCase, changeBalance,
    listItems: () => [...catalog.customItems.values()].map(itemView).reverse(),
    listCases: () => catalog.list.filter((c) => c.custom).map(caseView),
  };
}

function createAdmin({ db, catalog, limiters, requireAuth, requireAdmin }) {
  const svc = createAdminService({ db, catalog });
  svc.restore();
  const r = express.Router();
  // Logged-out -> 401, logged-in non-admin -> 404, so the panel is invisible to regular players.
  r.use('/admin', requireAuth, requireAdmin, limiters.game);

  r.get('/admin/search', (req, res) => {
    if (typeof req.query.q !== 'string') throw bad('Некоректний пошук');
    res.json(svc.search(req.query.q));
  });
  r.get('/admin/items', (req, res) => res.json({ items: svc.listItems() }));
  r.post('/admin/items', (req, res) => res.status(201).json({ item: svc.createItem(bodyOf(req)) }));
  r.post('/admin/items/:key/delete', (req, res) => res.json(svc.deleteItem(String(req.params.key))));
  r.post('/admin/give', (req, res) => res.json(svc.giveItems(req.user.id, req.user.username, bodyOf(req))));
  r.get('/admin/cases', (req, res) => res.json({ cases: svc.listCases() }));
  r.post('/admin/cases', (req, res) => res.status(201).json({ case: svc.createCase(bodyOf(req)) }));
  r.post('/admin/cases/:id/delete', (req, res) => res.json(svc.deleteCase(String(req.params.id))));
  r.post('/admin/balance', (req, res) => res.json(svc.changeBalance(req.user.id, req.user.username, bodyOf(req))));
  return r;
}

module.exports = { createAdmin, createAdminService };
