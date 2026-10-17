const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const VISTAS = '/gala-zivs-un-gatava-kulinarija/svaiga-putnu-gala/vistas-gala';
const THIGHS = '000000000001223665'; // Cāļa šķiņķi atkauloti bez ādas WELL DONE 500g
const THIGHS_LV = '172 kcal · 17 g olb.'; // snapshot 2026-10-17
const VISTAS_PER_UNIT = `${VISTAS}?order=comparativePriceAsc`;

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

test('sorting by price per unit loads the values without reordering', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS_PER_UNIT);
    const siteOrder = await page.$$eval('li[data-cnstrc-item-id]', (lis) => lis
      .filter((li) => !li.parentElement.closest('li')).map((li) => li.getAttribute('data-cnstrc-item-id')));
    await h.waitForBoxes(page);
    const cards = await h.readCards(page);
    assert.deepEqual(cards.map((c) => c.id), siteOrder, 'the site order stays');
    assert.ok(cards.every((c) => c.order === 0));
    assert.ok(cards.every((c) => ['ok', 'none', 'failed'].includes(c.kind)));
    assert.ok((await h.productFetches(page)).length > 0);
    assert.equal((await h.currentUrl(page)).hash, '', 'no calorie marker');
  } finally { await close(); }
});

test('sorting by price loads the values too, keeping the site order', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, `${VISTAS}?order=priceAsc`);
    const siteOrder = await page.$$eval('li[data-cnstrc-item-id]', (lis) => lis
      .filter((li) => !li.parentElement.closest('li')).map((li) => li.getAttribute('data-cnstrc-item-id')));
    await h.waitForBoxes(page);
    const cards = await h.readCards(page);
    assert.deepEqual(cards.map((c) => c.id), siteOrder, 'the site order stays');
    assert.ok(cards.every((c) => ['ok', 'none', 'failed'].includes(c.kind)));
  } finally { await close(); }
});

test('on a discounted product the box fits beside both price boxes', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS_PER_UNIT);
    await h.waitForBoxes(page);
    const fit = await page.evaluate(() => {
      const offers = [...document.querySelectorAll('li[data-cnstrc-item-id] [itemprop="offers"]')]
        .find((o) => o.querySelector(':scope > div:first-of-type [class*="rounded-l-"]') && o.querySelector(':scope > .bcs-box'));
      if (!offers) return null;
      const price = offers.querySelector(':scope > div:first-of-type').getBoundingClientRect();
      const box = offers.querySelector(':scope > .bcs-box').getBoundingClientRect();
      return { priceTop: price.top, priceHeight: price.height, boxTop: box.top, boxHeight: box.height, boxRight: box.right, areaRight: offers.getBoundingClientRect().right };
    });
    assert.ok(fit, 'a discounted product with a box is on the page (snapshot 2026-10-17)');
    assert.ok(Math.abs(fit.boxTop - fit.priceTop) <= 2, `same line: box top ${fit.boxTop} vs price top ${fit.priceTop}`);
    assert.ok(fit.boxRight <= fit.areaRight + 1, 'the box stays inside the price area');
    assert.ok(Math.abs(fit.boxHeight - fit.priceHeight) <= 2, `same height: ${fit.boxHeight} vs ${fit.priceHeight}`);
  } finally { await close(); }
});
