// ==UserScript==
// @name         Civitai Model Price Tag Visible
// @namespace    https://civitai.com/
// @version      1.1.0
// @description  Keeps a model's paid-download Buzz price visible to its creator, displaying the restored badge in gray.
// @author       Alex + ChatGPT
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @match        https://civitai.green/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const ENABLED_KEY = 'civitaiCreatorPriceBadgeEnabled';
  const OLD_CACHE_KEY = 'civitaiCreatorPriceBadgeCacheV1';
  const DOWNLOAD_SELECTOR = 'a[href*="/api/download/models/"]';
  const CUSTOM_BADGE_SELECTOR = '[data-civitai-creator-price-badge="true"]';
  const NATIVE_BADGE_SELECTOR = '.mantine-Badge-root, [class*="mantine-Badge-root"]';

  let enabled = GM_getValue(ENABLED_KEY, true);
  let renderQueued = false;
  let currentPathname = location.pathname;

  // This cache exists only in memory and only for the current model-page pathname.
  // It is intentionally not stored in sessionStorage, because Civitai may reuse React
  // elements while navigating and a persisted value can then appear on a free model.
  /** @type {Map<string, string>} */
  const priceByDownloadUrl = new Map();

  // Remove data saved by version 1.0.x. Version 1.1.0 never reads this cache.
  try {
    sessionStorage.removeItem(OLD_CACHE_KEY);
  } catch {
    // sessionStorage can be unavailable in restrictive browser modes.
  }

  GM_addStyle(`
    ${CUSTOM_BADGE_SELECTOR} {
      position: absolute !important;
      top: -8px !important;
      right: -8px !important;
      z-index: 20 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      min-width: 0 !important;
      height: 22px !important;
      padding: 3px 6px 3px 3px !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      border-radius: 4px !important;
      background: #6b7280 !important;
      color: #f3f4f6 !important;
      box-shadow:
        0 1px 3px rgba(0, 0, 0, 0.20),
        0 6px 12px -6px rgba(0, 0, 0, 0.45) !important;
      font-family: inherit !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      line-height: 1 !important;
      pointer-events: none !important;
      user-select: none !important;
      white-space: nowrap !important;
    }

    ${CUSTOM_BADGE_SELECTOR} svg {
      width: 14px !important;
      height: 14px !important;
      margin-right: 1px !important;
      fill: #f3f4f6 !important;
      stroke: #374151 !important;
      stroke-width: 2 !important;
    }
  `);

  GM_registerMenuCommand(
    enabled ? 'Disable creator price badges' : 'Enable creator price badges',
    () => {
      enabled = !enabled;
      GM_setValue(ENABLED_KEY, enabled);

      if (!enabled) {
        removeAllCustomBadges();
      }

      location.reload();
    }
  );

  function getDownloadKeyFromHref(href) {
    if (!href) return null;

    try {
      const url = new URL(href, location.href);
      if (!url.pathname.includes('/api/download/models/')) return null;
      return `${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }

  function getDownloadKey(button) {
    return getDownloadKeyFromHref(button?.getAttribute?.('href'));
  }

  function extractPrice(badge) {
    if (!(badge instanceof Element)) return null;

    // Prefer the small text element used by Civitai's actual Buzz badge.
    const priceTextElement = badge.querySelector('p[data-size="xs"], .mantine-Text-root');
    const text = (priceTextElement?.textContent || badge.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    // Valid examples: 1, 30, 1.5k, 7k, 2M.
    const match = text.match(/(?:^|\s)(\d+(?:[.,]\d+)?\s*[kKmM]?)(?:\s|$)/);
    return match ? match[1].replace(/\s+/g, '') : null;
  }

  function isNativePriceBadge(element) {
    if (!(element instanceof Element)) return false;
    if (element.matches(CUSTOM_BADGE_SELECTOR)) return false;
    if (!element.matches(NATIVE_BADGE_SELECTOR)) return false;

    const hasBolt = Boolean(
      element.querySelector('svg.tabler-icon-bolt, svg[class*="tabler-icon-bolt"]')
    );

    return hasBolt && Boolean(extractPrice(element));
  }

  function findNativeBadges(root) {
    if (!(root instanceof Element)) return [];

    const candidates = [];
    if (root.matches(NATIVE_BADGE_SELECTOR)) candidates.push(root);
    candidates.push(...root.querySelectorAll(NATIVE_BADGE_SELECTOR));

    return candidates.filter(isNativePriceBadge);
  }

  function associatePriceWithButton(button, price) {
    if (!(button instanceof HTMLElement) || !price) return;

    const key = getDownloadKey(button);
    if (!key) return;

    // Store the association on the exact button as well as in current-page memory.
    button.dataset.civitaiCreatorPriceKey = key;
    button.dataset.civitaiCreatorPriceValue = price;
    priceByDownloadUrl.set(key, price);
  }

  function rememberBadge(badge, fallbackButton = null) {
    if (!enabled || !isNativePriceBadge(badge)) return;

    // A connected badge must belong to the exact download button containing it.
    let button = badge.closest(DOWNLOAD_SELECTOR);

    // MutationObserver may report an added node after React has already detached it.
    // In that narrow case, use only the download button containing the mutation target.
    if (!button && fallbackButton instanceof HTMLElement) {
      button = fallbackButton;
    }

    if (!(button instanceof HTMLElement)) return;

    const price = extractPrice(badge);
    if (!price) return;

    associatePriceWithButton(button, price);
  }

  function captureAddedNode(node, fallbackButton = null) {
    if (!(node instanceof Element)) return;
    findNativeBadges(node).forEach((badge) => rememberBadge(badge, fallbackButton));
  }

  function isVisiblyRendered(element) {
    if (!(element instanceof Element)) return false;

    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number.parseFloat(style.opacity || '1') > 0 &&
      element.getClientRects().length > 0
    );
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function createGrayBadge(price) {
    const badge = document.createElement('span');
    badge.dataset.civitaiCreatorPriceBadge = 'true';
    badge.setAttribute('aria-label', `${price} Buzz download price (creator view)`);
    badge.title = `${price} Buzz download price (creator view)`;

    badge.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        <path d="M13 3v7h6l-8 11v-7H5l8-11"></path>
      </svg>
      <span>${escapeHtml(price)}</span>
    `;

    return badge;
  }

  function clearButtonAssociation(button) {
    if (!(button instanceof HTMLElement)) return;

    delete button.dataset.civitaiCreatorPriceKey;
    delete button.dataset.civitaiCreatorPriceValue;
    button.querySelectorAll(CUSTOM_BADGE_SELECTOR).forEach((badge) => badge.remove());
  }

  function removeAllCustomBadges() {
    document.querySelectorAll(CUSTOM_BADGE_SELECTOR).forEach((badge) => badge.remove());
  }

  function resetForNewPageIfNeeded() {
    if (location.pathname === currentPathname) return;

    currentPathname = location.pathname;
    priceByDownloadUrl.clear();

    document.querySelectorAll(DOWNLOAD_SELECTOR).forEach(clearButtonAssociation);
    removeAllCustomBadges();
  }

  function ensureBadgeForButton(button) {
    if (!(button instanceof HTMLElement)) return;

    const key = getDownloadKey(button);
    if (!key) {
      clearButtonAssociation(button);
      return;
    }

    // React sometimes reuses the same <a> element for another model/file.
    // Never carry a learned price across an href change.
    const associatedKey = button.dataset.civitaiCreatorPriceKey;
    if (associatedKey && associatedKey !== key) {
      clearButtonAssociation(button);
    }

    const nativeBadges = findNativeBadges(button);
    nativeBadges.forEach((badge) => rememberBadge(badge, button));

    if (nativeBadges.some(isVisiblyRendered)) {
      button.querySelectorAll(CUSTOM_BADGE_SELECTOR).forEach((badge) => badge.remove());
      return;
    }

    const exactButtonPrice =
      button.dataset.civitaiCreatorPriceKey === key
        ? button.dataset.civitaiCreatorPriceValue
        : null;

    // The page-memory fallback is limited to the current pathname and exact download URL.
    const price = exactButtonPrice || priceByDownloadUrl.get(key) || null;
    const existing = button.querySelector(CUSTOM_BADGE_SELECTOR);

    if (!enabled || !price) {
      existing?.remove();
      return;
    }

    if (existing) {
      const displayedPrice = existing.querySelector('span')?.textContent?.trim();
      if (displayedPrice !== price) {
        existing.replaceWith(createGrayBadge(price));
      }
      return;
    }

    if (getComputedStyle(button).position === 'static') {
      button.style.position = 'relative';
    }

    button.append(createGrayBadge(price));
  }

  function renderAll() {
    renderQueued = false;
    resetForNewPageIfNeeded();

    if (!enabled) return;
    document.querySelectorAll(DOWNLOAD_SELECTOR).forEach(ensureBadgeForButton);
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderAll);
  }

  const observer = new MutationObserver((records) => {
    if (!enabled) return;

    resetForNewPageIfNeeded();

    for (const record of records) {
      if (record.type === 'attributes') {
        const button = record.target;
        if (button instanceof HTMLElement && button.matches(DOWNLOAD_SELECTOR)) {
          // href changed: remove any old price before inspecting the new button state.
          clearButtonAssociation(button);
          findNativeBadges(button).forEach((badge) => rememberBadge(badge, button));
        }
        continue;
      }

      const mutationTarget = record.target;
      const fallbackButton =
        mutationTarget instanceof Element
          ? mutationTarget.matches(DOWNLOAD_SELECTOR)
            ? mutationTarget
            : mutationTarget.closest(DOWNLOAD_SELECTOR)
          : null;

      // Added-node records are enough even when React removes the badge immediately;
      // MutationObserver retains the added node in its record. We deliberately do not
      // learn from removed nodes, which could already belong to a reused button.
      for (const node of record.addedNodes) {
        captureAddedNode(node, fallbackButton);
      }
    }

    queueRender();
  });

  function startObserver() {
    if (!document.documentElement) {
      setTimeout(startObserver, 0);
      return;
    }

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    queueRender();
  }

  window.addEventListener('DOMContentLoaded', queueRender, { once: true });
  window.addEventListener('pageshow', queueRender);
  window.addEventListener('popstate', queueRender);

  // Covers SPA navigation and cases where Civitai hides the native badge via CSS.
  setInterval(queueRender, 1000);
  startObserver();
})();
