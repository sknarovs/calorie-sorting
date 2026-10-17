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

  // ---- Browser ----

  function start() {}

  if (typeof window === 'undefined') {
    module.exports = { CONFIG, extractAssignedJson, readNutrition };
  } else {
    start();
  }
})();
