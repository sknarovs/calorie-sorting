const test = require('node:test');
const assert = require('node:assert/strict');
const { LABELS, pickLabels, fill, formatBadge, composeNotice } = require('../../barbora-calorie-sort.user.js');

test('pickLabels follows the site language, Latvian otherwise', () => {
  assert.equal(pickLabels('ru').sortAsc, 'Калорийности от самой низкой');
  assert.equal(pickLabels('en').sortDesc, 'Calories from highest');
  assert.equal(pickLabels('lv').sortAsc, 'Kalorijas (augoši)');
  assert.equal(pickLabels('de'), LABELS.lv);
  assert.equal(pickLabels(undefined), LABELS.lv);
});

test('every label set has the same keys', () => {
  const keys = Object.keys(LABELS.lv).sort();
  assert.deepEqual(Object.keys(LABELS.en).sort(), keys);
  assert.deepEqual(Object.keys(LABELS.ru).sort(), keys);
});

test('fill replaces placeholders', () => {
  assert.equal(fill('{done} / {total}', { done: 3, total: 10 }), '3 / 10');
});

test('formatBadge data states use the locale number format', () => {
  assert.deepEqual(formatBadge(pickLabels('lv'), { status: 'ok', kcal: 172, protein: 17 }),
    { kind: 'ok', text: '172 kcal · 17 g olbaltumvielu', title: 'uz 100 g/ml' });
  assert.equal(formatBadge(pickLabels('en'), { status: 'ok', kcal: 132, protein: 22.4 }).text, '132 kcal · 22.4 g protein');
  assert.equal(formatBadge(pickLabels('ru'), { status: 'ok', kcal: 132, protein: 22.4 }).text, '132 ккал · 22,4 г белка');
  assert.equal(formatBadge(pickLabels('lv'), { status: 'ok', kcal: 38, protein: 0.5 }).text, '38 kcal · 0,5 g olbaltumvielu');
  assert.equal(formatBadge(pickLabels('lv'), { status: 'ok', kcal: 52.6, protein: null }).text, '53 kcal');
});

test('formatBadge other states', () => {
  const lv = pickLabels('lv');
  assert.deepEqual(formatBadge(lv, { status: 'loading' }), { kind: 'loading', text: '… kcal', title: '' });
  assert.deepEqual(formatBadge(lv, { status: 'none' }), { kind: 'none', text: 'nav datu', title: '' });
  assert.deepEqual(formatBadge(lv, { status: 'failed' }), { kind: 'failed', text: '?', title: 'Neizdevās ielādēt' });
  assert.equal(formatBadge(pickLabels('ru'), { status: 'loading' }).text, '… ккал');
});

test('composeNotice joins the parts that apply', () => {
  const lv = pickLabels('lv');
  assert.equal(composeNotice(lv, { failed: 0, rateLimited: false }), '');
  assert.equal(composeNotice(lv, { failed: 2, rateLimited: false }), 'Neizdevās ielādēt: 2');
  assert.equal(composeNotice(lv, { total: 84, failed: 1, rateLimited: true }),
    'Visas preces (84) sakārtotas pēc kalorijām · Neizdevās ielādēt: 1 · Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem');
});
