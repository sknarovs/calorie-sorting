const test = require('node:test');
const assert = require('node:assert/strict');
const { runPool, fetchNutrition, collectCategory } = require('../../barbora-calorie-sort.user.js');

const tick = () => new Promise((r) => setImmediate(r));
const noSleep = async () => {};
const page = (status, body = '') => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const productHtml = '<script>window.product = {"nutrients":[{"Name":"E","Amounts":[{"Amount":172,"UnitName":"Kcal"}]},'
  + '{"Name":"Olbaltumvielas","Amounts":[{"Amount":17,"UnitName":"g"}]}]};</script>';

test('runPool runs every item, at most `concurrency` at once, reporting progress', async () => {
  let inFlight = 0; let maxInFlight = 0; const progress = [];
  const { results, cancelled, rateLimited } = await runPool([1, 2, 3, 4, 5, 6, 7], async (n) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await tick(); inFlight--; return n * 10;
  }, { concurrency: 3, onResult: (item, result, done, total) => progress.push([done, total]) });
  assert.equal(maxInFlight, 3);
  assert.deepEqual([...results.entries()].sort((a, b) => a[0] - b[0]), [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60], [7, 70]]);
  assert.deepEqual(progress.at(-1), [7, 7]);
  assert.equal(cancelled, false);
  assert.equal(rateLimited, false);
});

test('runPool starts nothing new once the signal aborts', async () => {
  const ac = new AbortController(); const started = [];
  const { results, cancelled } = await runPool([1, 2, 3, 4, 5], async (n) => {
    started.push(n); if (n === 2) ac.abort(); await tick(); return n;
  }, { concurrency: 1, signal: ac.signal });
  assert.equal(cancelled, true);
  assert.deepEqual(started, [1, 2]);
  assert.equal(results.has(3), false);
});

test('runPool backs off once, then runs one at a time and retries the item', async () => {
  const sleeps = []; const calls = []; let limited = false; let inFlight = 0; let maxAfter = 0;
  const { results, rateLimited } = await runPool(['a', 'b', 'c', 'd', 'e'], async (id) => {
    calls.push(id); inFlight++;
    if (limited) maxAfter = Math.max(maxAfter, inFlight);
    if (id === 'b' && !limited) { limited = true; inFlight--; return 'LIMIT'; }
    await tick(); inFlight--; return id.toUpperCase();
  }, { concurrency: 2, isRateLimited: (r) => r === 'LIMIT', sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(rateLimited, false);
  assert.deepEqual(sleeps, [5000]);
  assert.deepEqual([...results.values()].sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(calls.filter((c) => c === 'b').length, 2);
  assert.equal(maxAfter, 1);
});

test('runPool gives up after 3 rate-limited answers in a row', async () => {
  const { results, rateLimited } = await runPool(['a', 'b', 'c', 'd', 'e'], async () => 'LIMIT',
    { concurrency: 2, isRateLimited: (r) => r === 'LIMIT', sleep: noSleep });
  assert.equal(rateLimited, true);
  assert.equal(results.size, 0);
});

test('fetchNutrition maps product pages to ok and none', async () => {
  assert.deepEqual(await fetchNutrition('/produkti/x', { fetch: page(200, productHtml), sleep: noSleep }), { status: 'ok', kcal: 172, protein: 17 });
  assert.deepEqual(await fetchNutrition('/produkti/x', { fetch: page(200, '<script>window.product = {"nutrients":[]};</script>'), sleep: noSleep }), { status: 'none' });
});

test('fetchNutrition: 404 and unreadable pages fail without a retry', async () => {
  let calls = 0;
  const f404 = async () => { calls++; return page(404)(); };
  assert.deepEqual(await fetchNutrition('/p', { fetch: f404, sleep: noSleep }), { status: 'failed' });
  assert.equal(calls, 1);
  assert.deepEqual(await fetchNutrition('/p', { fetch: page(200, '<p>Lapa nav atrasta</p>'), sleep: noSleep }), { status: 'failed' });
});

test('fetchNutrition: 429 and 503 are rateLimited', async () => {
  assert.deepEqual(await fetchNutrition('/p', { fetch: page(429), sleep: noSleep }), { status: 'rateLimited' });
  assert.deepEqual(await fetchNutrition('/p', { fetch: page(503), sleep: noSleep }), { status: 'rateLimited' });
});

test('fetchNutrition retries once after a network error or a 500', async () => {
  const sleeps = []; let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new TypeError('NetworkError'); return page(200, productHtml)(); };
  assert.deepEqual(await fetchNutrition('/p', { fetch: flaky, sleep: async (ms) => { sleeps.push(ms); } }), { status: 'ok', kcal: 172, protein: 17 });
  assert.deepEqual(sleeps, [1000]);
  let c500 = 0;
  assert.deepEqual(await fetchNutrition('/p', { fetch: async () => { c500++; return page(500)(); }, sleep: noSleep }), { status: 'failed' });
  assert.equal(c500, 2);
});

test('fetchNutrition times out a hanging request', async () => {
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.deepEqual(await fetchNutrition('/p', { fetch: hang, timeoutMs: 20, sleep: noSleep }), { status: 'failed' });
});

test('fetchNutrition does not retry after the caller aborts', async () => {
  const ac = new AbortController(); ac.abort(); let calls = 0;
  const f = async (url, { signal }) => { calls++; throw signal.reason; };
  assert.deepEqual(await fetchNutrition('/p', { fetch: f, signal: ac.signal, sleep: noSleep }), { status: 'failed' });
  assert.ok(calls <= 1);
});

const listing = (items) => `<script>window.b_productList = ${JSON.stringify(items.map((i) => (typeof i === 'string' ? { id: i, Url: `p-${i}` } : i)))};</script>`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
function fakeSite(pages) {
  const requested = [];
  const fetch = async (url) => { requested.push(url); return { ok: true, status: 200, text: async () => listing(pages[url] ?? []) }; };
  return { fetch, requested };
}
const loc = (search = '') => ({ pathname: '/c', search });

test('collectCategory gathers pages until a short page, keeping filters', async () => {
  const site = fakeSite({ '/c?brand=1': range(1, 52), '/c?brand=1&page=2': range(53, 104), '/c?brand=1&page=3': range(105, 110) });
  const loaded = [];
  const products = await collectCategory(loc('?brand=1&order=priceAsc&page=2'), { fetch: site.fetch, onPage: (n) => loaded.push(n), sleep: noSleep });
  assert.deepEqual(products.map((p) => p.id), range(1, 110));
  assert.deepEqual(site.requested, ['/c?brand=1', '/c?brand=1&page=2', '/c?brand=1&page=3']);
  assert.deepEqual(loaded, [1, 2, 3]);
});

test('collectCategory stops at an empty page and at a page with nothing new', async () => {
  const a = fakeSite({ '/c': range(1, 52), '/c?page=2': range(53, 104), '/c?page=3': [] });
  assert.equal((await collectCategory(loc(), { fetch: a.fetch, sleep: noSleep })).length, 104);
  const b = fakeSite({ '/c': range(1, 52), '/c?page=2': range(1, 52) });
  assert.equal((await collectCategory(loc(), { fetch: b.fetch, sleep: noSleep })).length, 52);
});

test('collectCategory drops banners and duplicates', async () => {
  const site = fakeSite({ '/c': ['1', '2', { id: 'b1', isBanner: true }, '2', '3'] });
  assert.deepEqual((await collectCategory(loc(), { fetch: site.fetch, sleep: noSleep })).map((p) => p.id), ['1', '2', '3']);
});

test('collectCategory stops at the 60-page cap', async () => {
  const pages = {};
  for (let n = 1; n <= 70; n++) pages[n === 1 ? '/c' : `/c?page=${n}`] = range((n - 1) * 52 + 1, n * 52);
  const site = fakeSite(pages);
  assert.equal((await collectCategory(loc(), { fetch: site.fetch, sleep: noSleep })).length, 60 * 52);
  assert.ok(site.requested.every((u) => !/page=(6[1-9]|70)$/.test(u)));
});

test('collectCategory retries a failing listing page once, then rejects', async () => {
  let calls = 0;
  const fetch = async (url) => {
    if (url === '/c?page=2') { calls++; throw new TypeError('NetworkError'); }
    return { ok: true, status: 200, text: async () => listing(url === '/c' ? range(1, 52) : []) };
  };
  await assert.rejects(collectCategory(loc(), { fetch, sleep: noSleep }));
  assert.equal(calls, 2);
});

test('collectCategory rejects a page without a product list, and rejects with AbortError when cancelled', async () => {
  await assert.rejects(collectCategory(loc(), { fetch: page(200, '<p>no list</p>'), sleep: noSleep }));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(collectCategory(loc(), { fetch: fakeSite({ '/c': range(1, 5) }).fetch, signal: ac.signal, sleep: noSleep }), { name: 'AbortError' });
});
