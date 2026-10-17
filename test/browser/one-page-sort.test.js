const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const VISTAS = '/gala-zivs-un-gatava-kulinarija/svaiga-putnu-gala/vistas-gala';
const THIGHS = '000000000001223665';

async function sortedVistas(browser, dir = 'asc') {
  const page = await h.openCategory(browser, VISTAS);
  await h.waitForBadges(page);
  await page.select('select.b-orderby', `bcs-kcal-${dir}`);
  await page.waitForFunction((d) => location.hash === `#kcal-${d}`, {}, dir);
  return page;
}

test('calories low to high sorts in place and survives a reload', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await sortedVistas(browser);
    h.assertCalorieOrder(await h.readCards(page), 'asc');
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'bcs-kcal-asc');
    assert.equal(await page.$eval('option[value="bcs-kcal-asc"]', (o) => o.textContent), 'Kalorijas (augoši)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('li[data-cnstrc-item-id]');
    await h.waitForBadges(page);
    await page.waitForFunction(() => [...document.querySelectorAll('li[data-cnstrc-item-id]')].some((li) => getComputedStyle(li).order !== '0'));
    h.assertCalorieOrder(await h.readCards(page), 'asc');
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'bcs-kcal-asc');
  } finally { await close(); }
});

test('sorts on complete data when chosen right away', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS); // no waiting for badges
    await page.select('select.b-orderby', 'bcs-kcal-desc');
    await page.waitForFunction(() => location.hash === '#kcal-desc');
    await h.waitForBadges(page);
    h.assertCalorieOrder(await h.readCards(page), 'desc');
    const fetched = await h.productFetches(page);
    assert.equal(new Set(fetched).size, fetched.length, 'no product page fetched twice');
  } finally { await close(); }
});

test('a re-rendered card keeps its sort position', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await sortedVistas(browser);
    const order = (await h.readCards(page)).find((c) => c.id === THIGHS).order;
    await page.evaluate((id) => {
      const li = document.querySelector(`li[data-cnstrc-item-id="${id}"]`);
      const clone = li.cloneNode(true);
      clone.removeAttribute('style');
      clone.querySelectorAll('.bcs-badge').forEach((b) => b.remove());
      li.replaceWith(clone);
    }, THIGHS);
    await page.waitForFunction((id, o) => {
      const li = document.querySelector(`li[data-cnstrc-item-id="${id}"]`);
      return li && li.querySelector('.bcs-badge') && getComputedStyle(li).order === String(o);
    }, { timeout: 5000 }, THIGHS, order);
  } finally { await close(); }
});

test('picking a native option returns to the site sorting', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await sortedVistas(browser);
    // Dropping the marker is itself a (same-document) navigation, so wait for the site's own reload.
    await Promise.all([page.waitForResponse((r) => r.url().includes('order=priceAsc')), page.select('select.b-orderby', 'priceAsc')]);
    await page.waitForFunction(() => location.search.includes('order=priceAsc'));
    const url = await h.currentUrl(page);

    assert.equal(url.searchParams.get('order'), 'priceAsc');
    assert.equal(url.hash, '');
    await page.waitForSelector('li[data-cnstrc-item-id]');
    await h.waitForBadges(page);
    assert.ok((await h.readCards(page)).every((c) => c.order === 0));
  } finally { await close(); }
});

test('the Russian site gets Russian labels', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS, { lang: 'ru' });
    await h.waitForBadges(page);
    const options = await page.$$eval('select.b-orderby option', (os) => os.map((o) => o.textContent));
    assert.ok(options.includes('Калорийности от самой низкой'));
    assert.ok(options.includes('Калорийности от самой высокой'));
    assert.equal((await h.readCards(page)).find((c) => c.id === THIGHS).text, '172 ккал · 17 г белка'); // snapshot 2026-10-17
  } finally { await close(); }
});

test('rate limiting shows the notice and marks unloaded products with ?', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS, {
      intercept: (req) => (new URL(req.url()).pathname.startsWith('/produkti/') ? { status: 429 } : undefined),
    });
    await page.waitForFunction(() => document.querySelector('.bcs-status')?.textContent.includes('Barbora ierobežo pieprasījumus'), { timeout: 60_000 });
    await h.waitForBadges(page);
    assert.ok((await h.readCards(page)).every((c) => c.kind === 'failed'));
  } finally { await close(); }
});
