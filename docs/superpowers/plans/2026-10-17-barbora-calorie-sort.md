# Barbora Calorie Sort Implementation Plan

> **Superseded in part (2026-10-17).** This plan built the first version. After first use, the whole-category view (Tasks 5's collection, 8 and most of 9) was removed and loading became on-demand and paced; see the revision note in the spec. The plan is kept as the record of how v1 was built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tampermonkey userscript for barbora.lv. It shows kcal and protein per 100 g/ml on every category card and sorts a whole category by calories, using the site's own cards.

**Architecture:**
- **One file:** everything lives in `barbora-calorie-sort.user.js`.
- **Pure core:** parsing, sorting, labels, storage, fetching and the list swap come first. They are exported to Node's built-in test runner.
- **Browser parts:** card decoration, status line, dropdown and the sort flows come next. They are tested against the live site with puppeteer-core driving the installed Firefox.
- **Whole-category sort:**
  1. Collect every listing page.
  2. Save the sorted list in sessionStorage and reload.
  3. At document-start, hand the list to the site through an accessor property on `window.b_productList`.

**Tech Stack:** plain JavaScript (no build step, no runtime dependencies), Tampermonkey (`@grant none`), Node 24 `node:test`, and puppeteer-core 25.12.0 driving Firefox 157 over WebDriver BiDi.

**Spec:** `docs/superpowers/specs/2026-10-17-barbora-calorie-sort-design.md`. Read it alongside this plan. Its "Site facts", "Labels", "Nutrition reading rules" and "Error handling" sections are referenced below and not repeated.

## Global Constraints

- **One file:** everything ships in `barbora-calorie-sort.user.js`, with no build step and no runtime dependencies.
- **Network:** only same-origin GET requests to barbora.lv. Never call cart, checkout or account APIs.
- **Metadata:** `@match https://barbora.lv/*`, `@match https://www.barbora.lv/*`, `@run-at document-start`, `@grant none`. Also `@sandbox raw` and `@noframes` (page context, top frame only; both refine the spec's intent).
- **File tail:** `if (typeof window === 'undefined') module.exports = {...}; else start();`. This tightens the spec's `typeof module` check, so a stray page global can never stop the script from starting.
- **Numbers:** all spec numbers live in one `CONFIG` object (Task 1). Code reads them from `CONFIG` and never repeats the literals.
- **Storage keys:** `bcs:nutrition:v1` (localStorage), `bcs:list:v1` and `bcs:reload` (sessionStorage). `bcs:reload` is the plan's reload-loop guard (Task 8).
- **Storage errors:** every Web Storage access goes through try/catch or `safeStorage`. A failure means "no cache" or "no saved list"; it never throws out of the script.
- **Names:**
  - URL marker: `#kcal-asc` / `#kcal-desc`
  - dropdown values: `bcs-kcal-asc` / `bcs-kcal-desc`
  - CSS classes and storage keys start with `bcs`
  - console messages start with `[calorie-sort]`
- **Text:** user-facing text comes only from the spec's Labels table, verbatim. The language is `window.b_data.selectedLanguageData.locale`, with Latvian as the fallback.
- **Tests:**
  - `npm test` runs `node --test` on `test/unit/*.test.js`, with no network.
  - `npm run test:browser` runs `test/browser/*.test.js` against the live site, one file at a time. It uses Firefox at `/usr/bin/firefox` (override with `FIREFOX_PATH`) and a fresh profile per test.
  - Live-data assertions check rules. Concrete values are 2026-10-17 snapshots and are marked so in a comment.
- **Commits:** each commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Calorie sort chosen before the badges finish loading** (right after opening a category). The order must use complete data, and no product page may be fetched twice. Test: Task 7, `sorts on complete data when chosen right away`.
2. **Reload loop after the whole-category reload.** If the saved list can't be matched or the swap doesn't take effect, the page sorts in place with the `fallback` notice and never reloads again. Tests: Task 8, `consumeReload is true once, within the window` (unit) and `falls back without a second reload when the swap fails` (browser).
3. **Filters, page 2+ or a native sort already in the URL.** The sort covers the whole filtered category from page 1: filters are kept, `page`/`order` are dropped, and the saved list still matches after the reload. Tests: Task 2, `sortedViewUrl …` and `listKey …`; Task 5, `collectCategory gathers pages until a short page, keeping filters`.
4. **A listing page failing mid-collection** (the spec is silent). The current page is sorted in place with the `fallback` notice, and there is no reload. Tests: Task 5, `collectCategory retries a failing listing page once, then rejects`; Task 8, `a failing listing page falls back to sorting this page`.
5. **Backing out** (Cancel, or declining the big-category question). No reload, no further product fetches, and the dropdown returns to its previous choice. Tests: Task 9, `cancel leaves the page as it was` and `declining the question loads nothing more`.

---

### Task 1: Project skeleton and nutrition reader

**Files:**
- Create: `package.json`, `.gitignore`, `barbora-calorie-sort.user.js`, `scripts/trim-fixture.js`
- Create: `test/fixtures/product-lv.html`, `product-en.html`, `product-ru.html`, `product-nodata.html`, `product-4rows.html`
- Test: `test/unit/nutrition.test.js`

**Interfaces:**
- Produces:
  - `CONFIG`
  - `extractAssignedJson(html: string, name: string): any | null`
  - `readNutrition(html: string): {status: 'ok', kcal: number, protein: number | null} | {status: 'none'} | {status: 'unreadable'}`
  - the file skeleton (metadata, IIFE, export tail) that every later task extends; each task adds its functions to `module.exports`

- [ ] **Step 1: Create `package.json` and `.gitignore`**

```json
{
  "name": "barbora-calorie-sort",
  "version": "1.0.0",
  "private": true,
  "description": "Tampermonkey userscript: calorie badges and calorie sorting on barbora.lv category pages",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test \"test/unit/*.test.js\""
  }
}
```

`.gitignore` contains `node_modules/` and `test/browser/screenshots/`.

- [ ] **Step 2: Create the userscript skeleton**

```js
// ==UserScript==
// @name         Barbora calorie sort
// @namespace    barbora-calorie-sort
// @version      1.0.0
// @description  Calorie and protein badges on barbora.lv category pages, and sorting a whole category by calories.
// @match        https://barbora.lv/*
// @match        https://www.barbora.lv/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    kcalMax: 950,
    proteinMax: 100,
    kJPerKcal: 4.184,
    productConcurrency: 4,
    listingConcurrency: 3,
    timeoutMs: 15000,
    retryDelayMs: 1000,
    backoffMs: 5000,
    maxRateLimited: 3,
    maxPages: 60,
    cacheDaysData: 30,
    cacheDaysNoData: 7,
    cacheMaxEntries: 6000,
    cacheFlushEvery: 20,
    listTtlMs: 30 * 60 * 1000,
    reloadWindowMs: 15000,
    confirmAbove: 300,
    fetchesPerSecond: 30,
    verifyTimeoutMs: 10000,
    keys: { nutrition: 'bcs:nutrition:v1', list: 'bcs:list:v1', reload: 'bcs:reload' },
  };

  // ---- Core: page data and nutrition ----

  // ---- Browser ----

  function start() {}

  if (typeof window === 'undefined') {
    module.exports = { CONFIG };
  } else {
    start();
  }
})();
```

Later tasks add their sections in this order:

| Section | Task |
|---|---|
| page data and nutrition | 1 |
| URLs and sorting | 2 |
| labels | 3 |
| storage | 4 |
| fetching | 5 |
| list swap | 8 |
| browser section | 6–9 |

- [ ] **Step 3: Write `scripts/trim-fixture.js` and generate the fixtures**

`scripts/trim-fixture.js` reads an HTML page from stdin and writes only two things, separated by a newline:
- the `<script>…</script>` element that contains `window.product =`
- the first `<table class="table table-striped table-condensed"…>…</table>`, if there is one

It exits with code 1 and a message if `window.product =` is missing. It has no dependencies.

```bash
UA='Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
EN='lng=EN; lang=1595dc26-9ecc-4c7d-b26e-badffc19c6b5'
RU='lng=RU; lang=909b6b59-bf29-497c-80e4-1c844f1849c7'
grab() { curl -sS --compressed -A "$UA" ${3:+-b "$3"} "https://barbora.lv/produkti/$2" | node scripts/trim-fixture.js > "test/fixtures/$1.html"; }
mkdir -p test/fixtures
grab product-lv cala-skinki-atkauloti-bez-adas-wd-500-g
grab product-en cala-skinki-atkauloti-bez-adas-wd-500-g "$EN"
grab product-ru cala-skinki-atkauloti-bez-adas-wd-500-g "$RU"
grab product-nodata cala-krutinas-fileja-well-done-500-g
grab product-4rows cala-sparni-well-done-fas
grep -c 'Kcal' test/fixtures/*.html
```

Expected:
- All five files are non-empty.
- `product-lv/en/ru` show `172.00 Kcal` in the table.
- `product-nodata` contains `"nutrients":[]` and no table.
- `product-4rows` contains `"Amount":157.00`.

If live values have changed, update the snapshot values in Step 4 and its date comment.

- [ ] **Step 4: Write the failing tests** in `test/unit/nutrition.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractAssignedJson, readNutrition } = require('../../barbora-calorie-sort.user.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', `${name}.html`), 'utf8');
const productPage = (nutrients) => `<script>window.product = ${JSON.stringify({ id: '1', nutrients })};</script>`;
const kcal = (n) => ({ Name: 'E', Amounts: [{ Amount: n, UnitName: 'Kcal' }] });

test('extractAssignedJson parses objects with tricky strings', () => {
  const html = '<script>window.a = 1; window.product = {"t":"a } b","q":"say \\"hi\\"","n":[1,{"x":"]"}]};\nwindow.z = 2;</script>';
  assert.deepEqual(extractAssignedJson(html, 'product'), { t: 'a } b', q: 'say "hi"', n: [1, { x: ']' }] });
});

test('extractAssignedJson parses arrays', () => {
  assert.deepEqual(extractAssignedJson('window.b_productList = [{"id":"1"}];', 'b_productList'), [{ id: '1' }]);
});

test('extractAssignedJson returns null for a missing name, a longer name or broken JSON', () => {
  assert.equal(extractAssignedJson('<p>nothing</p>', 'product'), null);
  assert.equal(extractAssignedJson('window.productList = [1];', 'product'), null);
  assert.equal(extractAssignedJson('window.product = {"a": ', 'product'), null);
});

test('readNutrition reads the boneless thighs in LV, EN and RU', () => {
  // snapshot 2026-10-17
  for (const name of ['product-lv', 'product-en', 'product-ru']) {
    assert.deepEqual(readNutrition(fixture(name)), { status: 'ok', kcal: 172, protein: 17 }, name);
  }
});

test('readNutrition handles a product with only four nutrient rows', () => {
  assert.deepEqual(readNutrition(fixture('product-4rows')), { status: 'ok', kcal: 157, protein: 18 }); // snapshot 2026-10-17
});

test('readNutrition: a product without a label is none', () => {
  assert.deepEqual(readNutrition(fixture('product-nodata')), { status: 'none' });
});

test('readNutrition converts kJ when kcal is missing', () => {
  const html = productPage([{ Name: 'Enerģētiskā vērtība', Amounts: [{ Amount: 717, UnitName: 'kJ' }] }]);
  assert.deepEqual(readNutrition(html), { status: 'ok', kcal: 171, protein: null });
});

test('readNutrition falls back to the visible table', () => {
  const html = '<table class="table table-striped table-condensed"><tbody>'
    + '<tr><td>Enerģētiskā vērtība</td><td class="b-text-right">717.00 kJ / 172.00 Kcal</td></tr>'
    + '<tr><td>Olbaltumvielas</td><td class="b-text-right">17,5 g</td></tr></tbody></table>';
  assert.deepEqual(readNutrition(html), { status: 'ok', kcal: 172, protein: 17.5 });
});

test('readNutrition applies the sanity rules', () => {
  assert.deepEqual(readNutrition(productPage([kcal(1200)])), { status: 'none' });
  assert.deepEqual(readNutrition(productPage([kcal(0)])), { status: 'ok', kcal: 0, protein: null });
  assert.deepEqual(
    readNutrition(productPage([kcal(50), { Name: 'Proteins', Amounts: [{ Amount: 140, UnitName: 'g' }] }])),
    { status: 'ok', kcal: 50, protein: null },
  );
});

test('readNutrition: neither product data nor a table is unreadable', () => {
  assert.deepEqual(readNutrition('<html><body>Lapa nav atrasta</body></html>'), { status: 'unreadable' });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, with `extractAssignedJson is not a function`.

- [ ] **Step 6: Implement `extractAssignedJson` and `readNutrition`** in the "page data and nutrition" section, and export both.

- **`extractAssignedJson`:**
  1. Find `window.<name>` followed by optional spaces and `=`. The name must not continue with an identifier character.
  2. From the first `{` or `[` after it, walk forward tracking depth and string/escape state until the matching close.
  3. `JSON.parse` that slice.
  4. Any failure returns `null`.
- **`readNutrition`:** follow the spec's "Nutrition reading rules" 1–6.
  - Protein names, compared trimmed and case-insensitive: `olbaltumvielas`, `proteins`, `protein`, `белки`, `белок`.
  - Table rows come from `/<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/g`; numbers may use a decimal comma.
  - kcal derived from kJ is `Math.round(kJ / CONFIG.kJPerKcal)`. kcal given directly is not rounded.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 10 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore barbora-calorie-sort.user.js scripts test
git commit -m "feat: read kcal and protein from Barbora product pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: URLs and sorting

**Files:**
- Modify: `barbora-calorie-sort.user.js` (new section "URLs and sorting", plus exports)
- Test: `test/unit/urls-sort.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (`loc` is `{pathname: string, search: string}`; `window.location` qualifies):
  - `parseMarker(hash: string): 'asc' | 'desc' | null`
  - `baseQuery(search: string): string`: `''` or `'?…'`, in the original parameter order, without `order` and `page`
  - `listingUrl(loc, page: number): string`: pathname plus `baseQuery`, with `page=N` appended only when N ≥ 2
  - `listKey(loc): string`: pathname plus `baseQuery` with parameters sorted by key
  - `sortedViewUrl(loc, dir: 'asc' | 'desc'): string`: pathname plus `baseQuery` plus `#kcal-<dir>`
  - `productUrl(product: {Url: string}): string`: `/produkti/<Url>`
  - `sortProducts(products: {id: string}[], states: Map<string, NutritionState>, dir): {id: string}[]`
  - `NutritionState` (used from here on): `{status: 'ok', kcal, protein} | {status: 'none'} | {status: 'failed'}`

- [ ] **Step 1: Write the failing tests** in `test/unit/urls-sort.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarker, baseQuery, listingUrl, listKey, sortedViewUrl, productUrl, sortProducts } = require('../../barbora-calorie-sort.user.js');

test('parseMarker', () => {
  assert.equal(parseMarker('#kcal-asc'), 'asc');
  assert.equal(parseMarker('#kcal-desc'), 'desc');
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker('#kcal-up'), null);
  assert.equal(parseMarker('#reviews'), null);
});

test('baseQuery drops order and page but keeps filters in their order', () => {
  assert.equal(baseQuery('?brand=3583&order=priceAsc&page=3&country=LV'), '?brand=3583&country=LV');
  assert.equal(baseQuery('?page=2'), '');
  assert.equal(baseQuery(''), '');
});

test('listingUrl keeps filters, drops order, numbers pages from 2', () => {
  const loc = { pathname: '/piena-produkti-un-olas/jogurti', search: '?order=priceAsc&brand=135&page=4' };
  assert.equal(listingUrl(loc, 1), '/piena-produkti-un-olas/jogurti?brand=135');
  assert.equal(listingUrl(loc, 2), '/piena-produkti-un-olas/jogurti?brand=135&page=2');
  assert.equal(listingUrl({ pathname: '/a', search: '' }, 3), '/a?page=3');
});

test('listKey ignores order, page and parameter order', () => {
  assert.equal(listKey({ pathname: '/a', search: '?country=LV&brand=135&page=2' }), '/a?brand=135&country=LV');
  assert.equal(listKey({ pathname: '/a', search: '?brand=135&country=LV&order=name' }), '/a?brand=135&country=LV');
  assert.equal(listKey({ pathname: '/a', search: '' }), '/a');
});

test('sortedViewUrl drops page and order, keeps filters, adds the marker', () => {
  assert.equal(sortedViewUrl({ pathname: '/a', search: '?brand=1&page=3&order=priceAsc' }, 'desc'), '/a?brand=1#kcal-desc');
  assert.equal(sortedViewUrl({ pathname: '/a', search: '' }, 'asc'), '/a#kcal-asc');
});

test('productUrl', () => {
  assert.equal(productUrl({ Url: 'cala-skinki-atkauloti-bez-adas-wd-500-g' }), '/produkti/cala-skinki-atkauloti-bez-adas-wd-500-g');
});

const ok = (kcal) => ({ status: 'ok', kcal, protein: null });
const products = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
const states = new Map([['a', ok(300)], ['b', { status: 'none' }], ['c', ok(100)], ['d', { status: 'failed' }], ['e', ok(100)], ['f', ok(50)]]);

test('sortProducts asc: by kcal, ties keep their order, no number last', () => {
  assert.deepEqual(sortProducts(products, states, 'asc').map((p) => p.id), ['f', 'c', 'e', 'a', 'b', 'd']);
});

test('sortProducts desc keeps entries without a number last', () => {
  assert.deepEqual(sortProducts(products, states, 'desc').map((p) => p.id), ['a', 'c', 'e', 'f', 'b', 'd']);
});

test('sortProducts treats unknown products as no number and leaves the input alone', () => {
  const input = [{ id: 'x' }, { id: 'f' }];
  assert.deepEqual(sortProducts(input, states, 'asc').map((p) => p.id), ['f', 'x']);
  assert.deepEqual(input.map((p) => p.id), ['x', 'f']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, with `parseMarker is not a function`.

- [ ] **Step 3: Implement the seven functions** with the signatures above, and export them.
  - Use `URLSearchParams`: delete `order` and `page`; `listKey` calls `.sort()`.
  - `sortProducts` copies the array. It sorts the `ok` entries by kcal (the built-in sort is stable) and then appends the rest in their original order.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add barbora-calorie-sort.user.js test/unit/urls-sort.test.js
git commit -m "feat: add URL helpers and calorie sorting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Labels and badge text

**Files:**
- Modify: `barbora-calorie-sort.user.js` (new section "labels", plus exports)
- Test: `test/unit/labels.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (`Labels` is one entry of `LABELS`):
  - `LABELS: {lv: Labels, en: Labels, ru: Labels}`. Each `Labels` has every key of the spec's Labels table, copied verbatim, plus `locale` (`'lv'`, `'en'` or `'ru'`).
  - `pickLabels(locale: string | undefined): Labels`
  - `fill(template: string, values: object): string`
  - `formatBadge(labels: Labels, state: NutritionState | {status: 'loading'}): {kind: 'ok' | 'none' | 'failed' | 'loading', text: string, title: string}`
  - `composeNotice(labels: Labels, {total?: number, failed: number, rateLimited: boolean}): string`

- [ ] **Step 1: Write the failing tests** in `test/unit/labels.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { LABELS, pickLabels, fill, formatBadge, composeNotice } = require('../../barbora-calorie-sort.user.js');

test('pickLabels follows the site language, Latvian otherwise', () => {
  assert.equal(pickLabels('ru').sortAsc, 'Калорийности от самой низкой');
  assert.equal(pickLabels('en').sortDesc, 'Calories from highest');
  assert.equal(pickLabels('lv').sortAsc, 'Kalorijas (augoši)');
  assert.equal(pickLabels('de'), LABELS.lv);
  assert.equal(pickLabels(undefined), LABELS.lv);
});

test('every label set has the same keys', () => {
  const keys = Object.keys(LABELS.lv).sort();
  assert.deepEqual(Object.keys(LABELS.en).sort(), keys);
  assert.deepEqual(Object.keys(LABELS.ru).sort(), keys);
});

test('fill replaces placeholders', () => {
  assert.equal(fill('{done} / {total}', { done: 3, total: 10 }), '3 / 10');
});

test('formatBadge data states use the locale number format', () => {
  assert.deepEqual(formatBadge(pickLabels('lv'), { status: 'ok', kcal: 172, protein: 17 }),
    { kind: 'ok', text: '172 kcal · 17 g olbaltumvielu', title: 'uz 100 g/ml' });
  assert.equal(formatBadge(pickLabels('en'), { status: 'ok', kcal: 132, protein: 22.4 }).text, '132 kcal · 22.4 g protein');
  assert.equal(formatBadge(pickLabels('ru'), { status: 'ok', kcal: 132, protein: 22.4 }).text, '132 ккал · 22,4 г белка');
  assert.equal(formatBadge(pickLabels('lv'), { status: 'ok', kcal: 38, protein: 0.5 }).text, '38 kcal · 0,5 g olbaltumvielu');
  assert.equal(formatBadge(pickLabels('lv'), { status: 'ok', kcal: 52.6, protein: null }).text, '53 kcal');
});

test('formatBadge other states', () => {
  const lv = pickLabels('lv');
  assert.deepEqual(formatBadge(lv, { status: 'loading' }), { kind: 'loading', text: '… kcal', title: '' });
  assert.deepEqual(formatBadge(lv, { status: 'none' }), { kind: 'none', text: 'nav datu', title: '' });
  assert.deepEqual(formatBadge(lv, { status: 'failed' }), { kind: 'failed', text: '?', title: 'Neizdevās ielādēt' });
  assert.equal(formatBadge(pickLabels('ru'), { status: 'loading' }).text, '… ккал');
});

test('composeNotice joins the parts that apply', () => {
  const lv = pickLabels('lv');
  assert.equal(composeNotice(lv, { failed: 0, rateLimited: false }), '');
  assert.equal(composeNotice(lv, { failed: 2, rateLimited: false }), 'Neizdevās ielādēt: 2');
  assert.equal(composeNotice(lv, { total: 84, failed: 1, rateLimited: true }),
    'Visas preces (84) sakārtotas pēc kalorijām · Neizdevās ielādēt: 1 · Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, with `pickLabels is not a function`.

- [ ] **Step 3: Implement the labels section**
  - **`LABELS`:** copy the spec's Labels table verbatim, with keys `sortAsc` … `rateLimited`, plus `locale`.
  - **`formatBadge`:** the loading text is `fill(badgeKcalOnly, {k: '…'})`. kcal is formatted with `Intl.NumberFormat(labels.locale, {maximumFractionDigits: 0})`, protein with `maximumFractionDigits: 1`.
  - **`composeNotice`:** joins with `' · '`, in this order: `allSorted` (only when `total` is given), `someFailed` (only when `failed > 0`), `rateLimited` (only when true).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add barbora-calorie-sort.user.js test/unit/labels.test.js
git commit -m "feat: add Latvian, English and Russian labels and badge text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Nutrition cache and saved list

**Files:**
- Modify: `barbora-calorie-sort.user.js` (new section "storage", plus exports)
- Create: `test/unit/helpers.js`
- Test: `test/unit/storage.test.js`

**Interfaces:**
- Consumes: `CONFIG`.
- Produces:
  - `isFresh(entry: {k: number | null, p: number | null, t: number}, now: number): boolean`
  - `class NutritionCache`:
    - `constructor(storage, {now = () => Date.now(), maxEntries = CONFIG.cacheMaxEntries, flushEvery = CONFIG.cacheFlushEvery} = {})`
    - `get(id): {status: 'ok', kcal, protein} | {status: 'none'} | undefined`
    - `put(id, state: NutritionState): void`
    - `flush(): void`
  - `saveList(storage, record: SavedList): boolean`
  - `loadList(storage, key: string, dir: 'asc' | 'desc', now: number): SavedList | null`
  - `SavedList = {key: string, dir, savedAt: number, products: object[], failed: string[], rateLimited: boolean}`. This adds `rateLimited` to the spec's shape, so the all-sorted banner can show it after the reload.
  - `test/unit/helpers.js` exports `fakeStorage({reject = () => false} = {})`, which Task 8 reuses. Its `setItem` throws a `QuotaExceededError` whenever `reject(value)` is true.

- [ ] **Step 1: Write the test helper and the failing tests**

`test/unit/helpers.js`:

```js
function fakeStorage({ reject = () => false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (reject(String(v))) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      data.set(k, String(v));
    },
    removeItem: (k) => { data.delete(k); },
  };
}
module.exports = { fakeStorage };
```

`test/unit/storage.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFresh, NutritionCache, saveList, loadList } = require('../../barbora-calorie-sort.user.js');
const { fakeStorage } = require('./helpers');

const DAY = 86_400_000;
const KEY = 'bcs:nutrition:v1';
const stored = (s) => JSON.parse(s.getItem(KEY));

test('isFresh: 30 days with data, 7 days without', () => {
  const now = 100 * DAY;
  assert.equal(isFresh({ k: 172, p: 17, t: now - 29 * DAY }, now), true);
  assert.equal(isFresh({ k: 172, p: 17, t: now - 31 * DAY }, now), false);
  assert.equal(isFresh({ k: null, p: null, t: now - 6 * DAY }, now), true);
  assert.equal(isFresh({ k: null, p: null, t: now - 8 * DAY }, now), false);
});

test('NutritionCache keeps ok and none, ignores failed, expires no-data first', () => {
  const s = fakeStorage();
  let now = 1000;
  const c = new NutritionCache(s, { now: () => now });
  c.put('1', { status: 'ok', kcal: 172, protein: 17 });
  c.put('2', { status: 'none' });
  c.put('3', { status: 'failed' });
  c.flush();
  const c2 = new NutritionCache(s, { now: () => now });
  assert.deepEqual(c2.get('1'), { status: 'ok', kcal: 172, protein: 17 });
  assert.deepEqual(c2.get('2'), { status: 'none' });
  assert.equal(c2.get('3'), undefined);
  now += 8 * DAY;
  assert.equal(c2.get('2'), undefined);
  assert.deepEqual(c2.get('1'), { status: 'ok', kcal: 172, protein: 17 });
});

test('NutritionCache flushes by itself every 20 puts', () => {
  const s = fakeStorage();
  const c = new NutritionCache(s, { now: () => 1 });
  for (let i = 0; i < 19; i++) c.put(String(i), { status: 'none' });
  assert.equal(s.getItem(KEY), null);
  c.put('19', { status: 'none' });
  assert.equal(Object.keys(stored(s)).length, 20);
});

test('flush merges with what another tab wrote', () => {
  const s = fakeStorage();
  const a = new NutritionCache(s, { now: () => 1 });
  const b = new NutritionCache(s, { now: () => 2 });
  a.put('1', { status: 'none' }); a.flush();
  b.put('2', { status: 'none' }); b.flush();
  assert.deepEqual(Object.keys(stored(s)).sort(), ['1', '2']);
});

test('flush keeps at most maxEntries, dropping the oldest', () => {
  const s = fakeStorage();
  let now = 0;
  const c = new NutritionCache(s, { now: () => now, maxEntries: 3 });
  for (const id of ['a', 'b', 'c', 'd']) { now += 1; c.put(id, { status: 'none' }); }
  c.flush();
  assert.deepEqual(Object.keys(stored(s)).sort(), ['b', 'c', 'd']);
});

test('on a quota error flush drops the oldest quarter and retries once', () => {
  const s = fakeStorage({ reject: (v) => Object.keys(JSON.parse(v)).length > 3 });
  let now = 0;
  const c = new NutritionCache(s, { now: () => now });
  for (const id of ['a', 'b', 'c', 'd']) { now += 1; c.put(id, { status: 'none' }); }
  c.flush();
  assert.deepEqual(Object.keys(stored(s)).sort(), ['b', 'c', 'd']);
});

test('when storage stays full the cache keeps working from memory', () => {
  const s = fakeStorage({ reject: () => true });
  const c = new NutritionCache(s, { now: () => 1 });
  c.put('a', { status: 'ok', kcal: 10, protein: 1 });
  assert.doesNotThrow(() => c.flush());
  assert.deepEqual(c.get('a'), { status: 'ok', kcal: 10, protein: 1 });
});

const record = { key: '/a?brand=1', dir: 'asc', savedAt: 1000, products: [{ id: '1' }], failed: ['2'], rateLimited: false };

test('saveList and loadList round-trip a matching, fresh list', () => {
  const s = fakeStorage();
  assert.equal(saveList(s, record), true);
  assert.deepEqual(loadList(s, '/a?brand=1', 'asc', 1000 + 29 * 60_000), record);
});

test('loadList rejects another key, another direction and lists older than 30 minutes', () => {
  const s = fakeStorage();
  saveList(s, record);
  assert.equal(loadList(s, '/b', 'asc', 1001), null);
  assert.equal(loadList(s, '/a?brand=1', 'desc', 1001), null);
  assert.equal(loadList(s, '/a?brand=1', 'asc', 1000 + 31 * 60_000), null);
});

test('saveList returns false when storage is full; loadList ignores corrupt data', () => {
  const s = fakeStorage({ reject: () => true });
  assert.equal(saveList(s, record), false);
  s.data.set('bcs:list:v1', '{not json');
  assert.equal(loadList(s, '/a?brand=1', 'asc', 1001), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, with `isFresh is not a function`.

- [ ] **Step 3: Implement the storage section**
  - **Entry shape:** `{k, p, t}` stored under `CONFIG.keys.nutrition`. `k: null` means "no data".
  - **Constructor:** reads storage once. Missing or corrupt data counts as empty.
  - **`get`:** returns only fresh entries.
  - **`put`:** ignores every status except `ok` and `none`. It updates memory immediately and calls `flush()` on every `flushEvery`-th put.
  - **`flush`:**
    1. Re-read storage and lay the memory entries over it.
    2. Keep the newest `maxEntries` by `t` and write them.
    3. On a quota error (`e.name` is `QuotaExceededError` or `NS_ERROR_DOM_QUOTA_REACHED`), drop the oldest `Math.max(1, Math.ceil(n / 4))` entries and retry once.
    4. If that fails too, log a `console.warn` and keep working from memory.
  - **`saveList` / `loadList`:** use `CONFIG.keys.list` and `CONFIG.listTtlMs`. `saveList` returns `false` on any write error.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add barbora-calorie-sort.user.js test/unit/helpers.js test/unit/storage.test.js
git commit -m "feat: cache nutrition in localStorage and save sorted lists per tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Fetching

**Files:**
- Modify: `barbora-calorie-sort.user.js` (new section "fetching", plus exports)
- Test: `test/unit/fetching.test.js`

**Interfaces:**
- Consumes: `CONFIG`, `extractAssignedJson`, `readNutrition` (Task 1), `listingUrl` (Task 2).
- Produces (`deps.fetch` has the `window.fetch` signature; `deps.sleep` defaults to a `setTimeout` promise):
  - `runPool(items, worker, opts): Promise<{results: Map<item, result>, cancelled: boolean, rateLimited: boolean}>`
    - `worker` is `(item, signal) => Promise<result>`
    - `opts` is `{concurrency, signal?, onResult?(item, result, done, total), isRateLimited?(result), sleep?, backoffMs = CONFIG.backoffMs, maxRateLimited = CONFIG.maxRateLimited}`
  - `fetchNutrition(url, deps): Promise<{status: 'ok', kcal, protein} | {status: 'none'} | {status: 'failed'} | {status: 'rateLimited'}>`
    - `deps` is `{fetch, signal?, sleep?, timeoutMs = CONFIG.timeoutMs, retryDelayMs = CONFIG.retryDelayMs}`
  - `collectCategory(loc, deps): Promise<object[]>`: products in site order, deduplicated, banners removed
    - `deps` is `{fetch, signal?, sleep?, onPage?(pagesLoaded), concurrency = CONFIG.listingConcurrency, maxPages = CONFIG.maxPages, timeoutMs, retryDelayMs}`

- [ ] **Step 1: Write the failing tests** in `test/unit/fetching.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPool, fetchNutrition, collectCategory } = require('../../barbora-calorie-sort.user.js');

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

const listing = (items) => `<script>window.b_productList = ${JSON.stringify(items.map((i) => (typeof i === 'string' ? { id: i, Url: `p-${i}` } : i)))};</script>`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
function fakeSite(pages) {
  const requested = [];
  const fetch = async (url) => { requested.push(url); return { ok: true, status: 200, text: async () => listing(pages[url] ?? []) }; };
  return { fetch, requested };
}
const loc = (search = '') => ({ pathname: '/c', search });

test('collectCategory gathers pages until a short page, keeping filters', async () => {
  const site = fakeSite({ '/c?brand=1': range(1, 52), '/c?brand=1&page=2': range(53, 104), '/c?brand=1&page=3': range(105, 110) });
  const loaded = [];
  const products = await collectCategory(loc('?brand=1&order=priceAsc&page=2'), { fetch: site.fetch, onPage: (n) => loaded.push(n), sleep: noSleep });
  assert.deepEqual(products.map((p) => p.id), range(1, 110));
  assert.deepEqual(site.requested, ['/c?brand=1', '/c?brand=1&page=2', '/c?brand=1&page=3']);
  assert.deepEqual(loaded, [1, 2, 3]);
});

test('collectCategory stops at an empty page and at a page with nothing new', async () => {
  const a = fakeSite({ '/c': range(1, 52), '/c?page=2': range(53, 104), '/c?page=3': [] });
  assert.equal((await collectCategory(loc(), { fetch: a.fetch, sleep: noSleep })).length, 104);
  const b = fakeSite({ '/c': range(1, 52), '/c?page=2': range(1, 52) });
  assert.equal((await collectCategory(loc(), { fetch: b.fetch, sleep: noSleep })).length, 52);
});

test('collectCategory drops banners and duplicates', async () => {
  const site = fakeSite({ '/c': ['1', '2', { id: 'b1', isBanner: true }, '2', '3'] });
  assert.deepEqual((await collectCategory(loc(), { fetch: site.fetch, sleep: noSleep })).map((p) => p.id), ['1', '2', '3']);
});

test('collectCategory stops at the 60-page cap', async () => {
  const pages = {};
  for (let n = 1; n <= 70; n++) pages[n === 1 ? '/c' : `/c?page=${n}`] = range((n - 1) * 52 + 1, n * 52);
  const site = fakeSite(pages);
  assert.equal((await collectCategory(loc(), { fetch: site.fetch, sleep: noSleep })).length, 60 * 52);
  assert.ok(site.requested.every((u) => !/page=(6[1-9]|70)$/.test(u)));
});

test('collectCategory retries a failing listing page once, then rejects', async () => {
  let calls = 0;
  const fetch = async (url) => {
    if (url === '/c?page=2') { calls++; throw new TypeError('NetworkError'); }
    return { ok: true, status: 200, text: async () => listing(url === '/c' ? range(1, 52) : []) };
  };
  await assert.rejects(collectCategory(loc(), { fetch, sleep: noSleep }));
  assert.equal(calls, 2);
});

test('collectCategory rejects a page without a product list, and rejects with AbortError when cancelled', async () => {
  await assert.rejects(collectCategory(loc(), { fetch: page(200, '<p>no list</p>'), sleep: noSleep }));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(collectCategory(loc(), { fetch: fakeSite({ '/c': range(1, 5) }).fetch, signal: ac.signal, sleep: noSleep }), { name: 'AbortError' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, with `runPool is not a function`.

- [ ] **Step 3: Implement the fetching section**

- **Internal `getPage(url, deps)`** (not exported) makes one attempt:
  - It calls `deps.fetch(url, {signal: AbortSignal.any([caller signal, AbortSignal.timeout(timeoutMs)]), credentials: 'same-origin'})`.
  - If the caller's signal is already aborted, it skips the fetch.
  - It returns one of:
    - `{kind: 'ok', text}` for a 2xx response
    - `{kind: 'limited'}` for 429 or 503
    - `{kind: 'retry'}` for other 5xx, a thrown error or a timeout
    - `{kind: 'fail'}` for any other status
    - `{kind: 'aborted'}` when the caller aborted
- **`fetchNutrition`:**
  - On `retry`, it sleeps `retryDelayMs` and tries once more; a second non-ok attempt is `failed`.
  - `ok` goes through `readNutrition`, and `unreadable` becomes `failed`.
  - `limited` becomes `rateLimited`.
  - `fail` and `aborted` become `failed`.
- **`runPool`:**
  - It keeps a queue and a limit, which starts at `concurrency`. It starts workers while fewer than the limit are in flight, the queue is non-empty, nothing has stopped it and the signal isn't aborted. Each worker is called as `worker(item, opts.signal)`.
  - When a worker resolves with a rate-limited result:
    - It increments a streak counter.
    - Once the streak reaches `maxRateLimited`, it sets `rateLimited` and starts nothing more.
    - Otherwise it sets the limit to 1, awaits `sleep(backoffMs)` and puts the item back at the front of the queue.
    - While the backoff runs, the item still counts as in flight, so nothing new starts during the pause.
  - Any other result resets the streak, is stored, and fires `onResult(item, result, done, total)`.
  - It resolves once nothing is in flight and nothing more will start. `cancelled` is `signal?.aborted === true`.
- **`collectCategory`:**
  - It fetches listing pages in batches of `concurrency` (pages 1–3, then 4–6, …) with `getPage`, using the same one-retry rule as above.
  - It processes each batch in page order. Each page's list comes from `extractAssignedJson(text, 'b_productList')`.
  - It keeps items that have an `id` and no `isBanner`, deduplicated by `id`, and calls `onPage(n)` after each page.
  - It stops after the first page that:
    - has no items
    - has fewer raw items than page 1
    - adds no new ids
    - is page `maxPages`
  - Pages after the stop are ignored.
  - It rejects with `Error('listing page N failed')` when a page still fails after the retry or has no list. It rejects with `new DOMException('Aborted', 'AbortError')` when cancelled.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add barbora-calorie-sort.user.js test/unit/fetching.test.js
git commit -m "feat: fetch product and listing pages with limits, retries and backoff" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Badges on category pages (first browser task)

These facts were verified with probes on 2026-10-17:
- **Cards:** each card is `li[data-cnstrc-item-id]`, a direct child of a `ul` with `display: grid`. The price block `[itemprop="offers"]` sits just above `button[data-cnstrc-btn="add_to_cart"]` ("Pievienot").
- **Cookie banner:** `#CybotCookiebotDialog` covers the bottom of the page.
- **Puppeteer and Firefox:**
  - puppeteer-core 25.12.0 drives `/usr/bin/firefox` (157) headless.
  - `evaluateOnNewDocument` runs before the page's inline scripts.
  - `browser.setCookie`, request interception (`abort` / `respond`) and dialogs all work.

**Files:**
- Modify: `package.json` (add a `test:browser` script and the dev dependency)
- Modify: `barbora-calorie-sort.user.js` (browser section)
- Create: `test/browser/harness.js`
- Test: `test/browser/badges.test.js`

**Interfaces:**
- Consumes: `pickLabels`, `formatBadge` (Task 3), `NutritionCache` (Task 4), `runPool`, `fetchNutrition` (Task 5), `productUrl` (Task 2).
- Produces, in the browser section:
  - `safeStorage(get: () => Storage): Storage`: the storage, or an in-memory stand-in if `get` throws
  - `injectStyle(doc): void`: adds `<style id="bcs-style">` once
  - `class CardDecorator`:
    - `constructor(container, labels, stateOf: (id) => NutritionState | {status: 'loading'})`
    - `start()`, `update(id)`
    - `setOrder(rankById: Map<string, number> | null)` (used from Task 7)
    - `ids(): string[]`
  - `class CategoryPage`:
    - `constructor({win, container, select, products, labels, cache, boot})`
    - `init()`, `stateOf(id)`, `setState(id, state)`
    - `fetchMissing(products, {signal?, onProgress?(done, total)} = {}): Promise<{rateLimited, cancelled}>`
    - fields `states: Map`, `byId: Map`, `decorator`, `loading: Promise<{rateLimited, cancelled}>`
  - `createCategoryPage(win, boot): CategoryPage | null`, and `start()`
- Produces in `test/browser/harness.js`:
  - `launchBrowser(): Promise<{browser, close}>`
  - `openCategory(browser, path, {lang?, before?, intercept?}): Promise<Page>`
  - `waitForBadges(page, timeoutMs = 90000)`
  - `readCards(page): Promise<{id, domIndex, order, text, kind}[]>` in visual order
  - `parseKcal(text): number | null`
  - `assertCalorieOrder(cards, dir)`
  - `productFetches(page): Promise<string[]>`
  - `waitUntil(fn, timeoutMs)`
  - `shot(name): string`

- [ ] **Step 1: Add the browser test setup**

In `package.json`, add the script `"test:browser": "node --test --test-concurrency=1 \"test/browser/*.test.js\""` and `"devDependencies": { "puppeteer-core": "25.12.0" }`. Then run `npm install`.

Create `test/browser/harness.js` with these exports:

```js
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
  if (intercept) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const action = intercept(req);
      if (action === 'abort') req.abort();
      else if (action && action.status) req.respond({ status: action.status, contentType: 'text/plain', body: '' });
      else req.continue();
    });
  }
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
  await page.waitForSelector('li[data-cnstrc-item-id]', { timeout: 60_000 });
  return page;
}
```

The remaining helpers:
- **`waitForBadges`:** waits until every `li[data-cnstrc-item-id]` has a `.bcs-badge` and none has `bcs-badge--loading` (polling every 250 ms).
- **`readCards`:** reads each card's id, DOM index, `Number(getComputedStyle(li).order)`, badge text, and kind (from the `bcs-badge--<kind>` class). It sorts them by `order`, then by DOM index.
- **`parseKcal`:** the leading integer of text matching `/^(\d+) (kcal|ккал)/`.
- **`assertCalorieOrder`:**
  - The `ok` cards come first, then everything else.
  - The `ok` cards' kcal values are non-decreasing for `asc` and non-increasing for `desc`.
- **`productFetches`:** the resource-timing entries with `initiatorType === 'fetch'` whose pathname starts with `/produkti/`.
- **`waitUntil`:** polls a Node-side predicate.
- **`shot`:** returns a path in `test/browser/screenshots/`, creating the folder if needed.

- [ ] **Step 2: Write the failing browser tests** in `test/browser/badges.test.js`

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:browser`
Expected: FAIL. `waitForBadges` times out because no `.bcs-badge` exists yet.

- [ ] **Step 4: Implement the browser section**

**Styles.** `injectStyle` inserts this CSS, which covers every later task:

```css
.bcs-badge { display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 999px; font-size: 12px; line-height: 16px; font-weight: 600; background: #e8f5e9; color: #1b5e20; white-space: normal; }
.bcs-badge--loading { background: #f2f2f2; color: #9e9e9e; font-weight: 400; }
.bcs-badge--none, .bcs-badge--failed { background: #f2f2f2; color: #757575; font-weight: 400; }
.bcs-status { margin: 8px 0; padding: 8px 12px; border-radius: 8px; background: #fff8e1; color: #3e2723; font-size: 14px; line-height: 20px; }
.bcs-status[hidden] { display: none; }
.bcs-status__action { margin-left: 8px; padding: 0; border: 0; background: none; color: #c00; font: inherit; text-decoration: underline; cursor: pointer; }
html.bcs-all-sorted ul.pagination { display: none !important; }
```

**`CardDecorator`:**
- **Badge:** `<span class="bcs-badge bcs-badge--<kind>" title="…">` built from `formatBadge`. It is appended to the card's `[itemprop="offers"]`, or to the `li` if that block is missing. There is one badge per card.
- **Observing:** `start()` renders every card, then observes `container` (`childList`, `subtree`). The observer callback re-renders every card. It writes to the DOM only when text, class, title or order differ, which stops the observer from looping on its own writes.
- **Ordering:**
  - `update(id)` re-renders one card.
  - `setOrder(map)` stores the ranks and re-renders.
  - With ranks, `li.style.order = String(rank)`; cards without a rank get `map.size`.
  - With `null`, it removes `order` only from cards where the decorator set it.

**`CategoryPage`:**
- **Constructor:** `byId` is built from `products`. `states` is filled from `cache.get` for each product.
- **`stateOf(id)`:** returns `states.get(id) ?? {status: 'loading'}`.
- **`setState(id, state)`:** writes to `states`, calls `cache.put` and `decorator.update(id)`.
- **`fetchMissing(products, opts)`:**
  - Runs `runPool` over `products` with `concurrency: CONFIG.productConcurrency` and `isRateLimited: (r) => r.status === 'rateLimited'`.
  - The worker calls `fetchNutrition(productUrl(p), {fetch: win.fetch.bind(win), signal})` and, unless the result is rate-limited, `setState(p.id, result)`.
  - `onProgress` comes from `onResult`.
  - When the run wasn't cancelled, products still without a state become `failed`.
  - It always calls `cache.flush()` at the end.
- **`init()`:** calls `injectStyle`, starts the decorator, then sets `this.loading = this.fetchMissing(products without a state)`.

**`createCategoryPage(win, boot)`:**
- Returns `null` when `#category-page-results-placeholder` is missing.
- When `win.b_productList` isn't an array, it logs `console.warn('[calorie-sort] product list not found')` and returns `null`.
- Otherwise it builds the page with:
  - `labels` from `pickLabels(win.b_data?.selectedLanguageData?.locale)`
  - `new NutritionCache(safeStorage(() => win.localStorage))`
  - `select` from `select.b-orderby`
- Then it calls `init()`.

**`start()`:** runs `createCategoryPage(window, {})` on `DOMContentLoaded`, or immediately if the document has already been parsed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:browser`
Expected: PASS, 3 tests. Look at `test/browser/screenshots/badges.png` and check that each badge sits under the price, above "Pievienot". Then run `npm test` and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json barbora-calorie-sort.user.js test/browser
git commit -m "feat: show kcal and protein badges on category cards" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sort options, one-page sort and status line

**Files:**
- Modify: `barbora-calorie-sort.user.js` (browser section)
- Test: `test/browser/one-page-sort.test.js`

**Interfaces:**
- Consumes:
  - `parseMarker`, `sortProducts` (Task 2)
  - `fill`, `composeNotice` (Task 3)
  - `CardDecorator.setOrder`, `CategoryPage.loading` and `fetchMissing` (Task 6)
- Produces:
  - `class StatusLine`: `constructor(container, labels)`, `progress(text, onCancel?)`, `notice(text, action?: {label, onClick})`, `clear()`
  - `class SortControl`: `constructor(select, labels, {onCalorie(dir), onLeave()})`, `install()`, `show(dir | null)`, `handleChange(event)`
  - `CategoryPage` gains:
    - fields `status` and `sortControl`
    - `isMultiPage(): boolean`
    - `sort(dir)`, `onePageSort(dir): Promise<void>`, `leaveCalorieMode()`
  - `boot.marker` (from `start()`) is read by `init()`

- [ ] **Step 1: Write the failing browser tests** in `test/browser/one-page-sort.test.js`

```js
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
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.select('select.b-orderby', 'priceAsc')]);
    const url = new URL(page.url());
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/browser/one-page-sort.test.js`
Expected: FAIL. `page.select` rejects because there is no `bcs-kcal-asc` option.

- [ ] **Step 3: Implement**

**`StatusLine`:**
- It creates `<div class="bcs-status" role="status" hidden>` just before `container`.
- `progress` and `notice` replace its content with the text. They add a `button.bcs-status__action` labelled `labels.cancel` (for progress with `onCancel`) or `action.label` (for a notice with an action), wired to the callback.
- `clear()` empties it and sets `hidden`.

**`SortControl`:**
- `install()` appends the options `bcs-kcal-asc` (`labels.sortAsc`) and `bcs-kcal-desc` (`labels.sortDesc`) once, and records `previous = select.value`.
- `show(dir)` sets `select.value` to `bcs-kcal-<dir>`. `show(null)` restores `previous`.
- `handleChange(e)`:
  - For a `bcs-kcal-*` value, it calls `e.stopImmediatePropagation()` and then `onCalorie(dir)`.
  - For any other value, it stores it in `previous` and calls `onLeave()`. The event then continues to the site's own listener.

**`start()`:**
- It computes `boot = {marker: parseMarker(location.hash)}`.
- It keeps the created page in a variable.
- It registers `window.addEventListener('change', e => { if (page && e.target?.matches?.('select.b-orderby')) page.sortControl.handleChange(e); }, true)` at document-start, before `DOMContentLoaded`.

**`CategoryPage` additions:**
- **`init()`:**
  - Creates the `StatusLine` and the `SortControl` (the latter only when `select` exists). Wires `onCalorie` to `sort` and `onLeave` to `leaveCalorieMode`, calls `install()`, and calls `show(boot.marker)` when a marker is present.
  - The page-load `fetchMissing` reports progress as `status.progress(fill(labels.loadingNutrition, {done, total}))`.
  - Afterwards it calls `status.notice(text)` when `composeNotice(labels, {failed: failed products on this page, rateLimited})` is non-empty, and `status.clear()` otherwise.
  - `this.loading` resolves only after that notice/clear step. That way the page-load notice can never overwrite a notice shown by a sort flow that awaited `this.loading`.
  - With a marker, it then calls `sort(boot.marker)`.
- **`isMultiPage()`:** true when `.pagination a[href*="page="]` exists, or the URL's `page` is greater than 1.
- **`sort(dir)`:** for now it calls `onePageSort(dir)`. Task 8 adds the multi-page branch.
- **`onePageSort(dir)`:**
  1. `await this.loading`.
  2. Build ranks from `sortProducts(products, states, dir)` (product id → index) and call `decorator.setOrder(ranks)`.
  3. Call `history.replaceState(null, '', location.pathname + location.search + '#kcal-' + dir)` and `sortControl.show(dir)`.
- **`leaveCalorieMode()`:** when the URL has a marker, drops it with `history.replaceState(null, '', location.pathname + location.search)`, then calls `decorator.setOrder(null)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:browser`, then `npm test`
Expected: PASS for both. Task 6's tests still pass.

- [ ] **Step 5: Commit**

```bash
git add barbora-calorie-sort.user.js test/browser/one-page-sort.test.js
git commit -m "feat: sort one-page categories by calories from the site's dropdown" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Whole-category view

**Files:**
- Modify: `barbora-calorie-sort.user.js` (new core section "list swap", plus browser section)
- Test: `test/unit/swap.test.js`, `test/browser/multi-page-sort.test.js`

**Interfaces:**
- Consumes:
  - `listKey`, `sortedViewUrl`, `baseQuery` (Task 2)
  - `composeNotice`, `fill` (Task 3)
  - `saveList`, `loadList` and `fakeStorage` (Task 4)
  - `collectCategory` (Task 5)
  - `CategoryPage` and `StatusLine` / `SortControl` (Tasks 6–7)
- Produces:
  - `installSwapHook(win, record: SavedList): {swapped: boolean, original: object[] | null}`. The object is live: `swapped` turns true when the site's assignment is intercepted.
  - `markReload(storage, now): void` and `consumeReload(storage, now): boolean`. The flag lives under `CONFIG.keys.reload`. It is true at most once, and only within `CONFIG.reloadWindowMs` of `markReload`.
  - `CategoryPage` gains:
    - `allSorted: boolean`
    - `multiPageSort(dir)`, `verifyAllSorted()`, `fallbackToOnePage(dir)`, `backToNormal()`
  - `boot` gains `record`, `swap`, `justReloaded`, `session`.

- [ ] **Step 1: Write the failing unit tests** in `test/unit/swap.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { installSwapHook, markReload, consumeReload } = require('../../barbora-calorie-sort.user.js');
const { fakeStorage } = require('./helpers');

const record = { products: [{ id: '1' }, { id: '2' }, { id: '3' }] };

test('installSwapHook hands the saved list to a later assignment', () => {
  const win = {};
  const swap = installSwapHook(win, record);
  assert.equal(swap.swapped, false);
  win.b_productList = [{ id: '1' }];
  assert.equal(win.b_productList, record.products);
  assert.deepEqual(swap.original, [{ id: '1' }]);
  assert.equal(swap.swapped, true);
});

test('installSwapHook swaps immediately when the list already exists', () => {
  const original = [{ id: '1' }];
  const win = { b_productList: original };
  const swap = installSwapHook(win, record);
  assert.equal(win.b_productList, record.products);
  assert.equal(swap.original, original);
  assert.equal(swap.swapped, true);
});

test('installSwapHook reports no swap when the property cannot be redefined', () => {
  const win = {};
  Object.defineProperty(win, 'b_productList', { value: undefined, writable: true, configurable: false });
  const swap = installSwapHook(win, record);
  win.b_productList = [{ id: '1' }];
  assert.equal(swap.swapped, false);
  assert.deepEqual(win.b_productList, [{ id: '1' }]);
});

test('consumeReload is true once, within the window', () => {
  const s = fakeStorage();
  markReload(s, 1000);
  assert.equal(consumeReload(s, 15_000), true);
  assert.equal(consumeReload(s, 15_500), false);
  markReload(s, 0);
  assert.equal(consumeReload(s, 16_000), false);
  assert.equal(consumeReload(fakeStorage(), 1), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`
Expected: FAIL, with `installSwapHook is not a function`.

- [ ] **Step 3: Implement the list-swap section and export it**

- **`installSwapHook`:**
  - If `Array.isArray(win.b_productList)` (the script was injected late), store the original, assign `record.products` and mark `swapped`.
  - Otherwise, inside try, call `Object.defineProperty(win, 'b_productList', {configurable: true, enumerable: true, get: () => record.products, set: (v) => { swap.original = v; swap.swapped = true; }})`.
  - On error, log `console.warn('[calorie-sort] could not hook the product list', e)` and leave `swapped` false.
- **`markReload` / `consumeReload`:**
  - `markReload` stores `{at: now}`.
  - `consumeReload` reads the value, removes it and returns `now - at <= CONFIG.reloadWindowMs`.
  - Both are wrapped in try/catch, so storage errors give `false`.

Run `npm test` and expect PASS.

- [ ] **Step 4: Write the failing browser tests** in `test/browser/multi-page-sort.test.js`

```js
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
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120_000 }), page.select('select.b-orderby', 'bcs-kcal-asc')]);
    await page.waitForSelector('html.bcs-all-sorted', { timeout: 30_000 });
    await h.waitForBadges(page);
    const cards = await h.readCards(page);
    assert.equal(cards.length, total);
    h.assertCalorieOrder(cards, 'asc');
    assert.ok(await page.$$eval('ul.pagination', (uls) => uls.every((u) => getComputedStyle(u).display === 'none')));
    assert.ok((await page.$eval('.bcs-status', (e) => e.textContent)).includes(`Visas preces (${total}) sakārtotas pēc kalorijām`));
    assert.equal(new URL(page.url()).hash, '#kcal-asc');
    assert.equal(await page.$eval('select.b-orderby', (s) => s.value), 'bcs-kcal-asc');
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
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120_000 }), page.select('select.b-orderby', 'bcs-kcal-asc')]);
    await page.waitForSelector('li[data-cnstrc-item-id]');
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
```

- [ ] **Step 5: Run them to verify they fail**

Run: `node --test test/browser/multi-page-sort.test.js`
Expected: FAIL. The first test times out waiting for navigation, because the one-page sort doesn't reload.

- [ ] **Step 6: Implement the whole-category flow**

**`start()`, at document-start:**
1. `session = safeStorage(() => window.sessionStorage)`.
2. `marker = parseMarker(location.hash)`.
3. `justReloaded = consumeReload(session, Date.now())`.
4. `record = marker ? loadList(session, listKey(location), marker, Date.now()) : null`.
5. `swap = record ? installSwapHook(window, record) : null`.

These go into `boot`, before anything waits for `DOMContentLoaded`.

**`init()`:**
- **When `boot.swap?.swapped` (the all-sorted view):**
  - Fill `states` from the cache, plus `{status: 'failed'}` for each id in `record.failed`. Any product still without a state is `failed`.
  - Do not fetch: `this.loading = Promise.resolve({rateLimited: record.rateLimited, cancelled: false})`.
  - Skip the page-load notice.
- **With a marker, decide in this order:**
  1. `swap?.swapped` → `verifyAllSorted()`.
  2. Otherwise `record || justReloaded` → `fallbackToOnePage(marker)`. This is the reload-loop guard.
  3. Otherwise → `sort(marker)`.

**`sort(dir)`:** `isMultiPage() ? multiPageSort(dir) : onePageSort(dir)`.

**`multiPageSort(dir)`:**
1. `await this.loading`.
2. Show `status.progress(fill(labels.loadingPages, {n}))` as pages arrive, from `collectCategory(location, {fetch: win.fetch.bind(win), onPage})`. If it rejects, call `fallbackToOnePage(dir)` and stop.
3. Call `fetchMissing` on the products without a state, with `labels.loadingNutrition` progress.
4. `sorted = sortProducts(products, states, dir)`. `failed` is the ids of sorted products whose state is `failed`.
5. If `saveList(boot.session, {key: listKey(location), dir, savedAt: Date.now(), products: sorted, failed, rateLimited})` returns false, call `fallbackToOnePage(dir)` and stop.
6. `markReload(boot.session, Date.now())`, then `history.replaceState(null, '', sortedViewUrl(location, dir))`, then `location.reload()`.

**`verifyAllSorted()`:**
- Wait until `decorator.ids().length === record.products.length`. Check now and on each container mutation, for at most `CONFIG.verifyTimeoutMs`.
- On success:
  - set `allSorted = true` and add the class `bcs-all-sorted` to `<html>`
  - call `sortControl.show(dir)`
  - call `status.notice(composeNotice(labels, {total: record.products.length, failed: record.failed.length, rateLimited: record.rateLimited}), {label: labels.backToNormal, onClick: () => this.backToNormal()})`
- On a timeout: `fallbackToOnePage(dir)`.

**`fallbackToOnePage(dir)`:** `await onePageSort(dir)`, then `status.notice(labels.fallback)`.

**`backToNormal()`:** `location.href = location.pathname + baseQuery(location.search)`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`, then `npm run test:browser`
Expected: PASS for both. Look at `test/browser/screenshots/all-sorted.png`: the banner should be above the grid with no page links.

- [ ] **Step 8: Commit**

```bash
git add barbora-calorie-sort.user.js test/unit/swap.test.js test/browser/multi-page-sort.test.js
git commit -m "feat: sort a whole multi-page category into one list of site cards" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Backing out, direction switch, README

**Files:**
- Modify: `barbora-calorie-sort.user.js` (core exports plus browser section)
- Create: `README.md`
- Test: `test/unit/flow.test.js`, `test/browser/edge-cases.test.js`

**Interfaces:**
- Consumes: everything above. In particular `CategoryPage.multiPageSort`, `allSorted`, `boot.record`, `SortControl.show(null)`, `markReload`, `saveList`.
- Produces:
  - `needsConfirm(n: number): boolean`: `n > CONFIG.confirmAbove`
  - `estimateSeconds(n: number): number`: `Math.max(1, Math.round(n / CONFIG.fetchesPerSecond))`
  - `CategoryPage.cancel()` and `CategoryPage.switchDirection(dir)`

- [ ] **Step 1: Write the failing unit tests** in `test/unit/flow.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsConfirm, estimateSeconds } = require('../../barbora-calorie-sort.user.js');

test('needsConfirm only above 300', () => {
  assert.equal(needsConfirm(300), false);
  assert.equal(needsConfirm(301), true);
});

test('estimateSeconds is N / 30, rounded, at least 1', () => {
  assert.equal(estimateSeconds(650), 22);
  assert.equal(estimateSeconds(10), 1);
  assert.equal(estimateSeconds(0), 1);
});
```

- [ ] **Step 2: Write the failing browser tests** in `test/browser/edge-cases.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const YOGURTS = '/piena-produkti-un-olas/jogurti-un-deserti/jogurts-ar-piedevam'; // 84 products, 2026-10-17
const YOGURTS_AND_DESSERTS = '/piena-produkti-un-olas/jogurti-un-deserti'; // about 200 products, 2026-10-17
const DAIRY = '/piena-produkti-un-olas'; // about 970 products, 2026-10-17

test('cancel leaves the page as it was', { timeout: 300_000 }, async () => {
  const { browser, close } = await h.launchBrowser();
  try {
    const page = await h.openCategory(browser, YOGURTS_AND_DESSERTS);
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
    assert.equal(new URL(page.url()).hash, '');
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
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120_000 }), page.select('select.b-orderby', 'bcs-kcal-asc')]);
    await page.waitForSelector('html.bcs-all-sorted', { timeout: 30_000 });
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }), page.select('select.b-orderby', 'bcs-kcal-desc')]);
    await page.waitForSelector('html.bcs-all-sorted', { timeout: 30_000 });
    await h.waitForBadges(page);
    const cards = await h.readCards(page);
    assert.equal(cards.length, total);
    h.assertCalorieOrder(cards, 'desc');
    assert.equal((await h.productFetches(page)).length, 0);
    assert.equal(new URL(page.url()).hash, '#kcal-desc');
  } finally { await close(); }
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test` and `node --test test/browser/edge-cases.test.js`
Expected:
- Unit: FAIL, with `needsConfirm is not a function`.
- Browser: FAIL. There is no Cancel button, no dialog and no direction switch yet.

- [ ] **Step 4: Implement**

- **`needsConfirm` / `estimateSeconds`:** add them in the fetching section and export them.
- **`cancel()`:** `this.abort?.abort()`, `this.abort = null`, `status.clear()`, `sortControl.show(null)`.
- **`multiPageSort(dir)` changes:**
  - It starts with `this.abort?.abort(); const ac = this.abort = new AbortController();`. A new choice cancels a running one.
  - It passes `signal: ac.signal` to `collectCategory` and `fetchMissing`.
  - Every progress line passes `() => this.cancel()` as `onCancel`. Progress callbacks do nothing once `ac.signal.aborted`, so a request finishing after Cancel can't bring the status line back.
  - After each `await`, it returns quietly if `ac.signal.aborted`. An `AbortError` from `collectCategory` is not a fallback.
  - After collecting, it computes `missing`. If `needsConfirm(missing.length)` and `!win.confirm(fill(labels.confirm, {n: missing.length, s: estimateSeconds(missing.length)}))`, it calls `cancel()` and returns.
- **`switchDirection(dir)`:**
  1. Re-sort `boot.record.products` with `sortProducts(products, states, dir)`.
  2. Save with `saveList(boot.session, {...boot.record, dir, products: sorted})`, keeping `savedAt` unchanged. If that fails, call `fallbackToOnePage(dir)`.
  3. `markReload(boot.session, Date.now())`, `history.replaceState(null, '', sortedViewUrl(location, dir))`, then `location.reload()`.
- **`sort(dir)`:** checks `this.allSorted` first and calls `switchDirection(dir)`.
- **`README.md`** has these sections:
  - **What it does:** one paragraph.
  - **Install:**
    1. Install Tampermonkey in Firefox.
    2. Dashboard → Utilities → "Import from file" → pick `barbora-calorie-sort.user.js`. Alternatively, create a new script, paste the file in and save.
  - **Use:** the badges, the two dropdown options and "Back to normal view".
  - **Good to know:**
    - many fresh products have no data
    - the first sort of a big category takes time
    - values are remembered for 30 days
    - Latvian, English and Russian are supported
  - **Development:** `npm test`, `npm install`, `npm run test:browser`.
  - **Troubleshooting:** look for `[calorie-sort]` messages in the browser console.

- [ ] **Step 5: Run everything**

Run: `npm test`, then `npm run test:browser`
Expected: every unit and browser test passes, from all tasks.

- [ ] **Step 6: Commit**

```bash
git add barbora-calorie-sort.user.js README.md test/unit/flow.test.js test/browser/edge-cases.test.js
git commit -m "feat: add cancel, the big-category question and direction switching; add README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand over for the manual check**

Tell the user how to install the script in Tampermonkey (README "Install"). Ask them to check "Vistas gaļa" and one multi-page category, including "Pievienot" from the sorted list while logged in. Logged-in carts can't be exercised by the anonymous browser tests.
