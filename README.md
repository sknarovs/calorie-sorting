# Barbora calorie sort

A Tampermonkey userscript for [barbora.lv](https://barbora.lv). On every category page it adds a
small badge to each product card with its calories and protein per 100 g/ml, read from the
product's own nutrition table. It also adds two options to the site's **Kārtot pēc** dropdown that
sort the **whole category** (every page, with your current filters) by calories, using Barbora's
own product cards, so **Pievienot** keeps working.

## Install

1. Install [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) in Firefox.
2. Open the Tampermonkey dashboard → **Utilities** → **Import from file** and pick
   `barbora-calorie-sort.user.js`. (Or create a new script, replace its contents with this file and
   save.)
3. Open any barbora.lv category page.

## Use

- **Badges:** each card shows e.g. `172 kcal · 17 g olbaltumvielu` (hover for "per 100 g/ml").
  `nav datu` means Barbora has no nutrition table for that product; `?` means its page couldn't be
  loaded, and it will be tried again on your next visit.
- **Sorting:** pick **Kalorijas (augoši)** or **Kalorijas (dilstoši)** in the dropdown.
  - A one-page category is reordered on the spot.
  - A bigger category is collected page by page (with a progress line and **Atcelt**), then shown
    as one sorted list with the page links hidden.
  - Products without a value always go last.
- **Back to normal:** use **Atgriezties parastajā skatā** in the line above the list, or pick any
  of the site's own sort options.

## Good to know

- Many fresh, unpacked products (meat, fruit, vegetables) have no nutrition data on Barbora, so
  they show `nav datu`. Packaged food nearly always has it.
- The first calorie sort of a big category has to load every product page once, so it can take a
  while (the script asks first when that is more than 300 pages). After that, values are
  remembered in your browser for 30 days, so it gets much faster.
- If Barbora starts limiting requests, the script slows down, then stops and sorts with what it has,
  and says so.
- Labels follow the site language: Latvian, English or Russian.

## Development

```sh
npm test                 # unit tests (no network)
npm install              # once, for the browser tests
npm run test:browser     # drives your installed Firefox (FIREFOX_PATH to override /usr/bin/firefox)
```

Barbora sits behind Cloudflare, which throttles an address that loads many pages in a short time.
The browser tests therefore record barbora.lv pages, assets and product pages once (spaced out) into
`test/browser/.cache/` and replay them on later runs; only the site's own `/api/` calls stay live.
Delete that folder to record afresh against today's site.

## Troubleshooting

Open the browser console on a barbora.lv page and look for messages starting with
`[calorie-sort]`.
