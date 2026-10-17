const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarker, baseQuery, listingUrl, listKey, sortedViewUrl, productUrl, sortProducts } = require('../../barbora-calorie-sort.user.js');

test('parseMarker', () => {
  assert.equal(parseMarker('#kcal-asc'), 'asc');
  assert.equal(parseMarker('#kcal-desc'), 'desc');
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker('#kcal-up'), null);
  assert.equal(parseMarker('#reviews'), null);
});

test('baseQuery drops order and page but keeps filters in their order', () => {
  assert.equal(baseQuery('?brand=3583&order=priceAsc&page=3&country=LV'), '?brand=3583&country=LV');
  assert.equal(baseQuery('?page=2'), '');
  assert.equal(baseQuery(''), '');
});

test('listingUrl keeps filters, drops order, numbers pages from 2', () => {
  const loc = { pathname: '/piena-produkti-un-olas/jogurti', search: '?order=priceAsc&brand=135&page=4' };
  assert.equal(listingUrl(loc, 1), '/piena-produkti-un-olas/jogurti?brand=135');
  assert.equal(listingUrl(loc, 2), '/piena-produkti-un-olas/jogurti?brand=135&page=2');
  assert.equal(listingUrl({ pathname: '/a', search: '' }, 3), '/a?page=3');
});

test('listKey ignores order, page and parameter order', () => {
  assert.equal(listKey({ pathname: '/a', search: '?country=LV&brand=135&page=2' }), '/a?brand=135&country=LV');
  assert.equal(listKey({ pathname: '/a', search: '?brand=135&country=LV&order=name' }), '/a?brand=135&country=LV');
  assert.equal(listKey({ pathname: '/a', search: '' }), '/a');
});

test('sortedViewUrl drops page and order, keeps filters, adds the marker', () => {
  assert.equal(sortedViewUrl({ pathname: '/a', search: '?brand=1&page=3&order=priceAsc' }, 'desc'), '/a?brand=1#kcal-desc');
  assert.equal(sortedViewUrl({ pathname: '/a', search: '' }, 'asc'), '/a#kcal-asc');
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
