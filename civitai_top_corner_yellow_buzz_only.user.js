// ==UserScript==
// @name         Civitai - Show Yellow + Green Buzz and Sales
// @namespace    https://civitai.com/
// @version      1.7.1
// @description  Shows combined Yellow and Green Buzz with configurable sales counts and a clickable sold-model list in Civitai's top-right account button.
// @match        https://civitai.com/*
// @match        https://civitai.green/*
// @match        https://civitai.red/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const YELLOW_HEX = '#f59f00';
  const YELLOW_RGB = 'rgb(245, 159, 0)';
  const GREEN_RGB = 'rgb(64, 192, 87)';
  const BUZZ_DASHBOARD_URL = 'https://civitai.red/user/buzz-dashboard';
  const BUZZ_ACCOUNT_PATH = '/api/trpc/buzz.getBuzzAccount';
  const EXACT_BUZZ_CACHE_KEY = 'civitai-yellow-green-buzz-exact-v1';
  const EXACT_BUZZ_REFRESH_MS = 60 * 1000;
  const UI_REPAIR_MS = 60 * 1000;
  const SALES_CACHE_KEY = 'civitai-yellow-green-buzz-sales-v1';
  const SALES_MODEL_METADATA_CACHE_KEY =
    'civitai-yellow-green-buzz-sale-model-metadata-v1';
  const SALES_MODEL_METADATA_CACHE_LIMIT = 2000;
  const SALES_LOCK_KEY = `${SALES_CACHE_KEY}-lock`;
  const SALES_PERIOD_KEY = 'civitai-yellow-buzz-sales-period-v1';
  const SALES_COLOR_SETTINGS_KEY =
    'civitai-yellow-buzz-sales-color-settings-v1';
  const SALES_REFRESH_MS = 2 * 60 * 1000;
  const SALES_LOCK_MS = 30 * 1000;
  const SALES_PAGE_SIZE = 200;
  const PURCHASE_TRANSACTION_TYPE = 6;
  const SALES_SINGLE_CLICK_DELAY_MS = 350;
  const SALES_LONG_PRESS_MS = 550;
  const SALES_PERIODS = Object.freeze({
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
  });
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
    exactYellowValue: null,
    exactGreenValue: null,
    exactCombinedValue: null,
    exactCombinedText: '',
    exactBuzzLoading: false,
    salesCount: null,
    salesByColor: null,
    salesModels: null,
    salesPeriod: 'daily',
    salesPeriodKey: '',
    salesLoading: false,
    salesError: '',
    salesColorSettings: null,
    salesSettingsPanel: null,
    salesTooltip: null,
    salesTooltipCloseTimer: null,
    updatePending: false,
  };

  console.info('[Civitai Buzz] Script v1.7.1 loaded');

  function getUtcSalesBounds(period = state.salesPeriod, now = new Date()) {
    let start = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));

    if (period === 'weekly') {
      const daysSinceMonday = (start.getUTCDay() + 6) % 7;
      start = new Date(start.getTime() - daysSinceMonday * 86400000);
    } else if (period === 'monthly') {
      start = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        1
      ));
    }

    const end = period === 'daily'
      ? new Date(start.getTime() + 86400000)
      : period === 'weekly'
        ? new Date(start.getTime() + 7 * 86400000)
        : new Date(Date.UTC(
          start.getUTCFullYear(),
          start.getUTCMonth() + 1,
          1
        ));

    return {
      period,
      periodKey: `${period}:${start.toISOString().slice(0, 10)}`,
      start,
      end,
    };
  }

  function normalizeSalesPeriod(period) {
    return Object.prototype.hasOwnProperty.call(SALES_PERIODS, period)
      ? period
      : 'daily';
  }

  function loadSalesPeriod() {
    try {
      return normalizeSalesPeriod(localStorage.getItem(SALES_PERIOD_KEY));
    } catch {
      return 'daily';
    }
  }

  function saveSalesPeriod(period) {
    const normalized = normalizeSalesPeriod(period);
    if (state.salesPeriod === normalized) return;

    state.salesPeriod = normalized;
    state.salesCount = null;
    state.salesByColor = null;
    state.salesModels = null;
    state.salesPeriodKey = '';
    state.salesError = '';

    try {
      localStorage.setItem(SALES_PERIOD_KEY, normalized);
    } catch {
      // The setting still applies until this page is closed.
    }

    queueUpdate();
    refreshSalesIfNeeded();
  }

  function cycleSalesPeriod() {
    const periods = Object.keys(SALES_PERIODS);
    const currentIndex = periods.indexOf(state.salesPeriod);
    const nextPeriod = periods[(currentIndex + 1) % periods.length];

    closeSalesTooltip();
    closeSalesSettingsPanel();
    saveSalesPeriod(nextPeriod);
  }

  function readSalesCacheStore() {
    try {
      const store = JSON.parse(
        localStorage.getItem(SALES_CACHE_KEY) || 'null'
      );

      if (store?.entries && typeof store.entries === 'object') return store;
    } catch {
      // Ignore an invalid or unavailable cache.
    }

    return { entries: {} };
  }

  function loadSalesCache(period, periodKey) {
    const cached = readSalesCacheStore().entries[period];
    const valid = cached &&
      cached.periodKey === periodKey &&
      Number.isInteger(cached.count) &&
      cached.count >= 0 &&
      Number.isInteger(cached.byColor?.yellow) &&
      cached.byColor.yellow >= 0 &&
      Number.isInteger(cached.byColor?.green) &&
      cached.byColor.green >= 0 &&
      cached.count === cached.byColor.yellow + cached.byColor.green &&
      Number.isFinite(cached.savedAt);

    if (!valid) return null;

    const models = cached.modelListVersion === 2 && Array.isArray(cached.models)
      ? cached.models.filter((model) =>
        model &&
        typeof model.name === 'string' &&
        typeof model.href === 'string' &&
        Number.isInteger(model.count) &&
        model.count > 0 &&
        Number.isFinite(model.firstSoldAt)
      )
      : null;

    return { ...cached, models };
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

  function normalizeSalesColorSettingsStore(value) {
    const hasPeriodSettings = Object.keys(SALES_PERIODS).some(
      (period) => value?.[period] && typeof value[period] === 'object'
    );

    if (hasPeriodSettings) {
      return Object.fromEntries(
        Object.keys(SALES_PERIODS).map((period) => [
          period,
          normalizeSalesColorSettings(value?.[period]),
        ])
      );
    }

    // Preserve the previous single configuration as the Daily settings.
    return {
      daily: normalizeSalesColorSettings(value),
      weekly: normalizeSalesColorSettings(null),
      monthly: normalizeSalesColorSettings(null),
    };
  }

  function loadSalesColorSettings() {
    if (state.salesColorSettings) return state.salesColorSettings;

    try {
      state.salesColorSettings = normalizeSalesColorSettingsStore(
        JSON.parse(
          localStorage.getItem(SALES_COLOR_SETTINGS_KEY) || 'null'
        )
      );
    } catch {
      state.salesColorSettings = normalizeSalesColorSettingsStore(null);
    }

    return state.salesColorSettings;
  }

  function saveSalesColorSettings(period, settings) {
    const normalized = normalizeSalesColorSettings(settings);
    const store = {
      ...loadSalesColorSettings(),
      [normalizeSalesPeriod(period)]: normalized,
    };
    state.salesColorSettings = store;

    try {
      localStorage.setItem(
        SALES_COLOR_SETTINGS_KEY,
        JSON.stringify(store)
      );
    } catch {
      // The setting still applies until this page is closed.
    }

    queueUpdate();
  }

  function getSalesCountColor(count) {
    const settings = loadSalesColorSettings()[state.salesPeriod];

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

    const changed =
      state.salesCount !== cached.count ||
      state.salesByColor?.yellow !== cached.byColor.yellow ||
      state.salesByColor?.green !== cached.byColor.green ||
      JSON.stringify(state.salesModels) !== JSON.stringify(cached.models) ||
      state.salesPeriodKey !== cached.periodKey ||
      state.salesError !== '';

    state.salesCount = cached.count;
    state.salesByColor = { ...cached.byColor };
    state.salesModels = cached.models;
    state.salesPeriodKey = cached.periodKey;
    state.salesError = '';
    if (changed) {
      closeSalesTooltip();
      queueUpdate();
    }
  }

  function saveSalesCache(period, periodKey, sales) {
    const cached = {
      period,
      periodKey,
      count: sales.byColor.yellow + sales.byColor.green,
      byColor: sales.byColor,
      models: sales.models,
      modelListVersion: 2,
      savedAt: Date.now(),
    };

    try {
      const store = readSalesCacheStore();
      store.entries[period] = cached;
      localStorage.setItem(SALES_CACHE_KEY, JSON.stringify(store));
    } catch {
      // Continue without cross-tab caching.
    }

    if (period === state.salesPeriod) applySalesCache(cached);
  }

  function acquireSalesRefreshLock(periodKey) {
    const token = `${Date.now()}-${Math.random()}`;
    const lockKey = `${SALES_LOCK_KEY}:${periodKey}`;

    try {
      const existing = JSON.parse(
        localStorage.getItem(lockKey) || 'null'
      );

      if (existing?.expiresAt > Date.now()) return null;

      localStorage.setItem(
        lockKey,
        JSON.stringify({
          token,
          expiresAt: Date.now() + SALES_LOCK_MS,
        })
      );

      const saved = JSON.parse(
        localStorage.getItem(lockKey) || 'null'
      );

      return saved?.token === token ? { lockKey, token } : null;
    } catch {
      // localStorage can be disabled; an in-tab loading flag still prevents
      // duplicate requests in this tab.
      return { lockKey, token };
    }
  }

  function releaseSalesRefreshLock(lock) {
    try {
      const saved = JSON.parse(
        localStorage.getItem(lock.lockKey) || 'null'
      );

      if (saved?.token === lock.token) {
        localStorage.removeItem(lock.lockKey);
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

  function getSaleBuzzType(transaction) {
    const buzzType = String(transaction?.toAccountType || '').toLowerCase();
    return buzzType === 'yellow' || buzzType === 'green'
      ? buzzType
      : null;
  }

  function getSaleModelVersionId(transaction) {
    const detailsId = Number(transaction?.details?.modelVersionId);
    if (Number.isInteger(detailsId) && detailsId > 0) return detailsId;

    const match = String(transaction?.externalTransactionId || '').match(
      /^(?:early-access|permanent-access)-(\d+)-/i
    );
    const externalId = Number(match?.[1]);
    return Number.isInteger(externalId) && externalId > 0
      ? externalId
      : null;
  }

  function getSaleDisplayName(transaction) {
    const description = String(transaction?.description || '').trim();
    return description.replace(
      /^Gain (?:early )?access (?:to|on) model\s*:\s*/i,
      ''
    ) || 'Sold model';
  }

  function getSaleTimestamp(transaction) {
    const timestamp = new Date(transaction?.date).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function readSaleModelMetadataCache() {
    try {
      const cache = JSON.parse(
        localStorage.getItem(SALES_MODEL_METADATA_CACHE_KEY) || 'null'
      );
      if (cache?.entries && typeof cache.entries === 'object') return cache;
    } catch {
      // Continue with the metadata embedded in the period caches.
    }

    return { entries: {} };
  }

  function saveSaleModelMetadata(models) {
    if (!models.length) return;

    try {
      const cache = readSaleModelMetadataCache();
      const savedAt = Date.now();

      for (const model of models) {
        cache.entries[model.modelVersionId] = {
          modelVersionId: model.modelVersionId,
          name: model.name,
          href: model.href,
          savedAt,
        };
      }

      const entries = Object.entries(cache.entries)
        .sort((left, right) =>
          Number(right[1]?.savedAt || 0) - Number(left[1]?.savedAt || 0)
        )
        .slice(0, SALES_MODEL_METADATA_CACHE_LIMIT);
      cache.entries = Object.fromEntries(entries);
      localStorage.setItem(
        SALES_MODEL_METADATA_CACHE_KEY,
        JSON.stringify(cache)
      );
    } catch {
      // The current sales result still contains the resolved model links.
    }
  }

  function getKnownSaleModels() {
    const known = new Map();

    for (const model of Object.values(readSaleModelMetadataCache().entries)) {
      if (
        Number.isInteger(model?.modelVersionId) &&
        /^\/models\/\d+\?modelVersionId=\d+$/.test(model.href)
      ) {
        known.set(model.modelVersionId, model);
      }
    }

    for (const cached of Object.values(readSalesCacheStore().entries)) {
      if (!Array.isArray(cached?.models)) continue;

      for (const model of cached.models) {
        if (
          Number.isInteger(model?.modelVersionId) &&
          /^\/models\/\d+\?modelVersionId=\d+$/.test(model.href) &&
          !known.has(model.modelVersionId)
        ) {
          known.set(model.modelVersionId, model);
        }
      }
    }

    return known;
  }

  async function fetchSaleModelMetadata(modelVersionId) {
    const response = await fetch(
      `/api/v1/model-versions/${encodeURIComponent(modelVersionId)}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) return null;

    const version = await response.json().catch(() => null);
    const modelId = Number(version?.modelId);
    if (!Number.isInteger(modelId) || modelId <= 0) return null;

    const modelName = String(version?.model?.name || '').trim();
    const versionName = String(version?.name || '').trim();
    const name = modelName && versionName
      ? `${modelName} — ${versionName}`
      : modelName || versionName || `Model version ${modelVersionId}`;

    return {
      modelVersionId,
      name,
      href: `/models/${encodeURIComponent(modelId)}?modelVersionId=` +
        encodeURIComponent(modelVersionId),
    };
  }

  async function hydrateSaleModels(groups) {
    const known = getKnownSaleModels();
    const metadata = new Map();
    const missingIds = groups
      .map((group) => group.modelVersionId)
      .filter((id) => Number.isInteger(id) && !known.has(id));

    // Avoid sending a large monthly list to the public API all at once.
    for (let index = 0; index < missingIds.length; index += 8) {
      const results = await Promise.all(
        missingIds.slice(index, index + 8).map(async (id) => {
          try {
            return await fetchSaleModelMetadata(id);
          } catch {
            return null;
          }
        })
      );

      for (const result of results) {
        if (result) metadata.set(result.modelVersionId, result);
      }
    }

    saveSaleModelMetadata(
      groups.map((group) =>
        known.get(group.modelVersionId) || metadata.get(group.modelVersionId)
      ).filter(Boolean)
    );

    return groups.map((group) => {
      const resolved = known.get(group.modelVersionId) ||
        metadata.get(group.modelVersionId);
      const fallbackHref = '/models?query=' + encodeURIComponent(group.name);

      return {
        modelVersionId: group.modelVersionId,
        name: resolved?.name || group.name,
        href: resolved?.href || fallbackHref,
        count: group.count,
        firstSoldAt: group.firstSoldAt,
      };
    }).sort((left, right) =>
      right.firstSoldAt - left.firstSoldAt ||
      left.name.localeCompare(right.name)
    );
  }

  async function fetchSales(bounds) {
    const saleIds = {
      yellow: new Set(),
      green: new Set(),
    };
    const salesByModel = new Map();
    const seenCursors = new Set();
    let cursor;

    do {
      const page = await fetchTransactionPage({
        start: bounds.start,
        end: bounds.end,
        accountTypes: ['yellow', 'green'],
        type: PURCHASE_TRANSACTION_TYPE,
        limit: SALES_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });

      for (const transaction of page.transactions) {
        if (!isPaidModelSale(transaction)) continue;

        const buzzType = getSaleBuzzType(transaction);
        if (!buzzType) continue;

        const saleIdentity = getSaleIdentity(transaction);
        if (saleIds[buzzType].has(saleIdentity)) continue;

        saleIds[buzzType].add(saleIdentity);
        const modelVersionId = getSaleModelVersionId(transaction);
        const name = getSaleDisplayName(transaction);
        const soldAt = getSaleTimestamp(transaction);
        const key = modelVersionId ? `version:${modelVersionId}` : `name:${name}`;
        const group = salesByModel.get(key) || {
          modelVersionId,
          name,
          count: 0,
          firstSoldAt: soldAt,
        };
        group.count += 1;
        if (
          soldAt > 0 &&
          (group.firstSoldAt <= 0 || soldAt < group.firstSoldAt)
        ) {
          group.firstSoldAt = soldAt;
        }
        salesByModel.set(key, group);
      }

      const nextCursor = page.cursor ? String(page.cursor) : '';
      if (!nextCursor || seenCursors.has(nextCursor)) break;

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return {
      byColor: {
        yellow: saleIds.yellow.size,
        green: saleIds.green.size,
      },
      models: await hydrateSaleModels([...salesByModel.values()]),
    };
  }

  async function refreshSalesIfNeeded(force = false) {
    if (state.salesLoading) return;

    const bounds = getUtcSalesBounds();
    const cached = loadSalesCache(bounds.period, bounds.periodKey);

    if (cached) applySalesCache(cached);

    if (
      !force &&
      cached &&
      Array.isArray(cached.models) &&
      Date.now() - cached.savedAt < SALES_REFRESH_MS
    ) {
      return;
    }

    const lock = acquireSalesRefreshLock(bounds.periodKey);
    if (!lock) return;

    state.salesLoading = true;
    state.salesError = '';
    queueUpdate();

    try {
      const sales = await fetchSales(bounds);
      saveSalesCache(bounds.period, bounds.periodKey, sales);
    } catch (error) {
      if (bounds.period === state.salesPeriod) {
        state.salesError = error?.message || String(error);
      }
      console.warn(
        `[Civitai Buzz] Could not update ${bounds.period} sales:`,
        error
      );
    } finally {
      state.salesLoading = false;
      releaseSalesRefreshLock(lock);
      queueUpdate();
      if (bounds.period !== state.salesPeriod) refreshSalesIfNeeded();
    }
  }

  function formatBuzzBalance(value) {
    if (!Number.isFinite(value)) return null;

    // Keep a decimal dot and exactly one decimal place for million values.
    if (Math.abs(value) >= 1e6 && Math.abs(value) < 1e9) {
      return `${(value / 1e6).toFixed(1)}M`;
    }

    return valueToCompactNumber(value);
  }

  function applyExactBuzzCache(cached) {
    if (
      !cached ||
      !Number.isFinite(cached.yellow) ||
      cached.yellow < 0 ||
      !Number.isFinite(cached.green) ||
      cached.green < 0
    ) {
      return;
    }

    const combined = cached.yellow + cached.green;
    const formatted = formatBuzzBalance(combined);
    const changed =
      state.exactYellowValue !== cached.yellow ||
      state.exactGreenValue !== cached.green ||
      state.exactCombinedText !== formatted;

    state.exactYellowValue = cached.yellow;
    state.exactGreenValue = cached.green;
    state.exactCombinedValue = combined;
    state.exactCombinedText = formatted;
    if (changed) queueUpdate();
  }

  function loadExactBuzzCache() {
    try {
      const cached = JSON.parse(
        localStorage.getItem(EXACT_BUZZ_CACHE_KEY) || 'null'
      );

      if (
        cached &&
        Number.isFinite(cached.yellow) &&
        cached.yellow >= 0 &&
        Number.isFinite(cached.green) &&
        cached.green >= 0 &&
        Number.isFinite(cached.savedAt)
      ) {
        return cached;
      }
    } catch {
      // Continue without a cached exact balance.
    }

    return null;
  }

  function saveExactBuzzCache(balances) {
    const cached = { ...balances, savedAt: Date.now() };

    try {
      localStorage.setItem(EXACT_BUZZ_CACHE_KEY, JSON.stringify(cached));
    } catch {
      // The fetched balance still applies until this page is closed.
    }

    applyExactBuzzCache(cached);
  }

  async function fetchExactBuzzBalances() {
    const input = encodeURIComponent(JSON.stringify({
      json: { authed: true },
    }));
    const response = await fetch(
      `${BUZZ_ACCOUNT_PATH}?input=${input}`,
      {
        credentials: 'same-origin',
        headers: {
          'x-client': 'web',
          'x-client-date': String(Date.now()),
        },
      }
    );
    const body = await response.json().catch(() => null);

    if (!response.ok || body?.error) {
      const message =
        body?.error?.json?.message ||
        body?.error?.message ||
        `Buzz account request failed (${response.status})`;
      throw new Error(message);
    }

    const yellow = body?.result?.data?.json?.yellow;
    const green = body?.result?.data?.json?.green;
    if (
      !Number.isFinite(yellow) ||
      yellow < 0 ||
      !Number.isFinite(green) ||
      green < 0
    ) {
      throw new Error('Civitai returned an unexpected Buzz account response');
    }

    return { yellow, green };
  }

  async function refreshExactBuzzIfNeeded(force = false) {
    if (state.exactBuzzLoading) return;

    const cached = loadExactBuzzCache();
    if (
      cached &&
      (
        !Number.isFinite(state.exactYellowValue) ||
        !Number.isFinite(state.exactGreenValue)
      )
    ) {
      applyExactBuzzCache(cached);
    }

    if (
      !force &&
      cached &&
      Date.now() - cached.savedAt < EXACT_BUZZ_REFRESH_MS
    ) {
      return;
    }

    state.exactBuzzLoading = true;

    try {
      saveExactBuzzCache(await fetchExactBuzzBalances());
    } catch (error) {
      console.warn(
        '[Civitai Buzz] Could not update exact Buzz balances:',
        error
      );
    } finally {
      state.exactBuzzLoading = false;
    }
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

  function setImportantStyle(element, property, value) {
    const currentValue = element.style.getPropertyValue(property);
    const valueMatches =
      currentValue === value ||
      (value === YELLOW_HEX && currentValue === YELLOW_RGB);

    if (
      valueMatches &&
      element.style.getPropertyPriority(property) === 'important'
    ) {
      return;
    }

    element.style.setProperty(property, value, 'important');
  }

  function setAttributeIfChanged(element, attribute, value) {
    if (element.getAttribute(attribute) === value) return;
    element.setAttribute(attribute, value);
  }

  function getCombinedBuzzGradient() {
    const total = state.exactCombinedValue;
    const yellowPercentage = total > 0
      ? Math.max(0, Math.min(100, state.exactYellowValue / total * 100))
      : 50;

    return `linear-gradient(90deg, ${YELLOW_RGB} 0%, ` +
      `${YELLOW_RGB} ${yellowPercentage}%, ` +
      `${GREEN_RGB} ${yellowPercentage}%, ${GREEN_RGB} 100%)`;
  }

  function forceCombinedBuzzAppearance(root, text) {
    const gradient = getCombinedBuzzGradient();

    if (root.dataset.tmCombinedBuzz !== 'true') {
      root.dataset.tmCombinedBuzz = 'true';
    }
    if (text.dataset.tmCombinedBuzz !== 'true') {
      text.dataset.tmCombinedBuzz = 'true';
    }

    // Keep the icon solid Yellow; only the number represents both balances.
    setImportantStyle(root, '--buzz-gradient', YELLOW_HEX);
    setImportantStyle(root, 'color', YELLOW_HEX);
    setImportantStyle(root, '-webkit-text-fill-color', YELLOW_HEX);

    setImportantStyle(text, '--buzz-gradient', gradient);
    setImportantStyle(text, 'background-image', gradient);
    setImportantStyle(text, 'background-clip', 'text');
    setImportantStyle(text, '-webkit-background-clip', 'text');
    setImportantStyle(text, 'color', 'transparent');
    setImportantStyle(text, 'font-size', '0.9em');
    setImportantStyle(text, '-webkit-text-fill-color', 'transparent');
    setImportantStyle(text, 'cursor', 'pointer');

    for (const svg of root.querySelectorAll('svg')) {
      setAttributeIfChanged(svg, 'stroke', YELLOW_HEX);
      setAttributeIfChanged(svg, 'fill', YELLOW_HEX);
      setImportantStyle(svg, 'stroke', YELLOW_HEX);
      setImportantStyle(svg, 'fill', YELLOW_HEX);

      for (const stop of svg.querySelectorAll('stop')) {
        setAttributeIfChanged(stop, 'stop-color', YELLOW_HEX);
        setImportantStyle(stop, 'stop-color', YELLOW_HEX);
      }

      for (const path of svg.querySelectorAll('path')) {
        setAttributeIfChanged(path, 'stroke', YELLOW_HEX);
        setAttributeIfChanged(path, 'fill', YELLOW_HEX);
        setImportantStyle(path, 'stroke', YELLOW_HEX);
        setImportantStyle(path, 'fill', YELLOW_HEX);
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
    closeSalesTooltip();

    if (state.salesSettingsPanel) {
      closeSalesSettingsPanel();
      return;
    }

    const settingsStore = loadSalesColorSettings();
    const settings = settingsStore[state.salesPeriod];
    const panel = document.createElement('div');
    panel.dataset.tmSalesSettings = 'true';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Sales view and color settings');
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
    heading.textContent = 'Sales settings';
    heading.style.setProperty('font-size', '15px');
    heading.style.setProperty('font-weight', '700');
    heading.style.setProperty('margin-bottom', '3px');
    panel.appendChild(heading);

    const help = document.createElement('div');
    help.textContent =
      'Each period has separate thresholds and colors. Unchecked ranges ' +
      'use Civitai\'s default text color.';
    help.style.setProperty('font-size', '11px');
    help.style.setProperty('opacity', '0.75');
    help.style.setProperty('margin-bottom', '10px');
    panel.appendChild(help);

    const periodRow = document.createElement('label');
    periodRow.style.setProperty('display', 'flex');
    periodRow.style.setProperty('align-items', 'center');
    periodRow.style.setProperty('justify-content', 'space-between');
    periodRow.style.setProperty('gap', '10px');
    periodRow.style.setProperty('margin-bottom', '10px');
    periodRow.style.setProperty('font-size', '12px');

    const periodLabel = document.createElement('span');
    periodLabel.textContent = 'Sales period';

    const periodSelect = document.createElement('select');
    periodSelect.setAttribute('aria-label', 'Sales period');
    periodSelect.style.setProperty('width', '130px');
    periodSelect.style.setProperty('padding', '4px');
    periodSelect.style.setProperty('border', '1px solid #5c5f66');
    periodSelect.style.setProperty('border-radius', '4px');
    periodSelect.style.setProperty(
      'background',
      'var(--mantine-color-body, #1a1b1e)'
    );
    periodSelect.style.setProperty('color', 'inherit');
    periodSelect.style.setProperty('-webkit-text-fill-color', 'currentColor');

    for (const [value, label] of Object.entries(SALES_PERIODS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === state.salesPeriod;
      periodSelect.appendChild(option);
    }

    periodRow.append(periodLabel, periodSelect);
    panel.appendChild(periodRow);

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

    function applySettingsToControls(period) {
      const periodSettings = settingsStore[normalizeSalesPeriod(period)];
      low.number.value = String(periodSettings.lowMax);
      low.checkbox.checked = periodSettings.lowEnabled;
      low.picker.value = periodSettings.lowColor;
      middle.checkbox.checked = periodSettings.middleEnabled;
      middle.picker.value = periodSettings.middleColor;
      high.number.value = String(periodSettings.highMin);
      high.checkbox.checked = periodSettings.highEnabled;
      high.picker.value = periodSettings.highColor;
    }

    periodSelect.addEventListener('change', () => {
      applySettingsToControls(periodSelect.value);
    });

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
      saveSalesColorSettings(
        periodSelect.value,
        DEFAULT_SALES_COLOR_SETTINGS
      );
      saveSalesPeriod(periodSelect.value);
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

      saveSalesColorSettings(
        periodSelect.value,
        {
          lowMax,
          highMin,
          lowEnabled: low.checkbox.checked,
          lowColor: low.picker.value,
          middleEnabled: middle.checkbox.checked,
          middleColor: middle.picker.value,
          highEnabled: high.checkbox.checked,
          highColor: high.picker.value,
        }
      );
      saveSalesPeriod(periodSelect.value);
      closeSalesSettingsPanel();
    });

    actions.append(reset, cancel, save);
    panel.appendChild(actions);
    panel.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(panel);
    state.salesSettingsPanel = panel;

    const panelRect = panel.getBoundingClientRect();
    let left;
    let top;

    if (badge?.isConnected) {
      const badgeRect = badge.getBoundingClientRect();
      left = Math.max(
        8,
        Math.min(
          window.innerWidth - panelRect.width - 8,
          badgeRect.right - panelRect.width
        )
      );
      top = badgeRect.bottom + 8;

      if (top + panelRect.height > window.innerHeight - 8) {
        top = Math.max(8, badgeRect.top - panelRect.height - 8);
      }
    } else {
      left = Math.max(8, (window.innerWidth - panelRect.width) / 2);
      top = Math.max(8, (window.innerHeight - panelRect.height) / 3);
    }

    panel.style.setProperty('left', `${left}px`);
    panel.style.setProperty('top', `${top}px`);
  }

  function clearSalesTooltipCloseTimer() {
    if (state.salesTooltipCloseTimer === null) return;
    clearTimeout(state.salesTooltipCloseTimer);
    state.salesTooltipCloseTimer = null;
  }

  function closeSalesTooltip() {
    clearSalesTooltipCloseTimer();
    const tooltip = state.salesTooltip;
    if (!tooltip) return;

    const badgeId = tooltip.dataset.tmSalesBadgeId;
    if (badgeId) {
      document.getElementById(badgeId)?.removeAttribute('aria-controls');
    }
    tooltip.remove();
    state.salesTooltip = null;
  }

  function scheduleSalesTooltipClose() {
    clearSalesTooltipCloseTimer();
    state.salesTooltipCloseTimer = setTimeout(() => {
      state.salesTooltipCloseTimer = null;
      closeSalesTooltip();
    }, 180);
  }

  function openSalesTooltip(badge) {
    clearSalesTooltipCloseTimer();
    if (state.salesSettingsPanel || !badge?.isConnected) return;

    const bounds = getUtcSalesBounds();
    const hasCurrentModels =
      state.salesPeriodKey === bounds.periodKey &&
      Array.isArray(state.salesModels);
    if (!hasCurrentModels) return;

    if (state.salesTooltip?.isConnected) return;
    closeSalesTooltip();

    if (!badge.id) {
      badge.id = 'tm-civitai-sales-badge';
    }

    const tooltip = document.createElement('div');
    tooltip.id = 'tm-civitai-sales-tooltip';
    tooltip.dataset.tmSalesTooltip = 'true';
    tooltip.dataset.tmSalesBadgeId = badge.id;
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-label', 'Sold models');
    tooltip.style.setProperty('position', 'fixed');
    tooltip.style.setProperty('z-index', '2147483647');
    tooltip.style.setProperty('width', 'min(360px, calc(100vw - 16px))');
    tooltip.style.setProperty('box-sizing', 'border-box');
    tooltip.style.setProperty('padding', '10px');
    tooltip.style.setProperty('border', '1px solid #5c5f66');
    tooltip.style.setProperty('border-radius', '8px');
    tooltip.style.setProperty(
      'background',
      'var(--mantine-color-body, #1a1b1e)'
    );
    tooltip.style.setProperty('color', 'var(--mantine-color-text, #f1f3f5)');
    tooltip.style.setProperty('-webkit-text-fill-color', 'currentColor');
    tooltip.style.setProperty('box-shadow', '0 8px 28px rgba(0, 0, 0, 0.4)');
    tooltip.style.setProperty('font-family', 'inherit');
    tooltip.style.setProperty('text-align', 'left');

    const heading = document.createElement('div');
    heading.textContent = `${SALES_PERIODS[state.salesPeriod]} sold models`;
    heading.style.setProperty('font-size', '13px');
    heading.style.setProperty('font-weight', '700');
    heading.style.setProperty('margin-bottom', '3px');

    const summary = document.createElement('div');
    summary.textContent =
      `${state.salesCount} sales · ` +
      `${state.salesByColor?.yellow ?? 0} yellow · ` +
      `${state.salesByColor?.green ?? 0} green`;
    summary.style.setProperty('font-size', '11px');
    summary.style.setProperty('opacity', '0.72');
    summary.style.setProperty('margin-bottom', state.salesModels.length ? '8px' : '0');

    tooltip.append(heading, summary);

    if (state.salesModels.length) {
      const list = document.createElement('div');
      list.style.setProperty('display', 'flex');
      list.style.setProperty('flex-direction', 'column');
      list.style.setProperty('gap', '3px');
      list.style.setProperty('max-height', 'min(420px, 60vh)');
      list.style.setProperty('overflow-y', 'auto');

      for (const model of state.salesModels) {
        const row = document.createElement('div');
        row.style.setProperty('display', 'grid');
        row.style.setProperty('grid-template-columns', '34px minmax(0, 1fr)');
        row.style.setProperty('align-items', 'start');
        row.style.setProperty('gap', '7px');
        row.style.setProperty('padding', '4px 5px');
        row.style.setProperty('border-radius', '5px');

        const count = document.createElement('span');
        count.textContent = `${model.count}×`;
        count.title = `${model.count} sale${model.count === 1 ? '' : 's'}`;
        count.style.setProperty('font-size', '12px');
        count.style.setProperty('font-weight', '700');
        count.style.setProperty('color', YELLOW_HEX);
        count.style.setProperty('-webkit-text-fill-color', YELLOW_HEX);
        count.style.setProperty('text-align', 'right');

        const link = document.createElement('a');
        link.href = model.href;
        link.textContent = model.name;
        link.title = `Open ${model.name}`;
        link.style.setProperty('min-width', '0');
        link.style.setProperty('font-size', '12px');
        link.style.setProperty('line-height', '1.3');
        link.style.setProperty('color', '#74c0fc');
        link.style.setProperty('-webkit-text-fill-color', '#74c0fc');
        link.style.setProperty('text-decoration', 'none');
        link.style.setProperty('overflow-wrap', 'anywhere');
        link.addEventListener('click', (event) => event.stopPropagation());
        link.addEventListener('auxclick', (event) => event.stopPropagation());

        row.append(count, link);
        list.appendChild(row);
      }

      tooltip.appendChild(list);
    }

    tooltip.addEventListener('mouseenter', clearSalesTooltipCloseTimer);
    tooltip.addEventListener('mouseleave', scheduleSalesTooltipClose);
    tooltip.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(tooltip);
    state.salesTooltip = tooltip;
    badge.setAttribute('aria-controls', tooltip.id);

    const badgeRect = badge.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - tooltipRect.width - 8,
        badgeRect.right - tooltipRect.width
      )
    );
    let top = badgeRect.bottom + 7;
    if (top + tooltipRect.height > window.innerHeight - 8) {
      top = Math.max(8, badgeRect.top - tooltipRect.height - 7);
    }

    tooltip.style.setProperty('left', `${left}px`);
    tooltip.style.setProperty('top', `${top}px`);
  }

  function updateSalesBadge(root) {
    let badge = root.querySelector('[data-tm-sales-badge="true"]');
    const bounds = getUtcSalesBounds();
    const periodLabel = SALES_PERIODS[state.salesPeriod].toLowerCase();
    const hasCurrentCount =
      state.salesPeriodKey === bounds.periodKey &&
      Number.isInteger(state.salesCount) &&
      Number.isInteger(state.salesByColor?.yellow) &&
      Number.isInteger(state.salesByColor?.green);

    if (!badge) {
      badge = document.createElement('span');
      badge.dataset.tmSalesBadge = 'true';
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
      badge.addEventListener('mouseenter', () => openSalesTooltip(badge));
      badge.addEventListener('mouseleave', scheduleSalesTooltipClose);

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
      dailyLabel.dataset.tmSalesPeriodLabel = 'true';

      const salesLabel = document.createElement('span');
      salesLabel.textContent = 'sales';

      label.append(dailyLabel, salesLabel);

      badge.append(number, label);
      let singleClickTimer = null;
      let longPressTimer = null;
      let longPressHandled = false;

      const clearSingleClick = () => {
        if (singleClickTimer === null) return;
        clearTimeout(singleClickTimer);
        singleClickTimer = null;
      };

      const clearLongPress = () => {
        if (longPressTimer === null) return;
        clearTimeout(longPressTimer);
        longPressTimer = null;
      };

      badge.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;

        longPressHandled = false;
        clearLongPress();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          longPressHandled = true;
          clearSingleClick();
          openSalesSettingsPanel(badge);
        }, SALES_LONG_PRESS_MS);
      });

      for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
        badge.addEventListener(eventName, clearLongPress);
      }

      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (longPressHandled) {
          longPressHandled = false;
          return;
        }

        // Wait briefly so the first click of a double-click does not cycle.
        clearSingleClick();
        if (event.detail > 1) return;

        singleClickTimer = setTimeout(() => {
          singleClickTimer = null;
          cycleSalesPeriod();
        }, SALES_SINGLE_CLICK_DELAY_MS);
      });
      badge.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSingleClick();
        clearLongPress();
        longPressHandled = false;
        openSalesSettingsPanel(badge);
      });
      badge.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSingleClick();
        clearLongPress();
        longPressHandled = true;
        if (!state.salesSettingsPanel) openSalesSettingsPanel(badge);
      });
      badge.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          openSalesSettingsPanel(badge);
        } else {
          cycleSalesPeriod();
        }
      });
      root.appendChild(badge);
    }

    const number = badge.querySelector('[data-tm-sales-number="true"]');
    const displayedPeriod = badge.querySelector(
      '[data-tm-sales-period-label="true"]'
    );
    if (displayedPeriod.textContent !== periodLabel) {
      displayedPeriod.textContent = periodLabel;
    }
    badge.setAttribute(
      'aria-label',
      `${SALES_PERIODS[state.salesPeriod]} paid-model sales. ` +
      'Hover for sold models; activate to cycle the period; ' +
      'Shift+activate for settings.'
    );

    if (hasCurrentCount) {
      const color = getSalesCountColor(state.salesCount);
      const countText = String(state.salesCount);
      if (number.textContent !== countText) number.textContent = countText;
      badge.removeAttribute('title');
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
      badge.title = `Loading ${periodLabel} paid-model sales. Click to cycle; double-click or hold for settings.`;
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
      const fallbackText = state.salesError ? '!' : '…';
      if (number.textContent !== fallbackText) {
        number.textContent = fallbackText;
      }
      badge.title = state.salesError
        ? `Could not load ${periodLabel} sales: ${state.salesError}. Double-click or hold for settings.`
        : `Waiting to load ${periodLabel} paid-model sales. Click to cycle; double-click or hold for settings.`;
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
    }
  }

  function enableCombinedBuzzLink(text) {
    const existingLink = text.closest('a[data-tm-combined-buzz-link="true"]');
    if (existingLink) {
      if (existingLink.href !== BUZZ_DASHBOARD_URL) {
        existingLink.href = BUZZ_DASHBOARD_URL;
      }
      return existingLink;
    }

    const parent = text.parentNode;
    if (!parent) return null;

    const link = document.createElement('a');
    link.dataset.tmCombinedBuzzLink = 'true';
    link.href = BUZZ_DASHBOARD_URL;
    link.setAttribute('aria-label', 'Open Buzz dashboard');
    link.style.setProperty('display', 'inline-flex');
    link.style.setProperty('align-items', 'center');
    link.style.setProperty('color', 'inherit');
    link.style.setProperty('text-decoration', 'none');
    link.style.setProperty('cursor', 'pointer');

    // Keep the account-menu button from consuming the link interaction while
    // preserving native link behavior, including middle-click and Ctrl/Cmd-click.
    for (const eventName of ['pointerdown', 'click', 'auxclick']) {
      link.addEventListener(eventName, (event) => event.stopPropagation());
    }
    link.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== ' ') return;
      event.preventDefault();
      window.location.assign(link.href);
    });

    parent.insertBefore(link, text);
    link.appendChild(text);
    text.dataset.tmCombinedBuzzLink = 'true';
    text.removeAttribute('role');
    text.removeAttribute('tabindex');
    return link;
  }

  function update() {
    const top = findTopBuzz();
    if (!top) return;

    updateSalesBadge(top.root);

    const combinedText = state.exactCombinedText;
    if (!combinedText) return;

    forceCombinedBuzzAppearance(top.root, top.text);
    const buzzLink = enableCombinedBuzzLink(top.text);

    if (top.text.textContent.trim().toUpperCase() !== combinedText) {
      top.text.textContent = combinedText;
    }

    top.text.title =
      `Yellow Buzz: ${state.exactYellowValue.toLocaleString('en-US')}\n` +
      `Green Buzz: ${state.exactGreenValue.toLocaleString('en-US')}`;
    (buzzLink || top.text).setAttribute(
      'aria-label',
      'Combined Yellow and Green Buzz: ' +
      state.exactCombinedValue.toLocaleString('en-US')
    );
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

  function showSalesSettingsFromMenu() {
    if (state.salesSettingsPanel) return;

    const showPanel = () => {
      const badge = document.querySelector(
        '[data-tm-sales-badge="true"]'
      );
      openSalesSettingsPanel(badge);
    };

    if (document.body) {
      showPanel();
    } else {
      document.addEventListener('DOMContentLoaded', showPanel, {
        once: true,
      });
    }
  }

  function registerUserscriptMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    GM_registerMenuCommand(
      'Show sales settings',
      showSalesSettingsFromMenu
    );
  }

  function start() {
    state.salesPeriod = loadSalesPeriod();
    applyExactBuzzCache(loadExactBuzzCache());
    registerUserscriptMenu();

    const observer = new MutationObserver(queueUpdate);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
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
      if (event.key === EXACT_BUZZ_CACHE_KEY) {
        applyExactBuzzCache(loadExactBuzzCache());
        return;
      }

      if (event.key === SALES_PERIOD_KEY) {
        const period = loadSalesPeriod();
        if (period !== state.salesPeriod) {
          state.salesPeriod = period;
          state.salesCount = null;
          state.salesByColor = null;
          state.salesModels = null;
          state.salesPeriodKey = '';
          state.salesError = '';
          closeSalesTooltip();
          refreshSalesIfNeeded();
        }
        queueUpdate();
        return;
      }

      if (event.key === SALES_COLOR_SETTINGS_KEY) {
        state.salesColorSettings = null;
        loadSalesColorSettings();
        queueUpdate();
        return;
      }

      if (event.key !== SALES_CACHE_KEY) return;

      const bounds = getUtcSalesBounds();
      applySalesCache(
        loadSalesCache(bounds.period, bounds.periodKey)
      );
    });

    document.addEventListener('click', (event) => {
      const panel = state.salesSettingsPanel;
      if (!panel) return;
      if (panel.contains(event.target)) return;
      if (event.target?.closest?.('[data-tm-sales-badge="true"]')) return;
      closeSalesSettingsPanel();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeSalesTooltip();
      closeSalesSettingsPanel();
    });

    window.addEventListener('resize', () => {
      closeSalesTooltip();
      closeSalesSettingsPanel();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshExactBuzzIfNeeded();
        refreshSalesIfNeeded();
      }
    });

    /*
      Civitai is a React application and can replace the header after route
      changes. The interval repairs the display if that happens.
    */
    setInterval(queueUpdate, UI_REPAIR_MS);
    setInterval(
      () => refreshExactBuzzIfNeeded(true),
      EXACT_BUZZ_REFRESH_MS
    );
    setInterval(refreshSalesIfNeeded, 30 * 1000);

    runSeveralTimes();
    refreshExactBuzzIfNeeded();
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
