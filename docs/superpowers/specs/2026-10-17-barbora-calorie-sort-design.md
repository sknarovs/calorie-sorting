# Barbora calorie sort: design

Date: 2026-10-17
Status: implemented on `feature/calorie-sort`

**Revision (2026-10-17, after first use).** The first version loaded nutrition for every card on
every category page and could sort a whole multi-page category into one list. In real use the
automatic loading got the user's IP throttled by Barbora's Cloudflare front after a few pages.
The design below replaces it:
- Nothing is loaded while browsing.
- Values load, slowly, only when the user picks a calorie sort.
- The sort covers the page on screen, so it combines with the site's own sorts. For example, sort
  by price per unit first, then by calories.
- The badge became a box shaped like the price box.

The whole-category view, its list swap and its big-category question were removed; they remain in
the git history.

**Revision 2.** Sorting by price per unit ("Cena par vienību", either direction) now loads the
values for that page by itself, without reordering. Next to a discounted price, where two joined
price boxes leave only about 63 px, the kcal box uses a compact size so it stays on the same line.

**Revision 3.** Any of the site's own sort options (any `order` parameter other than `default`) now
triggers the loading, not only price per unit. The unsorted page still loads nothing.

## Goal

The user orders groceries on barbora.lv and wants to eat healthier and possibly lose weight.
Category pages can be sorted by name, price, unit price and promotions, but not by calories;
nutrition values are only visible on each product's own page.

A Tampermonkey userscript adds:

1. two options to the site's "Kārtot pēc" dropdown that sort the products on the current page by
   calories (low to high, high to low), loading the values they need on demand, and
2. a small box with kcal and protein per 100 g/ml next to each product's price, once known.

## Success criteria

1. Browsing category pages makes no extra requests to Barbora. The exception is a page the user
   sorted with one of the site's own options, where the values for that page load automatically.
2. Picking a calorie option loads the missing values for the products on screen, at a gentle pace,
   then reorders them. Products with equal values keep the order the site showed them in.
3. Each known product shows a price-like box with kcal and protein. Saved values appear
   immediately on later visits.
4. Labels follow the site's language (Latvian, English, Russian).
5. The script never breaks the page. When Barbora limits requests it stops, sorts with what it
   has, and says so.

## Non-goals

- Sorting more than the page on screen (removed in the revision).
- Search results, promotion pages and other product lists.
- Sorting by protein or any nutrient other than calories.
- Estimating values for products without a nutrition table.
- Any use of Barbora's cart, checkout or account APIs.

## Site facts relied on

Verified 2026-10-17 against the live site (client version v1.59.1).

| Fact | Detail |
|---|---|
| Product list | Inline script `window.b_productList = [...]`, at most 52 products per page. Fields used: `id`, `Url`, `isBanner`. |
| Card rendering | React renders the list into `#category-page-results-placeholder` > `ul` (CSS grid). Each card is a direct grid child `li[data-cnstrc-item-id="<id>"]`. For logged-in users, "Pievienot" also inserts a full-width recommendations row (`li.tw-col-span-2`) after the clicked product's row. Its carousel items carry `data-cnstrc-item-id` too, but they are not cards. |
| Price area | `[itemprop="offers"]`, about 201 px wide on desktop. A normal price box is a 67×60 px rounded box. A discounted product has two joined boxes (blue promo price plus white regular price) in a flex row, about 134 px together. |
| Native sort | `select.b-orderby`. Its own `change` listener navigates to the current query plus `order=<value>`, without `page`. `comparativePriceAsc` is "Cena par vienību (augoši)". |
| Product page | `/produkti/<Url>`, with an inline `window.product = {...}`. `nutrients: [{Name, Amounts: [{Amount, UnitName}]}]` holds values per 100 g/ml; the `nutrients` key is absent when the product has no label. The visible table reads `717.00 kJ / 172.00 Kcal` (Russian site: `кДж / ккал`). |
| Language | Chosen by cookie. `window.b_data.selectedLanguageData.locale` is `lv`, `en` or `ru`. `UnitName` is `Kcal` in every language; the protein row is named `Olbaltumvielas` / `Proteins` / `Белки`. |
| Throttling | Barbora sits behind Cloudflare, which answers HTTP 429, or a 403 with `cf-mitigated: challenge` ("Just a moment..."), once an address sends many requests within a few minutes. One category page view already makes about 28 barbora.lv requests of its own. |
| Data coverage | Packaged goods nearly always have data. Fresh, unprocessed goods often don't (15/32 in "Vistas gaļa"). |

## User-facing behaviour

### Browsing
- No product pages are requested.
- Cards whose values were saved by an earlier sort show their box straight away. Other cards show
  nothing.
- **Pages sorted with a site option** (any `order` parameter other than `default`: price, price per
  unit, alphabetical, discounts…): the values for the products on the page load automatically, with
  the same pace, progress line and Cancel as a calorie sort. The site's order stays, and a later
  calorie sort reuses the loaded values.

### Sorting
- Two options are appended to `select.b-orderby`: calories low to high (`bcs-kcal-asc`) and high to
  low (`bcs-kcal-desc`).
- **Loading.** On a calorie choice, the script loads the products on this page that have no saved
  value:
  - at most 2 at a time, with at least 0.3 s between request starts;
  - about 15 s for 52 new products;
  - a status line shows "Loading nutrition: done / total" with a Cancel button;
  - those cards show a faint `… kcal` box meanwhile.
- **Ordering.** The page is then reordered with CSS `order` on each card. Products with a kcal
  value come first, in the chosen direction; products without one follow, in site order. Ties keep
  site order, so after "Cena par vienību (augoši)" the cheapest-per-unit page comes out ordered by
  calories.
- **Marker.** `#kcal-asc` / `#kcal-desc` is added with `history.replaceState`. A reload sorts
  again, which is instant for saved values.
- **Switching direction.** This only re-orders; nothing is loaded again.
- **Cancel.** Stops loading, leaves the page in site order, restores the dropdown and removes the
  marker. Products that were mid-request stay unknown and are loaded by the next sort.
- **Native options.** Choosing a native option, or the placeholder, leaves calorie mode and lets
  the site's own sort run.
- **Recommendations row.** A row inside the grid gets no boxes. In calorie mode it is placed after
  all cards.

### The box
- **Placement:** inside `[itemprop="offers"]`, in the same row as the price box(es), via
  `[itemprop="offers"]:has(> .bcs-box) { display: flex; flex-wrap: wrap; … }`. Other blocks of the
  price area keep their own line. When there is no room (discounted products, narrow screens), the
  box wraps below the price.
- **Shape:** 60 px tall like the price box, rounded 8 px corners, padding 7–8 px.
  - First line: bold, 16 px, e.g. `172 kcal`.
  - Second line: 12 px, e.g. `17 g olb.`; omitted when there is no protein value.
- **Compact size:** next to a discounted price (the price area holds a joined pair, detected by a
  `rounded-l-*` box), the box uses 4 px side padding, a 12 px first line and a 10 px second line.
  That is about 55 px, which fits the ~63 px left there in Latvian.
- **Tooltip:** "per 100 g/ml" (Latvian adds that "olb." means olbaltumvielas).
- **States:**
  - value: light green
  - `nav datu`: grey (no nutrition table)
  - `?`: grey (couldn't load; tooltip says so)
  - `… kcal`: faint (loading)
- **Numbers:** `Intl.NumberFormat` for the site locale, so Latvian and Russian get a decimal
  comma. kcal has no decimals; protein has at most one.

### Labels

The language comes from `window.b_data.selectedLanguageData.locale`; anything other than `en` or
`ru` uses Latvian.

| Key | lv | en | ru |
|---|---|---|---|
| kcal | {k} kcal | {k} kcal | {k} ккал |
| protein | {p} g olb. | {p} g protein | {p} г белка |
| boxTitle | uz 100 g/ml · olb. — olbaltumvielas | per 100 g/ml | на 100 г/мл |
| sortAsc | Kalorijas (augoši) | Calories from lowest | Калорийности от самой низкой |
| sortDesc | Kalorijas (dilstoši) | Calories from highest | Калорийности от самой высокой |
| noData | nav datu | no data | нет данных |
| failedTitle | Neizdevās ielādēt | Couldn't load | Не удалось загрузить |
| loadingNutrition | Ielādē uzturvērtību: {done} / {total} | Loading nutrition: {done} / {total} | Загрузка пищевой ценности: {done} / {total} |
| cancel | Atcelt | Cancel | Отмена |
| someFailed | Neizdevās ielādēt: {n} | {n} couldn't be loaded | Не удалось загрузить: {n} |
| rateLimited | Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem | Barbora is limiting requests — sorted with the data loaded so far | Barbora ограничивает запросы — отсортировано по уже загруженным данным |

## Architecture

### Packaging

- **One file:** `barbora-calorie-sort.user.js`, with no build step and no runtime dependencies.
- **Metadata:** `@match https://barbora.lv/*` and `https://www.barbora.lv/*`, `@run-at
  document-start`, `@grant none`, `@sandbox raw`, `@noframes`.
- **Testing hook:** pure functions are exported for Node tests through
  `if (typeof window === 'undefined') module.exports = {...}; else start();`.

### Units

Pure, unit-tested in Node:

| Unit | Responsibility |
|---|---|
| `extractAssignedJson(html, name)` | Parse the JSON value after `window.<name> =` (string- and escape-aware bracket matching), or `null`. |
| `readNutrition(html)` | Product page → `{status: 'ok', kcal, protein}`, `{status: 'none'}` or `{status: 'unreadable'}`. Rules below. Never throws. |
| `parseMarker(hash)`, `autoLoads(search)`, `productUrl(product)` | `#kcal-asc` → `asc`; true when the page has a site sort (`order` other than `default`); `/produkti/<Url>`. |
| `sortProducts(products, states, dir)` | Stable sort by kcal, entries without a number last in original order. |
| `pickLabels`, `fill`, `formatBox`, `composeNotice` | Labels for the site locale; box lines/kind/title per state; status text for failures and rate limiting. |
| `isFresh`, `NutritionCache(storage)` | Cache TTLs; load, lookup, batched put, merge-on-write, pruning, quota handling. |
| `startCooldown`, `inCooldown` | Shared 5-minute cooldown in localStorage after rate limiting. |
| `runPool(items, worker, opts)` | Concurrency limit, minimum spacing between starts, cancel, rate-limit backoff. |
| `fetchNutrition(url, deps)` | One product page with timeout and one retry → `ok` / `none` / `failed` / `rateLimited` (429, 503 and Cloudflare challenges count as rate limiting). |
| `safeStorage(get)` | The storage, or an in-memory stand-in if access throws. |

Browser-only, covered by the browser tests:

| Part | Responsibility |
|---|---|
| `CardDecorator` | MutationObserver on the results container. It keeps a box and, while sorted, a CSS `order` on every card, and places other grid children after the cards. It writes only what differs. |
| `StatusLine` | One element before the results container. Its text, label and handler update in place; its single button element is never replaced. |
| `SortControl` | Adds the two options, shows the active one, and intercepts `change` in the capture phase on `window`. |
| `CategoryPage` | Saved states, the on-demand loading run (one at a time), sorting, cancel, leaving calorie mode, cooldown. |
| `start()` | Reads the marker and registers the capture listener at document-start. Builds the page on `DOMContentLoaded`. |

### Nutrition reading rules

1. Parse `window.product`. kcal is the first finite `Amount` whose `UnitName` matches `/^kcal$/i`.
   Without one, kcal comes from `kJ / 4.184`, rounded.
2. Protein is the first amount of the nutrient named `Olbaltumvielas`, `Proteins`, `Protein`,
   `Белки` or `Белок` (trimmed, case-insensitive).
3. Malformed entries are skipped. A missing amount (`null`, `""`) is "no value", never 0.
4. Without `window.product`, read the visible table instead: kcal from
   `/([\d.,]+)\s*(?:kcal|ккал)/i`, protein by the same names.
5. kcal must be in 0–950, otherwise `none`. Protein outside 0–100 is dropped.
6. With neither product data nor a nutrition table, the result is `unreadable`, which is counted as
   failed and never cached.

## Storage

| Key | Storage | Rules |
|---|---|---|
| `bcs:nutrition:v1` | localStorage | `{ [id]: {k, p, t} }`, where `k: null` means no data. Fresh for 30 days with data, 7 days without. At most 6000 entries. Flushed every 20 results and at the end of a run, merging over what other tabs wrote. On a quota error, the oldest 25% are dropped and the write is retried once. |
| `bcs:cooldown` | localStorage | `{until}`, set for 5 minutes when a run ends rate-limited. While it lasts, no product pages are requested anywhere: unknown products show `?` and the page is sorted with what is known. |

## Error handling

| Situation | Behaviour |
|---|---|
| Network error, timeout (15 s), 5xx other than 503 | One retry after 1 s. Then `?`, sorted last, not cached, and the "couldn't be loaded" count is shown. |
| Other 4xx (e.g. a removed product) | Failed straight away. |
| 429, 503 or a Cloudflare challenge | Pause 5 s and drop to one request at a time. After 3 in a row, stop and start the cooldown; products not yet loaded count as failed for this sort, and the page is sorted with the rate-limited notice. |
| Cancel | Abort in-flight requests. Nothing that was cut short is recorded. Page order, dropdown and URL return to how they were. |
| Malformed product data | Skipped; `readNutrition` never throws. |
| Storage blocked or full | In-memory stand-in, or pruning; nothing throws. |
| Expected elements missing | Skip the feature, leave the page alone, and log a warning starting with `[calorie-sort]`. |

## Testing

- **Unit (`npm test`, Node's built-in runner, offline):**
  - nutrition reading against real saved pages (LV/EN/RU, no-label, four rows), plus malformed and
    edge cases
  - sorting, labels and box text, cache, cooldown
  - the pool: concurrency, spacing, cancel, backoff
  - fetch outcomes
- **Browser (`npm run test:browser`):** puppeteer-core drives the installed Firefox against a
  recorded copy of barbora.lv; only the site's own `/api/` calls stay live. Checks:
  - browsing the unsorted page makes no product requests
  - a page sorted by price per unit, or by price, shows the boxes without reordering
  - next to a discounted price the box stays on the price line
  - sorting loads values and puts each box beside the price at the same height
  - saved values show with zero requests
  - cards re-rendered by the site get their box and position back
  - reload keeps the order; switching direction loads nothing
  - a unit-price-sorted page keeps its products when sorted by calories
  - never more than 2 product requests in flight, about 0.3 s apart
  - native options leave calorie mode
  - Russian labels
  - rate limiting and the cooldown
  - the recommendations row
  - Cancel, then sorting again without failures
- **Manual (user):** real Tampermonkey, logged in, including "Pievienot" in a sorted list.

## Project layout

```
barbora-calorie-sort.user.js
package.json                      devDependencies: puppeteer-core; scripts: test, test:browser
scripts/trim-fixture.js           makes the unit-test fixtures from real product pages
test/unit/*.test.js, test/unit/helpers.js, test/fixtures/*.html
test/browser/*.test.js, test/browser/harness.js   (recorded pages in test/browser/.cache, git-ignored)
README.md
docs/superpowers/specs/, docs/superpowers/plans/
```
