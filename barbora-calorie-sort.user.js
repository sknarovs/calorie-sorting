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
    cooldownMs: 5 * 60 * 1000,
    keys: { nutrition: 'bcs:nutrition:v1', list: 'bcs:list:v1', reload: 'bcs:reload', cooldown: 'bcs:cooldown' },
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

  const isObject = (value) => Boolean(value) && typeof value === 'object';
  const amountsOf = (nutrient) => (Array.isArray(nutrient.Amounts) ? nutrient.Amounts.filter(isObject) : []);

  // A missing amount (null, "", absent) is NaN, never 0.
  function amountValue(amount) {
    if (typeof amount.Amount === 'number') return amount.Amount;
    if (typeof amount.Amount === 'string' && amount.Amount.trim() !== '') return parseDecimal(amount.Amount);
    return NaN;
  }

  function nutritionFromProduct(product) {
    // Products without a label have no `nutrients` key at all.
    const nutrients = Array.isArray(product.nutrients) ? product.nutrients.filter(isObject) : [];
    const amounts = nutrients.flatMap(amountsOf).filter((a) => Number.isFinite(amountValue(a)));
    const kcalAmount = amounts.find((a) => /^kcal$/i.test(a.UnitName));
    const kJAmount = amounts.find((a) => /^kj$/i.test(a.UnitName));
    let kcal = NaN;
    if (kcalAmount) kcal = amountValue(kcalAmount);
    else if (kJAmount) kcal = Math.round(amountValue(kJAmount) / CONFIG.kJPerKcal);
    const proteinRow = nutrients.find((n) => isProteinName(n.Name));
    const proteinAmount = proteinRow ? amountsOf(proteinRow)[0] : undefined;
    return nutritionResult(kcal, proteinAmount ? amountValue(proteinAmount) : NaN);
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
    try {
      const product = extractAssignedJson(html, 'product');
      if (isObject(product) && !Array.isArray(product)) return nutritionFromProduct(product);
      return nutritionFromTable(html);
    } catch {
      return { status: 'unreadable' }; // never let one odd page break a whole run
    }
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

  // ---- Core: storage ----

  const DAY_MS = 24 * 60 * 60 * 1000;

  const isQuotaError = (e) => Boolean(e) && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function isFresh(entry, now) {
    const days = entry.k === null ? CONFIG.cacheDaysNoData : CONFIG.cacheDaysData;
    return now - entry.t < days * DAY_MS;
  }

  // Nutrition per product id, kept in localStorage as {id: {k: kcal | null, p: protein | null, t: savedAt}}.
  class NutritionCache {
    constructor(storage, { now = () => Date.now(), maxEntries = CONFIG.cacheMaxEntries, flushEvery = CONFIG.cacheFlushEvery } = {}) {
      this.storage = storage;
      this.now = now;
      this.maxEntries = maxEntries;
      this.flushEvery = flushEvery;
      const saved = readJson(storage, CONFIG.keys.nutrition);
      this.entries = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      this.unsaved = {};
      this.puts = 0;
    }

    get(id) {
      const entry = this.entries[id];
      if (!entry || !isFresh(entry, this.now())) return undefined;
      return entry.k === null ? { status: 'none' } : { status: 'ok', kcal: entry.k, protein: entry.p };
    }

    put(id, state) {
      if (state.status !== 'ok' && state.status !== 'none') return;
      const t = this.now();
      const entry = state.status === 'ok' ? { k: state.kcal, p: state.protein, t } : { k: null, p: null, t };
      this.entries[id] = entry;
      this.unsaved[id] = entry;
      this.puts += 1;
      if (this.puts % this.flushEvery === 0) this.flush();
    }

    // Merges this tab's new entries into what is stored now, so other tabs' writes survive.
    flush() {
      const stored = readJson(this.storage, CONFIG.keys.nutrition);
      const merged = { ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}), ...this.unsaved };
      let ids = Object.keys(merged).sort((a, b) => merged[b].t - merged[a].t).slice(0, this.maxEntries);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          this.storage.setItem(CONFIG.keys.nutrition, JSON.stringify(Object.fromEntries(ids.map((id) => [id, merged[id]]))));
          this.unsaved = {};
          return;
        } catch (e) {
          if (!isQuotaError(e) || attempt === 1) break;
          ids = ids.slice(0, ids.length - Math.max(1, Math.ceil(ids.length / 4)));
        }
      }
      console.warn('[calorie-sort] could not save nutrition values; keeping them for this page only');
    }
  }

  function saveList(storage, record) {
    if (storage.memoryOnly) return false; // the list must survive the reload, or we would reload forever
    try {
      storage.setItem(CONFIG.keys.list, JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  function loadList(storage, key, dir, now) {
    const record = readJson(storage, CONFIG.keys.list);
    if (!record || record.key !== key || record.dir !== dir || !Array.isArray(record.products)) return null;
    return now - record.savedAt <= CONFIG.listTtlMs ? record : null;
  }

  // After Barbora limits requests, every tab stops fetching for a while instead of adding to the block.
  function startCooldown(storage, now) {
    try {
      storage.setItem(CONFIG.keys.cooldown, JSON.stringify({ until: now + CONFIG.cooldownMs }));
    } catch {
      // Without storage the cooldown only lasts for this page.
    }
  }

  function inCooldown(storage, now) {
    const cooldown = readJson(storage, CONFIG.keys.cooldown);
    return Boolean(cooldown) && typeof cooldown.until === 'number' && now < cooldown.until;
  }

  // ---- Core: fetching ----

  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Cloudflare marks its "Just a moment..." challenge responses with this header.
  const isChallenge = (response) => response.status === 403 && Boolean(response.headers)
    && typeof response.headers.get === 'function' && response.headers.get('cf-mitigated') === 'challenge';

  // One request, classified: ok | limited (429/503/challenge) | retry (5xx, network, timeout) | fail | aborted.
  async function getPage(url, { fetch, signal, timeoutMs = CONFIG.timeoutMs }) {
    if (signal && signal.aborted) return { kind: 'aborted' };
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'same-origin' });
      if (response.ok) return { kind: 'ok', text: await response.text() };
      if (response.status === 429 || response.status === 503 || isChallenge(response)) return { kind: 'limited' };
      return { kind: response.status >= 500 ? 'retry' : 'fail' };
    } catch {
      return { kind: signal && signal.aborted ? 'aborted' : 'retry' };
    }
  }

  async function getPageWithRetry(url, deps) {
    const first = await getPage(url, deps);
    if (first.kind !== 'retry') return first;
    await (deps.sleep || defaultSleep)(deps.retryDelayMs ?? CONFIG.retryDelayMs);
    const second = await getPage(url, deps);
    return second.kind === 'retry' ? { kind: 'fail' } : second;
  }

  async function fetchNutrition(url, deps) {
    const page = await getPageWithRetry(url, deps);
    if (page.kind === 'limited') return { status: 'rateLimited' };
    if (page.kind !== 'ok') return { status: 'failed' };
    const result = readNutrition(page.text);
    return result.status === 'unreadable' ? { status: 'failed' } : result;
  }

  // Runs `worker` over `items` with a concurrency limit, cancel support and rate-limit backoff.
  function runPool(items, worker, opts) {
    const {
      concurrency, signal, onResult, isRateLimited = () => false, sleep = defaultSleep,
      backoffMs = CONFIG.backoffMs, maxRateLimited = CONFIG.maxRateLimited,
    } = opts;
    return new Promise((resolve, reject) => {
      const queue = [...items];
      const results = new Map();
      const aborted = () => Boolean(signal && signal.aborted);
      let limit = concurrency;
      let inFlight = 0;
      let streak = 0;
      let stopped = false;
      let rateLimited = false;

      const finishIfDone = () => {
        if (inFlight === 0 && (stopped || aborted() || queue.length === 0)) {
          resolve({ results, cancelled: aborted(), rateLimited });
        }
      };
      const settle = async (item, result) => {
        if (isRateLimited(result)) {
          streak += 1;
          if (streak >= maxRateLimited) {
            stopped = true;
            rateLimited = true;
          } else {
            // The item stays "in flight" during the pause, so nothing new starts.
            limit = 1;
            await sleep(backoffMs);
            queue.unshift(item);
          }
        } else {
          streak = 0;
          results.set(item, result);
          if (onResult) onResult(item, result, results.size, items.length);
        }
        inFlight -= 1;
        pump();
        finishIfDone();
      };
      const pump = () => {
        while (!stopped && !aborted() && inFlight < limit && queue.length > 0) {
          const item = queue.shift();
          inFlight += 1;
          Promise.resolve()
            .then(() => worker(item, signal))
            .then((result) => settle(item, result))
            .catch((error) => {
              stopped = true;
              reject(error);
            });
        }
      };
      pump();
      finishIfDone();
    });
  }

  function needsConfirm(count) {
    return count > CONFIG.confirmAbove;
  }

  function estimateSeconds(count) {
    return Math.max(1, Math.round(count / CONFIG.fetchesPerSecond));
  }

  // All products of the category the user is looking at (current filters, every page), in site order.
  async function collectCategory(loc, deps) {
    const { signal, onPage, concurrency = CONFIG.listingConcurrency, maxPages = CONFIG.maxPages } = deps;
    const abortError = () => new DOMException('Aborted', 'AbortError');
    const products = [];
    const seen = new Set();
    let firstPageSize = null;
    for (let first = 1; first <= maxPages; first += concurrency) {
      if (signal && signal.aborted) throw abortError();
      const numbers = [];
      for (let n = first; n < first + concurrency && n <= maxPages; n++) numbers.push(n);
      const pages = await Promise.all(numbers.map((n) => getPageWithRetry(listingUrl(loc, n), deps)));
      for (let i = 0; i < numbers.length; i++) {
        const n = numbers[i];
        if (pages[i].kind === 'aborted') throw abortError();
        if (pages[i].kind === 'limited') {
          const error = new Error(`listing page ${n} was rate limited`);
          error.name = 'RateLimitError';
          throw error;
        }
        const list = pages[i].kind === 'ok' ? extractAssignedJson(pages[i].text, 'b_productList') : null;
        if (!Array.isArray(list)) throw new Error(`listing page ${n} failed`);
        if (firstPageSize === null) firstPageSize = list.length;
        let added = 0;
        for (const item of list) {
          if (item && item.id && !item.isBanner && !seen.has(item.id)) {
            seen.add(item.id);
            products.push(item);
            added += 1;
          }
        }
        if (onPage) onPage(n);
        if (list.length === 0 || list.length < firstPageSize || added === 0 || n === maxPages) return products;
      }
    }
    return products;
  }

  // ---- Core: list swap ----

  // Hands the site a saved, sorted product list in place of the one its page script assigns.
  function installSwapHook(win, record) {
    const swap = { swapped: false, original: null };
    if (Array.isArray(win.b_productList)) {
      // Injected after the page assigned its list: replace it, React may not have rendered yet.
      swap.original = win.b_productList;
      win.b_productList = record.products;
      swap.swapped = true;
      return swap;
    }
    try {
      Object.defineProperty(win, 'b_productList', {
        configurable: true,
        enumerable: true,
        get: () => record.products,
        set: (value) => {
          swap.original = value;
          swap.swapped = true;
        },
      });
    } catch (error) {
      console.warn('[calorie-sort] could not hook the product list', error);
    }
    return swap;
  }

  // A short-lived flag set just before the script reloads the page, so the next load can tell
  // "we reloaded but could not show the saved list" apart from a normal visit (no reload loops).
  function markReload(storage, now) {
    try {
      storage.setItem(CONFIG.keys.reload, JSON.stringify({ at: now }));
    } catch {
      // Without the flag the saved list still guards against loops.
    }
  }

  function consumeReload(storage, now) {
    const flag = readJson(storage, CONFIG.keys.reload);
    try {
      storage.removeItem(CONFIG.keys.reload);
    } catch {
      // Nothing to clean up.
    }
    return Boolean(flag) && typeof flag.at === 'number' && now - flag.at <= CONFIG.reloadWindowMs;
  }

  // ---- Browser ----

  const CARD_SELECTOR = 'li[data-cnstrc-item-id]';

  const STYLE_CSS = `
.bcs-badge { display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 999px; font-size: 12px; line-height: 16px; font-weight: 600; background: #e8f5e9; color: #1b5e20; white-space: normal; }
.bcs-badge--loading { background: #f2f2f2; color: #9e9e9e; font-weight: 400; }
.bcs-badge--none, .bcs-badge--failed { background: #f2f2f2; color: #757575; font-weight: 400; }
.bcs-status { margin: 8px 0; padding: 8px 12px; border-radius: 8px; background: #fff8e1; color: #3e2723; font-size: 14px; line-height: 20px; }
.bcs-status[hidden] { display: none; }
.bcs-status__action { margin-left: 8px; padding: 0; border: 0; background: none; color: #c00; font: inherit; text-decoration: underline; cursor: pointer; }
html.bcs-all-sorted ul.pagination { display: none !important; }
`;

  function injectStyle(doc) {
    if (doc.getElementById('bcs-style')) return;
    const style = doc.createElement('style');
    style.id = 'bcs-style';
    style.textContent = STYLE_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // The real storage, or an in-memory stand-in when the browser refuses access to it.
  function safeStorage(get) {
    try {
      const storage = get();
      if (storage) return storage;
    } catch {
      // Blocked storage (privacy settings): fall through to memory.
    }
    const data = new Map();
    return {
      memoryOnly: true, // nothing survives a reload
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => { data.set(k, String(v)); },
      removeItem: (k) => { data.delete(k); },
    };
  }

  // Keeps a badge (and, when sorting, a CSS `order`) on every card React renders.
  class CardDecorator {
    constructor(container, labels, stateOf) {
      this.container = container;
      this.labels = labels;
      this.stateOf = stateOf;
      this.ranks = null;
      this.ordered = new WeakSet();
    }

    start() {
      this.renderAll();
      // Writes below only happen when something differs, so our own changes settle after one pass.
      this.observer = new MutationObserver(() => this.renderAll());
      this.observer.observe(this.container, { childList: true, subtree: true });
    }

    cards() {
      return [...this.container.querySelectorAll(CARD_SELECTOR)];
    }

    ids() {
      return this.cards().map((li) => li.getAttribute('data-cnstrc-item-id'));
    }

    update(id) {
      const li = this.container.querySelector(`li[data-cnstrc-item-id="${CSS.escape(id)}"]`);
      if (li) this.render(li);
    }

    setOrder(ranks) {
      this.ranks = ranks;
      this.renderAll();
    }

    renderAll() {
      for (const li of this.cards()) this.render(li);
    }

    render(li) {
      const id = li.getAttribute('data-cnstrc-item-id');
      const { kind, text, title } = formatBadge(this.labels, this.stateOf(id));
      const anchor = li.querySelector('[itemprop="offers"]') || li;
      let badge = li.querySelector('.bcs-badge');
      if (!badge || badge.parentElement !== anchor) {
        if (badge) badge.remove();
        badge = li.ownerDocument.createElement('span');
        anchor.appendChild(badge);
      }
      const className = `bcs-badge bcs-badge--${kind}`;
      if (badge.className !== className) badge.className = className;
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.title !== title) badge.title = title;
      if (this.ranks) {
        const rank = String(this.ranks.has(id) ? this.ranks.get(id) : this.ranks.size);
        if (li.style.order !== rank) li.style.order = rank;
        this.ordered.add(li);
      } else if (this.ordered.has(li)) {
        li.style.removeProperty('order');
        this.ordered.delete(li);
      }
    }
  }

  // One line above the product grid for progress, notices and the all-sorted banner.
  class StatusLine {
    constructor(container, labels) {
      this.labels = labels;
      const doc = container.ownerDocument;
      this.el = doc.createElement('div');
      this.el.className = 'bcs-status';
      this.el.setAttribute('role', 'status');
      this.el.hidden = true;
      this.text = doc.createElement('span');
      // One button for the line's lifetime: updates swap its label and handler, never the element,
      // so a click is not lost while progress keeps ticking.
      this.button = doc.createElement('button');
      this.button.type = 'button';
      this.button.className = 'bcs-status__action';
      this.button.hidden = true;
      this.button.addEventListener('click', () => {
        if (this.onClick) this.onClick();
      });
      this.el.append(this.text, this.button);
      container.before(this.el);
    }

    show(text, buttonLabel, onClick) {
      this.text.textContent = text;
      this.onClick = buttonLabel ? onClick : null;
      this.button.textContent = buttonLabel || '';
      this.button.hidden = !buttonLabel;
      this.el.hidden = false;
    }

    progress(text, onCancel) {
      this.show(text, onCancel ? this.labels.cancel : null, onCancel);
    }

    notice(text, action) {
      this.show(text, action ? action.label : null, action ? action.onClick : null);
    }

    clear() {
      this.show('', null, null);
      this.el.hidden = true;
    }
  }

  // The two calorie options in the site's "Kārtot pēc" dropdown.
  class SortControl {
    constructor(select, labels, handlers) {
      Object.assign(this, { select, labels, handlers });
    }

    install() {
      if (!this.select.querySelector('option[value^="bcs-kcal-"]')) {
        const doc = this.select.ownerDocument;
        for (const [dir, text] of [['asc', this.labels.sortAsc], ['desc', this.labels.sortDesc]]) {
          const option = doc.createElement('option');
          option.value = `bcs-kcal-${dir}`;
          option.textContent = text;
          this.select.append(option);
        }
      }
      this.previous = this.select.value;
    }

    show(dir) {
      this.select.value = dir ? `bcs-kcal-${dir}` : this.previous;
    }

    // Runs in the capture phase on window, before the site's own listener on the select.
    handleChange(event) {
      const match = /^bcs-kcal-(asc|desc)$/.exec(this.select.value);
      if (match) {
        event.stopImmediatePropagation();
        this.handlers.onCalorie(match[1]);
      } else {
        this.previous = this.select.value;
        this.handlers.onLeave();
      }
    }
  }

  class CategoryPage {
    constructor({ win, container, select, products, labels, cache, local, boot }) {
      Object.assign(this, { win, container, select, products, labels, cache, local, boot });
      this.byId = new Map(products.map((p) => [p.id, p]));
      this.states = new Map();
      for (const product of products) {
        const cached = cache.get(product.id);
        if (cached) this.states.set(product.id, cached);
      }
      this.decorator = new CardDecorator(container, labels, (id) => this.stateOf(id));
    }

    init() {
      const { labels, boot } = this;
      injectStyle(this.win.document);
      this.status = new StatusLine(this.container, labels);
      if (this.select) {
        this.sortControl = new SortControl(this.select, labels, {
          onCalorie: (dir) => this.sort(dir),
          onLeave: () => this.leaveCalorieMode(),
        });
        this.sortControl.install();
        if (boot.marker) this.sortControl.show(boot.marker);
      }
      const allSortedView = Boolean(boot.swap && boot.swap.swapped);
      if (allSortedView) {
        // Every product here was processed before the reload: values come from the cache.
        for (const id of boot.record.failed) this.states.set(id, { status: 'failed' });
        for (const product of this.products) {
          if (!this.states.has(product.id)) this.states.set(product.id, { status: 'failed' });
        }
      }
      this.decorator.start();
      if (allSortedView) {
        this.loading = Promise.resolve({ rateLimited: Boolean(boot.record.rateLimited), cancelled: false });
      } else {
        const missing = this.products.filter((p) => !this.states.has(p.id));
        const run = this.coolingDown()
          ? Promise.resolve(this.markFailed(missing))
          : this.fetchMissing(missing, {
            onProgress: (done, total) => this.status.progress(fill(labels.loadingNutrition, { done, total })),
          });
        // Resolves only after the notice below, so it never overwrites a later sort flow's notice.
        this.loading = run.then((result) => {
          const failed = this.products.filter((p) => this.stateOf(p.id).status === 'failed').length;
          const text = composeNotice(labels, { failed, rateLimited: result.rateLimited });
          if (text) this.status.notice(text);
          else this.status.clear();
          return result;
        });
      }
      if (!boot.marker) return;
      if (allSortedView) this.verifyAllSorted();
      else if (boot.record || boot.justReloaded) this.fallbackToOnePage(boot.marker); // never reload twice
      else this.sort(boot.marker);
    }

    isMultiPage() {
      const { document, location } = this.win;
      return Boolean(document.querySelector('.pagination a[href*="page="]')) || Number(new URLSearchParams(location.search).get('page')) > 1;
    }

    sort(dir) {
      if (this.allSorted) return this.switchDirection(dir);
      return this.isMultiPage() ? this.multiPageSort(dir) : this.onePageSort(dir);
    }

    // Collects every page of the category, saves the sorted list for this tab and reloads;
    // the list swap then hands that list to the site, which draws all products as normal cards.
    async multiPageSort(dir) {
      const { win, labels, boot, status } = this;
      if (this.abort) this.abort.abort(); // a new choice replaces a running one
      const ac = new AbortController();
      this.abort = ac;
      // Requests finishing after Cancel must not bring the status line back.
      const progress = (text) => {
        if (!ac.signal.aborted) status.progress(text, () => this.cancel());
      };
      await this.loading;
      if (ac.signal.aborted) return undefined;
      if (this.coolingDown()) return this.sortHereRateLimited(dir);
      progress(fill(labels.loadingPages, { n: 0 }));
      let products;
      try {
        products = await collectCategory(win.location, {
          fetch: win.fetch.bind(win),
          signal: ac.signal,
          onPage: (n) => progress(fill(labels.loadingPages, { n })),
        });
      } catch (error) {
        if (ac.signal.aborted) return undefined;
        if (error.name === 'RateLimitError') {
          startCooldown(this.local, Date.now());
          return this.sortHereRateLimited(dir);
        }
        console.warn('[calorie-sort] could not load every page of the category', error);
        return this.fallbackToOnePage(dir);
      }
      const missing = products.filter((p) => !this.states.has(p.id));
      const question = fill(labels.confirm, { n: missing.length, s: estimateSeconds(missing.length) });
      if (needsConfirm(missing.length) && !win.confirm(question)) {
        this.cancel();
        return undefined;
      }
      const { rateLimited } = await this.fetchMissing(missing, {
        signal: ac.signal,
        onProgress: (done, total) => progress(fill(labels.loadingNutrition, { done, total })),
      });
      if (ac.signal.aborted) return undefined;
      // Barbora is limiting us: a reload would likely land on its challenge page, so sort what is here.
      if (rateLimited) return this.sortHereRateLimited(dir);
      const sorted = sortProducts(products, this.states, dir);
      const failed = sorted.filter((p) => this.stateOf(p.id).status === 'failed').map((p) => p.id);
      const record = { key: listKey(win.location), dir, savedAt: Date.now(), products: sorted, failed, rateLimited };
      if (!saveList(boot.session, record)) return this.fallbackToOnePage(dir);
      markReload(boot.session, Date.now());
      win.history.replaceState(null, '', sortedViewUrl(win.location, dir));
      win.location.reload();
      return undefined;
    }

    // After the reload: did React draw the whole saved list? If not, sort what is on screen.
    async verifyAllSorted() {
      const { record, marker } = this.boot;
      const total = record.products.length;
      if (!(await this.waitForCardCount(total, CONFIG.verifyTimeoutMs))) return this.fallbackToOnePage(marker);
      this.allSorted = true;
      this.win.document.documentElement.classList.add('bcs-all-sorted');
      if (this.sortControl) this.sortControl.show(marker);
      this.status.notice(composeNotice(this.labels, { total, failed: record.failed.length, rateLimited: Boolean(record.rateLimited) }), {
        label: this.labels.backToNormal,
        onClick: () => this.backToNormal(),
      });
      return undefined;
    }

    waitForCardCount(count, timeoutMs) {
      return new Promise((resolve) => {
        const matches = () => this.decorator.ids().length === count;
        if (matches()) {
          resolve(true);
          return;
        }
        const observer = new MutationObserver(() => {
          if (!matches()) return;
          observer.disconnect();
          clearTimeout(timer);
          resolve(true);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          resolve(matches());
        }, timeoutMs);
        observer.observe(this.container, { childList: true, subtree: true });
      });
    }

    cancel() {
      if (this.abort) this.abort.abort();
      this.abort = null;
      this.status.clear();
      if (this.sortControl) this.sortControl.show(null);
    }

    // In the all-sorted view every value is known already: re-sort the saved list and reload.
    switchDirection(dir) {
      const { win, boot } = this;
      if (Date.now() - boot.record.savedAt > CONFIG.listTtlMs) return this.multiPageSort(dir); // stale: rebuild
      const record = { ...boot.record, dir, products: sortProducts(boot.record.products, this.states, dir) };
      if (!saveList(boot.session, record)) return this.fallbackToOnePage(dir);
      markReload(boot.session, Date.now());
      win.history.replaceState(null, '', sortedViewUrl(win.location, dir));
      win.location.reload();
      return undefined;
    }

    async fallbackToOnePage(dir) {
      await this.onePageSort(dir);
      this.status.notice(this.labels.fallback);
    }

    async sortHereRateLimited(dir) {
      await this.onePageSort(dir);
      const failed = this.products.filter((p) => this.stateOf(p.id).status === 'failed').length;
      this.status.notice(composeNotice(this.labels, { failed, rateLimited: true }));
    }

    coolingDown() {
      return inCooldown(this.local, Date.now());
    }

    // During a cooldown nothing is fetched: unknown products show "?" and are retried later.
    markFailed(products) {
      for (const product of products) this.setState(product.id, { status: 'failed' });
      return { rateLimited: true, cancelled: false };
    }

    backToNormal() {
      const { location } = this.win;
      location.href = location.pathname + baseQuery(location.search);
    }

    // Reorders the cards already on screen with CSS `order`; React's DOM stays untouched.
    async onePageSort(dir) {
      await this.loading;
      const ranks = new Map(sortProducts(this.products, this.states, dir).map((product, index) => [product.id, index]));
      this.decorator.setOrder(ranks);
      const { pathname, search } = this.win.location;
      this.win.history.replaceState(null, '', `${pathname}${search}#kcal-${dir}`);
      if (this.sortControl) this.sortControl.show(dir);
    }

    leaveCalorieMode() {
      const { location, history } = this.win;
      if (parseMarker(location.hash)) history.replaceState(null, '', location.pathname + location.search);
      this.decorator.setOrder(null);
    }

    stateOf(id) {
      return this.states.get(id) || { status: 'loading' };
    }

    setState(id, state) {
      this.states.set(id, state);
      this.cache.put(id, state);
      this.decorator.update(id);
    }

    async fetchMissing(products, { signal, onProgress } = {}) {
      const fetch = this.win.fetch.bind(this.win);
      const { cancelled, rateLimited } = await runPool(products, async (product, poolSignal) => {
        const result = await fetchNutrition(productUrl(product), { fetch, signal: poolSignal });
        // A request cut short by Cancel did not fail: leave the product unknown so it is fetched next time.
        const cutShort = result.status === 'failed' && Boolean(poolSignal && poolSignal.aborted);
        if (result.status !== 'rateLimited' && !cutShort) this.setState(product.id, result);
        return result;
      }, {
        concurrency: CONFIG.productConcurrency,
        signal,
        isRateLimited: (result) => result.status === 'rateLimited',
        onResult: (product, result, done, total) => {
          if (onProgress) onProgress(done, total);
        },
      });
      if (!cancelled) {
        for (const product of products) {
          if (!this.states.has(product.id)) this.setState(product.id, { status: 'failed' });
        }
      }
      if (rateLimited) startCooldown(this.local, Date.now());
      this.cache.flush();
      return { cancelled, rateLimited };
    }
  }

  function createCategoryPage(win, boot) {
    const doc = win.document;
    const container = doc.getElementById('category-page-results-placeholder');
    if (!container) return null;
    if (!Array.isArray(win.b_productList)) {
      console.warn('[calorie-sort] product list not found');
      return null;
    }
    const language = win.b_data && win.b_data.selectedLanguageData;
    const local = safeStorage(() => win.localStorage);
    const page = new CategoryPage({
      win,
      container,
      select: doc.querySelector('select.b-orderby'),
      products: win.b_productList,
      labels: pickLabels(language && language.locale),
      cache: new NutritionCache(local),
      local,
      boot,
    });
    page.init();
    return page;
  }

  function start() {
    // Everything up to the list swap must happen now, before the page assigns its product list.
    const session = safeStorage(() => window.sessionStorage);
    const marker = parseMarker(location.hash);
    const justReloaded = consumeReload(session, Date.now());
    const record = marker ? loadList(session, listKey(location), marker, Date.now()) : null;
    const swap = record ? installSwapHook(window, record) : null;
    const boot = { marker, record, swap, justReloaded, session };
    let page = null;
    window.addEventListener('change', (event) => {
      const target = event.target;
      if (page && page.sortControl && target && target.matches && target.matches('select.b-orderby')) {
        page.sortControl.handleChange(event);
      }
    }, true);
    const go = () => { page = createCategoryPage(window, boot); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }

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
      isFresh,
      NutritionCache,
      saveList,
      loadList,
      startCooldown,
      inCooldown,
      runPool,
      fetchNutrition,
      needsConfirm,
      estimateSeconds,
      collectCategory,
      installSwapHook,
      markReload,
      consumeReload,
      safeStorage,
    };
  } else {
    start();
  }
})();
