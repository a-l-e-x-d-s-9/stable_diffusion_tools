// ==UserScript==
// @name         Civitai - Remove Top Banner Above Header Navigation
// @namespace    https://civitai.com/
// @version      1.3
// @description  Removes the extra promo/rewards banner placed at the top of Civitai pages
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @match        https://civitai.green/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PROCESSED_ATTR = 'data-tm-top-banner-removed';

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function getClassText(el) {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
    return '';
  }

  function hasClassPart(el, part) {
    if (!isElement(el)) return false;
    return getClassText(el).includes(part);
  }

  function isLikelyFullWidthTopBannerButton(el) {
    if (!isElement(el) || el.tagName !== 'BUTTON') return false;
    if (el.getAttribute(PROCESSED_ATTR) === '1') return false;

    const cls = getClassText(el);
    const txt = textOf(el);
    const aria = textOf({ textContent: el.getAttribute('aria-label') || '' });

    const hasFullWidthLayout =
      cls.includes('w-full') ||
      cls.includes('flex') ||
      el.style.width === '100%';

    const hasBannerShape =
      cls.includes('items-center') &&
      cls.includes('justify-center') &&
      cls.includes('overflow-hidden');

    const hasAnimatedGradientChild =
      !!el.querySelector(
        '[class*="animate-gradient-shift"], ' +
        '[class*="animate-shimmer"], ' +
        '[class*="bg-gradient-to-r"]'
      );

    const hasKnownPromoText =
      txt.includes('BONUS') ||
      txt.includes('REWARDS') ||
      txt.includes('BUZZ') ||
      aria.includes('REWARDS') ||
      aria.includes('BONUS');

    const hasPromoIconHints =
      !!el.querySelector(
        'svg[class*="tabler-icon-bolt"], ' +
        'svg[class*="tabler-icon-sparkles"]'
      );

    return (
      hasFullWidthLayout &&
      hasBannerShape &&
      hasAnimatedGradientChild &&
      (hasKnownPromoText || hasPromoIconHints)
    );
  }

  function getDirectChildAnchors(el) {
    if (!isElement(el)) return [];
    return Array.from(el.querySelectorAll('a[href]'));
  }

  function isHomeLikeNavBlock(el) {
    if (!isElement(el) || el.tagName !== 'DIV') return false;

    const links = getDirectChildAnchors(el);
    if (links.length < 4) return false;

    const hrefs = links
      .map(a => (a.getAttribute('href') || '').trim())
      .filter(Boolean);

    const wanted = ['/', '/models', '/images', '/videos', '/posts', '/articles'];
    let hits = 0;

    for (const item of wanted) {
      if (hrefs.includes(item)) hits++;
    }

    return hits >= 4;
  }

  function isUserSegmentedNavBlock(el) {
    if (!isElement(el) || el.tagName !== 'DIV') return false;

    const links = getDirectChildAnchors(el);
    if (links.length < 3) return false;

    const hrefs = links
      .map(a => (a.getAttribute('href') || '').trim())
      .filter(Boolean);

    const userLinks = hrefs.filter(href =>
      /^\/user\/[^/]+(?:\/(?:models|posts|images|videos|articles|collections|bounties|reviews|buzz|about)?)?$/.test(href)
    );

    if (userLinks.length >= 3) return true;

    const hasRadioGroup = !!el.querySelector('[role="radiogroup"]');
    const hasSegmentedInputs = el.querySelectorAll('input[type="radio"]').length >= 2;

    return hasRadioGroup && hasSegmentedInputs && userLinks.length >= 2;
  }

  function isHeaderNavBlock(el) {
    return isHomeLikeNavBlock(el) || isUserSegmentedNavBlock(el);
  }

  function findBannerPairInContainer(container) {
    if (!isElement(container) || container.tagName !== 'DIV') return null;

    const children = Array.from(container.children).filter(isElement);
    if (children.length < 2) return null;

    for (let i = 0; i < children.length - 1; i++) {
      const first = children[i];
      const second = children[i + 1];

      if (
        first.tagName === 'BUTTON' &&
        (isHeaderNavBlock(second) || isLikelyFullWidthTopBannerButton(first))
      ) {
        return { banner: first, next: second, container };
      }
    }

    return null;
  }

  function removeElement(el) {
    if (!isElement(el)) return false;
    if (el.getAttribute(PROCESSED_ATTR) === '1') return true;

    el.setAttribute(PROCESSED_ATTR, '1');
    el.remove();
    return true;
  }

  function removeBannerAboveNav(root = document) {
    const candidates = root.querySelectorAll
      ? root.querySelectorAll('div.sticky, div[class*="sticky"]')
      : [];

    for (const container of candidates) {
      const found = findBannerPairInContainer(container);
      if (found && removeElement(found.banner)) return true;
    }

    return false;
  }

  function removeGenericTopPromoButtons(root = document) {
    let removed = false;

    const scope = root.querySelectorAll ? root : document;
    const buttons = Array.from(scope.querySelectorAll('button'));

    if (isElement(root) && root.tagName === 'BUTTON') {
      buttons.unshift(root);
    }

    for (const btn of buttons) {
      if (!isLikelyFullWidthTopBannerButton(btn)) continue;

      const parent = btn.parentElement;
      if (!parent) continue;

      const siblings = Array.from(parent.children).filter(isElement);
      const index = siblings.indexOf(btn);

      const isNearTop = index >= 0 && index <= 1;
      const parentLooksLikeLayout =
        parent.tagName === 'MAIN' ||
        parent.tagName === 'DIV' ||
        hasClassPart(parent, 'flex') ||
        hasClassPart(parent, 'sticky') ||
        hasClassPart(parent, 'overflow-hidden');

      if (isNearTop && parentLooksLikeLayout) {
        removed = removeElement(btn) || removed;
      }
    }

    return removed;
  }

  function removeBanners(root = document) {
    const a = removeBannerAboveNav(document);
    const b = removeGenericTopPromoButtons(document);

    if (root !== document && isElement(root)) {
      const c = removeBannerAboveNav(root);
      const d = removeGenericTopPromoButtons(root);
      return a || b || c || d;
    }

    return a || b;
  }

  function scan(root = document) {
    removeBanners(root);
  }

  function init() {
    scan(document);

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (isElement(node)) {
            scan(node);
          }
        }
      }
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener('load', () => {
      scan(document);
    }, { once: true });

    setTimeout(() => scan(document), 250);
    setTimeout(() => scan(document), 1000);
    setTimeout(() => scan(document), 2500);
  }

  init();
})();