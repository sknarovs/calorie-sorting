# Barbora calorie sort: design

Date: 2026-10-17
Status: design agreed in conversation; awaiting spec review

## Goal

The user orders groceries on barbora.lv and wants to eat healthier and possibly
lose weight. Category pages can be sorted by name, price, unit price and promotions,
but not by calories; nutrition values are only visible on each product's own page.

A Tampermonkey userscript adds:

1. a calorie and protein badge on every product card of a category page, and
2. "sort by calories" (low to high, high to low) that orders the **whole category**
   (all pages, current filters) on one page, using the site's own product cards.

## Success criteria

1. On a category page, every card shows its kcal and protein per 100 g/ml, or a
   clear "no data" / "couldn't load" marker. Cached values show instantly; new ones
   appear within seconds for a one-page category.
2. The "Kārtot pēc" dropdown offers two calorie options, labelled in the site's
   current language (Latvian, English or Russian).
3. Choosing a calorie option on a multi-page category shows all of its products in
   one sorted list, and the site's "Pievienot" buttons work on every card.
4. The script never breaks the page. When something fails it falls back to sorting
   the current page, or to doing nothing, and says so.

## Non-goals

- Search results, promotion pages and other product lists (possible later).
- Sorting by protein or any nutrient other than calories.
- Calorie sort that carries over to other categories.
- Estimating values for products without a nutrition table.
- Any use of Barbora's cart, checkout or account APIs.

## Site facts relied on

Verified 2026-10-17 against the live site (client version v1.59.1) by fetching pages
and reading the minified bundle `/build/main.concat.js`.

| Fact | Detail |
|---|---|
| Product list on category pages | Inline script `window.b_productList = [...]`, at most 52 items per page. Paging via `?page=N`; a page past the end returns `[]`. Fields used: `id`, `Url`. |
| Card rendering | React reads `window.b_productList` **at render time** and renders it into `#category-page-results-placeholder` > `ul` (CSS grid) > one `li[data-cnstrc-item-id="<id>"]` per product. All `li` are direct grid children. |
| Price block in a card | `[itemprop="offers"]` (contains `[data-testid="priceTextContainer"]`). |
| Native sort | `select.b-orderby`; its own `change` listener navigates to the current query plus `order=<value>`, minus `page`. Values: `name`, `nameDesc`, `priceAsc`, `priceDesc`, `discount`, `discountDesc`, `aciuOffers`, `aciuOffersDesc`, `comparativePriceAsc`, `comparativePriceDesc`. |
| Pagination | Server-rendered `ul.pagination`; links carry `page=` only when there is more than one page. |
| Product page | `/produkti/<Url>`; inline `window.product = {...}` with `nutrients: [{Name, Amounts: [{Amount, UnitName}], PercentOfGda}]`, values per 100 g/ml. The `nutrients` key is absent when the product has no label. The visible table repeats the energy row as `717.00 kJ / 172.00 Kcal`; on the Russian site it reads `717.00 кДж / 172.00 ккал`. |
| Language | Chosen by cookie (`lng`, `lang`); same URLs. `window.b_data.selectedLanguageData.locale` is `lv`, `en` or `ru`. Pages fetched by the script come back in the current language. `UnitName` is `Kcal` in every language; the protein row is named `Olbaltumvielas` / `Proteins` / `Белки`. |
| Security headers | CSP has only `frame-ancestors` and `frame-src`; nothing restricts scripts. |
| URL hash | Not read by the site's code, so it is free for a marker. |
| Data coverage | Packaged goods: 20/20 sampled dairy products have data. Fresh, unprocessed goods often do not: 15/32 in "Vistas gaļa" have no nutrition table at all. |
| Fetch cost | 32 product pages at 4 in parallel took ~1.1 s, ~18 KB each compressed; no rate limiting seen. |

## User-facing behaviour

### Badges

- Every card on a category page gets a small badge, appended inside the card's
  price block (`[itemprop="offers"]`); if that block is missing, the badge goes at the end
  of the card's `li`.
- Badge states:
  - loading: faint `… kcal`
  - data: `172 kcal · 17 g protein` (protein part omitted if the product has no protein value)
  - no nutrition table: grey `no data`
  - fetch failed: `?`, with a tooltip saying it couldn't be loaded
- Tooltip on data badges: "per 100 g/ml".
- Numbers are formatted with `Intl.NumberFormat` for the site locale, so Latvian and
  Russian use a decimal comma. kcal has no decimals; protein has at most one
  (`17 g`, `22,4 g`, `0,5 g`).
- Badges appear on every category page automatically, for the products shown on
  that page, whether or not a calorie sort is chosen.

### Sort options

- Two options are appended to `select.b-orderby`: calories low to high
  (`bcs-kcal-asc`) and high to low (`bcs-kcal-desc`).
- Products without data, and products whose fetch failed, always go last, in both
  directions. Products with equal values keep the site's default order (stable sort).
- While calorie sort is active, the dropdown shows the chosen calorie option.
- Choosing a native option, or the "Kārtot pēc" placeholder, leaves calorie mode and
  hands control back to the site's own sorting.
- Switching between the two calorie directions while the all-sorted view is showing
  re-sorts the saved list, saves it with the new direction and reloads, without
  fetching anything again.

### One-page category

- Cards are reordered in place with CSS `order` on each `li`; no DOM nodes are moved,
  so React-managed buttons keep working.
- The marker `#kcal-asc` or `#kcal-desc` is added to the URL with
  `history.replaceState`, so a reload or Back keeps the order.
- The status line appears only while values are loading, or when there is a notice
  (failed products, rate limiting). Otherwise it is hidden.

### Multi-page category

1. Status line above the grid: "Loading category pages… N" (N = pages loaded so
   far), then "Loading nutrition: done / total", with a Cancel button.
2. If more than 300 products still need fetching, ask first with `confirm()`:
   "This will load N product pages (about S s). Continue?" (S = N / 30, rounded, at
   least 1).
3. When loading finishes, the page reloads with the marker. It then shows every
   product of the category, with the current filters applied, as normal site cards
   in sorted order.
4. In that view the page links are hidden and the status line reads
   "All N products sorted by calories · Back to normal view". If some products
   couldn't be loaded it adds "· K couldn't be loaded".
5. Cancel stops all loading, keeps values already fetched in the cache, and leaves
   the page unchanged.
6. "Back to normal view" reloads the page without the marker, and without `page` or
   `order`.

### Labels

The language comes from `window.b_data.selectedLanguageData.locale`; anything
other than `en` or `ru` uses Latvian. `{n}`-style placeholders are filled at runtime.
Phrasings avoid number agreement where Latvian or Russian would need it.

| Key | lv | en | ru |
|---|---|---|---|
| sortAsc | Kalorijas (augoši) | Calories from lowest | Калорийности от самой низкой |
| sortDesc | Kalorijas (dilstoši) | Calories from highest | Калорийности от самой высокой |
| badge | {k} kcal · {p} g olbaltumvielu | {k} kcal · {p} g protein | {k} ккал · {p} г белка |
| badgeKcalOnly | {k} kcal | {k} kcal | {k} ккал |
| badgeTitle | uz 100 g/ml | per 100 g/ml | на 100 г/мл |
| noData | nav datu | no data | нет данных |
| failedTitle | Neizdevās ielādēt | Couldn't load | Не удалось загрузить |
| loadingPages | Ielādē kategorijas lapas… {n} | Loading category pages… {n} | Загрузка страниц категории… {n} |
| loadingNutrition | Ielādē uzturvērtību: {done} / {total} | Loading nutrition: {done} / {total} | Загрузка пищевой ценности: {done} / {total} |
| cancel | Atcelt | Cancel | Отмена |
| confirm | Ielādējamo preču lapu skaits: {n} (apmēram {s} s). Turpināt? | This will load {n} product pages (about {s} s). Continue? | Будет загружено страниц товаров: {n} (около {s} с). Продолжить? |
| allSorted | Visas preces ({n}) sakārtotas pēc kalorijām | All {n} products sorted by calories | Все товары ({n}) отсортированы по калориям |
| someFailed | Neizdevās ielādēt: {n} | {n} couldn't be loaded | Не удалось загрузить: {n} |
| backToNormal | Atgriezties parastajā skatā | Back to normal view | Вернуться к обычному виду |
| fallback | Neizdevās parādīt visas lapas — sakārtota tikai šī lapa | Couldn't show all pages — sorted this page only | Не удалось показать все страницы — отсортирована только эта страница |
| rateLimited | Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem | Barbora is limiting requests — sorted with the data loaded so far | Barbora ограничивает запросы — отсортировано по уже загруженным данным |

## Architecture

### Packaging

- A single file, `barbora-calorie-sort.user.js`, because Tampermonkey installs
  one file. It has no build step and no runtime dependencies.
- Metadata:
  - `@match https://barbora.lv/*` and `@match https://www.barbora.lv/*`
  - `@run-at document-start`, needed for the list swap
  - `@grant none`, so the script runs in the page's own context and can hook
    `window.b_productList`. Same-origin `fetch` and `localStorage`/`sessionStorage`
    are enough, so no GM APIs are needed.
- The pure functions are exported for Node tests through a tail of
  `if (typeof module === 'object' && module.exports) module.exports = {...}; else start();`.
  Tampermonkey never defines `module`, so it always runs `start()`.
- The file is organised in clearly separated sections: pure core first, then
  browser-only parts.

### Units

Pure functions, unit-tested in Node:

| Unit | Responsibility |
|---|---|
| `extractAssignedJson(html, name)` | Find `window.<name> =` in HTML text and parse the JSON value after it (string- and escape-aware bracket matching). Returns the value or `null`. |
| `readNutrition(html)` | Product page HTML → `{status: 'ok', kcal, protein}`, `{status: 'none'}` (product found, no usable kcal) or `{status: 'unreadable'}` (neither product data nor a nutrition table found). Rules below. |
| `sortProducts(products, nutritionById, dir)` | Returns a new array: stable, by kcal in `dir` (`asc`/`desc`), entries without a number last in original order. |
| `isFresh(entry, now)` | Cache TTL rule: data entries 30 days, "no data" entries 7 days. |
| `NutritionCache(storage)` | Load, lookup, batched `put`, merge-on-write, pruning; `storage` is injectable (`localStorage` or a fake). |
| `listingUrl(loc, page)` | Current pathname and query without `order`/`page`, plus `page=N` for N ≥ 2. |
| `listKey(loc)` | Pathname plus the query without `order`/`page`, with params sorted; identifies "this category with these filters". |
| `parseMarker(hash)` | `#kcal-asc` → `asc`, `#kcal-desc` → `desc`, anything else → `null`. |
| `pickLabels(locale)` | Label set for `lv`/`en`/`ru`, Latvian otherwise. |
| `formatBadge(labels, result)` | Badge text and tooltip for each state. |
| `runPool(items, worker, opts)` | Concurrency-limited runner with cancel (`AbortSignal`), progress callback and rate-limit backoff. |
| `fetchNutrition(url, deps)` | Fetch one product page with timeout and retry; returns `ok` / `none` / `failed` / `rateLimited` (`unreadable` pages count as `failed`). `fetch` is injected. |
| `collectCategory(loc, deps)` | Fetch listing pages, keep only real products (items with an `id` and without `isBanner`), dedupe by `id`, apply the stop rules below. `fetch` is injected. |

Browser-only parts, covered by the browser test:

| Part | Responsibility |
|---|---|
| `installSwapHook()` | Runs at document-start; substitutes the saved full list (see "List swap"). |
| `CardDecorator` | MutationObserver on the results container; adds and refreshes badges and applies CSS `order` whenever React renders cards. |
| `SortControl` | Adds the two options, selects one in calorie mode, intercepts `change`. |
| `StatusLine` | One element before `#category-page-results-placeholder` for progress, notices and the "all sorted" banner. |
| `start()` | Wiring: language, cache, page detection, flows. Injects one `<style id="bcs-style">` for badges, the status line and hiding pagination. |

### Nutrition reading rules

1. Parse `window.product` with `extractAssignedJson`. kcal is the first `Amount`
   whose `UnitName` matches `/^kcal$/i`. If there is no kcal amount but there is a
   `kJ` amount, kcal = kJ / 4.184, rounded.
2. Protein is the `Amounts[0].Amount` of the nutrient whose trimmed `Name` matches
   `Olbaltumvielas`, `Proteins`, `Protein`, `Белки` or `Белок`, case-insensitively.
3. If `window.product` is missing or can't be parsed, fall back to the visible table.
   Read `<td>name</td><td …>value</td>` pairs, take kcal from
   `/([\d.,]+)\s*(?:kcal|ккал)/i` in the energy value, and take protein by the same names.
4. Sanity rules:
   - kcal must be a finite number in 0–950, otherwise the result is `none`.
   - Protein outside 0–100 is dropped, which leaves a kcal-only result.
5. If no kcal value is found, the result is `none`.
6. If there is neither `window.product` nor a nutrition table, the result is
   `unreadable`: the page is not a readable product page, for example after a
   redirect. Unreadable results are never cached.

### Card ↔ product mapping

The `li[data-cnstrc-item-id]` value equals the product `id` in `window.b_productList`.
The matching product's `Url` gives `/produkti/<Url>`. The cache is keyed by `id`.

### Page detection

- **Category page:** `#category-page-results-placeholder` exists and
  `window.b_productList` is an array. Otherwise the script does nothing after
  document-start.
- **Multi-page:** `.pagination a[href*="page="]` exists, or the URL has `page` > 1.

## Data flow

### Every category page load

1. Read the cache. Badges show cached values; uncached products show the loading state.
2. Fetch the missing products on this page (4 in parallel) and update badges as
   results arrive. Results are written to the cache every 20 results and at the end.
   This step is skipped in the all-sorted view: every product there was processed
   before the reload, and products that failed show `?` from the saved `failed` list.
3. If the marker is present:
   - if the list swap took effect, verify it (List swap, step 3);
   - otherwise run the sort flow that matches the category (one-page or multi-page).

### Choosing a calorie option, one-page category

1. Make sure every product on the page has a result (fetch missing ones, with progress).
2. Compute ranks with `sortProducts` and set `li.style.order`. `CardDecorator`
   re-applies them if React re-renders.
3. Run `history.replaceState` to the same URL plus the marker.

### Choosing a calorie option, multi-page category

1. `collectCategory`:
   - Fetch listing pages 1, 2, 3… (3 in parallel) using `listingUrl`.
   - Stop at the first page that returns no items, fewer items than page 1, or only
     already-seen ids.
   - Hard cap: 60 pages.
2. Count the uncached products; if more than 300, `confirm()`.
3. Fetch the missing nutrition (4 in parallel).
4. Sort with `sortProducts`. Save `{key: listKey, dir, savedAt, products, failed}` to
   `sessionStorage` under `bcs:list:v1`, replacing any earlier list.
5. Run `history.replaceState` to `pathname + query without order/page + marker`,
   then `location.reload()`.

### List swap (document-start, on a reload with the marker)

1. If the marker is present and `bcs:list:v1` matches `listKey(location)` and `dir`,
   and is at most 30 minutes old, define an accessor property `window.b_productList`.
   Its setter keeps the site's original array aside and stores the saved list; its
   getter returns the saved list. The site's inline assignment therefore hands React
   the full sorted list.
2. If `window.b_productList` already exists, the script was injected late. It
   reassigns the saved list immediately, which may still beat React's first render.
3. After the cards render, check that the number of `li[data-cnstrc-item-id]` equals
   the saved list length (wait up to 10 s).
   - **Equal:** add the class `bcs-all-sorted` to `<html>`, which hides every
     `ul.pagination`, and show the "all sorted" status line. Only the pagination
     lists are hidden: on top-level categories their wrapper also contains the
     subcategory chooser.
   - **Not equal:** fall back to the one-page flow on the cards that did render, and
     show the `fallback` notice.
4. If the marker is present but there is no valid saved list (expired, other tab,
   other filters), run the sort flow that matches the category again automatically.
   Cached nutrition makes this quick.

### Leaving calorie mode

- When the user picks a native option or the placeholder, the capture-phase listener
  first removes the marker with `history.replaceState`. It then lets the event reach
  the site's own handler, which reloads with the native sort.
- "Back to normal view" does the same, then reloads.

### Dropdown interception

A `change` listener on `window` in the capture phase runs before the site's listener
on the select, whenever either was registered: capture on `window` always precedes
the target phase. For `bcs-*` values it calls `stopImmediatePropagation()`, so the
site never navigates to an unknown `order`, and then runs the calorie flow.

## Storage

| Key | Storage | Shape | Rules |
|---|---|---|---|
| `bcs:nutrition:v1` | localStorage | `{ [id]: {k: kcal \| null, p: protein \| null, t: savedAtMs} }` | `k: null` means no data. Fresh: 30 days with data, 7 days without. At most 6000 entries; the oldest are pruned on write. Each write re-reads and merges first, so parallel tabs don't erase each other. On `QuotaExceededError`, drop the oldest 25% and retry once, then carry on without caching. |
| `bcs:list:v1` | sessionStorage | `{key, dir, savedAt, products, failed}` | One list at a time. Valid for 30 minutes. About 1.5 KB per product, so ~970 products is ~1.5 MB. If saving fails, use the one-page flow with the `fallback` notice. |

Failed fetches are never cached. "No data" results are cached.

## Error handling

| Situation | Behaviour |
|---|---|
| Network error, timeout (15 s) or 5xx other than 503 | Retry once after 1 s. If it still fails, the badge shows `?`, the product sorts last and is not cached, and the "couldn't be loaded" count is shown. |
| Other 4xx (e.g. 404 for a removed product) | `failed` straight away, no retry. |
| HTTP 429 or 503 | Pause 5 s, drop to 1 request at a time, retry. After 3 such responses in a row, stop fetching, sort with what is known (unfetched products count as failed), and show `rateLimited`. |
| Page loads but isn't a readable product page | `unreadable`, handled as `failed`. |
| Implausible values | See the sanity rules. |
| Cancel | Abort in-flight requests, keep cached results, no reload, status line removed. |
| Storage full | See Storage. |
| Expected elements missing (results container, dropdown, cards) | Skip the affected feature, leave the page alone, and log `console.warn('[calorie-sort] …')`. |
| Saved list older than 30 minutes | Rebuild (listing pages refetched; nutrition from cache). |
| List swap didn't take effect | One-page flow plus the `fallback` notice. |

## Testing

### Unit tests (Node built-in runner, `node --test`, no dependencies)

Fixtures in `test/fixtures/` are trimmed copies of real pages: the
`window.product` script and the nutrition table.

- `readNutrition`:
  - boneless thighs in LV, EN and RU: 172 kcal, 17 g
  - a no-data product (`cala-krutinas-fileja-well-done-500-g`)
  - a product with only 4 nutrient rows (`cala-sparni-well-done-fas`: 157 kcal, 18 g)
  - synthetic: kJ-only, table-only (JSON removed), and out-of-range kcal
- `extractAssignedJson`: braces and escaped quotes inside strings, missing name.
- `sortProducts`: asc and desc, stable ties, no-data and failed last in both directions.
- `isFresh` and `NutritionCache`: TTLs, merge-on-write with a fake storage, quota pruning.
- `listingUrl` and `listKey`: filters kept, `order`/`page` dropped, no `page` for
  page 1, key independent of parameter order.
- `parseMarker`, `pickLabels`, `formatBadge`.
- `runPool`: concurrency limit, cancel, the 429 backoff path.
- `fetchNutrition`: retry, timeout, status mapping.
- `collectCategory`: stop rules, dedupe, page cap.

### Browser test (live site)

Runs `puppeteer-core` (dev dependency only) driving the installed Firefox
(`/usr/bin/firefox`) headless over WebDriver BiDi, with a fresh temporary profile.
The script is injected with `evaluateOnNewDocument`, which runs before page scripts
like Tampermonkey's document-start. Nothing touches the user's account or cart.

Live data changes over time, so the assertions check structure and rules. The few
concrete values are snapshots from 2026-10-17.

1. "Vistas gaļa": every card gets a badge in a valid state, at least one reads
   `nav datu`, and the boneless-thigh card reads `172 kcal · 17 g olbaltumvielu`
   (snapshot).
2. "Vistas gaļa", calories low to high: visual order (by CSS `order`) is
   non-decreasing kcal with no-data last. The dropdown shows the option, the URL has
   `#kcal-asc`, and a reload keeps the order.
3. A two-page category ("Jogurts ar piedevām", 84 products at the time of writing),
   calories low to high: after the reload, the card count equals the category total,
   cards are in sorted order, page links are hidden, and the banner shows the total.
   "Pievienot" on a product that came from page 2 responds the same way as on a
   page-1 product.
4. Russian (cookies `lng=RU`, `lang=<RU id>`): Russian dropdown labels and badges.
5. Cancel during multi-page loading leaves the page unchanged and doesn't reload.
6. Picking a native option in calorie mode returns to the site's own sorting with no
   marker.

Screenshots of tests 1 and 3 are saved for a visual check of badge placement.

Risk: if the system Firefox can't be driven over BiDi, the test falls back to the
Firefox build that Puppeteer downloads.

### Manual check (user)

Install the script in Tampermonkey (Firefox). Check "Vistas gaļa" and one
multi-page category, including "Pievienot" from the sorted list.

## Project layout

```
barbora-calorie-sort.user.js      the userscript
package.json                      devDependencies: puppeteer-core; scripts: test, test:browser
test/unit/*.test.js
test/fixtures/*.html
test/browser/*.test.js
README.md                         install and usage
docs/superpowers/specs/2026-10-17-barbora-calorie-sort-design.md
```
