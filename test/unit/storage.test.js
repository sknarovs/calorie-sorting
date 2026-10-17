const test = require('node:test');
const assert = require('node:assert/strict');
const { isFresh, NutritionCache, saveList, loadList } = require('../../barbora-calorie-sort.user.js');
const { fakeStorage } = require('./helpers');

const DAY = 86_400_000;
const KEY = 'bcs:nutrition:v1';
const stored = (s) => JSON.parse(s.getItem(KEY));

test('isFresh: 30 days with data, 7 days without', () => {
  const now = 100 * DAY;
  assert.equal(isFresh({ k: 172, p: 17, t: now - 29 * DAY }, now), true);
  assert.equal(isFresh({ k: 172, p: 17, t: now - 31 * DAY }, now), false);
  assert.equal(isFresh({ k: null, p: null, t: now - 6 * DAY }, now), true);
  assert.equal(isFresh({ k: null, p: null, t: now - 8 * DAY }, now), false);
});

test('NutritionCache keeps ok and none, ignores failed, expires no-data first', () => {
  const s = fakeStorage();
  let now = 1000;
  const c = new NutritionCache(s, { now: () => now });
  c.put('1', { status: 'ok', kcal: 172, protein: 17 });
  c.put('2', { status: 'none' });
  c.put('3', { status: 'failed' });
  c.flush();
  const c2 = new NutritionCache(s, { now: () => now });
  assert.deepEqual(c2.get('1'), { status: 'ok', kcal: 172, protein: 17 });
  assert.deepEqual(c2.get('2'), { status: 'none' });
  assert.equal(c2.get('3'), undefined);
  now += 8 * DAY;
  assert.equal(c2.get('2'), undefined);
  assert.deepEqual(c2.get('1'), { status: 'ok', kcal: 172, protein: 17 });
});

test('NutritionCache flushes by itself every 20 puts', () => {
  const s = fakeStorage();
  const c = new NutritionCache(s, { now: () => 1 });
  for (let i = 0; i < 19; i++) c.put(String(i), { status: 'none' });
  assert.equal(s.getItem(KEY), null);
  c.put('19', { status: 'none' });
  assert.equal(Object.keys(stored(s)).length, 20);
});

test('flush merges with what another tab wrote', () => {
  const s = fakeStorage();
  const a = new NutritionCache(s, { now: () => 1 });
  const b = new NutritionCache(s, { now: () => 2 });
  a.put('1', { status: 'none' }); a.flush();
  b.put('2', { status: 'none' }); b.flush();
  assert.deepEqual(Object.keys(stored(s)).sort(), ['1', '2']);
});

test('flush keeps at most maxEntries, dropping the oldest', () => {
  const s = fakeStorage();
  let now = 0;
  const c = new NutritionCache(s, { now: () => now, maxEntries: 3 });
  for (const id of ['a', 'b', 'c', 'd']) { now += 1; c.put(id, { status: 'none' }); }
  c.flush();
  assert.deepEqual(Object.keys(stored(s)).sort(), ['b', 'c', 'd']);
});

test('on a quota error flush drops the oldest quarter and retries once', () => {
  const s = fakeStorage({ reject: (v) => Object.keys(JSON.parse(v)).length > 3 });
  let now = 0;
  const c = new NutritionCache(s, { now: () => now });
  for (const id of ['a', 'b', 'c', 'd']) { now += 1; c.put(id, { status: 'none' }); }
  c.flush();
  assert.deepEqual(Object.keys(stored(s)).sort(), ['b', 'c', 'd']);
});

test('when storage stays full the cache keeps working from memory', () => {
  const s = fakeStorage({ reject: () => true });
  const c = new NutritionCache(s, { now: () => 1 });
  c.put('a', { status: 'ok', kcal: 10, protein: 1 });
  assert.doesNotThrow(() => c.flush());
  assert.deepEqual(c.get('a'), { status: 'ok', kcal: 10, protein: 1 });
});

const record = { key: '/a?brand=1', dir: 'asc', savedAt: 1000, products: [{ id: '1' }], failed: ['2'], rateLimited: false };

test('saveList and loadList round-trip a matching, fresh list', () => {
  const s = fakeStorage();
  assert.equal(saveList(s, record), true);
  assert.deepEqual(loadList(s, '/a?brand=1', 'asc', 1000 + 29 * 60_000), record);
});

test('loadList rejects another key, another direction and lists older than 30 minutes', () => {
  const s = fakeStorage();
  saveList(s, record);
  assert.equal(loadList(s, '/b', 'asc', 1001), null);
  assert.equal(loadList(s, '/a?brand=1', 'desc', 1001), null);
  assert.equal(loadList(s, '/a?brand=1', 'asc', 1000 + 31 * 60_000), null);
});

test('saveList returns false when storage is full; loadList ignores corrupt data', () => {
  const s = fakeStorage({ reject: () => true });
  assert.equal(saveList(s, record), false);
  s.data.set('bcs:list:v1', '{not json');
  assert.equal(loadList(s, '/a?brand=1', 'asc', 1001), null);
});
