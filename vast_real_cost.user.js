// ==UserScript==
// @name         Vast.ai Real Cost (1h / 2h / 4h / 8h + Bandwidth)
// @namespace    https://cloud.vast.ai/
// @version      1.9.0
// @description  Show 1h / 2h / 4h / 8h + transfer costs in a compact column, highlighting the three cheapest 2h and 4h options, with persistent settings.
// @match        https://cloud.vast.ai/create/*
// @match        https://cloud.vast.ai/create
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

  const offers = new Map();
  const API = /\/api\/v0\/bundles(?:\/|\?|$)/;
  const money = (n) => '$' + n.toFixed(3);
  let scheduled = false;
  let dialog;
  let observer;

  // The marketplace response contains inet_down_cost / inet_up_cost in $ per GB.
  // Keep rates tied to offer ID (the "Type #..." shown on the card).
  function ingest(json) {
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

  // Observe the same HTTP responses Vast itself uses. No extra network requests,
  // no credential access, and no alteration to the site's HTTP responses.
  const fetchOriginal = pageWindow.fetch;
  if (typeof fetchOriginal === 'function') {
    pageWindow.fetch = function(...args) {
      const result = fetchOriginal.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0]);
        if (API.test(url)) {
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
    this.__vastRealCostWatch = API.test(String(url));
    return openOriginal.call(this, method, url, ...args);
  };
  xhrPrototype.send = function(...args) {
    if (this.__vastRealCostWatch) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const json = this.responseType === 'json' ? this.response :
            (this.responseType === '' || this.responseType === 'text') ? JSON.parse(this.responseText) : null;
          ingest(json);
        } catch { /* ignore malformed response */ }
      });
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
    /* Keep the whole row compact, including on wide screens. Width comes from
       CSS rather than measurements of elements we have already moved. */
    /* The supplied layout needs 1075px for details, hourly price, totals and
       Rent. The previous 1140px left about 65px unused before the price. */
    .results-table { width:1075px !important; min-width:1075px !important; max-width:1075px !important; }
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

  function updateCard(card, candidates) {
    const idText = card.querySelector('[data-aid="instance_id"]')?.textContent || '';
    const id = Number(idText.match(/#\s*(\d+)/)?.[1]);
    const priceBox = findPriceContainer(card);
    if (!priceBox) return;
    const priceText = Array.from(priceBox.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ');
    const m = priceText.match(/\$\s*([\d,.]+)\s*\/\s*hr/i);
    if (!m) return;
    const hourly = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(hourly)) return;
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
      const traffic = settings.download * offer.down + settings.upload * offer.up;
      markup = [1, 2, 4, 8].map(h => `<div class="vrc-row"><span class="vrc-duration">${h}h total</span>` +
        `<span class="vrc-value" data-vrc-hours="${h}">${money(hourly * h + traffic)}</span></div>`).join('') +
        `<div class="vrc-row vrc-data"><span class="vrc-duration">Data (once)</span>` +
        `<span class="vrc-value">${money(traffic)}</span></div>`;
      candidates.push({ output, hourly, traffic });
      output.title = `${settings.download} GB download × $${(offer.down*1000).toFixed(3)}/TB + ` +
        `${settings.upload} GB upload × $${(offer.up*1000).toFixed(3)}/TB = ${money(traffic)} transfer. ` +
        'Totals = advertised hourly price × hours + one-time transfer.';
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
    const displayed = candidates.filter(({ output }) =>
      output.getClientRects().length && getComputedStyle(output).visibility !== 'hidden');
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
    const candidates = [];
    document.querySelectorAll('.results-table [data-aid="RowElement"]')
      .forEach(card => updateCard(card, candidates));
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
      // Avoid looping on DOM changes made by our own price elements.
      const relevant = mutations.some(m => {
        const target = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        if (target?.closest('.vrc-costs, #vrc-dialog, #vrc-style')) return false;
        if (m.type === 'characterData') return true;
        return [...m.addedNodes, ...m.removedNodes].some(n =>
          n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE &&
          !n.matches?.('.vrc-costs, #vrc-dialog, #vrc-style')));
      });
      if (relevant) scheduleRender();
    });
    observer.observe(document.body, { subtree:true, childList:true, characterData:true });
    window.addEventListener('resize', scheduleRender, { passive:true });
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Real Cost: Download / upload settings…', () => showDialog());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
