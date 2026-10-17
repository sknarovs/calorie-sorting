const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const VISTAS = '/gala-zivs-un-gatava-kulinarija/svaiga-putnu-gala/vistas-gala';

test('cancel leaves the page as it was, and sorting again completes without failures', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, VISTAS); // paced loading leaves time to press Cancel
    await page.evaluate(() => { window.__bcsNoReload = true; });
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForFunction(() => {
      const s = document.querySelector('.bcs-status');
      return s && s.textContent.includes('Ielādē uzturvērtību') && s.querySelector('.bcs-status__action:not([hidden])');
    }, { timeout: 60_000, polling: 100 });
    await page.click('.bcs-status .bcs-status__action:not([hidden])');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await page.evaluate(() => window.__bcsNoReload), true);
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'default');
    assert.equal((await h.currentUrl(page)).hash, '');
    assert.equal(await page.$('.bcs-status:not([hidden])'), null);
    assert.equal(await page.$('.bcs-box--loading'), null, 'no box left waiting');
    assert.ok((await h.readCards(page)).every((c) => c.order === 0));
    // Products that were mid-request at Cancel must not count as failed when sorting again.
    await page.select('select.b-orderby', 'bcs-kcal-asc');
    await page.waitForFunction(() => location.hash === '#kcal-asc', { timeout: 120_000 });
    await h.waitForBoxes(page);
    const status = await page.$eval('.bcs-status', (e) => e.textContent);
    assert.ok(!status.includes('Neizdevās ielādēt'), `no failures after Cancel and a new sort, got: ${status}`);
    assert.ok((await h.readCards(page)).every((c) => c.kind !== 'failed'));
  } finally { await close(); }
});
