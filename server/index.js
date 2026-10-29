'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { openDb } = require('./db');
const { loadCatalog } = require('./catalog');
const { createAuth, hashPassword } = require('./auth');
const { createGame } = require('./game');
const { HttpError, bodyOf } = require('./util');

function loadConfig(env = process.env) {
  const tp = env.TRUST_PROXY;
  return {
    port: Number(env.PORT) || 3000,
    isProd: env.NODE_ENV === 'production',
    trustProxy: tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : false, // set to 1 behind one reverse proxy, otherwise IP limits see the proxy
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'buffgrade.db'),
    cacheFile: env.CATALOG_CACHE || path.join(__dirname, '..', 'data', 'crates.json'),
    scryptN: Number(env.SCRYPT_N) || 65536,
    startBalance: 1000,
    dailyBonus: 500,
    limits: {
      api: { windowMs: 60e3, limit: 300 },          // per IP, every /api request
      login: { windowMs: 15 * 60e3, limit: 8 },     // per IP + username, failed attempts only
      loginIp: { windowMs: 15 * 60e3, limit: 40 },  // per IP, failed attempts only
      register: { windowMs: 60 * 60e3, limit: 10 }, // per IP
      password: { windowMs: 15 * 60e3, limit: 10 }, // per user
      game: { windowMs: 60e3, limit: 120 },         // per user
    },
  };
}

function makeLimiters(cfg) {
  const mk = (o, extra) => rateLimit({
    ...o, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited', message: 'Забагато запитів, зачекай трохи' }),
    ...extra,
  });
  const L = cfg.limits;
  const ip = (req) => ipKeyGenerator(req.ip);
  return {
    api: mk(L.api),
    login: mk(L.login, { skipSuccessfulRequests: true, keyGenerator: (req) => ip(req) + '|' + String(bodyOf(req).username || '').toLowerCase().slice(0, 64) }),
    loginIp: mk(L.loginIp, { skipSuccessfulRequests: true }),
    register: mk(L.register),
    password: mk(L.password, { keyGenerator: (req) => 'u' + (req.user ? req.user.id : ip(req)) }),
    game: mk(L.game, { keyGenerator: (req) => 'u' + (req.user ? req.user.id : ip(req)) }),
  };
}

// CSRF defence in depth (the session cookie is SameSite=Lax as well):
// state-changing requests must be JSON and must come from our own origin.
function csrfGuard(cfg) {
  const safe = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, res, next) => {
    if (safe.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let ok = false;
      if (cfg.allowedOrigins.length) ok = cfg.allowedOrigins.includes(origin);
      else { try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; } }
      if (!ok) return next(new HttpError(403, 'bad_origin', 'Запит з чужого джерела заблоковано'));
    }
    const site = req.get('sec-fetch-site');
    if (site && !['same-origin', 'none'].includes(site) && !origin) return next(new HttpError(403, 'bad_origin', 'Запит з чужого джерела заблоковано'));
    if (!/^application\/json(\s*;|$)/i.test(req.get('content-type') || '')) return next(new HttpError(415, 'json_required', 'Потрібен Content-Type: application/json'));
    next();
  };
}

async function createApp({ db, catalog, config: cfg }) {
  const limiters = makeLimiters(cfg);
  const auth = createAuth({ db, cfg, limiters });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://raw.githubusercontent.com', 'https://*.steamstatic.com', 'https://*.akamaihd.net'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(cfg.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', dotfiles: 'ignore' }));

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', limiters.api);
  app.use('/api', express.json({ limit: '10kb', strict: true }));
  app.use('/api', csrfGuard(cfg));
  app.use('/api', auth.loadUser);
  app.use('/api/auth', auth.router);
  app.use('/api', createGame({ db, catalog, cfg, limiters, requireAuth: auth.requireAuth }));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', 'Не знайдено')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Запит завеликий' });
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'bad_json', message: 'Некоректний JSON' });
    console.error('[error]', req.method, req.path, err); // details stay in the log, never in the response
    res.status(500).json({ error: 'server_error', message: 'Внутрішня помилка сервера' });
  });

  app.locals.cleanup = auth.cleanup;
  return app;
}

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const catalog = await loadCatalog({ cacheFile: cfg.cacheFile });
  console.log(`catalog: ${catalog.cases.size} cases, ${catalog.items.size} items`);
  const app = await createApp({ db, catalog, config: cfg });
  const timer = setInterval(app.locals.cleanup, 3600e3);
  timer.unref();
  const server = app.listen(cfg.port, () => console.log(`BuffGrade on http://localhost:${cfg.port}`));
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createApp, loadConfig, hashPassword };
