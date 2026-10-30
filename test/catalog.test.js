'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog } = require('../server/catalog');

const img = (n) => `https://raw.githubusercontent.com/x/y/${n}.png`;
const mk = (id, rarity, i) => ({ id: `${id}-${rarity[0]}${i}`, name: `Gun${i} | ${rarity}${id}`, rarity: { name: rarity }, image: img(id + rarity + i) });
const body = (id) => ({
  contains: [0, 1, 2].map((i) => mk(id, 'Mil-Spec Grade', i)).concat([mk(id, 'Restricted', 0), mk(id, 'Classified', 0), mk(id, 'Covert', 0)]),
  contains_rare: [{ id: id + '-gl', name: '★ Driver Gloves | Wave ' + id, rarity: { name: 'Extraordinary' }, image: img(id + 'g') }],
});

test('terminals (type null, name ends with "Terminal") are loaded; other null-type crates are not', () => {
  const c = buildCatalog([
    { id: 'c1', type: 'Case', name: 'Old Case', image: img('c1'), first_sale_date: '2024-01-16', ...body('c1') },
    { id: 't1', type: null, name: 'Sealed Dead Hand Terminal', image: img('t1'), ...body('t1') },
    { id: 't2', type: null, name: 'Sealed Genesis Terminal', image: img('t2'), ...body('t2'), contains_rare: [] },
    { id: 'p1', type: null, name: 'Gift Package', image: img('p1'), ...body('p1') },
    { id: 'p2', type: null, name: 'Terminal Velocity Package', image: img('p2'), ...body('p2') },
    { id: 'p3', type: 'Souvenir', name: 'Some Terminal', image: img('p3'), ...body('p3') },
  ]);
  assert.deepEqual([...c.cases.keys()].sort(), ['c1', 't1', 't2']);
  const dead = c.cases.get('t1');
  assert.equal(dead.name, 'Dead Hand Terminal');          // "Sealed " prefix is dropped
  assert.equal(dead.kind, 'terminal');
  assert.equal(c.cases.get('c1').kind, 'case');
  // terminals come first, the one with a known release date before the one without; then regular cases
  assert.deepEqual(c.summaries.map((s) => s.id), ['t1', 't2', 'c1']);
  assert.deepEqual(Object.keys(c.summaries[0]).sort(), ['id', 'image', 'kind', 'name', 'price']);
  // gloves from the terminal are real catalog items: found by the market and by the upgrader
  const glove = c.items.get('t1-gl');
  assert.equal(glove.category, 'gloves'); assert.equal(glove.tier, 'rare'); assert.ok(glove.caseIds.has('t1'));
  assert.ok(c.targets.some((t) => t.key === 't1-gl'));
  // a terminal without a rare tier still gets a sane price
  assert.ok(c.cases.get('t2').price >= 40 && !c.cases.get('t2').byTier.rare);
});
