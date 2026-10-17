const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const VISTAS = '/gala-zivs-un-gatava-kulinarija/svaiga-putnu-gala/vistas-gala';
const YOGURTS = '/piena-produkti-un-olas/jogurti-un-deserti/jogurts-ar-piedevam'; // 84 products on 2 pages, 2026-10-17
const THIGHS = '000000000001223665';
const LIMITED = () => document.querySelector('.bcs-status')?.textContent.includes('Barbora ierobežo pieprasījumus');
const all429 = (req) => (new URL(req.url()).pathname.startsWith('/produkti/') ? { status: 429 } : undefined);

async function sortBy(page, dir) {
  await page.select('select.b-orderby', `bcs-kcal-${dir}`);
  await page.waitForFunction((d) => location.hash === `#kcal-${d}`, { timeout: 120_000 }, dir);
  await h.waitForBoxes(page);
}

test('calories low to high sorts in place and survives a reload', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    h.assertCalorieOrder(await h.readCards(page), 'asc');
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'bcs-kcal-asc');
    assert.equal(await page.$eval('option[value="bcs-kcal-asc"]', (o) => o.textContent), 'Kalorijas (augoši)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('li[data-cnstrc-item-id]');
    await h.waitForBoxes(page);
    await page.waitForFunction(() => [...document.querySelectorAll('li[data-cnstrc-item-id]')].some((li) => getComputedStyle(li).order !== '0'));
    h.assertCalorieOrder(await h.readCards(page), 'asc');
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'bcs-kcal-asc');
  } finally { await close(); }
});

test('sorts on complete data when chosen right away', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'desc');
    h.assertCalorieOrder(await h.readCards(page), 'desc');
    const fetched = await h.productFetches(page);
    assert.equal(new Set(fetched).size, fetched.length, 'no product page fetched twice');
  } finally { await close(); }
});

test('switching direction re-sorts without loading again', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    const loaded = (await h.productFetches(page)).length;
    await sortBy(page, 'desc');
    h.assertCalorieOrder(await h.readCards(page), 'desc');
    assert.equal((await h.productFetches(page)).length, loaded);
  } finally { await close(); }
});

test('a re-rendered card keeps its sort position', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    const order = (await h.readCards(page)).find((c) => c.id === THIGHS).order;
    await page.evaluate((id) => {
      const li = document.querySelector(`li[data-cnstrc-item-id="${id}"]`);
      const clone = li.cloneNode(true);
      clone.removeAttribute('style');
      clone.querySelectorAll('.bcs-box').forEach((b) => b.remove());
      li.replaceWith(clone);
    }, THIGHS);
    await page.waitForFunction((id, o) => {
      const li = document.querySelector(`li[data-cnstrc-item-id="${id}"]`);
      return li && li.querySelector('.bcs-box') && getComputedStyle(li).order === String(o);
    }, { timeout: 5000 }, THIGHS, order);
  } finally { await close(); }
});

test('after a unit-price sort, calorie sort reorders that page only', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, `${YOGURTS}?order=comparativePriceAsc`);
    const cheapestPage = await page.$$eval('li[data-cnstrc-item-id]', (lis) => lis
      .filter((li) => !li.parentElement.closest('li')).map((li) => li.getAttribute('data-cnstrc-item-id')));
    let listingFetches = 0;
    page.on('request', (req) => {
      if (!req.isNavigationRequest() && new URL(req.url()).pathname === YOGURTS) listingFetches++;
    });
    await page.evaluate(() => { window.__bcsNoReload = true; });
    await sortBy(page, 'asc');
    const cards = await h.readCards(page);
    assert.deepEqual(cards.map((c) => c.id).sort(), [...cheapestPage].sort(), 'the same cheapest-per-unit products');
    h.assertCalorieOrder(cards, 'asc');
    assert.equal(await page.evaluate(() => window.__bcsNoReload), true, 'no reload');
    assert.equal(listingFetches, 0, 'no other pages of the category are loaded');
    assert.equal((await h.currentUrl(page)).searchParams.get('order'), 'comparativePriceAsc');
  } finally { await close(); }
});

test('loads at most 2 product pages at a time, at least 0.3 s apart', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    // Measured inside the page: request events reach Node with jitter of tens of milliseconds.
    const before = () => {
      const log = { starts: [], active: 0, maxActive: 0 };
      window.__bcsFetchLog = log;
      const realFetch = window.fetch;
      window.fetch = function (input, init) {
        if (!String(input instanceof Request ? input.url : input).includes('/produkti/')) return realFetch.call(this, input, init);
        log.starts.push(performance.now());
        log.active += 1;
        log.maxActive = Math.max(log.maxActive, log.active);
        return realFetch.call(this, input, init).finally(() => { log.active -= 1; });
      };
    };
    const page = await h.openCategory(browser, VISTAS, { productDelayMs: 400, before });
    await sortBy(page, 'asc');
    const log = await page.evaluate(() => window.__bcsFetchLog);
    assert.ok(log.starts.length >= 20);
    assert.ok(log.maxActive <= 2, `at most 2 at once, saw ${log.maxActive}`);
    const gaps = log.starts.slice(1).map((t, i) => t - log.starts[i]);
    assert.ok(Math.min(...gaps) >= 295, `requests at least 0.3 s apart, smallest gap ${Math.min(...gaps)} ms`);
  } finally { await close(); }
});

test('picking a native option returns to the site sorting', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    // Dropping the marker is itself a (same-document) navigation, so wait for the site's own reload.
    await Promise.all([page.waitForResponse((r) => r.url().includes('order=priceAsc')), page.select('select.b-orderby', 'priceAsc')]);
    await page.waitForFunction(() => location.search.includes('order=priceAsc'));
    const url = await h.currentUrl(page);
    assert.equal(url.searchParams.get('order'), 'priceAsc');
    assert.equal(url.hash, '');
    await page.waitForSelector('li[data-cnstrc-item-id]');
    assert.ok((await h.readCards(page)).every((c) => c.order === 0));
  } finally { await close(); }
});

test('the Russian site gets Russian labels', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS, { lang: 'ru' });
    const options = await page.$$eval('select.b-orderby option', (os) => os.map((o) => o.textContent));
    assert.ok(options.includes('Калорийности от самой низкой'));
    assert.ok(options.includes('Калорийности от самой высокой'));
    await sortBy(page, 'asc');
    assert.equal((await h.readCards(page)).find((c) => c.id === THIGHS).text, '172 ккал · 17 г белка'); // snapshot 2026-10-17
  } finally { await close(); }
});

test('rate limiting shows the notice and marks unloaded products with ?', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS, { intercept: all429 });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForFunction(LIMITED, { timeout: 60_000 });
    await h.waitForBoxes(page);
    assert.ok((await h.readCards(page)).every((c) => c.kind === 'failed'));
  } finally { await close(); }
});

test('after rate limiting, the next sort does not fetch while the cooldown lasts', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS, { intercept: all429 });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForFunction(LIMITED, { timeout: 60_000 });
    await page.reload({ waitUntil: 'domcontentloaded' }); // the marker sorts again on load
    await page.waitForSelector('li[data-cnstrc-item-id]');
    await page.waitForFunction(LIMITED, { timeout: 30_000 });
    await h.waitForBoxes(page);
    assert.equal((await h.productFetches(page)).length, 0, 'no product pages requested during the cooldown');
  } finally { await close(); }
});

test('a recommendations row in the grid gets no boxes and follows the sorted cards', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    // What the site inserts for logged-in users after "Pievienot": a full-width row holding a
    // carousel of other products, whose items also carry data-cnstrc-item-id.
    await page.evaluate(() => {
      const grid = document.querySelector('li[data-cnstrc-item-id]').parentElement;
      const row = document.createElement('li');
      row.id = 'bcs-test-carousel';
      row.className = 'tw-col-span-2 tw-w-full tw-list-none md:tw-col-span-4';
      row.innerHTML = '<ul><li class="b-carousel--item" data-cnstrc-item="recommendation" data-cnstrc-item-id="000000000099999999"><div itemprop="offers"></div></li></ul>';
      grid.insertBefore(row, grid.children[4] || null);
    });
    await sortBy(page, 'asc');
    const seen = await page.evaluate(() => {
      const row = document.getElementById('bcs-test-carousel');
      const cardOrders = [...row.parentElement.children].filter((li) => li !== row).map((li) => Number(getComputedStyle(li).order));
      return { boxes: row.querySelectorAll('.bcs-box').length, rowOrder: Number(getComputedStyle(row).order), lastCardOrder: Math.max(...cardOrders) };
    });
    assert.equal(seen.boxes, 0, 'carousel products are not cards');
    assert.ok(seen.rowOrder > seen.lastCardOrder, `row order ${seen.rowOrder} should follow every card (${seen.lastCardOrder})`);
  } finally { await close(); }
});
