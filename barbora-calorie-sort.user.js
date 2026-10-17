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
    productConcurrency: 2, // gentle on Barbora's Cloudflare limits
    minSpacingMs: 300,
    timeoutMs: 15000,
    retryDelayMs: 1000,
    backoffMs: 5000,
    maxRateLimited: 3,
    cooldownMs: 5 * 60 * 1000,
    cacheDaysData: 30,
    cacheDaysNoData: 7,
    cacheMaxEntries: 6000,
    cacheFlushEvery: 20,
    keys: { nutrition: 'bcs:nutrition:v1', cooldown: 'bcs:cooldown' },
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

  // Sorting by price per unit ("Cena par vienību") shows the kcal boxes without being asked.
  function autoLoads(search) {
    return /^comparativePrice(Asc|Desc)$/.test(new URLSearchParams(search).get('order') || '');
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
      kcal: '{k} kcal',
      protein: '{p} g olb.',
      boxTitle: 'uz 100 g/ml · olb. — olbaltumvielas',
      sortAsc: 'Kalorijas (augoši)',
      sortDesc: 'Kalorijas (dilstoši)',
      noData: 'nav datu',
      failedTitle: 'Neizdevās ielādēt',
      loadingNutrition: 'Ielādē uzturvērtību: {done} / {total}',
      cancel: 'Atcelt',
      someFailed: 'Neizdevās ielādēt: {n}',
      rateLimited: 'Barbora ierobežo pieprasījumus — sakārtots pēc jau ielādētajiem datiem',
    },
    en: {
      locale: 'en',
      kcal: '{k} kcal',
      protein: '{p} g protein',
      boxTitle: 'per 100 g/ml',
      sortAsc: 'Calories from lowest',
      sortDesc: 'Calories from highest',
      noData: 'no data',
      failedTitle: "Couldn't load",
      loadingNutrition: 'Loading nutrition: {done} / {total}',
      cancel: 'Cancel',
      someFailed: "{n} couldn't be loaded",
      rateLimited: 'Barbora is limiting requests — sorted with the data loaded so far',
    },
    ru: {
      locale: 'ru',
      kcal: '{k} ккал',
      protein: '{p} г белка',
      boxTitle: 'на 100 г/мл',
      sortAsc: 'Калорийности от самой низкой',
      sortDesc: 'Калорийности от самой высокой',
      noData: 'нет данных',
      failedTitle: 'Не удалось загрузить',
      loadingNutrition: 'Загрузка пищевой ценности: {done} / {total}',
      cancel: 'Отмена',
      someFailed: 'Не удалось загрузить: {n}',
      rateLimited: 'Barbora ограничивает запросы — отсортировано по уже загруженным данным',
    },
  };

  function pickLabels(locale) {
    return Object.prototype.hasOwnProperty.call(LABELS, locale) ? LABELS[locale] : LABELS.lv;
  }

  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
  }

  const numberFormats = new Map();
  function formatNumber(locale, value, maxDigits) {
    const key = `${locale}:${maxDigits}`;
    if (!numberFormats.has(key)) numberFormats.set(key, new Intl.NumberFormat(locale, { maximumFractionDigits: maxDigits }));
    return numberFormats.get(key).format(value);
  }

  // The kcal box: a bold first line (kcal) and a small second line (protein), like the price box.
  function formatBox(labels, state) {
    switch (state.status) {
      case 'ok': {
        const lines = [fill(labels.kcal, { k: formatNumber(labels.locale, state.kcal, 0) })];
        if (state.protein !== null) lines.push(fill(labels.protein, { p: formatNumber(labels.locale, state.protein, 1) }));
        return { kind: 'ok', lines, title: labels.boxTitle };
      }
      case 'none':
        return { kind: 'none', lines: [labels.noData], title: '' };
      case 'failed':
        return { kind: 'failed', lines: ['?'], title: labels.failedTitle };
      default:
        return { kind: 'loading', lines: [fill(labels.kcal, { k: '…' })], title: '' };
    }
  }

  function composeNotice(labels, { failed, rateLimited }) {
    const parts = [];
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

  // Runs `worker` over `items` with a concurrency limit, a minimum gap between starts, cancel
  // support and rate-limit backoff.
  function runPool(items, worker, opts) {
    const {
      concurrency, signal, onResult, isRateLimited = () => false, sleep = defaultSleep, now = Date.now,
      minSpacingMs = 0, backoffMs = CONFIG.backoffMs, maxRateLimited = CONFIG.maxRateLimited,
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
      let pumping = false;
      let lastStart = -Infinity;
      const pump = async () => {
        if (pumping) return;
        pumping = true;
        while (!stopped && !aborted() && inFlight < limit && queue.length > 0) {
          const wait = lastStart + minSpacingMs - now();
          if (wait > 0) {
            await sleep(wait);
            continue; // conditions may have changed while waiting
          }
          const item = queue.shift();
          inFlight += 1;
          lastStart = now();
          let running;
          try {
            running = Promise.resolve(worker(item, signal));
          } catch (error) {
            running = Promise.reject(error);
          }
          running
            .then((result) => settle(item, result))
            .catch((error) => {
              stopped = true;
              reject(error);
            });
        }
        pumping = false;
        finishIfDone();
      };
      pump();
      finishIfDone();
    });
  }

  // ---- Browser ----

  const CARD_SELECTOR = 'li[data-cnstrc-item-id]';
  // Cards are the grid's own <li>s. For logged-in users the site nests a full-width recommendations
  // row in the grid whose carousel items also carry data-cnstrc-item-id; those are not cards.
  const isCard = (li) => !li.parentElement || !li.parentElement.closest('li');

  // The kcal box sits in the price row like a second price box; other blocks of the price area
  // keep their own line underneath.
  const STYLE_CSS = `
[itemprop="offers"]:has(> .bcs-box) { display: flex; flex-wrap: wrap; align-items: flex-start; column-gap: 4px; }
[itemprop="offers"]:has(> .bcs-box) > .bcs-box { order: 1; }
[itemprop="offers"]:has(> .bcs-box) > div:not(:first-of-type) { order: 2; flex-basis: 100%; }
.bcs-box { box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; min-height: 60px; margin-bottom: 2px; padding: 7px 8px; border: 1px solid #c8e6c9; border-radius: 8px; background: #e8f5e9; color: #1b5e20; white-space: nowrap; }
.bcs-box__main { font-size: 16px; line-height: 24px; font-weight: 700; }
.bcs-box__sub { margin-top: 2px; font-size: 12px; line-height: 16px; font-weight: 600; }
.bcs-box--none, .bcs-box--failed { border-color: #e0e0e0; background: #f5f5f5; color: #757575; }
.bcs-box--loading { border-color: #eeeeee; background: #fafafa; color: #9e9e9e; }
/* Beside a discounted price (two joined price boxes) only ~63 px are left: a compact box fits there. */
[itemprop="offers"]:has(> div:first-of-type [class*="rounded-l-"]) > .bcs-box { padding: 7px 4px; }
[itemprop="offers"]:has(> div:first-of-type [class*="rounded-l-"]) > .bcs-box .bcs-box__main { font-size: 12px; line-height: 22px; }
[itemprop="offers"]:has(> div:first-of-type [class*="rounded-l-"]) > .bcs-box .bcs-box__sub { font-size: 10px; line-height: 14px; }
.bcs-status { margin: 8px 0; padding: 8px 12px; border-radius: 8px; background: #fff8e1; color: #3e2723; font-size: 14px; line-height: 20px; }
.bcs-status[hidden] { display: none; }
.bcs-status__action { margin-left: 8px; padding: 0; border: 0; background: none; color: #c00; font: inherit; text-decoration: underline; cursor: pointer; }
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
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => { data.set(k, String(v)); },
      removeItem: (k) => { data.delete(k); },
    };
  }

  // Keeps a kcal box (and, when sorting, a CSS `order`) on every card React renders.
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
      return [...this.container.querySelectorAll(CARD_SELECTOR)].filter(isCard);
    }

    update(id) {
      const li = [...this.container.querySelectorAll(`li[data-cnstrc-item-id="${CSS.escape(id)}"]`)].find(isCard);
      if (li) this.render(li);
    }

    setOrder(ranks) {
      this.ranks = ranks;
      this.renderAll();
    }

    renderAll() {
      const cards = this.cards();
      for (const li of cards) this.render(li);
      // Anything else in the grid (the recommendations row) goes after the sorted cards.
      const isOwnCard = new Set(cards);
      const grid = cards.length ? cards[0].parentElement : null;
      if (grid) for (const child of grid.children) if (!isOwnCard.has(child)) this.applyOrder(child, this.ranks && this.ranks.size + 1);
    }

    // Sets the CSS order (or removes the one this decorator set when there are no ranks).
    applyOrder(el, rank) {
      if (this.ranks) {
        const order = String(rank);
        if (el.style.order !== order) el.style.order = order;
        this.ordered.add(el);
      } else if (this.ordered.has(el)) {
        el.style.removeProperty('order');
        this.ordered.delete(el);
      }
    }

    render(li) {
      const id = li.getAttribute('data-cnstrc-item-id');
      const state = this.stateOf(id);
      let box = li.querySelector('.bcs-box');
      if (!state) {
        if (box) box.remove(); // nothing known or loading yet: no box
      } else {
        const anchor = li.querySelector('[itemprop="offers"]') || li;
        if (!box || box.parentElement !== anchor) {
          if (box) box.remove();
          box = li.ownerDocument.createElement('span');
          anchor.appendChild(box);
        }
        this.paint(box, formatBox(this.labels, state));
      }
      this.applyOrder(li, this.ranks && (this.ranks.has(id) ? this.ranks.get(id) : this.ranks.size));
    }

    paint(box, { kind, lines, title }) {
      const className = `bcs-box bcs-box--${kind}`;
      if (box.className !== className) box.className = className;
      if (box.title !== title) box.title = title;
      const text = lines.join('\n');
      if (box.dataset.lines === text) return;
      box.dataset.lines = text;
      const doc = box.ownerDocument;
      box.replaceChildren(...lines.map((line, index) => {
        const span = doc.createElement('span');
        span.className = index === 0 ? 'bcs-box__main' : 'bcs-box__sub';
        span.textContent = line;
        return span;
      }));
    }
  }

  // One line above the product grid for progress and notices.
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

    notice(text) {
      this.show(text, null, null);
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

  // Sorts the products on screen by calories. Values are only loaded when a sort asks for them;
  // browsing shows the ones already saved and requests nothing.
  class CategoryPage {
    constructor({ win, container, select, products, labels, cache, local, boot }) {
      Object.assign(this, { win, container, select, products, labels, cache, local, boot });
      this.states = new Map();
      for (const product of products) {
        const cached = cache.get(product.id);
        if (cached) this.states.set(product.id, cached);
      }
      this.waiting = new Set(); // ids being loaded right now, shown as "… kcal"
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
      this.decorator.start();
      if (boot.marker) this.sort(boot.marker);
      else if (autoLoads(this.win.location.search)) this.showValues();
    }

    // On a price-per-unit page the boxes appear by themselves; the site's order stays.
    async showValues() {
      const { cancelled, rateLimited } = await this.loadMissing();
      if (!cancelled) this.reportProblems(rateLimited);
    }

    stateOf(id) {
      if (this.states.has(id)) return this.states.get(id);
      return this.waiting.has(id) ? { status: 'loading' } : null;
    }

    setState(id, state) {
      this.waiting.delete(id);
      this.states.set(id, state);
      this.cache.put(id, state);
      this.decorator.update(id);
    }

    // Reorders the cards on screen with CSS `order`; React's DOM stays untouched. Products with
    // equal values keep the order the site showed them in (e.g. its price-per-unit sort).
    async sort(dir) {
      this.wanted = dir;
      const { cancelled, rateLimited } = await this.loadMissing();
      if (cancelled || this.wanted !== dir) return; // cancelled, or a newer choice finishes the job
      const ranks = new Map(sortProducts(this.products, this.states, dir).map((product, index) => [product.id, index]));
      this.decorator.setOrder(ranks);
      const { location, history } = this.win;
      history.replaceState(history.state, '', `${location.pathname}${location.search}#kcal-${dir}`);
      if (this.sortControl) this.sortControl.show(dir);
      this.reportProblems(rateLimited);
    }

    reportProblems(rateLimited) {
      const failed = this.products.filter((p) => (this.stateOf(p.id) || {}).status === 'failed').length;
      const text = composeNotice(this.labels, { failed, rateLimited });
      if (text) this.status.notice(text);
      else this.status.clear();
    }

    // One loading run at a time: a second choice made while loading waits for the same run.
    loadMissing() {
      if (this.run) return this.run;
      const missing = this.products.filter((p) => !this.states.has(p.id));
      if (!missing.length) return Promise.resolve({ cancelled: false, rateLimited: false });
      if (this.coolingDown()) return Promise.resolve(this.markFailed(missing));
      const ac = new AbortController();
      this.abort = ac;
      for (const product of missing) this.waiting.add(product.id);
      this.decorator.renderAll();
      this.run = this.fetchMissing(missing, {
        signal: ac.signal,
        // Requests finishing after Cancel must not bring the status line back.
        onProgress: (done, total) => {
          if (!ac.signal.aborted) this.status.progress(fill(this.labels.loadingNutrition, { done, total }), () => this.cancel());
        },
      }).finally(() => {
        this.run = null;
        this.abort = null;
      });
      return this.run;
    }

    cancel() {
      this.stopLoading();
      this.status.clear();
      if (this.sortControl) this.sortControl.show(null);
      this.dropMarker();
    }

    leaveCalorieMode() {
      this.stopLoading();
      this.dropMarker();
      this.decorator.setOrder(null);
    }

    stopLoading() {
      this.wanted = null;
      if (this.abort) this.abort.abort();
      this.waiting.clear();
      this.decorator.renderAll();
    }

    dropMarker() {
      const { location, history } = this.win;
      if (parseMarker(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
    }

    coolingDown() {
      return inCooldown(this.local, Date.now());
    }

    // During a cooldown nothing is fetched: unknown products show "?" and are retried later.
    markFailed(products) {
      for (const product of products) this.setState(product.id, { status: 'failed' });
      return { rateLimited: true, cancelled: false };
    }

    async fetchMissing(products, { signal, onProgress } = {}) {
      const fetch = this.win.fetch.bind(this.win);
      if (onProgress) onProgress(0, products.length);
      const { cancelled, rateLimited } = await runPool(products, async (product, poolSignal) => {
        const result = await fetchNutrition(productUrl(product), { fetch, signal: poolSignal });
        // A request cut short by Cancel did not fail: leave the product unknown so it is fetched next time.
        const cutShort = result.status === 'failed' && Boolean(poolSignal && poolSignal.aborted);
        if (result.status !== 'rateLimited' && !cutShort) this.setState(product.id, result);
        return result;
      }, {
        concurrency: CONFIG.productConcurrency,
        minSpacingMs: CONFIG.minSpacingMs,
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
    const select = doc.querySelector('select.b-orderby');
    if (!select) console.warn('[calorie-sort] sort dropdown not found');
    const language = win.b_data && win.b_data.selectedLanguageData;
    const local = safeStorage(() => win.localStorage);
    const page = new CategoryPage({
      win,
      container,
      select,
      products: win.b_productList.filter((p) => p && p.id && !p.isBanner),
      labels: pickLabels(language && language.locale),
      cache: new NutritionCache(local),
      local,
      boot,
    });
    page.init();
    return page;
  }

  function start() {
    const boot = { marker: parseMarker(location.hash) };
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
      autoLoads,
      productUrl,
      sortProducts,
      LABELS,
      pickLabels,
      fill,
      formatBox,
      composeNotice,
      isFresh,
      NutritionCache,
      startCooldown,
      inCooldown,
      runPool,
      fetchNutrition,
      safeStorage,
    };
  } else {
    start();
  }
})();
