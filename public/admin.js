'use strict';
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString('uk-UA');
const COLORS = { mil: '#4b69ff', res: '#8847ff', cls: '#d32ce6', cov: '#eb4b4b', rare: '#ffd24a' };
const TN = { mil: 'Армійське', res: 'Обмежене', cls: 'Засекречене', cov: 'Таємне', rare: 'Рідкісне' };

/* ---------- helpers (no innerHTML anywhere: everything is built with DOM nodes and textContent) ---------- */
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
async function api(path, method = 'GET', body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
  let r;
  try { r = await fetch('/api' + path, opt); } catch { throw new ApiError(0, 'network', 'Немає зв’язку із сервером'); }
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new ApiError(r.status, j && j.error, (j && j.message) || 'Помилка сервера');
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('show'), 3200);
}
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}
const emptyMsg = (el, text) => el.replaceChildren(h('p', { class: 'empty', text }));
const num = (el) => (el.value.trim() === '' ? undefined : Number(el.value)); // '' -> undefined, so the server says "required" instead of silently using 0
const priceEl = (v) => h('div', { class: 'price' }, h('span', { class: 'coin' }), h('span', { text: fmt(v) }));

// Small card for a search result, a chosen skin or a case.
function card(it, onclick, sub) {
  const c = h('div', { class: 'icard', style: '--c:' + (COLORS[it.tier] || '#9aa5bd'), title: it.name, onclick },
    h('img', { src: it.image, alt: '' }),
    h('b', { text: it.name }),
    h('span', { text: sub ?? (it.tier ? TN[it.tier] + (it.custom ? ', свій' : '') : (it.custom ? 'Свій кейс' : 'Кейс')) }));
  if (it.price !== undefined) c.append(priceEl(it.price));
  return c;
}

// Search box + results. onItem(skin) and/or onCase(case) are called when a result is clicked.
function picker(mount, { onItem, onCase, placeholder }) {
  const input = h('input', { type: 'search', maxlength: '60', placeholder: placeholder || 'Пошук скіна за назвою (від 2 літер)…', autocomplete: 'off' });
  const out = h('div', { class: 'igrid scroll pk-out' });
  let tok = 0, timer = 0;
  async function run() {
    const v = input.value.trim(), my = ++tok;
    if (v.length < 2) { out.replaceChildren(); return; }
    try {
      const r = await api('/admin/search?q=' + encodeURIComponent(v));
      if (my !== tok) return; // a newer search superseded this one
      const nodes = [];
      if (onItem) r.items.forEach((it) => nodes.push(card(it, () => onItem(it))));
      if (onCase) r.cases.forEach((c) => nodes.push(card(c, () => onCase(c))));
      if (nodes.length) out.replaceChildren(...nodes); else emptyMsg(out, 'Нічого не знайдено');
    } catch (e) { toast(e.message); }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  mount.replaceChildren(input, out);
}

/* ---------- tabs ---------- */
const TABS = [['skins', '#atab-skins', '#a-skins'], ['cases', '#atab-cases', '#a-cases'], ['users', '#atab-users', '#a-users']];
function setTab(name) {
  for (const [k, btn, box] of TABS) {
    $(btn).classList.toggle('on', k === name); $(btn).setAttribute('aria-selected', String(k === name)); $(box).hidden = k !== name;
  }
}
TABS.forEach(([k, btn]) => $(btn).addEventListener('click', () => setTab(k)));

/* ---------- give a skin ---------- */
let giveItem = null;
function paintGive() {
  const box = $('#give-sel');
  if (!giveItem) { emptyMsg(box, 'Скін ще не обрано'); $('#give-go').disabled = true; return; }
  box.replaceChildren(card(giveItem, null, giveItem.canST ? 'Базова ціна FT' : 'Без StatTrak™'));
  $('#give-go').disabled = false;
  $('#g-st').disabled = !giveItem.canST; if (!giveItem.canST) $('#g-st').checked = false;
}
function selectGive(it) { giveItem = it; paintGive(); }
$('#give-go').addEventListener('click', async () => {
  if (!giveItem) return;
  const btn = $('#give-go'); btn.disabled = true;
  const body = { key: giveItem.key, stattrak: $('#g-st').checked, count: num($('#g-count')) };
  if ($('#g-user').value.trim()) body.username = $('#g-user').value.trim();
  if ($('#g-wear').value) body.wear = $('#g-wear').value;
  if ($('#g-float').value.trim() !== '') body.float = Number($('#g-float').value);
  if ($('#g-price').value.trim() !== '') body.price = Number($('#g-price').value);
  try {
    const r = await api('/admin/give', 'POST', body);
    const f = r.items[0];
    $('#give-res').textContent = 'Видано ' + r.count + ' × ' + f.name + ' гравцю ' + r.user + ' (' + f.wear + ', флоут ' + Number(f.float).toFixed(4) + (f.stattrak ? ', StatTrak' : '') + ', ' + fmt(f.price) + ' монет)';
    toast('Скін видано');
  } catch (e) { $('#give-res').textContent = e.message; toast(e.message); }
  btn.disabled = false;
});
picker($('#pk-give'), { onItem: selectGive });

/* ---------- custom skins ---------- */
picker($('#pk-iimg'), { onItem: (it) => { $('#i-image').value = it.image; if (!$('#i-name').value.trim()) $('#i-name').value = it.name; toast('Картинку взято'); } });
$('#item-go').addEventListener('click', async () => {
  const btn = $('#item-go'); btn.disabled = true;
  try {
    const r = await api('/admin/items', 'POST', {
      name: $('#i-name').value, image: $('#i-image').value, tier: $('#i-tier').value, price: num($('#i-price')), canST: $('#i-st').checked,
    });
    toast('Скін створено: ' + r.item.name);
    ['#i-name', '#i-image', '#i-price'].forEach((s) => { $(s).value = ''; });
    selectGive(r.item); // ready to hand out right away
    await loadItems();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});
function listRow(it, ...actions) {
  return h('div', { class: 'arow', style: '--c:' + (COLORS[it.tier] || 'var(--line)') },
    h('img', { src: it.image, alt: '' }),
    h('div', { class: 'grow' }, h('b', { text: it.name }), h('div', { class: 'sm', text: it.tier ? TN[it.tier] + (it.canST === false ? ', без StatTrak' : '') : (it.count + ' скінів') }), it.price !== undefined ? priceEl(it.price) : null),
    ...actions);
}
async function loadItems() {
  const box = $('#items-list');
  try {
    const { items } = await api('/admin/items');
    if (!items.length) { emptyMsg(box, 'Своїх скінів ще немає'); return; }
    box.replaceChildren(...items.map((it) => listRow(it,
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Видати', onclick: () => { selectGive(it); scrollTo(0, 0); } }),
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Видалити', onclick: async () => {
        if (!confirm('Видалити скін «' + it.name + '»? Уже видані предмети й кейси з ним залишаться.')) return;
        try { await api('/admin/items/' + encodeURIComponent(it.key) + '/delete', 'POST'); if (giveItem && giveItem.key === it.key) { giveItem = null; paintGive(); } await loadItems(); toast('Видалено'); }
        catch (e) { toast(e.message); }
      } }))));
  } catch (e) { toast(e.message); }
}

/* ---------- custom cases ---------- */
const caseItems = []; // { it, w }
const chanceLabels = new Map();
const weightOf = (e) => (Number.isInteger(e.w) && e.w > 0 ? e.w : 0);
function updateChances() {
  const total = caseItems.reduce((a, e) => a + weightOf(e), 0);
  for (const e of caseItems) {
    const el = chanceLabels.get(e.it.key);
    if (el) el.textContent = total ? (Math.round((weightOf(e) / total) * 10000) / 100) + '%' : '—';
  }
}
function paintCaseItems() {
  const box = $('#case-items'); chanceLabels.clear();
  if (!caseItems.length) { emptyMsg(box, 'Додай хоча б один скін (клік по скіну в результатах пошуку)'); return; }
  box.replaceChildren(...caseItems.map((e) => {
    const w = h('input', { type: 'number', min: '1', max: '1000000', step: '1', value: String(e.w), 'aria-label': 'Вага ' + e.it.name });
    w.addEventListener('input', () => { e.w = Number(w.value); updateChances(); });
    const ch = h('span', { class: 'chance', text: '' }); chanceLabels.set(e.it.key, ch);
    return listRow(e.it, h('label', { class: 'wlbl' }, 'Вага', w), ch,
      h('button', { class: 'btn btn-ghost', type: 'button', text: '✕', 'aria-label': 'Прибрати', onclick: () => { caseItems.splice(caseItems.indexOf(e), 1); paintCaseItems(); } }));
  }));
  updateChances();
}
picker($('#pk-case'), { onItem: (it) => {
  if (caseItems.some((e) => e.it.key === it.key)) { toast('Цей скін уже додано'); return; }
  if (caseItems.length >= 60) { toast('Максимум 60 скінів'); return; }
  caseItems.push({ it, w: 10 }); paintCaseItems();
} });
picker($('#pk-cimg'), { onItem: (it) => { $('#c-image').value = it.image; toast('Картинку взято'); }, onCase: (c) => { $('#c-image').value = c.image; toast('Картинку взято'); }, placeholder: 'Пошук кейса або скіна…' });
$('#case-go').addEventListener('click', async () => {
  const btn = $('#case-go'); btn.disabled = true;
  try {
    const r = await api('/admin/cases', 'POST', {
      name: $('#c-name').value, image: $('#c-image').value, price: num($('#c-price')),
      items: caseItems.map((e) => ({ key: e.it.key, w: e.w })),
    });
    toast('Кейс створено: ' + r.case.name + '. Онови головну сторінку, щоб побачити його');
    ['#c-name', '#c-image', '#c-price'].forEach((s) => { $(s).value = ''; });
    caseItems.length = 0; paintCaseItems(); await loadCases();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});
async function loadCases() {
  const box = $('#cases-list');
  try {
    const { cases } = await api('/admin/cases');
    if (!cases.length) { emptyMsg(box, 'Своїх кейсів ще немає'); return; }
    box.replaceChildren(...cases.map((c) => listRow(c,
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Видалити', onclick: async () => {
        if (!confirm('Видалити кейс «' + c.name + '»? Уже випавші предмети залишаться в інвентарях.')) return;
        try { await api('/admin/cases/' + encodeURIComponent(c.id) + '/delete', 'POST'); await loadCases(); toast('Видалено'); }
        catch (e) { toast(e.message); }
      } }))));
  } catch (e) { toast(e.message); }
}

/* ---------- balance ---------- */
$('#bal-go').addEventListener('click', async () => {
  const btn = $('#bal-go'); btn.disabled = true;
  try {
    const body = { delta: num($('#b-delta')) };
    if ($('#b-user').value.trim()) body.username = $('#b-user').value.trim();
    const r = await api('/admin/balance', 'POST', body);
    $('#bal-res').textContent = 'Баланс гравця ' + r.user + ': ' + fmt(r.balance) + ' монет';
    toast('Готово');
  } catch (e) { $('#bal-res').textContent = e.message; toast(e.message); }
  btn.disabled = false;
});

/* ---------- boot ---------- */
(async function boot() {
  const gate = $('#gate');
  try {
    const { user } = await api('/auth/me');
    if (!user) { gate.replaceChildren('Спершу увійди в акаунт на ', h('a', { href: '/', text: 'головній сторінці' }), '.'); return; }
    if (!user.admin) { gate.textContent = 'Немає доступу.'; return; }
    gate.hidden = true; $('#panel').hidden = false;
    paintGive(); paintCaseItems();
    await Promise.all([loadItems(), loadCases()]);
  } catch (e) { gate.textContent = e.message; }
})();
