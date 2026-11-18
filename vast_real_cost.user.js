// ==UserScript==
// @name         Vast.ai Real Cost (1h / 2h / 4h / 8h + Bandwidth)
// @namespace    https://cloud.vast.ai/
// @version      1.12.0
// @description  Show rental and transfer totals on Create and Instances, hide machines from Create, and highlight and refresh marketplace offers.
// @match        https://cloud.vast.ai/create/*
// @match        https://cloud.vast.ai/create
// @match        https://cloud.vast.ai/instances/*
// @match        https://cloud.vast.ai/instances
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';
  // Menu/storage grants can put the script in a different JavaScript context.
  // Keep the network observers attached to the window used by Vast itself.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (pageWindow.__vastRealCostInstalled) return;
  pageWindow.__vastRealCostInstalled = true;
  const isCreatePage = () => /^\/create(?:\/|$)/.test(location.pathname);

  const KEY = 'vast-real-cost-settings-v1';
  const DEFAULTS = { download: 50, upload: 2 };
  let saved = null;
  try {
    if (typeof GM_getValue === 'function') saved = GM_getValue(KEY, null);
  } catch { /* fall back to the previous version's settings */ }
  const migrateSettings = saved == null;
  if (migrateSettings) {
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch { saved = {}; }
  }
  let settings = { ...DEFAULTS, ...saved };
  for (const key of ['download', 'upload']) {
    if (!Number.isFinite(+settings[key]) || +settings[key] < 0 || +settings[key] > 1000000) settings[key] = DEFAULTS[key];
    settings[key] = +settings[key];
  }
  if (migrateSettings && typeof GM_setValue === 'function') {
    try { GM_setValue(KEY, settings); }
    catch { /* retain the existing local settings until the user saves */ }
  }

  const HIDDEN_KEY = 'vast-real-cost-hidden-machines-v1';
  const savedHidden = readHiddenMachines();
  let hiddenMachines = savedHidden ?? new Set();
  // Migrate existing saved IDs and repair the backup when possible.
  if (savedHidden) saveHiddenMachines(hiddenMachines);
  let showHidden = false;

  const REFRESH_KEY = 'vast-real-cost-refresh-v1';
  let savedRefresh;
  try { savedRefresh = JSON.parse(localStorage.getItem(REFRESH_KEY) || 'null'); }
  catch { /* try userscript storage independently */ }
  if (!savedRefresh || typeof savedRefresh !== 'object') {
    try {
      if (typeof GM_getValue === 'function') savedRefresh = GM_getValue(REFRESH_KEY, null);
    } catch { /* use defaults */ }
  }
  let refreshSettings = {
    enabled: typeof savedRefresh?.enabled === 'boolean' ? savedRefresh.enabled : true,
    seconds: Number.isInteger(savedRefresh?.seconds) && savedRefresh.seconds >= 5 && savedRefresh.seconds <= 3600
      ? savedRefresh.seconds : 15,
  };
  let refreshTimer;
  let refreshing = false;
  let refreshStatus = '';
  let onCreatePage = false;

  const offers = new Map();
  const instanceRates = new Map();
  const BUNDLES_API = /\/api\/v0\/bundles(?:\/|\?|$)/;
  const INSTANCES_API = /\/api\/v[01]\/instances(?:\/+\d+)?\/?(?:[?#]|$)/;
  const HOURS = [1, 2, 4, 8];
  const INSTANCE_DETAILS = '[data-testid="instance-card-view-description"]';
  const OWN_UI = '.vrc-costs, .vrc-hide-machine, .vrc-hidden-toggle, .vrc-refresh-controls, .vrc-instance-extras, #vrc-dialog, #vrc-style';
  const money = (n) => '$' + n.toFixed(3);
  let scheduled = false;
  let dialog;
  let observer;

  // The marketplace response contains inet_down_cost / inet_up_cost in $ per GB.
  // Keep rates tied to offer ID (the "Type #..." shown on the card).
  function ingestOffers(json) {
    if (!json || !Array.isArray(json.offers)) return;
    for (const offer of json.offers) {
      const id = Number(offer.id);
      const down = Number(offer.inet_down_cost);
      const up = Number(offer.inet_up_cost);
      if (!Number.isFinite(id) || !Number.isFinite(down) || !Number.isFinite(up) || down < 0 || up < 0) continue;
      offers.set(id, { down, up });
    }
    scheduleRender();
  }

  function parseRate(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const rate = Number(value);
    return Number.isFinite(rate) && rate >= 0 ? rate : null;
  }

  function ingestInstances(json) {
    const instances = Array.isArray(json?.instances) ? json.instances : [json?.instances];
    for (const instance of instances) {
      const id = String(instance?.id);
      if (!/^\d+$/.test(id)) continue;
      // The instance price breakdown uses the per-TB fields. Vast converts
      // its rates between $/GB and $/TB using 1024 GB per TB.
      const downPerTb = parseRate(instance.internet_down_cost_per_tb);
      const upPerTb = parseRate(instance.internet_up_cost_per_tb);
      const down = downPerTb === null ? parseRate(instance.inet_down_cost) : downPerTb / 1024;
      const up = upPerTb === null ? parseRate(instance.inet_up_cost) : upPerTb / 1024;
      if (down !== null && up !== null) instanceRates.set(id, { down, up });
    }
    scheduleRender();
  }

  function responseHandler(url, method) {
    if (BUNDLES_API.test(url)) return ingestOffers;
    if (method.toUpperCase() === 'GET' && INSTANCES_API.test(url)) return ingestInstances;
    return null;
  }

  // These passive observers read Vast's own HTTP responses without sending
  // requests, accessing credentials, or altering the site's responses.
  const fetchOriginal = pageWindow.fetch;
  if (typeof fetchOriginal === 'function') {
    pageWindow.fetch = function(...args) {
      const result = fetchOriginal.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0]);
        const ingest = responseHandler(url, String(args[1]?.method ?? args[0]?.method ?? 'GET'));
        if (ingest) {
          result.then(r => {
            if (r.ok) r.clone().json().then(ingest).catch(() => {});
          }).catch(() => {});
        }
      } catch { /* never interfere with Vast */ }
      return result;
    };
  }

  const xhrPrototype = pageWindow.XMLHttpRequest.prototype;
  const openOriginal = xhrPrototype.open;
  const sendOriginal = xhrPrototype.send;
  xhrPrototype.open = function(method, url, ...args) {
    this.__vastRealCostWatch = responseHandler(String(url), String(method));
    return openOriginal.call(this, method, url, ...args);
  };
  xhrPrototype.send = function(...args) {
    const ingest = this.__vastRealCostWatch;
    if (ingest) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const json = this.responseType === 'json' ? this.response :
            (this.responseType === '' || this.responseType === 'text') ? JSON.parse(this.responseText) : null;
          ingest(json);
        } catch { /* ignore malformed response */ }
      }, { once:true });
    }
    return sendOriginal.apply(this, args);
  };

  const CSS = `
    #vrc-dialog { position:fixed; right:16px; top:16px; z-index:2147483001;
      background:#19232e; color:#f2f6fd; border:1px solid #537495; border-radius:10px;
      padding:16px; width:280px; box-shadow:0 8px 30px #0008; font:13px Arial,sans-serif; }
    #vrc-dialog label { display:flex; align-items:center; justify-content:space-between; margin:12px 0; gap:12px; }
    #vrc-dialog input { width:90px; padding:5px; background:#f7fbff; color:#111; border:1px solid #aaa;
      border-radius:4px; font-size:13px; }
    #vrc-dialog button { cursor:pointer; padding:6px 10px; margin-right:6px; }
    #vrc-dialog .vrc-help { color:#bac9d7; font-size:11px; line-height:1.45; margin-top:10px; }
    .vrc-hide-machine, .vrc-hidden-toggle, .vrc-refresh-now {
      cursor:pointer; color:inherit; background:transparent; border:1px solid #718096;
      border-radius:4px; font:11px Arial,sans-serif; line-height:16px;
      padding:2px 6px; box-sizing:border-box;
    }
    .vrc-hidden-toggle { flex-shrink:0; margin-left:8px; white-space:nowrap; }
    .sort-info.vrc-menu { flex-wrap:nowrap; height:auto; }
    .vrc-refresh-controls { display:inline-flex; align-items:center; gap:6px;
      flex-shrink:0; margin-left:8px; white-space:nowrap; font:11px Arial,sans-serif; }
    .vrc-refresh-controls label { display:inline-flex; align-items:center; gap:4px; margin:0; }
    .vrc-refresh-controls input[type="number"] { width:54px; padding:2px 4px;
      background:transparent; color:inherit; border:1px solid #718096; border-radius:4px; font:inherit; }
    .vrc-refresh-controls input[type="checkbox"] { margin:0; }
    .vrc-refresh-now:disabled { cursor:wait; opacity:.6; }
    .vrc-refresh-status { opacity:.75; }
    /* The native Rent button can extend to the card's bottom. Keep this
       control in the empty space above it without moving any card details. */
    .results-table [data-aid="RowElement"] .vrc-hide-machine {
      position:absolute; right:12px; top:8px; bottom:auto; width:100px; height:22px;
      padding:0 4px; font-size:10px; z-index:2;
    }
    .results-table [data-aid="RowElement"].vrc-machine-collapsed { display:none !important; }
    .vrc-hide-machine[aria-pressed="true"] { color:#f0c987; border-color:#b18b50; }
    .vrc-instance-extras {
      display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; font-size:11px;
    }
    .vrc-instance-extras .vrc-hide-machine { white-space:nowrap; color:inherit; }
    .vrc-instance-costs {
      display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px;
      font-variant-numeric:tabular-nums;
    }
    .vrc-instance-costs > span { white-space:nowrap; }
    /* Keep the whole row compact, including on wide screens. Width comes from
       CSS rather than measurements of elements we have already moved. */
    /* The supplied layout needs 1075px for details, hourly price, totals and
       Rent. The previous 1140px left about 65px unused before the price. */
    .vrc-create-page .results-table { width:1075px !important; min-width:1075px !important; max-width:1075px !important; }
    .results-table [data-aid="RowElement"],
    .results-table [data-aid="RowElement"] .rentable-card,
    .results-table [data-aid="RowElement"] .machine-row {
      width:100% !important; min-width:0 !important; max-width:100% !important; box-sizing:border-box;
    }
    /* Reset-and-measure must be immediate; a site transition would return an
       intermediate position and make the next render move the element again. */
    .results-table [data-aid="RowElement"] .vrc-positioned { transition:none !important; }
    /* Do not restyle Vast's original price or Rent button. Insert only a
       transparent, borderless cost column into the existing card. */
    .results-table [data-aid="RowElement"] .vrc-costs {
      position:absolute;
      width:142px;
      height:92px;
      display:flex;
      flex-direction:column;
      align-items:stretch;
      gap:1px;
      box-sizing:border-box;
      margin:0;
      padding:0;
      border:0;
      border-radius:0;
      background:none;
      box-shadow:none;
      white-space:nowrap;
      color:inherit;
      font-family:inherit;
      font-size:inherit;
      line-height:1.15;
      z-index:1;
      pointer-events:none;
    }
    .results-table [data-aid="RowElement"] .vrc-row {
      display:grid;
      grid-template-columns:73px max-content;
      column-gap:4px;
      align-items:center;
      height:17px;
      min-height:17px;
    }
    .results-table [data-aid="RowElement"] .vrc-duration {
      font-size:11px;
      font-weight:500;
      opacity:.72;
    }
    .results-table [data-aid="RowElement"] .vrc-value {
      font-size:14px;
      font-weight:700;
      color:inherit;
      font-variant-numeric:tabular-nums;
      text-align:left;
    }
    .results-table [data-aid="RowElement"] .vrc-data .vrc-value { font-size:13px; }
    /* Paint only the number's existing box; do not change any layout metrics. */
    .results-table [data-aid="RowElement"] .vrc-costs[data-vrc-rank-2="1"] .vrc-value[data-vrc-hours="2"] { background-color:rgba(255, 213, 0, .55); }
    .results-table [data-aid="RowElement"] .vrc-costs[data-vrc-rank-2="2"] .vrc-value[data-vrc-hours="2"] { background-color:rgba(255, 213, 0, .35); }
    .results-table [data-aid="RowElement"] .vrc-costs[data-vrc-rank-2="3"] .vrc-value[data-vrc-hours="2"] { background-color:rgba(255, 213, 0, .18); }
    .results-table [data-aid="RowElement"] .vrc-costs[data-vrc-rank-4="1"] .vrc-value[data-vrc-hours="4"] { background-color:rgba(46, 204, 113, .55); }
    .results-table [data-aid="RowElement"] .vrc-costs[data-vrc-rank-4="2"] .vrc-value[data-vrc-hours="4"] { background-color:rgba(46, 204, 113, .35); }
    .results-table [data-aid="RowElement"] .vrc-costs[data-vrc-rank-4="3"] .vrc-value[data-vrc-hours="4"] { background-color:rgba(46, 204, 113, .18); }
    .results-table [data-aid="RowElement"] .vrc-costs.vrc-pending {
      color:inherit;
      opacity:.65;
      font-size:11px;
      font-weight:400;
    }

  `;

  function findPriceContainer(card) {
    const hover = card.querySelector('.button-hover');
    if (!hover) return null;
    // In the supplied DOM, this is the absolute-positioned div containing
    // "$0.227/hr" and the "plus bandwidth" caption.
    for (const node of hover.querySelectorAll(':scope > .abspos')) {
      if (/\$\s*\d+(?:\.\d+)?\s*\/\s*hr/i.test(node.textContent || '')) return node;
    }
    return null;
  }

  function savePersistentValue(key, value) {
    let persisted = false;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      persisted = true;
    } catch { /* userscript storage can still save the list */ }
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        persisted = true;
      }
    } catch { /* the browser copy remains usable */ }
    return persisted;
  }

  function readHiddenMachines() {
    let saved;
    // Prefer the browser copy so changes are shared across open tabs.
    try { saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || 'null'); }
    catch { /* try userscript storage independently */ }
    if (!Array.isArray(saved)) {
      try {
        if (typeof GM_getValue === 'function') saved = GM_getValue(HIDDEN_KEY, null);
      } catch { /* neither store is readable */ }
    }
    return Array.isArray(saved) ? new Set(saved.map(String).filter(id => /^\d+$/.test(id))) : null;
  }

  function saveHiddenMachines(ids) {
    return savePersistentValue(HIDDEN_KEY, [...ids]);
  }

  function syncHiddenMachines() {
    hiddenMachines = readHiddenMachines() ?? new Set();
    scheduleRender();
  }

  function resetRefreshTimer() {
    clearTimeout(refreshTimer);
    if (!isCreatePage() || !refreshSettings.enabled) return;
    refreshTimer = setTimeout(() => {
      // Background tabs and offline periods should not generate requests.
      if (document.visibilityState === 'hidden' || navigator.onLine === false ||
          !document.querySelector('[data-aid="SearchPageGpuButtons"]')) {
        resetRefreshTimer();
        return;
      }
      refreshOffers();
    }, refreshSettings.seconds * 1000);
  }

  function findMarketplaceClient() {
    // Vast exposes the same query client used by its results components.
    // Refetching that query updates the native list, including new/removed
    // offers, without replaying API calls or copying authentication data.
    const client = pageWindow.__TANSTACK_QUERY_CLIENT__;
    return typeof client?.getQueryCache === 'function' && typeof client.refetchQueries === 'function' ? client : null;
  }

  async function refreshOffers() {
    if (!isCreatePage() || refreshing) return;
    clearTimeout(refreshTimer);
    const client = findMarketplaceClient();
    if (!client || !client.getQueryCache().findAll({ queryKey:['bundles'], type:'active' }).length) {
      refreshStatus = 'Search not ready. Try again.';
      scheduleRender();
      resetRefreshTimer();
      return;
    }
    refreshing = true;
    refreshStatus = 'Refreshing…';
    scheduleRender();
    try {
      await client.refetchQueries({ queryKey:['bundles'], type:'active' }, { throwOnError:true });
      refreshStatus = `Updated ${new Date().toLocaleTimeString()}`;
    } catch {
      refreshStatus = 'Refresh failed. Try again.';
    } finally {
      refreshing = false;
      scheduleRender();
      // Wait a full interval after completion; never overlap our requests.
      resetRefreshTimer();
    }
  }

  function updateRefreshControls() {
    const menu = document.querySelector('[data-aid="SearchPageGpuButtons"]')?.closest('.sort-info');
    if (!menu) return;
    menu.classList.add('vrc-menu');
    let controls = menu.querySelector('.vrc-refresh-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'vrc-refresh-controls';
      controls.innerHTML = `<label><input class="vrc-refresh-enabled" type="checkbox">Auto refresh</label>
        <label><input class="vrc-refresh-seconds" type="number" min="5" max="3600" step="1" aria-label="Auto refresh interval in seconds">s</label>
        <button type="button" class="vrc-refresh-now">Refresh</button>
        <span class="vrc-refresh-status" role="status"></span>`;
      controls.addEventListener('click', e => e.stopPropagation());
      controls.querySelector('.vrc-refresh-now').addEventListener('click', refreshOffers);
      controls.addEventListener('change', e => {
        const enabled = controls.querySelector('.vrc-refresh-enabled');
        const seconds = controls.querySelector('.vrc-refresh-seconds');
        if (!seconds.value.trim() || !seconds.checkValidity()) {
          seconds.reportValidity();
          seconds.value = refreshSettings.seconds;
          return;
        }
        const next = { enabled:enabled.checked, seconds:Number(seconds.value) };
        if (savePersistentValue(REFRESH_KEY, next)) {
          refreshSettings = next;
          resetRefreshTimer();
        } else refreshStatus = 'Could not save refresh settings.';
        e.stopPropagation();
        scheduleRender();
      });
      menu.append(controls);
    }
    const hiddenToggle = menu.querySelector('.vrc-hidden-toggle');
    if (hiddenToggle && hiddenToggle.nextElementSibling !== controls) hiddenToggle.after(controls);
    controls.querySelector('.vrc-refresh-enabled').checked = refreshSettings.enabled;
    const seconds = controls.querySelector('.vrc-refresh-seconds');
    if (document.activeElement !== seconds) seconds.value = refreshSettings.seconds;
    const button = controls.querySelector('.vrc-refresh-now');
    button.disabled = refreshing;
    const status = controls.querySelector('.vrc-refresh-status');
    if (status.textContent !== refreshStatus) status.textContent = refreshStatus;
  }

  function toggleMachineHidden(id) {
    const next = readHiddenMachines() ?? new Set(hiddenMachines);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (!saveHiddenMachines(next)) {
      alert('Could not save hidden machines. Please try again.');
      return;
    }
    hiddenMachines = next;
    scheduleRender();
  }

  function updateHiddenToggle() {
    const menu = document.querySelector('[data-aid="SearchPageGpuButtons"]')?.closest('.sort-info');
    if (!menu) return;
    let toggle = menu.querySelector('.vrc-hidden-toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'vrc-hidden-toggle';
      toggle.addEventListener('click', e => {
        e.stopPropagation();
        showHidden = !showHidden;
        scheduleRender();
      });
      menu.append(toggle);
    }
    const label = `${showHidden ? 'Hide' : 'Show'} hidden (${hiddenMachines.size})`;
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.setAttribute('aria-pressed', String(showHidden));
    toggle.title = 'Saved hidden machines across all searches. Hidden machines never receive best-price highlights.';
  }

  function machineId(card) {
    // Machine IDs survive offer changes; "Type #..." is only an offer ID.
    return card.querySelector('[data-testid="machine-id"]')?.textContent.match(/\b(?:m|machine id):\s*(\d+)\b/i)?.[1];
  }

  function updateHideButton(container, id, suffix = '') {
    let button = container.querySelector(':scope > .vrc-hide-machine');
    if (!id) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'vrc-hide-machine';
      button.addEventListener('click', e => {
        e.stopPropagation();
        toggleMachineHidden(button.dataset.machineId);
      });
      container.prepend(button);
    }
    // Read the current ID on click because Vast can reuse an existing row.
    button.dataset.machineId = id;
    const hidden = hiddenMachines.has(id);
    const label = hidden ? 'Unhide' : 'Hide';
    if (button.textContent !== label + suffix) button.textContent = label + suffix;
    button.setAttribute('aria-pressed', String(hidden));
    button.setAttribute('aria-label', `${label} machine ${id}${suffix}`);
    button.title = `${label} all offers for machine ${id}${suffix}`;
  }

  function updateMachineControl(card) {
    const id = machineId(card);
    const hidden = hiddenMachines.has(id);
    card.classList.toggle('vrc-machine-collapsed', hidden && !showHidden);
    const panel = card.querySelector('.rentable-card');
    if (panel) {
      if (id && getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
      updateHideButton(panel, id);
    }
    return hidden;
  }

  function readHourlyPrice(text) {
    const amount = text?.match(/\$\s*([\d,.]+)\s*\/\s*hr/i)?.[1];
    return parseRate(amount?.replace(/,/g, ''));
  }

  function estimateTransfer(rates) {
    return settings.download * rates.down + settings.upload * rates.up;
  }

  function transferDetails(rates, traffic, gbPerTb) {
    return `${settings.download} GB download × ${money(rates.down * gbPerTb)}/TB + ` +
      `${settings.upload} GB upload × ${money(rates.up * gbPerTb)}/TB = ${money(traffic)} transfer.`;
  }

  function updateInstanceCard(details) {
    const id = details.querySelector('[data-testid="instance-id"]')?.textContent.match(/\bInstance ID:\s*(\d+)\b/i)?.[1];
    const machine = machineId(details);
    let extras = details.parentElement.querySelector(':scope > .vrc-instance-extras');
    if (!id && !machine) {
      extras?.remove();
      return;
    }
    if (!extras) {
      extras = document.createElement('div');
      extras.className = 'vrc-instance-extras';
      extras.innerHTML = '<div class="vrc-instance-costs"></div>';
      details.after(extras);
    }
    updateHideButton(extras, machine, ' on Create');

    const output = extras.querySelector('.vrc-instance-costs');
    const badge = id && document.querySelector(`[data-testid="instance-price-badge-${id}"]`);
    const hourly = readHourlyPrice(badge?.textContent);
    const rates = instanceRates.get(id);
    let markup = id ? '<span>Cost estimate unavailable</span>' : '';
    let title = '';
    if (hourly !== null && rates) {
      const traffic = estimateTransfer(rates);
      markup = '<span>Est. totals</span>' + HOURS.map(h => `<span>${h}h <strong>${money(hourly * h + traffic)}</strong></span>`).join('') +
        `<span>Data (once) <strong>${money(traffic)}</strong></span>`;
      title = transferDetails(rates, traffic, 1024) + ' Estimates use the hourly price shown for this instance.';
    }
    if (output.innerHTML !== markup) output.innerHTML = markup;
    output.title = title;
  }

  function updateCard(card, candidates, hidden) {
    if (hidden && !showHidden) {
      const output = card.querySelector('.vrc-costs');
      output?.removeAttribute('data-vrc-rank-2');
      output?.removeAttribute('data-vrc-rank-4');
      // Measuring a collapsed card would overwrite its layout with zeroes.
      return;
    }
    const idText = card.querySelector('[data-aid="instance_id"]')?.textContent || '';
    const id = Number(idText.match(/#\s*(\d+)/)?.[1]);
    const priceBox = findPriceContainer(card);
    if (!priceBox) return;
    const priceText = Array.from(priceBox.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ');
    const hourly = readHourlyPrice(priceText);
    if (hourly === null) return;
    const panel = card.querySelector('.rentable-card');
    if (!panel) return;
    // This is a new sibling inside the ORIGINAL card, not inside the price.
    // The original price retains Vast's own flex layout, position and caption.
    let output = panel.querySelector(':scope > .vrc-costs');
    if (!output) {
      output = document.createElement('div');
      output.className = 'vrc-costs';
      panel.append(output);
    }
    const offer = offers.get(id);
    let markup;
    if (!offer) {
      markup = '<span class="vrc-note">Bandwidth: loading…</span>';
      output.classList.add('vrc-pending');
      output.removeAttribute('data-vrc-rank-2');
      output.removeAttribute('data-vrc-rank-4');
    } else {
      output.classList.remove('vrc-pending');
      const traffic = estimateTransfer(offer);
      markup = HOURS.map(h => `<div class="vrc-row"><span class="vrc-duration">${h}h total</span>` +
        `<span class="vrc-value" data-vrc-hours="${h}">${money(hourly * h + traffic)}</span></div>`).join('') +
        `<div class="vrc-row vrc-data"><span class="vrc-duration">Data (once)</span>` +
        `<span class="vrc-value">${money(traffic)}</span></div>`;
      candidates.push({ output, hourly, traffic, hidden });
      output.title = transferDetails(offer, traffic, 1000) +
        ' Totals = advertised hourly price × hours + one-time transfer.';
    }
    if (output.innerHTML !== markup) output.innerHTML = markup;

    // Five rows fit within Vast's original card height; only positions change.
    // Never set widths from measured positions: that caused the old growth loop.
    const rent = card.querySelector('[data-aid="RowElement-ask"]');
    const details = card.querySelector('.fixed-layout');
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    if (!rent || !details) return;

    for (const element of [rent, priceBox, details]) element.classList.add('vrc-positioned');

    // Undo only translations from previous renders before measuring. They are
    // then set again relative to original positions (no accumulating drift).
    rent.style.translate = '';
    priceBox.style.translate = '';
    details.style.translate = '';
    const panelRect = panel.getBoundingClientRect();
    const rentRect = rent.getBoundingClientRect();
    const priceRect = priceBox.getBoundingClientRect();

    // Anchor the price group to the compact card's right edge. Its placement
    // never depends on the translated details or on the totals' text content.
    const rentLeft = panelRect.right - rentRect.width - 12;

    const costWidth = 142;
    const costHeight = 92;
    output.style.top = `${Math.max(3, Math.round((panelRect.height - costHeight) / 2))}px`;

    // Locate the GPU heading, not just the outer fixed-layout bounding box.
    // Moving it near the logo also brings the m:... machine index ABOVE it.
    const gpuLabel = Array.from(details.querySelectorAll(':scope > .abspos'))
      .find(n => /\b\d+x\s+(?:RTX|GTX|L4|A100|H100|H200|B200|V100|A40|L40)/i.test(n.textContent || ''));
    const nativeGpuLeft = (gpuLabel || details).getBoundingClientRect().left;
    const nativeDetailRight = Math.max(...Array.from(details.children)
      .filter(n => n.getClientRects().length)
      .map(n => n.getBoundingClientRect().right));

    // Compact the far-left column without colliding with the logo.
    // In the user's screenshot this changes GPU x~156 to about x~105.
    const gpuInset = 102;
    let detailDx = Math.round(panelRect.left + gpuInset - nativeGpuLeft);
    const gapAfterDetails = 12;
    const gapAfterPrice = 8;
    const gapBeforeRent = 8;
    const desiredCostX = rentLeft - gapBeforeRent - costWidth;
    const desiredPriceX = desiredCostX - gapAfterPrice - priceRect.width;

    // If a smaller window is tight, compress the left section further instead
    // of creating overlaps or increasing the width at every redraw.
    const overflow = nativeDetailRight + detailDx + gapAfterDetails - desiredPriceX;
    if (overflow > 0) {
      detailDx -= Math.ceil(overflow);
    }
    details.style.translate = detailDx ? `${detailDx}px 0` : '';

    const priceDx = Math.round(desiredPriceX - priceRect.left);
    priceBox.style.translate = priceDx ? `${priceDx}px 0` : '';
    output.style.left = `${Math.round(desiredCostX - panelRect.left)}px`;

    const rentDx = Math.round(rentLeft - rentRect.left);
    rent.style.translate = rentDx ? `${rentDx}px 0` : '';

  }

  function highlightCheapest(candidates) {
    // Rank only offers currently displayed, using unrounded totals including
    // bandwidth. Equal costs keep page order, so at most three offers win.
    const displayed = candidates.filter(({ output, hidden }) =>
      !hidden && output.getClientRects().length && getComputedStyle(output).visibility !== 'hidden');
    for (const hours of [2, 4]) {
      const cheapest = [...displayed].sort((a, b) =>
        (a.hourly * hours + a.traffic) - (b.hourly * hours + b.traffic)).slice(0, 3);
      for (const { output } of candidates) {
        const index = cheapest.findIndex(candidate => candidate.output === output);
        const attribute = `data-vrc-rank-${hours}`;
        // Keep ranks on the outer column so the price markup stays stable.
        if (index >= 0) output.setAttribute(attribute, String(index + 1));
        else output.removeAttribute(attribute);
      }
    }
  }

  function render() {
    if (!document.body) return;
    ensureStyles();
    const create = isCreatePage();
    if (onCreatePage !== create) {
      onCreatePage = create;
      document.documentElement.classList.toggle('vrc-create-page', create);
      resetRefreshTimer();
    }
    if (!create) {
      if (/^\/instances(?:\/|$)/.test(location.pathname)) {
        document.querySelectorAll(INSTANCE_DETAILS).forEach(updateInstanceCard);
      }
      return;
    }
    updateHiddenToggle();
    updateRefreshControls();
    const candidates = [];
    document.querySelectorAll('.results-table [data-aid="RowElement"]')
      .forEach(card => updateCard(card, candidates, updateMachineControl(card)));
    highlightCheapest(candidates);
  }
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; render(); });
  }

  function ensureStyles() {
    if (!document.getElementById('vrc-style')) {
      const style = document.createElement('style');
      style.id = 'vrc-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
  }

  function showDialog() {
    if (dialog && dialog.isConnected) {
      dialog.querySelector('[name="download"]').focus();
      return;
    }
    dialog = document.createElement('section');
    dialog.id = 'vrc-dialog';
    dialog.innerHTML = `
      <strong>Real Cost — settings</strong>
      <label>Download (GB) <input name="download" type="number" min="0" max="1000000" step="any" required></label>
      <label>Upload (GB) <input name="upload" type="number" min="0" max="1000000" step="any" required></label>
      <button type="button" data-action="save">Save</button>
      <button type="button" data-action="reset">Defaults</button>
      <button type="button" data-action="close">Close</button>
      <div class="vrc-help">Saved amounts are remembered for future visits. Transfers are counted once per rental, not per hour. Uses the separate host-specific prices published by Vast.ai. Estimates exclude other unlisted charges.</div>`;
    for (const key of ['download', 'upload']) dialog.querySelector(`[name="${key}"]`).value = settings[key];
    dialog.addEventListener('click', e => {
      const action = e.target?.dataset?.action;
      if (action === 'close') { dialog.remove(); dialog = null; }
      if (action === 'reset') {
        for (const key of ['download', 'upload']) dialog.querySelector(`[name="${key}"]`).value = DEFAULTS[key];
      }
      if (action === 'save') {
        const next = {};
        for (const key of ['download', 'upload']) {
          const raw = dialog.querySelector(`[name="${key}"]`).value.trim();
          const value = Number(raw);
          if (!raw || !Number.isFinite(value) || value < 0 || value > 1000000) {
            alert(`Enter a valid ${key} amount (0 to 1,000,000 GB).`); return;
          }
          next[key] = value;
        }
        try {
          if (typeof GM_setValue === 'function') GM_setValue(KEY, next);
          else localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          alert('Could not save transfer amounts. Please try again.');
          return;
        }
        settings = next;
        dialog.remove(); dialog = null;
        scheduleRender();
      }
    });
    document.body.appendChild(dialog);
  }

  function start() {
    ensureStyles();
    scheduleRender();
    observer = new MutationObserver((mutations) => {
      // Avoid looping on DOM changes made by our own UI. Removed controls
      // still trigger repair if Vast replaces or clears part of the page.
      const relevant = mutations.some(m => {
        const target = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        if (target?.closest(OWN_UI)) return false;
        if (m.type === 'characterData') return true;
        if ([...m.removedNodes].some(n => n.nodeType === Node.ELEMENT_NODE &&
          n.matches('.vrc-hide-machine, .vrc-hidden-toggle, .vrc-refresh-controls, .vrc-instance-extras'))) return true;
        return [...m.addedNodes, ...m.removedNodes].some(n =>
          n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE &&
          !n.matches(OWN_UI)));
      });
      if (relevant) scheduleRender();
    });
    observer.observe(document.body, { subtree:true, childList:true, characterData:true });
    window.addEventListener('resize', scheduleRender, { passive:true });
    window.addEventListener('popstate', scheduleRender);
    window.addEventListener('storage', event => {
      if (event.key === HIDDEN_KEY) syncHiddenMachines();
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) syncHiddenMachines();
    });
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Real Cost: Download / upload settings…', () => showDialog());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
