'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, ah, bodyOf, readCookie } = require('./util');

const DAY = 24 * 3600 * 1000;
const SESSION_TTL = 30 * DAY;
const MAX_SESSIONS = 10;
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'moderator', 'mod', 'system', 'buffgrade', 'staff', 'owner']);
const COMMON = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', '11111111', 'iloveyou', 'abc12345', 'admin123', 'letmein1']);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (pw) => pw.normalize('NFKC');
const bad = (m) => new HttpError(400, 'invalid_input', m);

const scryptAsync = (pw, salt, len, N, r, p) =>
  new Promise((res, rej) =>
    crypto.scrypt(pw, salt, len, { N, r, p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

// Format: scrypt$N$r$p$salt$hash. Parameters live in the hash, so they can be raised later without breaking old users.
async function hashPassword(pw, N) {
  const salt = crypto.randomBytes(16);
  const k = await scryptAsync(norm(pw), salt, 64, N, 8, 1);
  return ['scrypt', N, 8, 1, salt.toString('base64'), k.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  const [alg, N, r, p, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const k = await scryptAsync(norm(pw), Buffer.from(s, 'base64'), expected.length, +N, +r, +p);
  return crypto.timingSafeEqual(k, expected);
}

function validUsername(v) {
  if (typeof v !== 'string') throw bad('Вкажи нік');
  const u = v.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw bad('Нік: 3–20 символів, лише латиниця, цифри та _');
  if (RESERVED.has(u.toLowerCase())) throw bad('Цей нік зарезервований');
  return u;
}
function validPassword(v, username) {
  if (typeof v !== 'string' || v.length < 8) throw bad('Пароль має містити щонайменше 8 символів');
  if (v.length > 128) throw bad('Пароль задовгий (максимум 128 символів)');
  const l = v.toLowerCase();
  if (COMMON.has(l) || l === username.toLowerCase()) throw bad('Цей пароль надто простий');
  return v;
}

function createAuth({ db, cfg, limiters }) {
  const COOKIE = cfg.isProd ? '__Host-bg_sid' : 'bg_sid';
  const cookieOpts = { httpOnly: true, secure: cfg.isProd, sameSite: 'lax', path: '/' };

  const q = {
    session: db.prepare(`SELECT s.id sid, s.expires_at exp, u.id, u.username, u.balance, u.daily_at
                         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`),
    delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    insSession: db.prepare('INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES(?,?,?,?)'),
    capSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id NOT IN
                             (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_SESSIONS})`),
    userByName: db.prepare('SELECT id, pass_hash FROM users WHERE username = ?'),
    insUser: db.prepare('INSERT INTO users(username, pass_hash, balance, created_at) VALUES(?,?,?,?)'),
    ledger: db.prepare('INSERT INTO ledger(user_id, kind, delta, balance_after, meta, created_at) VALUES(?,?,?,?,?,?)'),
    fresh: db.prepare('SELECT username, balance, daily_at FROM users WHERE id = ?'),
  };

  const userView = (row) => ({
    username: row.username,
    balance: row.balance,
    dailyInMs: Math.max(0, row.daily_at + DAY - Date.now()),
  });

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url'); // 256 bits; only its hash is stored
    const now = Date.now();
    q.insSession.run(sha256(token), userId, now, now + SESSION_TTL);
    q.capSessions.run(userId, userId);
    res.cookie(COOKIE, token, { ...cookieOpts, maxAge: SESSION_TTL });
  }

  const loadUser = (req, res, next) => {
    req.user = null;
    const t = readCookie(req, COOKIE);
    if (t && /^[A-Za-z0-9_-]{43}$/.test(t)) {
      const row = q.session.get(sha256(t));
      if (row) {
        if (row.exp > Date.now()) { req.user = row; req.sid = row.sid; } else q.delSession.run(row.sid);
      }
    }
    next();
  };
  const requireAuth = (req, res, next) =>
    req.user ? next() : next(new HttpError(401, 'unauthorized', 'Увійди в акаунт'));

  // Hash against which unknown usernames are checked, so login time doesn't reveal if a nick exists.
  let dummyHash;
  const getDummy = async () => (dummyHash ||= await hashPassword('dummy-password', cfg.scryptN));

  const router = express.Router();

  router.post('/register', limiters.register, ah(async (req, res) => {
    const b = bodyOf(req);
    const username = validUsername(b.username);
    const password = validPassword(b.password, username);
    const hash = await hashPassword(password, cfg.scryptN);
    const now = Date.now();
    let id;
    try {
      id = db.transaction(() => {
        const r = q.insUser.run(username, hash, cfg.startBalance, now);
        q.ledger.run(r.lastInsertRowid, 'signup', cfg.startBalance, cfg.startBalance, null, now);
        return r.lastInsertRowid;
      })();
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'username_taken', 'Цей нік уже зайнятий');
      throw e;
    }
    startSession(res, id);
    res.status(201).json({ user: userView(q.fresh.get(id)) });
  }));

  router.post('/login', limiters.loginIp, limiters.login, ah(async (req, res) => {
    const b = bodyOf(req);
    const username = typeof b.username === 'string' ? b.username.trim().slice(0, 64) : '';
    const password = typeof b.password === 'string' && b.password.length <= 128 ? b.password : '';
    const row = q.userByName.get(username);
    const ok = await verifyPassword(password, row ? row.pass_hash : await getDummy());
    if (!row || !ok) throw new HttpError(401, 'bad_credentials', 'Невірний нік або пароль');
    startSession(res, row.id);
    res.json({ user: userView(q.fresh.get(row.id)) });
  }));

  router.post('/logout', (req, res) => {
    if (req.sid) q.delSession.run(req.sid);
    res.clearCookie(COOKIE, cookieOpts);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => res.json({ user: req.user ? userView(req.user) : null }));

  router.post('/password', requireAuth, limiters.password, ah(async (req, res) => {
    const b = bodyOf(req);
    const current = typeof b.current === 'string' ? b.current.slice(0, 128) : '';
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(current, row.pass_hash))) throw new HttpError(401, 'bad_credentials', 'Поточний пароль невірний');
    const next = validPassword(b.newPassword, req.user.username);
    const hash = await hashPassword(next, cfg.scryptN);
    db.transaction(() => {
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, req.user.id);
      q.delUserSessions.run(req.user.id); // every other device is logged out
    })();
    startSession(res, req.user.id);
    res.json({ ok: true });
  }));

  const cleanup = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { router, loadUser, requireAuth, cleanup };
}

module.exports = { createAuth, hashPassword, verifyPassword, DAY };
