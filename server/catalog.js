'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TIERS = ['mil', 'res', 'cls', 'cov', 'rare'];
// Drop odds in basis points (sum = 10000), same as the real game.
const ODDS_BP = { mil: 7992, res: 1598, cls: 320, cov: 64, rare: 26 };
const BASE = { mil: 12, res: 55, cls: 240, cov: 1100, rare: 9000 };
const WEAR = [
  { k: 'FN', lo: 0, hi: 0.07, p: 3, m: 1.6 },
  { k: 'MW', lo: 0.07, hi: 0.15, p: 24, m: 1.25 },
  { k: 'FT', lo: 0.15, hi: 0.38, p: 33, m: 1 },
  { k: 'WW', lo: 0.38, hi: 0.45, p: 24, m: 0.8 },
  { k: 'BS', lo: 0.45, hi: 1, p: 16, m: 0.65 },
];
const FT = WEAR[2];
const ST_MULT = 1.8;
const ST_CHANCE_1_IN = 10;
const CASE_MARGIN = 1.3; // case price = 1.3 x expected value, so the economy always drains a little

const SOURCES = [
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json',
  'https://bymykel.github.io/CSGO-API/api/en/crates.json',
];
// Only these hosts may appear as image URLs (also matches the CSP). Anything else is dropped.
const IMG_HOSTS = ['raw.githubusercontent.com', 'steamstatic.com', 'akamaihd.net'];

const randInt = (n) => crypto.randomInt(n); // CSPRNG, never Math.random for game outcomes

function hv(s) {
  let x = 0;
  for (const ch of s) x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return 0.6 + (x % 1000) / 1000;
}
const itemPrice = (it, wear, st) =>
  Math.max(1, Math.round(BASE[it.tier] * hv(it.name) * wear.m * (st ? ST_MULT : 1)));
const targetPrice = (it) => itemPrice(it, FT, false);

function tierOf(rarityName) {
  const r = String(rarityName || '').toLowerCase();
  if (r.includes('mil-spec') || r.includes('industrial') || r.includes('consumer')) return 'mil';
  if (r.includes('restricted')) return 'res';
  if (r.includes('classified')) return 'cls';
  if (r.includes('covert')) return 'cov';
  return null;
}

function safeImage(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    return IMG_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h)) ? x.href : null;
  } catch {
    return null;
  }
}

function buildCatalog(crates) {
  const cases = new Map();
  const items = new Map();
  const avgWear = WEAR.reduce((a, w) => a + (w.p * w.m) / 100, 0);
  const stFactor = 1 + (ST_MULT - 1) / ST_CHANCE_1_IN;

  for (const c of Array.isArray(crates) ? crates : []) {
    if (!c || c.type !== 'Case' || typeof c.id !== 'string' || typeof c.name !== 'string') continue;
    const image = safeImage(c.image);
    if (!image) continue;
    const list = [];
    const seen = new Set();
    const add = (it, forced) => {
      if (!it || typeof it.name !== 'string') return;
      const tier = forced || tierOf(it.rarity && it.rarity.name);
      const img = safeImage(it.image);
      const key = String(it.id || it.name).slice(0, 100);
      if (!tier || !img || seen.has(key)) return;
      seen.add(key);
      list.push({ key, name: it.name.slice(0, 120), image: img, tier });
    };
    (c.contains || []).forEach((i) => add(i));
    (c.contains_rare || []).forEach((i) => add(i, 'rare'));

    const byTier = {};
    for (const it of list) (byTier[it.tier] ||= []).push(it);
    const tiers = TIERS.filter((t) => byTier[t]);
    if (!byTier.mil || tiers.length < 2) continue;

    const total = tiers.reduce((a, t) => a + ODDS_BP[t], 0);
    let ev = 0;
    for (const t of tiers) {
      const mean = byTier[t].reduce((a, it) => a + BASE[t] * hv(it.name), 0) / byTier[t].length;
      ev += (ODDS_BP[t] / total) * mean;
    }
    ev *= avgWear * stFactor;
    const price = Math.max(40, Math.round((ev * CASE_MARGIN) / 5) * 5);
    const odds = {};
    for (const t of tiers) odds[t] = Math.round((ODDS_BP[t] / total) * 10000) / 100;

    cases.set(c.id, {
      id: c.id, name: c.name.slice(0, 120), image, price, items: list, byTier, tiers, odds,
      firstSale: Date.parse(c.first_sale_date) || 0,
    });
    for (const it of list) if (!items.has(it.key)) items.set(it.key, { ...it, price: targetPrice(it) });
  }

  const list = [...cases.values()].sort((a, b) => b.firstSale - a.firstSale);
  const summaries = list.map(({ id, name, image, price }) => ({ id, name, image, price }));
  const targets = [...items.values()].sort((a, b) => a.price - b.price);
  return { cases, items, list, summaries, targets };
}

function makeInstance(item, wear) {
  if (!wear) {
    let r = randInt(100);
    wear = WEAR.find((w) => (r -= w.p) < 0) || FT;
  }
  const st = !/gloves|wraps/i.test(item.name) && randInt(ST_CHANCE_1_IN) === 0;
  const wf = +(wear.lo + (randInt(1000000) / 1000000) * (wear.hi - wear.lo)).toFixed(4);
  return {
    key: item.key, name: item.name, image: item.image, tier: item.tier,
    wear: wear.k, float: wf, stattrak: st, price: itemPrice(item, wear, st),
  };
}

function rollDrop(c) {
  let r = randInt(c.tiers.reduce((a, t) => a + ODDS_BP[t], 0));
  let tier = c.tiers[c.tiers.length - 1];
  for (const t of c.tiers) {
    if (r < ODDS_BP[t]) { tier = t; break; }
    r -= ODDS_BP[t];
  }
  const pool = c.byTier[tier];
  return makeInstance(pool[randInt(pool.length)]);
}

async function loadCatalog({ cacheFile, log = console } = {}) {
  let data = null;
  for (const url of SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      if (cacheFile) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(data));
        fs.renameSync(cacheFile + '.tmp', cacheFile);
      }
      break;
    } catch (e) {
      log.warn('catalog source failed:', url, e.message);
    }
  }
  if (!data && cacheFile && fs.existsSync(cacheFile)) {
    log.warn('using cached catalog');
    data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  if (!data) throw new Error('Cannot load the CS2 catalog and there is no cache');
  const cat = buildCatalog(data);
  if (!cat.cases.size) throw new Error('Catalog is empty after validation');
  return cat;
}

module.exports = { buildCatalog, loadCatalog, rollDrop, makeInstance, targetPrice, itemPrice, randInt, WEAR, FT, TIERS };
