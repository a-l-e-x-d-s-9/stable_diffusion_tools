// ==UserScript==
// @name         Civitai Emoji – fixed 2025-04-29
// @description  Hover a gallery and press Ctrl + Shift + S → auto-react 👍 ❤️ on every image.
// @author       You
// @version      0.2
// @match        https://civitai.com/*
// ==/UserScript==

(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  helpers                                                           */
  /* ------------------------------------------------------------------ */

  // Returns the first ancestor that owns a chevron-right navigation button.
  // (works for the “card” *and* the “container” layouts.)
  function findGalleryRoot(startNode) {
    let n = startNode;
    while (n && !n.querySelector('svg.tabler-icon-chevron-right')) n = n.parentElement;
    return n;
  }

  // Right-hand navigation button inside the gallery root.
  function getNextBtn(root) {
    const svg = root.querySelector('svg.tabler-icon-chevron-right');
    return svg ? svg.closest('button') : null;
  }

  // All reaction buttons (👍, ❤️, 😂, 😢 …) visible inside the gallery root.
  function getReactionBtns(root) {
    return [...root.querySelectorAll('button[data-button="true"]')]
      .filter(btn => /👍|❤️/.test(btn.textContent));
  }

  // VERY cheap “already-pressed?” test: pressed buttons have a solid bg,
  // unpressed are transparent.  Works on both light & dark themes.
  function isPressed(btn) {
    return window.getComputedStyle(btn).backgroundColor !== 'rgba(0, 0, 0, 0)';
  }

  // Promise convenience.
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ------------------------------------------------------------------ */
  /*  main loop                                                         */
  /* ------------------------------------------------------------------ */

  async function runAutoReact() {
    // 1) Element under the mouse → gallery root
    const [top] = document.elementsFromPoint(lastX, lastY);
    const root   = findGalleryRoot(top);
    if (!root) return console.log('No gallery under cursor.');

    // 2) First image src – used to detect when we looped around.
    const firstImg = root.querySelector('img');
    if (!firstImg) return console.log('Gallery has no images.');
    const firstSrc = firstImg.currentSrc || firstImg.src;

    const nextBtn = getNextBtn(root);          // may be null for single-image posts

    async function step() {
      // click 👍 / ❤️ if we haven’t yet
      for (const b of getReactionBtns(root)) if (!isPressed(b)) b.click();

      // single-image post? we’re done.
      if (!nextBtn) return;

      // go to next image & wait a little for DOM to update
      nextBtn.click();
      await sleep(250);

      const curImg = root.querySelector('img');
      const curSrc = curImg?.currentSrc || curImg?.src || '';
      if (curSrc && curSrc !== firstSrc) return step();  // recurse
    }

    step();
  }

  /* ------------------------------------------------------------------ */
  /*  key-binding & cursor tracking                                     */
  /* ------------------------------------------------------------------ */

  let lastX = 0, lastY = 0;
  document.addEventListener('mousemove', e => { lastX = e.clientX; lastY = e.clientY; });

  window.addEventListener('keydown', e => {
    if (e.key === 'S' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      runAutoReact();
    }
  });

  console.log('✅  Civitai Emoji 0.2 initialised.');
})();
