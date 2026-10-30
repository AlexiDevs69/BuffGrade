'use strict';
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString('uk-UA');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quickMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
const COLORS = { mil: '#4b69ff', res: '#8847ff', cls: '#d32ce6', cov: '#eb4b4b', rare: '#ffd24a' };
const TN = { mil: 'Армійське', res: 'Обмежене', cls: 'Засекречене', cov: 'Таємне', rare: 'Рідкісне' };
const DAY = 86400000;
const state = { me: null, inv: [], cases: [], details: new Map(), dailyAt: 0, busy: false, cur: null };

class ApiError extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data; }
}
async function api(path, method = 'GET', body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
  let r;
  try { r = await fetch('/api' + path, opt); } catch { throw new ApiError(0, 'network', 'Немає зв’язку із сервером'); }
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    if (r.status === 401 && state.me && !path.startsWith('/auth/')) { setMe(null); toast('Сесію завершено, увійди знову'); }
    throw new ApiError(r.status, j && j.error, (j && j.message) || 'Помилка сервера', j);
  }
  return j;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- account ---------- */
function setMe(u) {
  state.me = u;
  if (u) { state.dailyAt = Date.now() + u.dailyInMs; $('#bal').textContent = fmt(u.balance); $('#who').textContent = u.username; }
  else { state.inv = []; }
  $('#wallet').hidden = !u; $('#who').hidden = !u; $('#login').hidden = !!u; $('#logout').hidden = !u;
  $('#adminlink').hidden = !(u && u.admin); // only a hint: the server still checks every /api/admin call
  dailyState();
}
function setBal(b) { if (state.me) { state.me.balance = b; $('#bal').textContent = fmt(b); } }
function requireLogin() {
  if (state.me) return true;
  toast('Спершу увійди в акаунт'); openAuth('login'); return false;
}
function dailyState() {
  const btn = $('#daily'), left = state.dailyAt - Date.now();
  if (state.me && left > 0) { btn.disabled = true; btn.textContent = 'Бонус буде через ' + Math.ceil(left / 3600000) + ' год'; }
  else { btn.disabled = false; btn.textContent = 'Забрати щоденний бонус'; }
}
$('#daily').addEventListener('click', async () => {
  if (!requireLogin()) return;
  try {
    const r = await api('/daily', 'POST');
    setBal(r.balance); state.dailyAt = Date.now() + DAY; dailyState(); toast('+' + fmt(r.bonus) + ' монет на баланс');
  } catch (e) {
    if (e.code === 'daily_cooldown') { state.dailyAt = Date.now() + e.data.retryInMs; dailyState(); }
    toast(e.message);
  }
});

let authMode = 'login';
function renderAuth() {
  const login = authMode === 'login';
  $('#a-title').textContent = login ? 'Вхід' : 'Реєстрація';
  $('#a-submit').textContent = login ? 'Увійти' : 'Створити акаунт';
  $('#a-switch').textContent = login ? 'Немає акаунта? Зареєструватися' : 'Уже є акаунт? Увійти';
  $('#a-pass').autocomplete = login ? 'current-password' : 'new-password';
  $('#a-err').textContent = '';
}
function openAuth(mode) {
  authMode = mode || 'login'; renderAuth();
  if (!$('#auth').open) $('#auth').showModal();
  $('#a-user').focus();
}
$('#login').addEventListener('click', () => openAuth('login'));
$('#a-close').addEventListener('click', () => $('#auth').close());
$('#a-switch').addEventListener('click', () => { authMode = authMode === 'login' ? 'register' : 'login'; renderAuth(); });
$('#a-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#a-submit'); btn.disabled = true; $('#a-err').textContent = '';
  try {
    const r = await api('/auth/' + authMode, 'POST', { username: $('#a-user').value.trim(), password: $('#a-pass').value });
    $('#a-pass').value = ''; $('#auth').close();
    setMe(r.user); await loadInv(); refreshView();
    toast('Вітаємо, ' + r.user.username + '!');
  } catch (err) { $('#a-err').textContent = err.message; }
  finally { btn.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/auth/logout', 'POST'); } catch { /* cookie is cleared server-side anyway */ }
  setMe(null); show('home'); toast('Ти вийшов з акаунта');
});

/* ---------- rendering helpers ---------- */
function cell(it) {
  const d = document.createElement('div'); d.className = 'item'; d.style.setProperty('--c', COLORS[it.tier]);
  if (it.image) { const im = document.createElement('img'); im.src = it.image; im.alt = ''; im.loading = 'lazy'; d.append(im); }
  const s = document.createElement('span'); s.textContent = it.name; d.append(s);
  if (it.chance !== undefined) d.title = it.name + ' — шанс ' + it.chance + '%';
  return d;
}
function icard(it, extra, sub) {
  const d = document.createElement('div'); d.className = 'icard ' + (extra || ''); d.style.setProperty('--c', COLORS[it.tier]);
  const im = document.createElement('img'); im.alt = ''; im.src = it.image;
  const b = document.createElement('b'); b.textContent = it.name;
  const s = document.createElement('span');
  s.textContent = sub ?? (it.wear + ', ' + Number(it.float).toFixed(4) + (it.stattrak ? ', StatTrak' : ''));
  const p = document.createElement('div'); p.className = 'price';
  const coin = document.createElement('span'); coin.className = 'coin';
  const v = document.createElement('span'); v.textContent = fmt(it.price);
  p.append(coin, v); d.append(im, b, s, p);
  return d;
}
function weightedItems(d, n) {
  const cnt = {}; d.items.forEach((i) => { cnt[i.tier] = (cnt[i.tier] || 0) + 1; });
  const w = d.items.map((i) => d.odds[i.tier] / cnt[i.tier]), tot = w.reduce((a, b) => a + b, 0);
  return Array.from({ length: n }, () => {
    let r = Math.random() * tot;
    for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return d.items[i];
    return d.items[0];
  });
}
// The server has already decided the result; this only animates the reel so that it lands on index W.
async function runReel(track, items, W, ms) {
  track.style.transition = 'none'; track.style.transform = 'translateX(0)';
  track.replaceChildren(...items.map(cell));
  const c = track.children[W], box = track.parentElement.clientWidth; void track.offsetWidth;
  const target = c.offsetLeft + c.offsetWidth / 2 + (Math.random() - 0.5) * c.offsetWidth * 0.7 - box / 2;
  const quick = quickMotion();
  track.style.transition = quick ? 'none' : 'transform ' + ms + 'ms cubic-bezier(.08,.6,.12,1)';
  track.style.transform = 'translateX(' + (-target) + 'px)';
  await sleep(quick ? 0 : ms + 100);
  c.classList.add('win');
}
async function getDetail(id) {
  if (!state.details.has(id)) state.details.set(id, await api('/cases/' + encodeURIComponent(id)));
  return state.details.get(id);
}

/* ---------- navigation ---------- */
let view = 'home';
function show(v) {
  if ((v === 'prof' || v === 'up') && !requireLogin()) return;
  view = v;
  ['home', 'case', 'market', 'prof', 'up'].forEach((x) => { $('#v-' + x).hidden = x !== v; });
  document.querySelectorAll('nav [data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === v || (v === 'case' && b.dataset.go === 'home')));
  if (v === 'prof') renderProfile();
  if (v === 'market') renderMarket();
  if (v === 'up') openUp();
  scrollTo(0, 0);
}
function refreshView() { if (view === 'prof') renderProfile(); if (view === 'up') renderUp(); }
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]'); if (g) { show(g.dataset.go); return; }
  const b = e.target.closest('[data-soon]'); if (b) toast('«' + b.dataset.soon + '» з’явиться на одному з наступних етапів');
});

/* ---------- home ---------- */
async function loadCases() {
  const g = $('#cases-grid');
  try {
    state.cases = (await api('/cases')).cases;
    g.replaceChildren();
    state.cases.forEach((c) => {
      const el = document.createElement('button'); el.className = 'case';
      const art = document.createElement('div'); art.className = 'art';
      const im = document.createElement('img'); im.src = c.image; im.alt = ''; im.loading = 'lazy'; art.append(im);
      const h = document.createElement('h3'); h.textContent = c.name;
      if (c.kind === 'terminal') { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = 'Термінал'; el.append(tg); }
      const p = document.createElement('div'); p.className = 'price';
      const coin = document.createElement('span'); coin.className = 'coin';
      const v = document.createElement('span'); v.textContent = fmt(c.price);
      p.append(coin, v); el.append(art, h, p);
      el.addEventListener('click', () => openCase(c));
      g.append(el);
    });
    $('#casesNote').textContent = 'Кейси CS2, ціни у віртуальній валюті';
    heroSpin();
  } catch (e) {
    g.replaceChildren(); $('#casesNote').textContent = e.message;
    $('#drop').textContent = 'Не вдалося завантажити кейси.';
  }
}
let heroBusy = false;
async function heroSpin() {
  if (heroBusy || !state.cases.length) return;
  heroBusy = true; $('#respin').disabled = true; $('#drop').textContent = 'Крутимо демо…';
  try {
    const d = await getDetail(state.cases[Math.floor(Math.random() * Math.min(5, state.cases.length))].id);
    const items = weightedItems(d, 46);
    await runReel($('#track'), items, 38, 6000);
    $('#drop').textContent = 'У демо випало: ' + items[38].name;
  } catch (e) { $('#drop').textContent = e.message; }
  heroBusy = false; $('#respin').disabled = false;
}
$('#respin').addEventListener('click', heroSpin);

/* ---------- case page ---------- */
async function openCase(c) {
  if (state.busy) { toast('Зачекай, кейс ще відкривається'); return; }
  try {
    const d = await getDetail(c.id);
    state.cur = d; show('case');
    $('#cname').textContent = d.name; $('#cres').replaceChildren();
    const im = new Image(); im.src = d.image; im.alt = ''; $('#cimg').replaceChildren(im);
    const coin = document.createElement('span'); coin.className = 'coin';
    $('#cprice').replaceChildren(coin, ' ' + fmt(d.price));
    idleReel(d); paintCtl();
    const box = $('#cpool'); box.replaceChildren();
    ['mil', 'res', 'cls', 'cov', 'rare'].forEach((t) => {
      const l = d.items.filter((i) => i.tier === t); if (!l.length) return;
      const h = document.createElement('h3'); h.className = 'sub'; h.style.color = COLORS[t]; h.textContent = TN[t] + ', шанс ' + d.odds[t] + '%';
      const g = document.createElement('div'); g.className = 'igrid'; g.append(...l.map(cell)); box.append(h, g);
    });
  } catch (e) { toast(e.message); }
}
const pref = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let openN = 1, speed = pref.get('bg_speed', 'normal');
if (!['normal', 'fast', 'instant'].includes(speed)) speed = 'normal';
function paintCtl() {
  document.querySelectorAll('#cnt button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === openN));
  document.querySelectorAll('#spd button').forEach((b) => b.classList.toggle('on', b.dataset.s === speed));
  const d = state.cur;
  if (d) $('#copen').textContent = 'Відкрити' + (openN > 1 ? ' ×' + openN : '') + ' за ' + fmt(d.price * openN);
}
$('#cnt').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || state.busy) return; openN = Number(b.dataset.n); paintCtl(); });
$('#spd').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; speed = b.dataset.s; pref.set('bg_speed', speed); paintCtl(); });
function makeReel() {
  const r = document.createElement('div'); r.className = 'reel';
  const p = document.createElement('div'); p.className = 'pointer';
  const t = document.createElement('div'); t.className = 'track'; r.append(p, t); return r;
}
function idleReel(d) {
  const r = makeReel(); r.querySelector('.track').replaceChildren(...d.items.slice(0, 12).map(cell));
  $('#creels').className = 'reels'; $('#creels').replaceChildren(r);
}
async function openNow() {
  const d = state.cur; if (state.busy || !d || !requireLogin()) return;
  const n = openN;
  if (state.me.balance < d.price * n) { toast('Не вистачає монет на ' + n + ' шт.'); return; }
  state.busy = true; $('#copen').disabled = true; $('#cres').replaceChildren();
  try {
    const r = await api('/cases/' + encodeURIComponent(d.id) + '/open', 'POST', { count: n });
    setBal(r.balance);
    if (speed === 'instant' || quickMotion()) idleReel(d);
    else {
      const box = $('#creels'); box.className = 'reels' + (n > 1 ? ' multi' : '');
      const reels = r.items.map(() => makeReel()); box.replaceChildren(...reels);
      await Promise.all(r.items.map((it, i) => {
        const items = weightedItems(d, 46); items[38] = it; // all reels spin at the same time
        return runReel(reels[i].querySelector('.track'), items, 38, speed === 'fast' ? 1800 : 6000);
      }));
    }
    showResults(r.items, d.price * n);
  } catch (e) { toast(e.message); }
  state.busy = false; $('#copen').disabled = false;
}
function showResults(items, cost) {
  if (items.length === 1) { showRes(items[0]); return; }
  const box = $('#cres'), w = document.createElement('div'); w.className = 'batch';
  const value = items.reduce((a, i) => a + i.price, 0);
  const head = document.createElement('div'); head.className = 'bhead';
  const p = document.createElement('p'); p.textContent = 'Випало ' + items.length + ' предметів на суму ' + fmt(value) + ', витрачено ' + fmt(cost) + '. Усе вже в інвентарі.';
  const b = document.createElement('button'); b.className = 'btn btn-ghost'; b.textContent = 'Продати все за ' + fmt(value);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = await api('/inventory/sell', 'POST', { ids: items.map((i) => i.id) }); setBal(r.balance); box.replaceChildren(); toast('Продано за ' + fmt(r.sold) + ' монет'); }
    catch (e) { toast(e.message); b.disabled = false; }
  });
  head.append(p, b);
  const g = document.createElement('div'); g.className = 'igrid static'; items.forEach((it) => g.append(icard(it, '')));
  w.append(head, g); box.replaceChildren(w);
}
function showRes(g) {
  const box = $('#cres'), w = document.createElement('div'); w.className = 'rescard'; w.style.setProperty('--c', COLORS[g.tier]);
  const side = document.createElement('div'), p = document.createElement('p');
  p.textContent = TN[g.tier] + '. Предмет уже в інвентарі.';
  const b = document.createElement('button'); b.className = 'btn btn-ghost'; b.textContent = 'Продати за ' + fmt(g.price);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = await api('/inventory/sell', 'POST', { ids: [g.id] }); setBal(r.balance); box.replaceChildren(); toast('Продано за ' + fmt(r.sold) + ' монет'); }
    catch (e) { toast(e.message); b.disabled = false; }
  });
  side.append(p, b); w.append(icard(g), side); box.replaceChildren(w);
}
$('#copen').addEventListener('click', openNow);

/* ---------- inventory ---------- */
async function loadInv() {
  if (!state.me) return;
  try { const r = await api('/inventory'); state.inv = r.items; setBal(r.balance); } catch (e) { toast(e.message); }
}
const invSel = new Set();
async function renderInv() { await loadInv(); renderInvLocal(); }
function renderInvLocal() { // draws from cached state, no network call
  for (const id of [...invSel]) if (!state.inv.some((i) => i.id === id)) invSel.delete(id);
  const f = $('#ifilter').value, g = $('#igrid');
  const list = state.inv.filter((i) => f === 'all' || i.tier === f);
  g.replaceChildren();
  if (!list.length) emptyMsg(g, 'Тут порожньо. Відкрий кейс, і скін з’явиться тут.');
  list.forEach((it) => {
    const c = icard(it, invSel.has(it.id) ? 'sel' : '');
    c.addEventListener('click', () => { invSel.has(it.id) ? invSel.delete(it.id) : invSel.add(it.id); renderInvLocal(); });
    g.append(c);
  });
  const tot = state.inv.reduce((a, i) => a + i.price, 0), sv = state.inv.filter((i) => invSel.has(i.id)).reduce((a, i) => a + i.price, 0);
  $('#isum').textContent = state.inv.length + ' предметів на суму ' + fmt(tot);
  $('#pvalue').textContent = 'Вартість інвентаря: ' + fmt(tot);
  $('#isell').textContent = invSel.size ? 'Продати вибране (' + invSel.size + ') за ' + fmt(sv) : 'Продати вибране';
  $('#isell').disabled = !invSel.size;
}
$('#ifilter').addEventListener('change', renderInvLocal);
$('#iall').addEventListener('click', () => {
  const f = $('#ifilter').value; state.inv.filter((i) => f === 'all' || i.tier === f).forEach((i) => invSel.add(i.id)); renderInvLocal();
});
$('#isell').addEventListener('click', async () => {
  const ids = [...invSel].slice(0, 100); if (!ids.length) return;
  $('#isell').disabled = true;
  try { const r = await api('/inventory/sell', 'POST', { ids }); setBal(r.balance); ids.forEach((i) => invSel.delete(i)); toast('Продано за ' + fmt(r.sold) + ' монет'); }
  catch (e) { toast(e.message); }
  renderInv();
});

/* ---------- market ---------- */
const MF = { q: '', cat: '', tier: new Set(), wear: new Set(), st: 'any', min: '', max: '', case: '', sort: 'price_asc', page: 1 };
let mTok = 0, mTimer = 0;
function mQuery() {
  const p = new URLSearchParams();
  if (MF.q) p.set('q', MF.q);
  if (MF.cat) p.set('cat', MF.cat);
  if (MF.tier.size) p.set('tier', [...MF.tier].join(','));
  if (MF.wear.size) p.set('wear', [...MF.wear].join(','));
  if (MF.st !== 'any') p.set('st', MF.st);
  if (MF.min !== '') p.set('min', MF.min);
  if (MF.max !== '') p.set('max', MF.max);
  if (MF.case) p.set('case', MF.case);
  p.set('sort', MF.sort); p.set('page', String(MF.page));
  return p.toString();
}
function syncFilters() {
  const checked = (sel) => [...document.querySelectorAll(sel + ':checked')].map((x) => x.value);
  const num = (v) => { const n = Math.floor(Number(v)); return v !== '' && Number.isFinite(n) && n >= 0 ? String(Math.min(n, 1e9)) : ''; };
  MF.q = $('#mq').value.trim().slice(0, 60);
  MF.cat = checked('input[name=mcat]')[0] || '';
  MF.tier = new Set(checked('input[name=mtier]')); MF.wear = new Set(checked('input[name=mwear]'));
  MF.st = checked('input[name=mst]')[0] || 'any';
  MF.min = num($('#mmin').value); MF.max = num($('#mmax').value);
  MF.case = $('#mcase').value; MF.sort = $('#msort').value;
}
function onFilter(e) {
  if (!e.target.closest('#mfilters, #msort')) return;
  syncFilters(); MF.page = 1; clearTimeout(mTimer); mTimer = setTimeout(loadMarket, 250);
}
$('#v-market').addEventListener('input', onFilter);
$('#v-market').addEventListener('change', onFilter);
$('#mreset').addEventListener('click', () => {
  ['#mq', '#mmin', '#mmax', '#mcase'].forEach((id) => { $(id).value = ''; });
  document.querySelectorAll('#mfilters input[type=checkbox]').forEach((c) => { c.checked = false; });
  $('input[name=mcat][value=""]').checked = true; $('input[name=mst][value=any]').checked = true;
  syncFilters(); MF.page = 1; loadMarket();
});
$('#mprev').addEventListener('click', () => { MF.page = Math.max(1, MF.page - 1); loadMarket(); scrollTo(0, 0); });
$('#mnext').addEventListener('click', () => { MF.page += 1; loadMarket(); scrollTo(0, 0); });
function mcard(l) {
  const c = icard(l, 'mc', l.wear + (l.stattrak ? ', StatTrak' : ''));
  const b = document.createElement('button'); b.className = 'btn btn-main buy'; b.textContent = 'Купити';
  b.addEventListener('click', () => buy(l, b)); c.append(b); return c;
}
async function buy(l, btn) {
  if (!requireLogin()) return;
  btn.disabled = true;
  try {
    const r = await api('/market/buy', 'POST', { key: l.key, wear: l.wear, stattrak: l.stattrak });
    setBal(r.balance); toast('Куплено: ' + r.item.name + ' за ' + fmt(r.cost));
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}
async function loadMarket() {
  const tok = ++mTok;
  try {
    const r = await api('/market?' + mQuery());
    if (tok !== mTok) return; // a newer filter change superseded this response
    MF.page = r.page;
    $('#mcount').textContent = 'Знайдено: ' + fmt(r.total);
    const g = $('#mgrid'); g.replaceChildren();
    if (!r.listings.length) emptyMsg(g, 'Нічого не знайдено. Спробуй змінити фільтри.');
    r.listings.forEach((l) => g.append(mcard(l)));
    $('#mpage').textContent = 'Сторінка ' + r.page + ' з ' + r.pages;
    $('#mprev').disabled = r.page <= 1; $('#mnext').disabled = r.page >= r.pages;
  } catch (e) { toast(e.message); }
}
function renderMarket() {
  const sel = $('#mcase');
  if (sel.options.length <= 1) state.cases.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.append(o); });
  if (!matchMedia('(max-width:760px)').matches) $('#mfdet').open = true;
  syncFilters(); loadMarket();
}

/* ---------- profile ---------- */
let profTab = 'inv', histCursor = null, histLoading = false;
function avatarEl(av, size, name) {
  const d = document.createElement('div'); d.className = 'av'; d.style.setProperty('--s', size + 'px');
  if (av && av.type === 'item') {
    d.style.setProperty('--c', COLORS[av.tier]);
    const im = document.createElement('img'); im.src = av.image; im.alt = ''; d.append(im);
  } else { d.style.setProperty('--h', String((av ? av.index : 0) * 30)); d.textContent = (name || '?').slice(0, 1).toUpperCase(); }
  return d;
}
function paintProfile() {
  const p = state.profile; if (!p) return;
  $('#pname').textContent = p.username;
  $('#psince').textContent = 'З нами з ' + new Date(p.createdAt).toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' });
  $('#pavatar').replaceChildren(avatarEl(p.avatar, 112, p.username));
  const box = $('#pbest'); box.replaceChildren();
  const l = document.createElement('div'); l.className = 'lbl'; l.textContent = 'Найкращий дроп'; box.append(l);
  if (!p.bestDrop) { const e = document.createElement('p'); e.className = 'empty'; e.textContent = 'Ще нічого не випало'; box.append(e); return; }
  const c = icard(p.bestDrop, '');
  if (p.bestDrop.case) { const ci = document.createElement('img'); ci.className = 'corner'; ci.src = p.bestDrop.case.image; ci.alt = ''; ci.title = p.bestDrop.case.name; c.append(ci); }
  box.append(c);
}
async function renderProfile() {
  try { const [p] = await Promise.all([api('/profile'), loadInv()]); state.profile = p; paintProfile(); } catch (e) { toast(e.message); }
  setTab(profTab);
}
function setTab(t) {
  profTab = t;
  for (const [id, key] of [['#tab-inv', 'inv'], ['#tab-hist', 'hist']]) { $(id).classList.toggle('on', t === key); $(id).setAttribute('aria-selected', String(t === key)); }
  $('#p-inv').hidden = t !== 'inv'; $('#p-hist').hidden = t !== 'hist';
  if (t === 'inv') renderInvLocal(); else loadHistory(true);
}
$('#tab-inv').addEventListener('click', () => setTab('inv'));
$('#tab-hist').addEventListener('click', () => setTab('hist'));

const stamp = (ts) => new Date(ts).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
function priceEl(v) {
  const p = document.createElement('div'); p.className = 'price';
  const c = document.createElement('span'); c.className = 'coin'; const t = document.createElement('span'); t.textContent = fmt(v);
  p.append(c, t); return p;
}
function thumb(it, small) {
  const im = document.createElement('img'); im.className = 'hthumb' + (small ? ' sm' : ''); im.src = it.image; im.alt = ''; im.title = it.name; im.loading = 'lazy'; return im;
}
function textBlock(it, withWear) {
  const body = document.createElement('div'); body.className = 'hbody';
  const b = document.createElement('b'); b.textContent = it.name; body.append(b);
  if (withWear) { const s = document.createElement('span'); s.textContent = it.wear + ', ' + Number(it.float).toFixed(4) + (it.stattrak ? ', StatTrak' : ''); body.append(s); }
  body.append(priceEl(it.price)); return body;
}
function histRow(e) {
  const row = document.createElement('div'); row.className = 'hrow'; const d = e.data;
  const time = document.createElement('span'); time.className = 'htime'; time.textContent = stamp(e.at);
  if (e.kind === 'case') {
    row.style.setProperty('--c', COLORS[d.item.tier]);
    const ci = document.createElement('img'); ci.className = 'corner'; ci.src = d.case.image; ci.alt = ''; ci.title = d.case.name;
    row.append(thumb(d.item), textBlock(d.item, true), ci, time); return row;
  }
  row.classList.add(d.win ? 'win' : 'lose');
  const left = document.createElement('div'); left.className = 'hside';
  const strip = document.createElement('div'); strip.className = 'hstake';
  d.stake.slice(0, 4).forEach((it) => strip.append(thumb(it, true)));
  if (d.stake.length > 4) { const m = document.createElement('span'); m.textContent = '+' + (d.stake.length - 4); strip.append(m); }
  const lb = document.createElement('div'); lb.className = 'hbody';
  const t1 = document.createElement('span'); t1.textContent = 'Ставка'; lb.append(t1, priceEl(d.stake.reduce((a, i) => a + i.price, 0)));
  left.append(strip, lb);
  const mid = document.createElement('div'); mid.className = 'hmid';
  const ar = document.createElement('div'); ar.className = 'arrow'; ar.textContent = '→';
  const ch = document.createElement('span'); ch.textContent = 'шанс ' + Number(d.chance).toFixed(1) + '%';
  const bd = document.createElement('span'); bd.className = 'badge ' + (d.win ? 'win' : 'lose'); bd.textContent = d.win ? 'Зайшло' : 'Не зайшло';
  mid.append(ar, ch, bd);
  const right = document.createElement('div'); right.className = 'hside r';
  right.append(textBlock(d.target, false), thumb(d.target));
  row.append(left, mid, right, time); return row;
}
async function loadHistory(reset) {
  if (histLoading) return; histLoading = true;
  const list = $('#hlist');
  try {
    if (reset) { histCursor = null; list.replaceChildren(); }
    const r = await api('/history?limit=20' + (histCursor ? '&before=' + histCursor : ''));
    r.entries.forEach((e) => list.append(histRow(e)));
    histCursor = r.next; $('#hmore').hidden = !r.next;
    if (reset && !r.entries.length) emptyMsg(list, 'Історія порожня. Відкрий кейс або зроби апгрейд.');
  } catch (e) { toast(e.message); }
  histLoading = false;
}
$('#hmore').addEventListener('click', () => loadHistory(false));

function openAvatarPicker() {
  if (!state.profile) return;
  const colors = $('#avcolors'); colors.replaceChildren();
  for (let i = 0; i < 12; i++) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch'; b.setAttribute('aria-label', 'Колір ' + (i + 1));
    b.append(avatarEl({ type: 'color', index: i }, 44, state.profile.username));
    b.addEventListener('click', () => setAvatar('c:' + i)); colors.append(b);
  }
  const seen = new Set(), pool = [];
  [...state.inv].sort((a, b) => b.price - a.price).forEach((i) => { if (!seen.has(i.key) && pool.length < 24) { seen.add(i.key); pool.push(i); } });
  const best = state.profile.bestDrop; if (best && !seen.has(best.key)) pool.unshift(best);
  const g = $('#avitems'); g.replaceChildren();
  if (!pool.length) emptyMsg(g, 'Відкрий кейс, і тут з’являться твої скіни.');
  pool.forEach((it) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pick'; b.style.setProperty('--c', COLORS[it.tier]); b.title = it.name;
    const im = document.createElement('img'); im.src = it.image; im.alt = it.name; b.append(im);
    b.addEventListener('click', () => setAvatar('i:' + it.key)); g.append(b);
  });
  $('#avdlg').showModal();
}
async function setAvatar(a) {
  try { const r = await api('/profile/avatar', 'POST', { avatar: a }); state.profile.avatar = r.avatar; paintProfile(); $('#avdlg').close(); toast('Аватар оновлено'); }
  catch (e) { toast(e.message); }
}
$('#pavatar').addEventListener('click', openAvatarPicker);
$('#av-close').addEventListener('click', () => $('#avdlg').close());

/* ---------- upgrader ---------- */
const upSel = new Set(); let upTarget = null, upBusy = false, upTok = 0;
function setWheel(ch) {
  $('#wheel').style.setProperty('--p', ch + '%'); $('#wpct').textContent = ch.toFixed(1) + '%';
  $('#upgo').disabled = !ch || upBusy;
}
function emptyMsg(el, text) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = text; el.replaceChildren(p); }
// The cached inventory can be stale (cases opened, items bought or sold since the last load), so entering the tab reloads it first.
async function openUp() {
  emptyMsg($('#uplist'), 'Завантажуємо інвентар…');
  await loadInv();
  if (view === 'up') renderUp();
}
async function renderUp() {
  for (const id of [...upSel]) if (!state.inv.some((i) => i.id === id)) upSel.delete(id);
  const L = $('#uplist'); L.replaceChildren();
  if (!state.inv.length) emptyMsg(L, 'Інвентар порожній. Спершу відкрий кейс.');
  state.inv.slice().sort((a, b) => b.price - a.price).forEach((it) => {
    const c = icard(it, upSel.has(it.id) ? 'sel' : '');
    c.addEventListener('click', () => {
      if (upBusy) return;
      if (upSel.has(it.id)) upSel.delete(it.id);
      else if (upSel.size >= 10) { toast('Максимум 10 скінів за раз'); return; }
      else upSel.add(it.id);
      renderUp();
    });
    L.append(c);
  });
  const sum = state.inv.filter((i) => upSel.has(i.id)).reduce((a, i) => a + i.price, 0), T = $('#uptargets'), tok = ++upTok;
  if (!sum) { upTarget = null; emptyMsg(T, 'Обери скіни зліва, і тут з’являться цілі.'); setWheel(0); return; }
  let targets = [];
  try { targets = (await api('/upgrade/targets?sum=' + sum)).targets; } catch (e) { toast(e.message); }
  if (tok !== upTok) return; // a newer selection superseded this response
  upTarget = upTarget ? targets.find((t) => t.key === upTarget.key) || null : null;
  T.replaceChildren();
  if (!targets.length) emptyMsg(T, 'Немає цілей для такої суми. Додай ще скінів або відкрий більше кейсів.');
  targets.forEach((t) => {
    const c = icard({ ...t, wear: 'FT' }, upTarget && upTarget.key === t.key ? 'sel' : '', 'FT, шанс ' + t.chance.toFixed(1) + '%');
    c.addEventListener('click', () => { if (!upBusy) { upTarget = t; renderUp(); } });
    T.append(c);
  });
  setWheel(upTarget ? upTarget.chance : 0);
}
$('#upgo').addEventListener('click', async () => {
  if (upBusy || !upTarget || !upSel.size) return;
  upBusy = true; $('#upgo').disabled = true; $('#upres').textContent = 'Крутимо…';
  const nd = $('#needle');
  try {
    const r = await api('/upgrade', 'POST', { ids: [...upSel], target: upTarget.key });
    const a = r.roll * 3.6; // the server's roll IS the landing angle: win zone = [0, chance*3.6)
    nd.style.transition = quickMotion() ? 'none' : 'transform 5s cubic-bezier(.1,.6,.1,1)';
    nd.style.transform = 'rotate(' + (1800 + a) + 'deg)';
    await sleep(quickMotion() ? 0 : 5100);
    nd.style.transition = 'none'; nd.style.transform = 'rotate(' + a + 'deg)';
    setBal(r.balance);
    $('#upres').textContent = r.win ? 'Успіх! Ти отримав ' + r.item.name : 'Не пощастило, вкладені скіни втрачено.';
    upSel.clear(); upTarget = null; await loadInv();
  } catch (e) { $('#upres').textContent = e.message; }
  upBusy = false; renderUp();
});

/* ---------- boot ---------- */
(async function boot() {
  try { const r = await api('/auth/me'); setMe(r.user); if (r.user) loadInv(); } catch { setMe(null); }
  setInterval(dailyState, 60000);
  loadCases();
})();
