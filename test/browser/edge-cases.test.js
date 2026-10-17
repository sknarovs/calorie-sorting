const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const YOGURTS = '/piena-produkti-un-olas/jogurti-un-deserti/jogurts-ar-piedevam'; // 84 products, 2026-10-17
const YOGURTS_AND_DESSERTS = '/piena-produkti-un-olas/jogurti-un-deserti'; // about 200 products, 2026-10-17
const DAIRY = '/piena-produkti-un-olas'; // about 970 products, 2026-10-17

test('cancel leaves the page as it was', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    // Replayed product pages are near-instant; slow them so there is time to press Cancel.
    const page = await h.openCategory(browser, YOGURTS_AND_DESSERTS, { productDelayMs: 150 });
    await h.waitForBadges(page);
    await page.evaluate(() => { window.__bcsNoReload = true; });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForFunction(() => {
      const s = document.querySelector('.bcs-status');
      return s && s.textContent.includes('Ielādē uzturvērtību') && s.querySelector('.bcs-status__action');
    }, { timeout: 60_000, polling: 100 });
    await page.click('.bcs-status .bcs-status__action');
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await page.evaluate(() => window.__bcsNoReload), true);
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'default');
    assert.equal((await h.currentUrl(page)).hash, '');
    assert.equal(await page.$('.bcs-status:not([hidden])'), null);
    assert.ok((await h.readCards(page)).every((c) => c.order === 0));
  } finally { await close(); }
});

test('declining the question loads nothing more', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, DAIRY);
    let message = null;
    page.on('dialog', async (d) => { message = d.message(); await d.dismiss(); });
    await h.waitForBadges(page);
    const before = (await h.productFetches(page)).length;
    await page.evaluate(() => { window.__bcsNoReload = true; });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await h.waitUntil(() => message !== null, 120_000);
    await new Promise((r) => setTimeout(r, 3000));
    assert.match(message, /^Ielādējamo preču lapu skaits: \d+ \(apmēram \d+ s\)\. Turpināt\?$/);
    assert.equal(await page.evaluate(() => window.__bcsNoReload), true);
    assert.equal((await h.productFetches(page)).length, before);
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'default');
    assert.equal(await page.$('.bcs-status:not([hidden])'), null);
  } finally { await close(); }
});

test('switching direction in the whole-category view re-sorts without fetching', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, YOGURTS);
    const total = await page.$eval('.b-category-children--active .b-category-children--count', (e) => Number(e.textContent));
    await h.waitForBadges(page);
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForSelector('html.bcs-all-sorted', { timeout: 120_000 });
    await page.evaluate(() => { window.__bcsOldDocument = true; });
    let listingFetches = 0; // the script's own fetches of category pages (not navigations)
    page.on('request', (req) => {
      if (!req.isNavigationRequest() && new URL(req.url()).pathname === YOGURTS) listingFetches++;
    });
    await page.select('select.b-orderby', 'bcs-kcal-desc');
    // The old document is already all-sorted, so wait for the new one.
    await page.waitForFunction(() => !window.__bcsOldDocument && document.documentElement.classList.contains('bcs-all-sorted'), { timeout: 60_000 });
    await h.waitForBadges(page);
    const cards = await h.readCards(page);
    assert.equal(cards.length, total);
    h.assertCalorieOrder(cards, 'desc');
    assert.equal(listingFetches, 0, 'switching re-sorts the saved list without collecting the pages again');
    assert.equal((await h.productFetches(page)).length, 0);
    assert.equal((await h.currentUrl(page)).hash, '#kcal-desc');
  } finally { await close(); }
});
