const puppeteer = require('puppeteer-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SITE = 'https://barbora.lv';
const USERSCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'barbora-calorie-sort.user.js'), 'utf8');
const LANG_COOKIES = {
  en: [{ name: 'lng', value: 'EN' }, { name: 'lang', value: '1595dc26-9ecc-4c7d-b26e-badffc19c6b5' }],
  ru: [{ name: 'lng', value: 'RU' }, { name: 'lang', value: '909b6b59-bf29-497c-80e4-1c844f1849c7' }],
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

// Barbora (behind Cloudflare) answers 429 after bursts from one address, so product pages are
// fetched live once, spaced out, and replayed from disk afterwards. Category pages stay live.
const CACHE_DIR = path.join(__dirname, '.cache');
const LIVE_SPACING_MS = 400;
let liveQueue = Promise.resolve();
let lastLiveFetch = 0;

function productPage(url, lang) {
  const file = path.join(CACHE_DIR, `${lang || 'lv'}${new URL(url).pathname.replace(/\//g, '_')}.html`);
  if (fs.existsSync(file)) return Promise.resolve({ status: 200, body: fs.readFileSync(file, 'utf8') });
  const live = async () => {
    const wait = lastLiveFetch + LIVE_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLiveFetch = Date.now();
    try {
      const cookie = lang ? LANG_COOKIES[lang].map((c) => `${c.name}=${c.value}`).join('; ') : '';
      const response = await fetch(url, { headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) } });
      const body = await response.text();
      if (response.status === 200) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, body);
      }
      return { status: response.status, body };
    } catch {
      return { status: 502, body: '' };
    }
  };
  liveQueue = liveQueue.then(live);
  return liveQueue;
}

async function launchBrowser() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-test-'));
  const browser = await puppeteer.launch({
    browser: 'firefox', executablePath: process.env.FIREFOX_PATH || '/usr/bin/firefox', headless: true, userDataDir,
  });
  return { browser, close: async () => { await browser.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); } };
}

// intercept(req) returns 'abort', {status} (fake response) or undefined (let it through).
// before is an extra page-start script that runs before the userscript.
async function openCategory(browser, urlPath, { lang, before, intercept } = {}) {
  if (lang) await browser.setCookie(...LANG_COOKIES[lang].map((c) => ({ ...c, domain: 'barbora.lv', path: '/' })));
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setRequestInterception(true);
  // Resolving a request can reject once its page has navigated away or closed; that is harmless.
  const ignoreGone = () => {};
  page.on('request', (req) => {
    const action = intercept ? intercept(req) : undefined;
    if (action === 'abort') return req.abort().catch(ignoreGone);
    if (action && action.status) return req.respond({ status: action.status, contentType: 'text/plain', body: '' }).catch(ignoreGone);
    const url = new URL(req.url());
    if (url.hostname === 'barbora.lv' && url.pathname.startsWith('/produkti/') && req.method() === 'GET') {
      return productPage(req.url(), lang)
        .then(({ status, body }) => req.respond({ status, contentType: 'text/html; charset=utf-8', body }))
        .catch(ignoreGone);
    }
    return req.continue().catch(ignoreGone);
  });
  let documentStatus = null;
  page.on('response', (res) => {
    if (documentStatus === null && res.url() === SITE + urlPath) documentStatus = res.status();
  });
  await page.evaluateOnNewDocument(() => {
    performance.setResourceTimingBufferSize(5000);
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay { display: none !important; }';
      document.head.appendChild(s);
    });
  });
  if (before) await page.evaluateOnNewDocument(before);
  await page.evaluateOnNewDocument(USERSCRIPT);
  await page.goto(SITE + urlPath, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('li[data-cnstrc-item-id]', { timeout: 60_000 });
  } catch (error) {
    const title = await page.title().catch(() => '?');
    throw new Error(`no product cards on ${urlPath} (document HTTP ${documentStatus}, title "${title}")`, { cause: error });
  }
  return page;
}

async function waitForBadges(page, timeoutMs = 90_000) {
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('li[data-cnstrc-item-id]')];
    return cards.length > 0 && cards.every((li) => {
      const badge = li.querySelector('.bcs-badge');
      return badge && !badge.classList.contains('bcs-badge--loading');
    });
  }, { timeout: timeoutMs, polling: 250 });
}

// Cards in visual order: by CSS `order`, then by position in the DOM.
async function readCards(page) {
  const cards = await page.$$eval('li[data-cnstrc-item-id]', (lis) => lis.map((li, domIndex) => {
    const badge = li.querySelector('.bcs-badge');
    const kind = badge ? ((/bcs-badge--(\w+)/.exec(badge.className) || [])[1] || null) : null;
    return {
      id: li.getAttribute('data-cnstrc-item-id'),
      domIndex,
      order: Number(getComputedStyle(li).order) || 0,
      text: badge ? badge.textContent : null,
      kind,
    };
  }));
  return cards.sort((a, b) => a.order - b.order || a.domIndex - b.domIndex);
}

function parseKcal(text) {
  const match = /^(\d+) (kcal|ккал)/.exec(text || '');
  return match ? Number(match[1]) : null;
}

function assertCalorieOrder(cards, dir) {
  const firstOther = cards.findIndex((c) => c.kind !== 'ok');
  const okCards = firstOther === -1 ? cards : cards.slice(0, firstOther);
  assert.ok(cards.slice(okCards.length).every((c) => c.kind !== 'ok'), 'cards without a kcal value must come last');
  const values = okCards.map((c) => parseKcal(c.text));
  for (let i = 1; i < values.length; i++) {
    const inOrder = dir === 'asc' ? values[i] >= values[i - 1] : values[i] <= values[i - 1];
    assert.ok(inOrder, `kcal out of ${dir} order at position ${i}: ${values[i - 1]} then ${values[i]}`);
  }
}

async function productFetches(page) {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => e.initiatorType === 'fetch' && new URL(e.name).pathname.startsWith('/produkti/'))
    .map((e) => e.name));
}

async function waitUntil(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`waitUntil timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function shot(name) {
  const dir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

module.exports = {
  SITE, launchBrowser, openCategory, waitForBadges, readCards, parseKcal, assertCalorieOrder, productFetches, waitUntil, shot,
};
