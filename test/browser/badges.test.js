const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const VISTAS = '/gala-zivs-un-gatava-kulinarija/svaiga-putnu-gala/vistas-gala';
const THIGHS = '000000000001223665'; // Cāļa šķiņķi atkauloti bez ādas WELL DONE 500g
const THIGHS_LV = '172 kcal · 17 g olbaltumvielu'; // snapshot 2026-10-17

test('every card gets a badge inside its price block', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await h.waitForBadges(page);
    const cards = await h.readCards(page);
    assert.ok(cards.length >= 20);
    assert.ok(cards.every((c) => ['ok', 'none', 'failed'].includes(c.kind)));
    assert.ok(cards.some((c) => c.text === 'nav datu'));
    assert.equal(cards.find((c) => c.id === THIGHS).text, THIGHS_LV);
    assert.equal(await page.$$eval('li[data-cnstrc-item-id] [itemprop="offers"] > .bcs-badge', (b) => b.length), cards.length);
    const fetched = await h.productFetches(page);
    assert.equal(new Set(fetched).size, fetched.length, 'no product page fetched twice');
    assert.ok(fetched.length >= cards.length, 'a fresh profile fetches every product once');
    await page.$eval('#category-page-results-placeholder', (el) => el.scrollIntoView());
    await page.screenshot({ path: h.shot('badges.png') });
  } finally { await close(); }
});

test('a card re-rendered by the site gets its badge back', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await h.waitForBadges(page);
    await page.evaluate((id) => {
      const li = document.querySelector(`li[data-cnstrc-item-id="${id}"]`);
      const clone = li.cloneNode(true);
      clone.querySelectorAll('.bcs-badge').forEach((b) => b.remove());
      li.replaceWith(clone);
    }, THIGHS);
    await page.waitForFunction((id, text) => document.querySelector(`li[data-cnstrc-item-id="${id}"] .bcs-badge`)?.textContent === text,
      { timeout: 5000 }, THIGHS, THIGHS_LV);
  } finally { await close(); }
});

test('a second visit uses saved values', { timeout: 180_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS);
    await h.waitForBadges(page);
    const failed = (await h.readCards(page)).filter((c) => c.kind === 'failed').length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('li[data-cnstrc-item-id]');
    await h.waitForBadges(page);
    assert.ok((await h.productFetches(page)).length <= failed);
  } finally { await close(); }
});
