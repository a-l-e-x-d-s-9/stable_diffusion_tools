// ==UserScript==
// @name         Civitai - Remove Top Banner Above Header Navigation
// @namespace    https://civitai.com/
// @version      1.0
// @description  Removes the extra banner button placed above top navigation blocks on Civitai
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

      if (first.tagName === 'BUTTON' && isHeaderNavBlock(second)) {
        return { banner: first, nav: second, container };
      }
    }

    return null;
  }

  function findBanner(root = document) {
    const candidates = root.querySelectorAll
      ? root.querySelectorAll('div.sticky, div[class*="sticky"]')
      : [];

    for (const container of candidates) {
      const found = findBannerPairInContainer(container);
      if (found) return found;
    }

    return null;
  }

  function removeBanner(root = document) {
    const found = findBanner(root);
    if (!found) return false;

    const { banner } = found;
    if (banner.getAttribute(PROCESSED_ATTR) === '1') return true;

    banner.setAttribute(PROCESSED_ATTR, '1');
    banner.remove();
    return true;
  }

  function scan(root = document) {
    removeBanner(document);

    if (root !== document && isElement(root)) {
      removeBanner(root);
    }
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
  }

  init();
})();