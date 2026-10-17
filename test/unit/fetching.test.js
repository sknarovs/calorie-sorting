const test = require('node:test');
const assert = require('node:assert/strict');
const { runPool, fetchNutrition } = require('../../barbora-calorie-sort.user.js');

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

test('runPool keeps the starts of its workers at least minSpacingMs apart', async () => {
  let clock = 0;
  const starts = [];
  await runPool([1, 2, 3, 4, 5], async (n) => { starts.push(clock); await tick(); return n; }, {
    concurrency: 2, minSpacingMs: 300, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(starts.length, 5);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 300, `start ${i} came ${starts[i] - starts[i - 1]} ms after the previous one`);
  }
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

test('fetchNutrition treats a Cloudflare challenge as rate limiting, a plain 403 as failed', async () => {
  const challenge = async () => ({ ok: false, status: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }), text: async () => '<title>Just a moment...</title>' });
  assert.deepEqual(await fetchNutrition('/p', { fetch: challenge, sleep: noSleep }), { status: 'rateLimited' });
  const forbidden = async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => '' });
  assert.deepEqual(await fetchNutrition('/p', { fetch: forbidden, sleep: noSleep }), { status: 'failed' });
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
