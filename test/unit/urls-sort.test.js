const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarker, autoLoads, productUrl, sortProducts } = require('../../barbora-calorie-sort.user.js');

test('parseMarker', () => {
  assert.equal(parseMarker('#kcal-asc'), 'asc');
  assert.equal(parseMarker('#kcal-desc'), 'desc');
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker('#kcal-up'), null);
  assert.equal(parseMarker('#reviews'), null);
});

test('autoLoads is true only for the price-per-unit sorts', () => {
  assert.equal(autoLoads('?order=comparativePriceAsc'), true);
  assert.equal(autoLoads('?brand=135&order=comparativePriceDesc&page=2'), true);
  assert.equal(autoLoads('?order=priceAsc'), false);
  assert.equal(autoLoads('?order=name'), false);
  assert.equal(autoLoads(''), false);
});

test('productUrl', () => {
  assert.equal(productUrl({ Url: 'cala-skinki-atkauloti-bez-adas-wd-500-g' }), '/produkti/cala-skinki-atkauloti-bez-adas-wd-500-g');
});

const ok = (kcal) => ({ status: 'ok', kcal, protein: null });
const products = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
const states = new Map([['a', ok(300)], ['b', { status: 'none' }], ['c', ok(100)], ['d', { status: 'failed' }], ['e', ok(100)], ['f', ok(50)]]);

test('sortProducts asc: by kcal, ties keep their order, no number last', () => {
  assert.deepEqual(sortProducts(products, states, 'asc').map((p) => p.id), ['f', 'c', 'e', 'a', 'b', 'd']);
});

test('sortProducts desc keeps entries without a number last', () => {
  assert.deepEqual(sortProducts(products, states, 'desc').map((p) => p.id), ['a', 'c', 'e', 'f', 'b', 'd']);
});

test('sortProducts treats unknown products as no number and leaves the input alone', () => {
  const input = [{ id: 'x' }, { id: 'f' }];
  assert.deepEqual(sortProducts(input, states, 'asc').map((p) => p.id), ['f', 'x']);
  assert.deepEqual(input.map((p) => p.id), ['x', 'f']);
});
