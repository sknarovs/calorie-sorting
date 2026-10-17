const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const VISTAS = '/gala-zivs-un-gatava-kulinarija/svaiga-putnu-gala/vistas-gala';
const THIGHS = '000000000001223665'; // Cāļa šķiņķi atkauloti bez ādas WELL DONE 500g
const THIGHS_LV = '172 kcal · 17 g olb.'; // snapshot 2026-10-17

async function sortBy(page, dir) {
  await page.select('select.b-orderby', `bcs-kcal-${dir}`);
  await page.waitForFunction((d) => location.hash === `#kcal-${d}`, { timeout: 60_000 }, dir);
  await h.waitForBoxes(page);
}

test('opening a category loads no nutrition until you sort', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await h.productFetches(page)).length, 0, 'no product pages requested while browsing');
    assert.equal(await page.$$eval('.bcs-box', (boxes) => boxes.length), 0);
  } finally { await close(); }
});

test('sorting loads the values and puts each box next to the price', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    const cards = await h.readCards(page);
    assert.ok(cards.length >= 20);
    assert.ok(cards.every((c) => ['ok', 'none', 'failed'].includes(c.kind)));
    assert.ok(cards.some((c) => c.text === 'nav datu'));
    assert.equal(cards.find((c) => c.id === THIGHS).text, THIGHS_LV);
    const fetched = await h.productFetches(page);
    assert.equal(new Set(fetched).size, fetched.length, 'no product page fetched twice');
    const layout = await page.evaluate((id) => {
      const offers = document.querySelector(`li[data-cnstrc-item-id="${id}"] [itemprop="offers"]`);
      const price = offers.querySelector(':scope > div').getBoundingClientRect();
      const box = offers.querySelector(':scope > .bcs-box').getBoundingClientRect();
      return { price: { top: price.top, right: price.right, height: price.height }, box: { top: box.top, left: box.left, height: box.height } };
    }, THIGHS);
    assert.ok(Math.abs(layout.box.top - layout.price.top) <= 2, `box top ${layout.box.top} vs price top ${layout.price.top}`);
    assert.ok(layout.box.left >= layout.price.right, 'the box sits to the right of the price');
    assert.ok(Math.abs(layout.box.height - layout.price.height) <= 2, `box height ${layout.box.height} vs price height ${layout.price.height}`);
    await page.$eval('#category-page-results-placeholder', (el) => el.scrollIntoView());
    await page.screenshot({ path: h.shot('boxes.png') });
  } finally { await close(); }
});

test('saved values show on the next visit without any requests', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    const known = (await h.readCards(page)).filter((c) => c.kind === 'ok' || c.kind === 'none').length;
    await page.goto(h.SITE + VISTAS, { waitUntil: 'domcontentloaded' }); // no marker: just browsing again
    await page.waitForSelector('li[data-cnstrc-item-id]');
    await page.waitForFunction((n) => document.querySelectorAll('.bcs-box').length >= n, { timeout: 10_000 }, known);
    assert.equal((await h.productFetches(page)).length, 0);
    assert.equal((await h.readCards(page)).find((c) => c.id === THIGHS).text, THIGHS_LV);
  } finally { await close(); }
});

test('a card re-rendered by the site gets its box back', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await sortBy(page, 'asc');
    await page.evaluate((id) => {
      const li = document.querySelector(`li[data-cnstrc-item-id="${id}"]`);
      const clone = li.cloneNode(true);
      clone.querySelectorAll('.bcs-box').forEach((b) => b.remove());
      li.replaceWith(clone);
    }, THIGHS);
    await page.waitForFunction((id) => document.querySelector(`li[data-cnstrc-item-id="${id}"] .bcs-box`), { timeout: 5000 }, THIGHS);
    assert.equal((await h.readCards(page)).find((c) => c.id === THIGHS).text, THIGHS_LV);
  } finally { await close(); }
});
