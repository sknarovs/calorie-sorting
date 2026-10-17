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

  const PROTEIN_NAMES = ['olbaltumvielas', 'proteins', 'protein', 'белки', 'белок'];

  // Parses the JSON value a page assigns with `window.<name> = {…}` or `= […]`.
  function extractAssignedJson(html, name) {
    const match = new RegExp(`window\\.${name}(?![\\w$])\\s*=\\s*`).exec(html);
    if (!match) return null;
    const start = match.index + match[0].length;
    if (html[start] !== '{' && html[start] !== '[') return null;
    let depth = 0;
    let inString = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  const isProteinName = (name) => PROTEIN_NAMES.includes(String(name).trim().toLowerCase());
  const parseDecimal = (text) => Number(String(text).replace(',', '.'));

  function nutritionResult(kcal, protein) {
    if (!Number.isFinite(kcal) || kcal < 0 || kcal > CONFIG.kcalMax) return { status: 'none' };
    const usableProtein = Number.isFinite(protein) && protein >= 0 && protein <= CONFIG.proteinMax;
    return { status: 'ok', kcal, protein: usableProtein ? protein : null };
  }

  function nutritionFromProduct(product) {
    // Products without a label have no `nutrients` key at all.
    const nutrients = Array.isArray(product.nutrients) ? product.nutrients : [];
    const amounts = nutrients.flatMap((n) => (Array.isArray(n.Amounts) ? n.Amounts : []));
    const kcalAmount = amounts.find((a) => /^kcal$/i.test(a.UnitName));
    const kJAmount = amounts.find((a) => /^kj$/i.test(a.UnitName));
    let kcal = NaN;
    if (kcalAmount) kcal = Number(kcalAmount.Amount);
    else if (kJAmount) kcal = Math.round(Number(kJAmount.Amount) / CONFIG.kJPerKcal);
    const proteinRow = nutrients.find((n) => isProteinName(n.Name));
    const protein = proteinRow && proteinRow.Amounts && proteinRow.Amounts[0] ? Number(proteinRow.Amounts[0].Amount) : NaN;
    return nutritionResult(kcal, protein);
  }

  function nutritionFromTable(html) {
    const rows = [...html.matchAll(/<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/g)];
    // The Russian table translates the units ("кДж / ккал"); the embedded data does not.
    const energyRow = rows.find(([, , value]) => /kcal|ккал|kj|кдж/i.test(value));
    const proteinRow = rows.find(([, label]) => isProteinName(label));
    if (!energyRow && !proteinRow) return { status: 'unreadable' };
    const kcalMatch = energyRow && /([\d.,]+)\s*(?:kcal|ккал)/i.exec(energyRow[2]);
    const proteinMatch = proteinRow && /\d+(?:[.,]\d+)?/.exec(proteinRow[2]);
    return nutritionResult(kcalMatch ? parseDecimal(kcalMatch[1]) : NaN, proteinMatch ? parseDecimal(proteinMatch[0]) : NaN);
  }

  function readNutrition(html) {
    const product = extractAssignedJson(html, 'product');
    if (product && typeof product === 'object' && !Array.isArray(product)) return nutritionFromProduct(product);
    return nutritionFromTable(html);
  }

  // ---- Core: URLs and sorting ----

  function parseMarker(hash) {
    const match = /^#kcal-(asc|desc)$/.exec(hash || '');
    return match ? match[1] : null;
  }

  // The current filters, without the site's own sort order and page number.
  function filterParams(search) {
    const params = new URLSearchParams(search);
    params.delete('order');
    params.delete('page');
    return params;
  }

  const toQuery = (params) => {
    const query = params.toString();
    return query ? `?${query}` : '';
  };

  function baseQuery(search) {
    return toQuery(filterParams(search));
  }

  function listingUrl(loc, page) {
    const params = filterParams(loc.search);
    if (page >= 2) params.set('page', String(page));
    return loc.pathname + toQuery(params);
  }

  function listKey(loc) {
    const params = filterParams(loc.search);
    params.sort();
    return loc.pathname + toQuery(params);
  }

  function sortedViewUrl(loc, dir) {
    return `${loc.pathname}${baseQuery(loc.search)}#kcal-${dir}`;
  }

  function productUrl(product) {
    return `/produkti/${product.Url}`;
  }

  // Products with a kcal value first, in `dir` order; everything else after, in site order.
  function sortProducts(products, states, dir) {
    const sign = dir === 'desc' ? -1 : 1;
    const kcalOf = (product) => {
      const state = states.get(product.id);
      return state && state.status === 'ok' ? state.kcal : null;
    };
    const known = products.filter((p) => kcalOf(p) !== null);
    const unknown = products.filter((p) => kcalOf(p) === null);
    return [...known.sort((a, b) => sign * (kcalOf(a) - kcalOf(b))), ...unknown];
  }

  // ---- Core: labels ----

  const LABELS = {
    lv: {
      locale: 'lv',
      sortAsc: 'Kalorijas (augoši)',
      sortDesc: 'Kalorijas (dilstoši)',
      badge: '{k} kcal · {p} g olbaltumvielu',
      badgeKcalOnly: '{k} kcal',
      badgeTitle: 'uz 100 g/ml',
      noData: 'nav datu',
      failedTitle: 'Neizdevās ielādēt',
      loadingPages: 'Ielādē kategorijas lapas… {n}',
      loadingNutrition: 'Ielādē uzturvērtību: {done} / {total}',
      cancel: 'Atcelt',
      confirm: 'Ielādējamo preču lapu skaits: {n} (apmēram {s} s). Turpināt?',
      allSorted: 'Visas preces ({n}) sakārtotas pēc kalorijām',
      someFailed: 'Neizdevās ielādēt: {n}',
      backToNormal: 'Atgriezties parastajā skatā',
      fallback: 'Neizdevās parādīt visas lapas — sakārtota tikai šī lapa',
      rateLimited: 'Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem',
    },
    en: {
      locale: 'en',
      sortAsc: 'Calories from lowest',
      sortDesc: 'Calories from highest',
      badge: '{k} kcal · {p} g protein',
      badgeKcalOnly: '{k} kcal',
      badgeTitle: 'per 100 g/ml',
      noData: 'no data',
      failedTitle: "Couldn't load",
      loadingPages: 'Loading category pages… {n}',
      loadingNutrition: 'Loading nutrition: {done} / {total}',
      cancel: 'Cancel',
      confirm: 'This will load {n} product pages (about {s} s). Continue?',
      allSorted: 'All {n} products sorted by calories',
      someFailed: "{n} couldn't be loaded",
      backToNormal: 'Back to normal view',
      fallback: "Couldn't show all pages — sorted this page only",
      rateLimited: 'Barbora is limiting requests — sorted with the data loaded so far',
    },
    ru: {
      locale: 'ru',
      sortAsc: 'Калорийности от самой низкой',
      sortDesc: 'Калорийности от самой высокой',
      badge: '{k} ккал · {p} г белка',
      badgeKcalOnly: '{k} ккал',
      badgeTitle: 'на 100 г/мл',
      noData: 'нет данных',
      failedTitle: 'Не удалось загрузить',
      loadingPages: 'Загрузка страниц категории… {n}',
      loadingNutrition: 'Загрузка пищевой ценности: {done} / {total}',
      cancel: 'Отмена',
      confirm: 'Будет загружено страниц товаров: {n} (около {s} с). Продолжить?',
      allSorted: 'Все товары ({n}) отсортированы по калориям',
      someFailed: 'Не удалось загрузить: {n}',
      backToNormal: 'Вернуться к обычному виду',
      fallback: 'Не удалось показать все страницы — отсортирована только эта страница',
      rateLimited: 'Barbora ограничивает запросы — отсортировано по уже загруженным данным',
    },
  };

  function pickLabels(locale) {
    return Object.prototype.hasOwnProperty.call(LABELS, locale) ? LABELS[locale] : LABELS.lv;
  }

  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
  }

  function formatBadge(labels, state) {
    const number = (value, digits) => new Intl.NumberFormat(labels.locale, { maximumFractionDigits: digits }).format(value);
    switch (state.status) {
      case 'ok': {
        const k = number(state.kcal, 0);
        const text = state.protein === null ? fill(labels.badgeKcalOnly, { k }) : fill(labels.badge, { k, p: number(state.protein, 1) });
        return { kind: 'ok', text, title: labels.badgeTitle };
      }
      case 'none':
        return { kind: 'none', text: labels.noData, title: '' };
      case 'failed':
        return { kind: 'failed', text: '?', title: labels.failedTitle };
      default:
        return { kind: 'loading', text: fill(labels.badgeKcalOnly, { k: '…' }), title: '' };
    }
  }

  function composeNotice(labels, { total, failed, rateLimited }) {
    const parts = [];
    if (total !== undefined) parts.push(fill(labels.allSorted, { n: total }));
    if (failed > 0) parts.push(fill(labels.someFailed, { n: failed }));
    if (rateLimited) parts.push(labels.rateLimited);
    return parts.join(' · ');
  }

  // ---- Browser ----

  function start() {}

  if (typeof window === 'undefined') {
    module.exports = {
      CONFIG,
      extractAssignedJson,
      readNutrition,
      parseMarker,
      baseQuery,
      listingUrl,
      listKey,
      sortedViewUrl,
      productUrl,
      sortProducts,
      LABELS,
      pickLabels,
      fill,
      formatBadge,
      composeNotice,
    };
  } else {
    start();
  }
})();
