const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const YOGURTS = '/piena-produkti-un-olas/jogurti-un-deserti/jogurts-ar-piedevam'; // 84 products on 2 pages, 2026-10-17

async function openYogurts(browser, options) {
  const page = await h.openCategory(browser, YOGURTS, options);
  const page1Ids = await page.evaluate(() => window.b_productList.map((p) => p.id));
  const total = await page.$eval('.b-category-children--active .b-category-children--count', (e) => Number(e.textContent));
  assert.ok(total > 52, 'the category must span two pages');
  await h.waitForBadges(page);
  return { page, page1Ids, total };
}

test('calories low to high shows the whole category, sorted, with working Pievienot', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const { page, page1Ids, total } = await openYogurts(browser);
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForSelector('html.bcs-all-sorted', { timeout: 120_000 });
    await h.waitForBadges(page);
    const cards = await h.readCards(page);
    assert.equal(cards.length, total);
    h.assertCalorieOrder(cards, 'asc');
    assert.ok(await page.$$eval('ul.pagination', (uls) => uls.every((u) => getComputedStyle(u).display === 'none')));
    assert.ok((await page.$eval('.bcs-status', (e) => e.textContent)).includes(`Visas preces (${total}) sakārtotas pēc kalorijām`));
    assert.equal((await h.currentUrl(page)).hash, '#kcal-asc');
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'bcs-kcal-asc');
    await page.$eval('.bcs-status', (el) => { el.scrollIntoView(); window.scrollBy(0, -150); }); // clear of the sticky header
    await page.screenshot({ path: h.shot('all-sorted.png') });
    const fromPage1 = cards.find((c) => page1Ids.includes(c.id)).id;
    const fromPage2 = cards.find((c) => !page1Ids.includes(c.id)).id;
    for (const id of [fromPage1, fromPage2]) { // anonymous visitors get the site's login prompt
      await page.$eval(`li[data-cnstrc-item-id="${id}"] button[data-cnstrc-btn="add_to_cart"]`, (b) => b.click());
      await page.waitForSelector('#fti-pop-up-modal .b-next-registration-container', { visible: true, timeout: 10_000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector('#fti-pop-up-modal', { hidden: true, timeout: 10_000 });
    }
  } finally { await close(); }
});

test('a failing listing page falls back to sorting this page', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const { page } = await openYogurts(browser, { intercept: (req) => (req.url().includes('page=2') ? 'abort' : undefined) });
    await page.evaluate(() => { window.__bcsNoReload = true; });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForFunction(() => document.querySelector('.bcs-status')?.textContent.includes('Neizdevās parādīt visas lapas'), { timeout: 60_000 });
    assert.equal(await page.evaluate(() => window.__bcsNoReload), true);
    const cards = await h.readCards(page);
    assert.equal(cards.length, 52);
    h.assertCalorieOrder(cards, 'asc');
    assert.equal(await page.$('html.bcs-all-sorted'), null);
  } finally { await close(); }
});

test('falls back without a second reload when the swap fails', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const before = () => Object.defineProperty(window, 'b_productList', { value: undefined, writable: true, configurable: false });
    const { page } = await openYogurts(browser, { before });
    await page.evaluate(() => { window.__bcsOldDocument = true; });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    // Wait for the script's one reload: a new document (no flag) that has cards.
    await page.waitForFunction(() => !window.__bcsOldDocument && document.querySelector('li[data-cnstrc-item-id]'), { timeout: 120_000 });
    await page.evaluate(() => { window.__bcsNoReload = true; });
    await page.waitForFunction(() => document.querySelector('.bcs-status')?.textContent.includes('Neizdevās parādīt visas lapas'), { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(await page.evaluate(() => window.__bcsNoReload), true, 'no second reload');
    await h.waitForBadges(page);
    const cards = await h.readCards(page);
    assert.equal(cards.length, 52);
    h.assertCalorieOrder(cards, 'asc');
  } finally { await close(); }
});
