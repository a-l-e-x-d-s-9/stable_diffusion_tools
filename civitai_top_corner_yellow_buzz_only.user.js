// ==UserScript==
// @name         Civitai - Show Yellow Buzz Only
// @namespace    https://civitai.com/
// @version      1.1.0
// @description  Shows only Yellow Buzz in Civitai's top-right account button.
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

  const state = {
    lastCombinedText: '',
    lastCombinedGradient: '',
    lastAppliedYellow: '',
    updatePending: false,
  };

  console.info('[Civitai Yellow Buzz] Script v1.1.0 loaded');

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

    if (!yellowText) return;

    forceYellowAppearance(top.root, top.text);

    if (top.text.textContent.trim().toUpperCase() !== yellowText) {
      top.text.textContent = yellowText;
    }

    state.lastAppliedYellow = yellowText;

    top.text.title = state.lastCombinedText
      ? `Yellow Buzz only — combined total: ${state.lastCombinedText}`
      : 'Yellow Buzz only';
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

    /*
      Civitai is a React application and can replace the header after route
      changes. The interval repairs the display if that happens.
    */
    setInterval(queueUpdate, 750);

    runSeveralTimes();
  }

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, {
      once: true,
    });
  }
})();
