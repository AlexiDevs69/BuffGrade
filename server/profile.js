'use strict';
const express = require('express');
const { HttpError, ah, bodyOf } = require('./util');

const COLOR_PRESETS = 12;
const bad = (m) => new HttpError(400, 'invalid_input', m);
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const nameHash = (s) => { let x = 0; for (const ch of s) x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0; return x; };

function createProfile({ db, catalog, limiters, requireAuth }) {
  const r = express.Router();
  const lookup = (key) => catalog.items.get(key) || (catalog.customItems && catalog.customItems.get(key)); // catalog or admin-made
  const guard = [requireAuth, limiters.game];
  const getUser = (id) => db.get('SELECT username, avatar, best_drop, created_at FROM users WHERE id = $1', [id]);

  // The avatar is never a user-supplied URL: either a colour preset or the image of a catalog item.
  function avatarView(u) {
    const a = u.avatar || '';
    const m = /^c:(\d{1,2})$/.exec(a);
    if (m && Number(m[1]) < COLOR_PRESETS) return { type: 'color', index: Number(m[1]) };
    if (a.startsWith('i:')) {
      const it = lookup(a.slice(2));
      if (it) return { type: 'item', key: it.key, name: it.name, image: it.image, tier: it.tier };
    }
    return { type: 'color', index: nameHash(u.username) % COLOR_PRESETS };
  }

  r.get('/profile', guard, ah(async (req, res) => {
    const u = await getUser(req.user.id);
    res.json({
      username: u.username, createdAt: u.created_at, avatar: avatarView(u),
      bestDrop: u.best_drop ? safeParse(u.best_drop) : null,
    });
  }));

  r.post('/profile/avatar', guard, ah(async (req, res) => {
    const a = bodyOf(req).avatar;
    if (typeof a !== 'string' || a.length > 120) throw bad('Некоректний аватар');
    const m = /^c:(\d{1,2})$/.exec(a);
    if (m) {
      if (Number(m[1]) >= COLOR_PRESETS) throw bad('Немає такого кольору');
    } else if (a.startsWith('i:')) {
      const key = a.slice(2);
      if (!lookup(key)) throw bad('Невідомий предмет');
      const best = safeParse((await getUser(req.user.id)).best_drop);
      const owns = await db.get('SELECT 1 AS x FROM items WHERE user_id = $1 AND item_key = $2 LIMIT 1', [req.user.id, key]);
      if (!owns && !(best && best.key === key)) {
        throw new HttpError(403, 'not_owned', 'Аватаркою може бути лише скін, який у тебе є або був найкращим дропом');
      }
    } else throw bad('Некоректний аватар');
    await db.run('UPDATE users SET avatar = $1 WHERE id = $2', [a, req.user.id]);
    res.json({ avatar: avatarView(await getUser(req.user.id)) });
  }));

  r.get('/history', guard, ah(async (req, res) => {
    const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isSafeInteger(before) || before < 1) throw bad('Некоректний курсор');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw bad('Некоректний ліміт');
    const rows = await db.all('SELECT id, kind, data, created_at FROM history WHERE user_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3',
      [req.user.id, before, limit + 1]);
    const more = rows.length > limit;
    const entries = rows.slice(0, limit)
      .map((x) => ({ id: x.id, kind: x.kind, at: x.created_at, data: safeParse(x.data) }))
      .filter((e) => e.data);
    res.json({ entries, next: more ? rows[limit - 1].id : null });
  }));

  return r;
}

module.exports = { createProfile };
