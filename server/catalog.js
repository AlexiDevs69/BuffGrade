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
const MARKET_MARKUP = 1.2; // market buy price = value x 1.2 (rounded UP), selling pays the plain value
const CASE_MARGIN = 1.3; // case price = 1.3 x expected value, so the economy always drains a little

// The API has no release date for terminals; Dead Hand came out on 2026-03-11 (confirmed by several sources).
const RELEASE_OVERRIDES = new Map([['dead hand terminal', Date.parse('2026-03-11')]]);
// Terminals arrive with `type: null`, as do gift packages, so they are recognised by name, never by "type is empty".
const isTerminal = (c) => c && c.type == null && typeof c.name === 'string' && /\bTerminal$/i.test(c.name.trim());

const SOURCES = [
  'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json',
  'https://bymykel.github.io/CSGO-API/api/en/crates.json',
];
// Only these hosts may appear as image URLs (also matches the CSP). Anything else is dropped.
const IMG_HOSTS = ['raw.githubusercontent.com', 'steamstatic.com', 'akamaihd.net'];
const HOST_RE = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
// Extra hosts (EXTRA_IMG_HOSTS) let the admin use images from e.g. imgur; the same list is added to the CSP in index.js.
function allowImageHosts(list) {
  for (const h of list || []) {
    const x = String(h).trim().toLowerCase();
    if (!HOST_RE.test(x)) throw new Error('Bad image host: ' + h);
    if (!IMG_HOSTS.includes(x)) IMG_HOSTS.push(x);
  }
}

const CATEGORIES = [
  { id: 'rifle', name: 'Гвинтівки' }, { id: 'sniper', name: 'Снайперські гвинтівки' }, { id: 'pistol', name: 'Пістолети' },
  { id: 'smg', name: 'Пістолети-кулемети' }, { id: 'heavy', name: 'Важка зброя' }, { id: 'knife', name: 'Ножі' },
  { id: 'gloves', name: 'Рукавички' }, { id: 'other', name: 'Інше' },
];
const WEAPON_CAT = new Map();
for (const [cat, list] of Object.entries({
  rifle: ['AK-47', 'M4A4', 'M4A1-S', 'Galil AR', 'FAMAS', 'SG 553', 'AUG'],
  sniper: ['AWP', 'SSG 08', 'SCAR-20', 'G3SG1'],
  pistol: ['Glock-18', 'USP-S', 'P2000', 'P250', 'Five-SeveN', 'Tec-9', 'CZ75-Auto', 'Desert Eagle', 'R8 Revolver', 'Dual Berettas'],
  smg: ['MP9', 'MAC-10', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon'],
  heavy: ['Nova', 'XM1014', 'MAG-7', 'Sawed-Off', 'M249', 'Negev'],
})) for (const w of list) WEAPON_CAT.set(w.toLowerCase(), cat);
function categoryOf(name) {
  if (/gloves|wraps/i.test(name)) return 'gloves';
  if (name.startsWith('★')) return 'knife';
  return WEAPON_CAT.get(name.split(' | ')[0].replace(/^StatTrak™\s*/, '').toLowerCase()) || 'other';
}
const canStatTrak = (name) => !/gloves|wraps/i.test(name);

const randInt = (n) => crypto.randomInt(n); // CSPRNG, never Math.random for game outcomes

function hv(s) {
  let x = 0;
  for (const ch of s) x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return 0.6 + (x % 1000) / 1000;
}
// Custom (admin-made) items carry `fixed`, the price of the Field-Tested non-StatTrak version; catalog items use the formula.
const itemPrice = (it, wear, st) =>
  Math.max(1, Math.round((it.fixed != null ? it.fixed : BASE[it.tier] * hv(it.name)) * wear.m * (st ? ST_MULT : 1)));
const wearForFloat = (f) => WEAR.find((w) => f < w.hi) || WEAR[WEAR.length - 1];
const targetPrice = (it) => itemPrice(it, FT, false);
const marketPrice = (it, wear, st) => Math.ceil(itemPrice(it, wear, st) * MARKET_MARKUP); // ceil: buying is always dearer than selling back

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
    const terminal = isTerminal(c);
    if (!c || (c.type !== 'Case' && !terminal) || typeof c.id !== 'string' || typeof c.name !== 'string') continue;
    const name = c.name.replace(/^Sealed\s+/i, '').slice(0, 120);
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
      id: c.id, name, kind: terminal ? 'terminal' : 'case', image, price, items: list, byTier, tiers, odds,
      firstSale: Date.parse(c.first_sale_date) || RELEASE_OVERRIDES.get(name.toLowerCase()) || 0,
    });
    for (const it of list) {
      let e = items.get(it.key);
      if (!e) {
        e = { ...it, price: targetPrice(it), category: categoryOf(it.name), canST: canStatTrak(it.name), lname: it.name.toLowerCase(), caseIds: new Set() };
        items.set(it.key, e);
      }
      e.caseIds.add(c.id);
    }
  }

  const targets = [...items.values()].sort((a, b) => a.price - b.price);
  const cat = { cases, items, itemList: [...items.values()], list: [], summaries: [], targets, customItems: new Map() };
  refreshLists(cat);
  return cat;
}

// Admin-made cases come first (newest first). Then terminals, the newest container format; inside each group the newest release leads.
function refreshLists(cat) {
  cat.list = [...cat.cases.values()].sort((a, b) =>
    (!!b.custom - !!a.custom) || (a.custom ? b.createdAt - a.createdAt : 0) ||
    (b.kind === 'terminal') - (a.kind === 'terminal') || b.firstSale - a.firstSale || (a.name < b.name ? -1 : 1));
  cat.summaries = cat.list.map(({ id, name, kind, image, price }) => ({ id, name, kind, image, price }));
}

/* ---------- admin-made content (persisted by server/admin.js) ---------- */
const pct = (x) => Math.round(x * 10000) / 100;

function addCustomItem(cat, d) {
  const it = { key: d.key, name: d.name, image: d.image, tier: d.tier, fixed: d.price, canST: !!d.canST, lname: d.name.toLowerCase(), custom: true };
  cat.customItems.set(it.key, it);
  return it;
}
function removeCustomItem(cat, key) { return cat.customItems.delete(key); }

// d.items: self-contained snapshots {key, name, image, tier, fixed?, canST, w}, so deleting a custom item never breaks a case.
function addCustomCase(cat, d) {
  const total = d.items.reduce((a, i) => a + i.w, 0);
  const pool = d.items.map((i) => ({
    item: { key: i.key, name: i.name, image: i.image, tier: i.tier, canST: !!i.canST, ...(i.fixed != null ? { fixed: i.fixed } : {}) },
    w: i.w,
  }));
  const byTier = {}, odds = {};
  for (const p of pool) (byTier[p.item.tier] ||= []).push(p.item);
  const tiers = TIERS.filter((t) => byTier[t]);
  for (const t of tiers) odds[t] = pct(pool.filter((p) => p.item.tier === t).reduce((a, p) => a + p.w, 0) / total);
  const c = {
    id: d.id, name: d.name, kind: 'case', image: d.image, price: d.price, custom: true, createdAt: d.createdAt, firstSale: 0,
    items: pool.map((p) => ({ key: p.item.key, name: p.item.name, image: p.item.image, tier: p.item.tier, chance: pct(p.w / total) })),
    byTier, tiers, odds, pool, poolTotal: total,
  };
  cat.cases.set(c.id, c);
  for (const p of pool) { const e = cat.items.get(p.item.key); if (e) e.caseIds.add(c.id); } // so the market's "case" filter works
  refreshLists(cat);
  return c;
}
function removeCustomCase(cat, id) {
  const c = cat.cases.get(id);
  if (!c || !c.custom) return false;
  cat.cases.delete(id);
  for (const e of cat.items.values()) e.caseIds.delete(id);
  refreshLists(cat);
  return true;
}

function makeInstance(item, wear, forceSt) {
  if (!wear) {
    let r = randInt(100);
    wear = WEAR.find((w) => (r -= w.p) < 0) || FT;
  }
  const canST = item.canST !== undefined ? item.canST : canStatTrak(item.name);
  const st = forceSt !== undefined ? forceSt : canST && randInt(ST_CHANCE_1_IN) === 0;
  const wf = +(wear.lo + (randInt(1000000) / 1000000) * (wear.hi - wear.lo)).toFixed(4);
  return {
    key: item.key, name: item.name, image: item.image, tier: item.tier,
    wear: wear.k, float: wf, stattrak: st, price: itemPrice(item, wear, st),
  };
}

function rollDrop(c) {
  if (c.pool) { // admin-made case: per-item weights, still CSPRNG
    let w = randInt(c.poolTotal);
    for (const p of c.pool) { if (w < p.w) return makeInstance(p.item); w -= p.w; }
    return makeInstance(c.pool[c.pool.length - 1].item);
  }
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

const imageHosts = () => [...IMG_HOSTS];

module.exports = {
  buildCatalog, loadCatalog, rollDrop, makeInstance, targetPrice, itemPrice, marketPrice, categoryOf, randInt, WEAR, FT, TIERS, CATEGORIES, MARKET_MARKUP,
  safeImage, allowImageHosts, imageHosts, wearForFloat, addCustomItem, removeCustomItem, addCustomCase, removeCustomCase, refreshLists,
};
