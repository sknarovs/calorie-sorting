const test = require('node:test');
const assert = require('node:assert/strict');
const { LABELS, pickLabels, fill, formatBox, composeNotice } = require('../../barbora-calorie-sort.user.js');

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

test('formatBox puts kcal on the first line and protein on the second, in the locale number format', () => {
  assert.deepEqual(formatBox(pickLabels('lv'), { status: 'ok', kcal: 172, protein: 17 }),
    { kind: 'ok', lines: ['172 kcal', '17 g olb.'], title: 'uz 100 g/ml · olb. — olbaltumvielas' });
  assert.deepEqual(formatBox(pickLabels('en'), { status: 'ok', kcal: 132, protein: 22.4 }).lines, ['132 kcal', '22.4 g protein']);
  assert.deepEqual(formatBox(pickLabels('ru'), { status: 'ok', kcal: 132, protein: 22.4 }).lines, ['132 ккал', '22,4 г белка']);
  assert.deepEqual(formatBox(pickLabels('lv'), { status: 'ok', kcal: 38, protein: 0.5 }).lines, ['38 kcal', '0,5 g olb.']);
  assert.deepEqual(formatBox(pickLabels('lv'), { status: 'ok', kcal: 52.6, protein: null }).lines, ['53 kcal']);
});

test('formatBox other states', () => {
  const lv = pickLabels('lv');
  assert.deepEqual(formatBox(lv, { status: 'loading' }), { kind: 'loading', lines: ['… kcal'], title: '' });
  assert.deepEqual(formatBox(lv, { status: 'none' }), { kind: 'none', lines: ['nav datu'], title: '' });
  assert.deepEqual(formatBox(lv, { status: 'failed' }), { kind: 'failed', lines: ['?'], title: 'Neizdevās ielādēt' });
  assert.deepEqual(formatBox(pickLabels('ru'), { status: 'loading' }).lines, ['… ккал']);
});

test('composeNotice joins the parts that apply', () => {
  const lv = pickLabels('lv');
  assert.equal(composeNotice(lv, { failed: 0, rateLimited: false }), '');
  assert.equal(composeNotice(lv, { failed: 2, rateLimited: false }), 'Neizdevās ielādēt: 2');
  assert.equal(composeNotice(lv, { failed: 1, rateLimited: true }),
    'Neizdevās ielādēt: 1 · Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem');
});
