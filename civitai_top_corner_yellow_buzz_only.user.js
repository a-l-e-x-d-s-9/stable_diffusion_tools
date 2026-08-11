// ==UserScript==
// @name         Civitai - Show Yellow Buzz and Today's Sales
// @namespace    https://civitai.com/
// @version      1.3.1
// @description  Shows Yellow Buzz and a configurable daily paid-model sales counter in Civitai's top-right account button.
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
  const SALES_COLOR_SETTINGS_KEY =
    'civitai-yellow-buzz-sales-color-settings-v1';
  const SALES_REFRESH_MS = 2 * 60 * 1000;
  const SALES_LOCK_MS = 30 * 1000;
  const SALES_PAGE_SIZE = 200;
  const PURCHASE_TRANSACTION_TYPE = 6;
  const DEFAULT_SALES_COLOR_SETTINGS = Object.freeze({
    lowMax: 3,
    highMin: 6,
    lowEnabled: false,
    lowColor: '#fa5252',
    middleEnabled: false,
    middleColor: '#f59f00',
    highEnabled: false,
    highColor: '#40c057',
  });

  const state = {
    lastCombinedText: '',
    lastCombinedGradient: '',
    lastAppliedYellow: '',
    salesCount: null,
    salesDayKey: '',
    salesLoading: false,
    salesError: '',
    salesColorSettings: null,
    salesSettingsPanel: null,
    updatePending: false,
  };

  console.info('[Civitai Yellow Buzz] Script v1.3.1 loaded');

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

  function normalizeSalesColorSettings(value) {
    const defaults = DEFAULT_SALES_COLOR_SETTINGS;
    const lowMax = Number(value?.lowMax);
    const highMin = Number(value?.highMin);
    const isHexColor = (color) =>
      /^#[\da-f]{6}$/i.test(String(color || ''));

    return {
      lowMax: Number.isInteger(lowMax) && lowMax >= 0
        ? lowMax
        : defaults.lowMax,
      highMin: Number.isInteger(highMin) && highMin >= 0
        ? highMin
        : defaults.highMin,
      lowEnabled: value?.lowEnabled === true,
      lowColor: isHexColor(value?.lowColor)
        ? value.lowColor
        : defaults.lowColor,
      middleEnabled: value?.middleEnabled === true,
      middleColor: isHexColor(value?.middleColor)
        ? value.middleColor
        : defaults.middleColor,
      highEnabled: value?.highEnabled === true,
      highColor: isHexColor(value?.highColor)
        ? value.highColor
        : defaults.highColor,
    };
  }

  function loadSalesColorSettings() {
    if (state.salesColorSettings) return state.salesColorSettings;

    try {
      state.salesColorSettings = normalizeSalesColorSettings(
        JSON.parse(
          localStorage.getItem(SALES_COLOR_SETTINGS_KEY) || 'null'
        )
      );
    } catch {
      state.salesColorSettings = normalizeSalesColorSettings(null);
    }

    return state.salesColorSettings;
  }

  function saveSalesColorSettings(settings) {
    const normalized = normalizeSalesColorSettings(settings);
    state.salesColorSettings = normalized;

    try {
      localStorage.setItem(
        SALES_COLOR_SETTINGS_KEY,
        JSON.stringify(normalized)
      );
    } catch {
      // The setting still applies until this page is closed.
    }

    queueUpdate();
  }

  function getSalesCountColor(count) {
    const settings = loadSalesColorSettings();

    if (count <= settings.lowMax) {
      return settings.lowEnabled ? settings.lowColor : '';
    }

    if (count >= settings.highMin) {
      return settings.highEnabled ? settings.highColor : '';
    }

    return settings.middleEnabled ? settings.middleColor : '';
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
    text.style.setProperty('font-size', '0.9em', 'important');
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

  function closeSalesSettingsPanel() {
    state.salesSettingsPanel?.remove();
    state.salesSettingsPanel = null;
  }

  function styleSettingsButton(button, primary = false) {
    button.type = 'button';
    button.style.setProperty('border', '1px solid #5c5f66');
    button.style.setProperty('border-radius', '5px');
    button.style.setProperty('padding', '5px 9px');
    button.style.setProperty('cursor', 'pointer');
    button.style.setProperty('font-size', '12px');
    button.style.setProperty(
      'background',
      primary ? YELLOW_HEX : 'transparent'
    );
    button.style.setProperty('color', primary ? '#1a1b1e' : 'inherit');
  }

  function openSalesSettingsPanel(badge) {
    if (state.salesSettingsPanel) {
      closeSalesSettingsPanel();
      return;
    }

    const settings = loadSalesColorSettings();
    const panel = document.createElement('div');
    panel.dataset.tmSalesSettings = 'true';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Daily sales color settings');
    panel.style.setProperty('position', 'fixed');
    panel.style.setProperty('z-index', '2147483647');
    panel.style.setProperty('width', '300px');
    panel.style.setProperty('box-sizing', 'border-box');
    panel.style.setProperty('padding', '12px');
    panel.style.setProperty('border', '1px solid #5c5f66');
    panel.style.setProperty('border-radius', '8px');
    panel.style.setProperty(
      'background',
      'var(--mantine-color-body, #1a1b1e)'
    );
    panel.style.setProperty('color', 'var(--mantine-color-text, #f1f3f5)');
    panel.style.setProperty(
      'box-shadow',
      '0 8px 28px rgba(0, 0, 0, 0.35)'
    );
    panel.style.setProperty('font-family', 'inherit');
    panel.style.setProperty('-webkit-text-fill-color', 'currentColor');

    const heading = document.createElement('div');
    heading.textContent = 'Daily sales colors';
    heading.style.setProperty('font-size', '15px');
    heading.style.setProperty('font-weight', '700');
    heading.style.setProperty('margin-bottom', '3px');
    panel.appendChild(heading);

    const help = document.createElement('div');
    help.textContent = 'Unchecked ranges use Civitai\'s default text color.';
    help.style.setProperty('font-size', '11px');
    help.style.setProperty('opacity', '0.75');
    help.style.setProperty('margin-bottom', '10px');
    panel.appendChild(help);

    function createRow(labelText, enabled, color, threshold) {
      const row = document.createElement('label');
      row.style.setProperty('display', 'grid');
      row.style.setProperty(
        'grid-template-columns',
        threshold === null ? '20px 1fr 42px' : '20px 68px 1fr 42px'
      );
      row.style.setProperty('align-items', 'center');
      row.style.setProperty('gap', '6px');
      row.style.setProperty('margin', '7px 0');
      row.style.setProperty('font-size', '12px');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = enabled;
      checkbox.title = `Enable the ${labelText.toLowerCase()} color`;
      row.appendChild(checkbox);

      const label = document.createElement('span');
      label.textContent = labelText;
      row.appendChild(label);

      let number = null;
      if (threshold !== null) {
        number = document.createElement('input');
        number.type = 'number';
        number.min = '0';
        number.step = '1';
        number.value = String(threshold);
        number.style.setProperty('width', '100%');
        number.style.setProperty('box-sizing', 'border-box');
        number.style.setProperty('padding', '4px');
        number.style.setProperty('border', '1px solid #5c5f66');
        number.style.setProperty('border-radius', '4px');
        number.style.setProperty('background', 'transparent');
        number.style.setProperty('color', 'inherit');
        number.style.setProperty('-webkit-text-fill-color', 'currentColor');
        row.appendChild(number);
      }

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = color;
      picker.title = `${labelText} color`;
      picker.style.setProperty('width', '42px');
      picker.style.setProperty('height', '28px');
      picker.style.setProperty('padding', '1px');
      picker.style.setProperty('cursor', 'pointer');
      row.appendChild(picker);

      panel.appendChild(row);
      return { checkbox, number, picker };
    }

    const low = createRow(
      'Low ≤',
      settings.lowEnabled,
      settings.lowColor,
      settings.lowMax
    );
    const middle = createRow(
      'Middle',
      settings.middleEnabled,
      settings.middleColor,
      null
    );
    const high = createRow(
      'High ≥',
      settings.highEnabled,
      settings.highColor,
      settings.highMin
    );

    const error = document.createElement('div');
    error.style.setProperty('min-height', '15px');
    error.style.setProperty('font-size', '11px');
    error.style.setProperty('color', '#fa5252');
    error.style.setProperty('-webkit-text-fill-color', '#fa5252');
    panel.appendChild(error);

    const actions = document.createElement('div');
    actions.style.setProperty('display', 'flex');
    actions.style.setProperty('justify-content', 'flex-end');
    actions.style.setProperty('gap', '6px');

    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    styleSettingsButton(reset);
    reset.addEventListener('click', () => {
      saveSalesColorSettings(DEFAULT_SALES_COLOR_SETTINGS);
      closeSalesSettingsPanel();
    });

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    styleSettingsButton(cancel);
    cancel.addEventListener('click', closeSalesSettingsPanel);

    const save = document.createElement('button');
    save.textContent = 'Save';
    styleSettingsButton(save, true);
    save.addEventListener('click', () => {
      const lowMax = Number(low.number.value);
      const highMin = Number(high.number.value);

      if (
        !Number.isInteger(lowMax) ||
        lowMax < 0 ||
        !Number.isInteger(highMin) ||
        highMin <= lowMax
      ) {
        error.textContent = 'High must be a whole number greater than Low.';
        return;
      }

      saveSalesColorSettings({
        lowMax,
        highMin,
        lowEnabled: low.checkbox.checked,
        lowColor: low.picker.value,
        middleEnabled: middle.checkbox.checked,
        middleColor: middle.picker.value,
        highEnabled: high.checkbox.checked,
        highColor: high.picker.value,
      });
      closeSalesSettingsPanel();
    });

    actions.append(reset, cancel, save);
    panel.appendChild(actions);
    panel.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(panel);
    state.salesSettingsPanel = panel;

    const badgeRect = badge.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - panelRect.width - 8,
        badgeRect.right - panelRect.width
      )
    );
    let top = badgeRect.bottom + 8;

    if (top + panelRect.height > window.innerHeight - 8) {
      top = Math.max(8, badgeRect.top - panelRect.height - 8);
    }

    panel.style.setProperty('left', `${left}px`);
    panel.style.setProperty('top', `${top}px`);
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
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.style.setProperty('display', 'inline-flex', 'important');
      badge.style.setProperty('flex-direction', 'row', 'important');
      badge.style.setProperty('align-items', 'center', 'important');
      badge.style.setProperty('justify-content', 'center', 'important');
      badge.style.setProperty('margin-left', '6px', 'important');
      badge.style.setProperty('min-width', '46px', 'important');
      badge.style.setProperty('font-weight', '600', 'important');
      badge.style.setProperty('line-height', '1', 'important');
      badge.style.setProperty('white-space', 'nowrap', 'important');
      badge.style.setProperty('background', 'none', 'important');
      badge.style.setProperty('cursor', 'pointer', 'important');
      badge.style.setProperty('user-select', 'none', 'important');

      const number = document.createElement('span');
      number.dataset.tmSalesNumber = 'true';
      number.style.setProperty('font-size', '1em', 'important');
      number.style.setProperty('font-weight', '700', 'important');
      number.style.setProperty('margin-right', '5px', 'important');

      const label = document.createElement('span');
      label.dataset.tmSalesLabel = 'true';
      label.style.setProperty('display', 'inline-flex', 'important');
      label.style.setProperty('flex-direction', 'column', 'important');
      label.style.setProperty('align-items', 'flex-start', 'important');
      label.style.setProperty('font-size', '0.58em', 'important');
      label.style.setProperty('font-weight', '600', 'important');
      label.style.setProperty('line-height', '0.95', 'important');

      const dailyLabel = document.createElement('span');
      dailyLabel.textContent = 'daily';

      const salesLabel = document.createElement('span');
      salesLabel.textContent = 'sales';

      label.append(dailyLabel, salesLabel);

      badge.append(number, label);
      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openSalesSettingsPanel(badge);
      });
      badge.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        openSalesSettingsPanel(badge);
      });
      root.appendChild(badge);
    }

    const number = badge.querySelector('[data-tm-sales-number="true"]');

    if (hasCurrentCount) {
      const color = getSalesCountColor(state.salesCount);
      const countText = String(state.salesCount);
      if (number.textContent !== countText) number.textContent = countText;
      badge.title = `${state.salesCount} paid-model sales since 00:00 UTC. Click to configure colors.`;
      badge.style.setProperty(
        'display',
        'inline-flex',
        'important'
      );
      badge.style.setProperty(
        'color',
        color || 'var(--mantine-color-text)',
        'important'
      );
      badge.style.setProperty(
        '-webkit-text-fill-color',
        color || 'var(--mantine-color-text)',
        'important'
      );
    } else if (state.salesLoading) {
      if (number.textContent !== '…') number.textContent = '…';
      badge.title = 'Loading paid-model sales since 00:00 UTC';
      badge.style.setProperty('display', 'inline-flex', 'important');
      badge.style.setProperty(
        'color',
        'var(--mantine-color-text)',
        'important'
      );
      badge.style.setProperty(
        '-webkit-text-fill-color',
        'var(--mantine-color-text)',
        'important'
      );
    } else {
      if (number.textContent) number.textContent = '';
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
      if (event.key === SALES_COLOR_SETTINGS_KEY) {
        state.salesColorSettings = null;
        loadSalesColorSettings();
        queueUpdate();
        return;
      }

      if (event.key !== SALES_CACHE_KEY) return;

      const bounds = getUtcDayBounds();
      applySalesCache(loadSalesCache(bounds.dayKey));
    });

    document.addEventListener('click', (event) => {
      const panel = state.salesSettingsPanel;
      if (!panel) return;
      if (panel.contains(event.target)) return;
      if (event.target?.closest?.('[data-tm-sales-today="true"]')) return;
      closeSalesSettingsPanel();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSalesSettingsPanel();
    });

    window.addEventListener('resize', closeSalesSettingsPanel);

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
