const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractAssignedJson, readNutrition } = require('../../barbora-calorie-sort.user.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', `${name}.html`), 'utf8');
const productPage = (nutrients) => `<script>window.product = ${JSON.stringify({ id: '1', nutrients })};</script>`;
const kcal = (n) => ({ Name: 'E', Amounts: [{ Amount: n, UnitName: 'Kcal' }] });

test('extractAssignedJson parses objects with tricky strings', () => {
  const html = '<script>window.a = 1; window.product = {"t":"a } b","q":"say \\"hi\\"","n":[1,{"x":"]"}]};\nwindow.z = 2;</script>';
  assert.deepEqual(extractAssignedJson(html, 'product'), { t: 'a } b', q: 'say "hi"', n: [1, { x: ']' }] });
});

test('extractAssignedJson parses arrays', () => {
  assert.deepEqual(extractAssignedJson('window.b_productList = [{"id":"1"}];', 'b_productList'), [{ id: '1' }]);
});

test('extractAssignedJson returns null for a missing name, a longer name or broken JSON', () => {
  assert.equal(extractAssignedJson('<p>nothing</p>', 'product'), null);
  assert.equal(extractAssignedJson('window.productList = [1];', 'product'), null);
  assert.equal(extractAssignedJson('window.product = {"a": ', 'product'), null);
});

test('readNutrition reads the boneless thighs in LV, EN and RU', () => {
  // snapshot 2026-10-17
  for (const name of ['product-lv', 'product-en', 'product-ru']) {
    assert.deepEqual(readNutrition(fixture(name)), { status: 'ok', kcal: 172, protein: 17 }, name);
  }
});

test('readNutrition handles a product with only four nutrient rows', () => {
  assert.deepEqual(readNutrition(fixture('product-4rows')), { status: 'ok', kcal: 157, protein: 18 }); // snapshot 2026-10-17
});

test('readNutrition: a product without a label is none', () => {
  assert.deepEqual(readNutrition(fixture('product-nodata')), { status: 'none' });
});

test('readNutrition converts kJ when kcal is missing', () => {
  const html = productPage([{ Name: 'Enerģētiskā vērtība', Amounts: [{ Amount: 717, UnitName: 'kJ' }] }]);
  assert.deepEqual(readNutrition(html), { status: 'ok', kcal: 171, protein: null });
});

test('readNutrition falls back to the visible table', () => {
  const html = '<table class="table table-striped table-condensed"><tbody>'
    + '<tr><td>Enerģētiskā vērtība</td><td class="b-text-right">717.00 kJ / 172.00 Kcal</td></tr>'
    + '<tr><td>Olbaltumvielas</td><td class="b-text-right">17,5 g</td></tr></tbody></table>';
  assert.deepEqual(readNutrition(html), { status: 'ok', kcal: 172, protein: 17.5 });
});

test('readNutrition falls back to a Russian table, whose units are translated', () => {
  const html = '<table class="table table-striped table-condensed"><tbody>'
    + '<tr><td>Энергетическая ценность</td><td class="b-text-right">717.00 кДж / 172.00 ккал</td></tr>'
    + '<tr><td>Белки</td><td class="b-text-right">17.00 g</td></tr></tbody></table>';
  assert.deepEqual(readNutrition(html), { status: 'ok', kcal: 172, protein: 17 });
});

test('readNutrition applies the sanity rules', () => {
  assert.deepEqual(readNutrition(productPage([kcal(1200)])), { status: 'none' });
  assert.deepEqual(readNutrition(productPage([kcal(0)])), { status: 'ok', kcal: 0, protein: null });
  assert.deepEqual(
    readNutrition(productPage([kcal(50), { Name: 'Proteins', Amounts: [{ Amount: 140, UnitName: 'g' }] }])),
    { status: 'ok', kcal: 50, protein: null },
  );
});

test('readNutrition: neither product data nor a table is unreadable', () => {
  assert.deepEqual(readNutrition('<html><body>Lapa nav atrasta</body></html>'), { status: 'unreadable' });
});
