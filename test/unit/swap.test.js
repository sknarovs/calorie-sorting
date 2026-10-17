const test = require('node:test');
const assert = require('node:assert/strict');
const { installSwapHook, markReload, consumeReload } = require('../../barbora-calorie-sort.user.js');
const { fakeStorage } = require('./helpers');

const record = { products: [{ id: '1' }, { id: '2' }, { id: '3' }] };

test('installSwapHook hands the saved list to a later assignment', () => {
  const win = {};
  const swap = installSwapHook(win, record);
  assert.equal(swap.swapped, false);
  win.b_productList = [{ id: '1' }];
  assert.equal(win.b_productList, record.products);
  assert.deepEqual(swap.original, [{ id: '1' }]);
  assert.equal(swap.swapped, true);
});

test('installSwapHook swaps immediately when the list already exists', () => {
  const original = [{ id: '1' }];
  const win = { b_productList: original };
  const swap = installSwapHook(win, record);
  assert.equal(win.b_productList, record.products);
  assert.equal(swap.original, original);
  assert.equal(swap.swapped, true);
});

test('installSwapHook reports no swap when the property cannot be redefined', () => {
  const win = {};
  Object.defineProperty(win, 'b_productList', { value: undefined, writable: true, configurable: false });
  const swap = installSwapHook(win, record);
  win.b_productList = [{ id: '1' }];
  assert.equal(swap.swapped, false);
  assert.deepEqual(win.b_productList, [{ id: '1' }]);
});

test('consumeReload is true once, within the window', () => {
  const s = fakeStorage();
  markReload(s, 1000);
  assert.equal(consumeReload(s, 15_000), true);
  assert.equal(consumeReload(s, 15_500), false);
  markReload(s, 0);
  assert.equal(consumeReload(s, 16_000), false);
  assert.equal(consumeReload(fakeStorage(), 1), false);
});
