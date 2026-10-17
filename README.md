# Barbora calorie sort

A Tampermonkey userscript for [barbora.lv](https://barbora.lv). It adds two options to the site's
**Kārtot pēc** dropdown that sort the products on the current page by calories. The calorie and
protein values (per 100 g/ml) are read from each product's own nutrition table and shown in a small
box next to the price.

Values are only loaded when you pick a calorie sort or sort by price per unit, so ordinary
browsing sends Barbora no extra requests.

## Install

1. Install [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) in Firefox.
2. Open the Tampermonkey dashboard → **Utilities** → **Import from file** and pick
   `barbora-calorie-sort.user.js`. (Or create a new script, replace its contents with this file and
   save.)
3. Open any barbora.lv category page.

## Use

- **Sort:** pick **Kalorijas (augoši)** or **Kalorijas (dilstoši)**. The script loads the values
  it doesn't know yet for the products on this page, showing a progress line with **Atcelt**. Then
  it reorders the page.
- **Price per unit shows the boxes by itself:** pick the site's own **Cena par vienību** (augoši
  or dilstoša) and the values for that page load automatically. The site's order stays as it is.
- **Cheap and low in calories:** after a price-per-unit sort you can also pick a calorie sort. You
  get the cheapest-per-unit products ordered by calories, and products with equal calories keep
  their price order.
- **The box** next to the price shows e.g. **172 kcal** and **17 g olb.** (protein). Next to a
  discounted price, which already has two price boxes, it is a little smaller so it still fits on
  the same line.
  - `nav datu` means Barbora has no nutrition table for that product.
  - `?` means its page couldn't be loaded; it is tried again on the next sort.
- **Back to the site's order:** pick any of the site's own sort options.

## Good to know

- Loading is deliberately slow: 2 products at a time, about 0.3 s apart. That is about 15 seconds
  for a page of 52 products the script hasn't seen. Values are remembered in your browser for 30
  days, so sorting again, or revisiting a page, is instant.
- If Barbora starts limiting requests, the script stops loading for 5 minutes, sorts with what it
  already has, and says so.
- Many fresh, unpacked products (meat, fruit, vegetables) have no nutrition data on Barbora, so they
  show `nav datu`. Packaged food nearly always has it.
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
