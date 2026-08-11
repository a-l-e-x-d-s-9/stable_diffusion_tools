// ==UserScript==
// @name         Civitai - Show Yellow Buzz and Today's Sales
// @namespace    https://civitai.com/
// @version      1.2.0
// @description  Shows Yellow Buzz and today's paid-model sales in Civitai's top-right account button.
// @match        https://civitai.com/*
// @match        https://civitai.green/*
// @match        https://civitai.red/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const YELLOW_HEX = '#f59f00';
  const YELLOW_RGB = 'rgb(245, 159, 0)';
  const CACHE_KEY = 'civitai-yellow-buzz-only-v1';
  const SALES_CACHE_KEY = 'civitai-yellow-buzz-sales-today-v1';
  const SALES_LOCK_KEY = `${SALES_CACHE_KEY}-lock`;
  const SALES_REFRESH_MS = 2 * 60 * 1000;
  const SALES_LOCK_MS = 30 * 1000;
  const SALES_PAGE_SIZE = 200;
  const PURCHASE_TRANSACTION_TYPE = 6;

  const state = {
    lastCombinedText: '',
    lastCombinedGradient: '',
    lastAppliedYellow: '',
    salesCount: null,
    salesDayKey: '',
    salesLoading: false,
    salesError: '',
    updatePending: false,
  };

  console.info('[Civitai Yellow Buzz] Script v1.2.0 loaded');

  function getUtcDayBounds(now = new Date()) {
    const start = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));

    return {
      dayKey: start.toISOString().slice(0, 10),
      start,
      end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    };
  }

  function loadSalesCache(dayKey) {
    try {
      const cached = JSON.parse(
        localStorage.getItem(SALES_CACHE_KEY) || 'null'
      );

      if (
        cached &&
        cached.dayKey === dayKey &&
        Number.isInteger(cached.count) &&
        cached.count >= 0 &&
        Number.isFinite(cached.savedAt)
      ) {
        return cached;
      }
    } catch {
      // Ignore an invalid or unavailable cache.
    }

    return null;
  }

  function applySalesCache(cached) {
    if (!cached) return;

    state.salesCount = cached.count;
    state.salesDayKey = cached.dayKey;
    state.salesError = '';
    queueUpdate();
  }

  function saveSalesCache(dayKey, count) {
    const cached = {
      dayKey,
      count,
      savedAt: Date.now(),
    };

    try {
      localStorage.setItem(SALES_CACHE_KEY, JSON.stringify(cached));
    } catch {
      // Continue without cross-tab caching.
    }

    applySalesCache(cached);
  }

  function acquireSalesRefreshLock() {
    const token = `${Date.now()}-${Math.random()}`;

    try {
      const existing = JSON.parse(
        localStorage.getItem(SALES_LOCK_KEY) || 'null'
      );

      if (existing?.expiresAt > Date.now()) return null;

      localStorage.setItem(
        SALES_LOCK_KEY,
        JSON.stringify({
          token,
          expiresAt: Date.now() + SALES_LOCK_MS,
        })
      );

      const saved = JSON.parse(
        localStorage.getItem(SALES_LOCK_KEY) || 'null'
      );

      return saved?.token === token ? token : null;
    } catch {
      // localStorage can be disabled; an in-tab loading flag still prevents
      // duplicate requests in this tab.
      return token;
    }
  }

  function releaseSalesRefreshLock(token) {
    try {
      const saved = JSON.parse(
        localStorage.getItem(SALES_LOCK_KEY) || 'null'
      );

      if (saved?.token === token) {
        localStorage.removeItem(SALES_LOCK_KEY);
      }
    } catch {
      // The short lease will expire on its own.
    }
  }

  function serializeTransactionInput(input) {
    return {
      json: {
        ...input,
        start: input.start.toISOString(),
        end: input.end.toISOString(),
      },
      meta: {
        values: {
          start: ['Date'],
          end: ['Date'],
        },
        v: 1,
      },
    };
  }

  /*
    Civitai currently writes SuperJSON responses. During its gradual tRPC
    serializer migration, some server pools can instead write devalue's flat
    format, so support the subset used by transaction responses as well.
  */
  function deserializeDevalue(serialized) {
    const values = JSON.parse(serialized);
    if (!Array.isArray(values)) return values;

    const hydrated = new Array(values.length);
    const ready = new Array(values.length).fill(false);

    function hydrate(index) {
      if (index === -1) return undefined;
      if (index === -2) return undefined;
      if (index === -3) return NaN;
      if (index === -4) return Infinity;
      if (index === -5) return -Infinity;
      if (index === -6) return -0;
      if (typeof index !== 'number' || index < 0) return index;
      if (ready[index]) return hydrated[index];

      const value = values[index];

      if (value === null || typeof value !== 'object') {
        ready[index] = true;
        hydrated[index] = value;
        return value;
      }

      if (Array.isArray(value)) {
        if (value[0] === 'Date') {
          const date = new Date(value[1]);
          ready[index] = true;
          hydrated[index] = date;
          return date;
        }

        const array = [];
        ready[index] = true;
        hydrated[index] = array;

        for (const item of value) {
          array.push(hydrate(item));
        }

        return array;
      }

      const object = {};
      ready[index] = true;
      hydrated[index] = object;

      for (const [key, item] of Object.entries(value)) {
        object[key] = hydrate(item);
      }

      return object;
    }

    return hydrate(0);
  }

  function deserializeTransactionData(serialized) {
    if (typeof serialized === 'string') {
      return deserializeDevalue(serialized);
    }

    if (
      serialized &&
      typeof serialized === 'object' &&
      Object.prototype.hasOwnProperty.call(serialized, 'json')
    ) {
      return serialized.json;
    }

    return serialized;
  }

  async function fetchTransactionPage(input) {
    const serialized = serializeTransactionInput(input);
    const url =
      '/api/trpc/buzz.getUserTransactions?input=' +
      encodeURIComponent(JSON.stringify(serialized));

    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        'x-client': 'web',
        'x-client-date': String(Date.now()),
      },
    });

    const body = await response.json().catch(() => null);

    if (!response.ok || body?.error) {
      const message =
        body?.error?.json?.message ||
        body?.error?.message ||
        `Transaction request failed (${response.status})`;
      throw new Error(message);
    }

    const data = deserializeTransactionData(body?.result?.data);

    if (!data || !Array.isArray(data.transactions)) {
      throw new Error('Civitai returned an unexpected transaction response');
    }

    return data;
  }

  function isPaidModelSale(transaction) {
    if (!transaction || Number(transaction.amount) <= 0) return false;

    const externalId = String(
      transaction.externalTransactionId || ''
    ).toLowerCase();

    if (
      externalId.startsWith('early-access-') ||
      externalId.startsWith('permanent-access-')
    ) {
      return true;
    }

    return /^gain (?:early )?access (?:to|on) model\b/i.test(
      String(transaction.description || '').trim()
    );
  }

  function getSaleIdentity(transaction) {
    if (transaction.externalTransactionId) {
      return `external:${transaction.externalTransactionId}`;
    }

    return JSON.stringify([
      transaction.date,
      transaction.fromAccountId,
      transaction.toAccountId,
      transaction.amount,
      transaction.description,
    ]);
  }

  async function fetchTodaySales(bounds) {
    const saleIds = new Set();
    const seenCursors = new Set();
    let cursor;

    do {
      const page = await fetchTransactionPage({
        start: bounds.start,
        end: bounds.end,
        accountTypes: ['yellow'],
        type: PURCHASE_TRANSACTION_TYPE,
        limit: SALES_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });

      for (const transaction of page.transactions) {
        if (isPaidModelSale(transaction)) {
          saleIds.add(getSaleIdentity(transaction));
        }
      }

      const nextCursor = page.cursor ? String(page.cursor) : '';
      if (!nextCursor || seenCursors.has(nextCursor)) break;

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return saleIds.size;
  }

  async function refreshSalesIfNeeded(force = false) {
    if (state.salesLoading) return;

    const bounds = getUtcDayBounds();
    const cached = loadSalesCache(bounds.dayKey);

    if (cached) applySalesCache(cached);

    if (
      !force &&
      cached &&
      Date.now() - cached.savedAt < SALES_REFRESH_MS
    ) {
      return;
    }

    const lockToken = acquireSalesRefreshLock();
    if (!lockToken) return;

    state.salesLoading = true;
    state.salesError = '';
    queueUpdate();

    try {
      const count = await fetchTodaySales(bounds);
      saveSalesCache(bounds.dayKey, count);
    } catch (error) {
      state.salesError = error?.message || String(error);
      console.warn(
        '[Civitai Yellow Buzz] Could not update today\'s sales:',
        error
      );
    } finally {
      state.salesLoading = false;
      releaseSalesRefreshLock(lockToken);
      queueUpdate();
    }
  }

  function compactNumberToValue(text) {
    const normalized = String(text || '')
      .trim()
      .toLowerCase()
      .replace(/,/g, '')
      .replace(/\s+/g, '');

    const match = normalized.match(/^([\d.]+)([kmbt])?$/);
    if (!match) return null;

    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;

    const multiplier = {
      k: 1e3,
      m: 1e6,
      b: 1e9,
      t: 1e12,
    }[match[2]] || 1;

    return number * multiplier;
  }

  function valueToCompactNumber(value) {
    if (!Number.isFinite(value)) return null;

    const units = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];

    for (const [divisor, suffix] of units) {
      if (Math.abs(value) >= divisor) {
        const scaled = value / divisor;
        const decimals = Math.abs(scaled) < 10 ? 1 : 0;

        return (
          scaled
            .toFixed(decimals)
            .replace(/\.0$/, '') + suffix
        );
      }
    }

    return String(Math.round(value));
  }

  function isCompactBuzzText(text) {
    return /^[\d,.]+(?:\.\d+)?[KMBT]?$/i.test(
      String(text || '').trim()
    );
  }

  function findBuzzText(root) {
    if (!root) return null;

    const preferred = root.querySelector(
      '[class*="buzzText"], span[data-size="md"]'
    );

    if (preferred && isCompactBuzzText(preferred.textContent)) {
      return preferred;
    }

    return [...root.querySelectorAll('span')].find((element) =>
      isCompactBuzzText(element.textContent)
    ) || null;
  }

  function findTopBuzz() {
    const accountButton = document.querySelector(
      'button[aria-label="Account menu"]'
    );

    if (!accountButton) return null;

    const candidates = [
      ...accountButton.querySelectorAll(
        '[class*="userBuzz"], [style*="--buzz-gradient"]'
      ),
    ];

    for (const root of candidates) {
      const text = findBuzzText(root);

      if (text) {
        return {
          accountButton,
          root,
          text,
        };
      }
    }

    return null;
  }

  function elementLooksYellow(element) {
    if (!element) return false;

    const inlineStyle = (
      element.getAttribute('style') || ''
    ).toLowerCase();

    const gradient = (
      element.style.getPropertyValue('--buzz-gradient') || ''
    ).toLowerCase();

    let computedColor = '';

    try {
      computedColor = getComputedStyle(element).color;
    } catch {
      // Ignore detached or temporarily unavailable elements.
    }

    return (
      inlineStyle.includes(YELLOW_HEX) ||
      inlineStyle.includes(YELLOW_RGB) ||
      gradient.includes(YELLOW_HEX) ||
      computedColor === YELLOW_RGB
    );
  }

  function getYellowFromOpenMenu() {
    const dashboardLink = document.querySelector(
      'a[href="/user/buzz-dashboard"], ' +
      'a[href^="/user/buzz-dashboard?"], ' +
      'a[href*="/user/buzz-dashboard"]'
    );

    if (!dashboardLink) return null;

    const candidates = [
      ...dashboardLink.querySelectorAll(
        '[class*="userBuzz"], [style*="--buzz-gradient"]'
      ),
    ];

    for (const root of candidates) {
      if (!elementLooksYellow(root)) continue;

      const text = findBuzzText(root);
      const value = text?.textContent?.trim();

      if (value) {
        return value.toUpperCase();
      }
    }

    /*
      Fallback: inspect every compact-number span inside the Buzz dashboard
      row and use the one whose closest styled ancestor is yellow.
    */
    for (const text of dashboardLink.querySelectorAll('span')) {
      const value = text.textContent?.trim();

      if (!isCompactBuzzText(value)) continue;

      let ancestor = text;

      while (ancestor && ancestor !== dashboardLink) {
        if (elementLooksYellow(ancestor)) {
          return value.toUpperCase();
        }

        ancestor = ancestor.parentElement;
      }
    }

    return null;
  }

  function saveCachedYellow(yellowText, combinedText) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          yellowText,
          combinedText,
          savedAt: Date.now(),
        })
      );
    } catch {
      // Continue without caching.
    }
  }

  function loadCachedYellow(combinedText) {
    try {
      const cached = JSON.parse(
        localStorage.getItem(CACHE_KEY) || 'null'
      );

      if (
        cached &&
        typeof cached.yellowText === 'string' &&
        (
          !combinedText ||
          !cached.combinedText ||
          cached.combinedText === combinedText
        )
      ) {
        return cached.yellowText;
      }
    } catch {
      // Ignore an invalid cache.
    }

    return null;
  }

  function deriveYellowFromCombined(combinedText, gradientText) {
    const total = compactNumberToValue(combinedText);
    if (total === null) return null;

    const percentages = [
      ...String(gradientText || '').matchAll(/([\d.]+)%/g),
    ]
      .map((match) => Number(match[1]))
      .filter((number) => Number.isFinite(number));

    const split = percentages.find(
      (percentage) => percentage > 0 && percentage < 100
    );

    if (split === undefined) return null;

    const yellowValue = total * ((100 - split) / 100);
    return valueToCompactNumber(yellowValue);
  }

  function forceYellowAppearance(root, text) {
    root.dataset.tmYellowBuzzOnly = 'true';
    text.dataset.tmYellowBuzzOnly = 'true';

    root.style.setProperty(
      '--buzz-gradient',
      YELLOW_HEX,
      'important'
    );
    root.style.setProperty('color', YELLOW_HEX, 'important');
    root.style.setProperty(
      '-webkit-text-fill-color',
      YELLOW_HEX,
      'important'
    );

    text.style.setProperty(
      '--buzz-gradient',
      YELLOW_HEX,
      'important'
    );
    text.style.setProperty('background', 'none', 'important');
    text.style.setProperty(
      'background-image',
      'none',
      'important'
    );
    text.style.setProperty('color', YELLOW_HEX, 'important');
    text.style.setProperty(
      '-webkit-text-fill-color',
      YELLOW_HEX,
      'important'
    );

    for (const svg of root.querySelectorAll('svg')) {
      svg.setAttribute('stroke', YELLOW_HEX);
      svg.setAttribute('fill', YELLOW_HEX);
      svg.style.setProperty('stroke', YELLOW_HEX, 'important');
      svg.style.setProperty('fill', YELLOW_HEX, 'important');

      for (const stop of svg.querySelectorAll('stop')) {
        stop.setAttribute('stop-color', YELLOW_HEX);
        stop.style.setProperty(
          'stop-color',
          YELLOW_HEX,
          'important'
        );
      }

      for (const path of svg.querySelectorAll('path')) {
        path.style.setProperty('stroke', YELLOW_HEX, 'important');
        path.style.setProperty('fill', YELLOW_HEX, 'important');
      }
    }
  }

  function updateSalesBadge(root) {
    let badge = root.querySelector('[data-tm-sales-today="true"]');
    const currentDayKey = getUtcDayBounds().dayKey;
    const hasCurrentCount =
      state.salesDayKey === currentDayKey &&
      Number.isInteger(state.salesCount);

    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.tmSalesToday = 'true';
      badge.setAttribute('aria-label', 'Paid-model sales today');
      badge.style.setProperty('margin-left', '5px', 'important');
      badge.style.setProperty('font-size', '0.75em', 'important');
      badge.style.setProperty('font-weight', '600', 'important');
      badge.style.setProperty('line-height', '1', 'important');
      badge.style.setProperty('white-space', 'nowrap', 'important');
      badge.style.setProperty('background', 'none', 'important');
      badge.style.setProperty('color', YELLOW_HEX, 'important');
      badge.style.setProperty(
        '-webkit-text-fill-color',
        YELLOW_HEX,
        'important'
      );
      root.appendChild(badge);
    }

    if (hasCurrentCount) {
      const noun = state.salesCount === 1 ? 'sale' : 'sales';
      badge.textContent = `· ${state.salesCount} ${noun}`;
      badge.title =
        `${state.salesCount} paid-model ${noun} since 00:00 UTC`;
      badge.style.removeProperty('display');
    } else if (state.salesLoading) {
      badge.textContent = '· … sales';
      badge.title = 'Loading paid-model sales since 00:00 UTC';
      badge.style.removeProperty('display');
    } else {
      badge.textContent = '';
      badge.title = state.salesError
        ? `Could not load today's sales: ${state.salesError}`
        : '';
      badge.style.setProperty('display', 'none', 'important');
    }
  }

  function update() {
    const top = findTopBuzz();
    if (!top) return;

    const currentText = top.text.textContent.trim().toUpperCase();
    const currentGradient =
      top.root.style.getPropertyValue('--buzz-gradient') ||
      top.root.getAttribute('style') ||
      '';

    /*
      Capture Civitai's combined value before replacing it. If React later
      refreshes the value, it will differ from our last inserted Yellow value.
    */
    if (
      currentText &&
      currentText !== state.lastAppliedYellow &&
      isCompactBuzzText(currentText)
    ) {
      state.lastCombinedText = currentText;
    }

    if (
      currentGradient.includes('linear-gradient') ||
      currentGradient.includes('%')
    ) {
      state.lastCombinedGradient = currentGradient;
    }

    const exactYellow = getYellowFromOpenMenu();

    if (exactYellow) {
      state.lastAppliedYellow = exactYellow;
      saveCachedYellow(exactYellow, state.lastCombinedText);
    }

    const yellowText =
      exactYellow ||
      loadCachedYellow(state.lastCombinedText) ||
      deriveYellowFromCombined(
        state.lastCombinedText,
        state.lastCombinedGradient
      );

    updateSalesBadge(top.root);

    if (!yellowText) return;

    forceYellowAppearance(top.root, top.text);

    if (top.text.textContent.trim().toUpperCase() !== yellowText) {
      top.text.textContent = yellowText;
    }

    state.lastAppliedYellow = yellowText;

    const buzzTitle = state.lastCombinedText
      ? `Yellow Buzz only — combined total: ${state.lastCombinedText}`
      : 'Yellow Buzz only';

    top.text.title = Number.isInteger(state.salesCount)
      ? `${buzzTitle} — today's paid-model sales: ${state.salesCount}`
      : buzzTitle;
  }

  function queueUpdate() {
    if (state.updatePending) return;

    state.updatePending = true;

    requestAnimationFrame(() => {
      state.updatePending = false;
      update();
    });
  }

  function runSeveralTimes() {
    queueUpdate();

    for (const delay of [50, 150, 350, 700, 1200]) {
      setTimeout(queueUpdate, delay);
    }
  }

  function start() {
    const observer = new MutationObserver(queueUpdate);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'style',
        'class',
        'aria-expanded',
      ],
    });

    document.addEventListener(
      'click',
      (event) => {
        if (
          event.target.closest(
            'button[aria-label="Account menu"], ' +
            'a[href*="/user/buzz-dashboard"]'
          )
        ) {
          runSeveralTimes();
        }
      },
      true
    );

    window.addEventListener('storage', (event) => {
      if (event.key !== SALES_CACHE_KEY) return;

      const bounds = getUtcDayBounds();
      applySalesCache(loadSalesCache(bounds.dayKey));
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshSalesIfNeeded();
    });

    /*
      Civitai is a React application and can replace the header after route
      changes. The interval repairs the display if that happens.
    */
    setInterval(queueUpdate, 750);
    setInterval(refreshSalesIfNeeded, 30 * 1000);

    runSeveralTimes();
    refreshSalesIfNeeded();
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, {
      once: true,
    });
  }
})();
