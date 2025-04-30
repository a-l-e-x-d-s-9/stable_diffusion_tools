// ==UserScript==
// @name         Civitai Emoji – auto-react 2025-04-29
// @description  Ctrl+Shift+S → hovered post • Ctrl+Shift+A → every gallery inside that post
// @version      0.6
// @author       You
// @match        https://civitai.com/*
// ==/UserScript==

(() => {
  'use strict';

  /* ── tweakables ────────────────────────────────────────── */
  const SLIDE_DELAY = 20;          // ms between ➡️ clicks

  /* ── helpers ───────────────────────────────────────────── */

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Outer card element = first ancestor that
      – has a random `id`,  and
      – owns at least one reaction-button set. */
  function getCard(node) {
    while (node &&
           !(node.id && node.querySelector('button[data-button="true"]')))
      node = node.parentElement;
    return node;
  }

  /** Gallery root inside a card = ancestor that owns the right-arrow.
      If the card has only 1 image (no arrow) return the
      nearest ancestor that contains the reaction strip. */
  function getGallery(node, card) {
    let withButtons = null;
    while (node && node !== card.parentElement) {
      if (!withButtons && node.querySelector('button[data-button="true"]'))
        withButtons = node;
      if (node.querySelector('svg.tabler-icon-chevron-right'))
        return node;                       // multi-image gallery
      node = node.parentElement;
    }
    return withButtons;                    // single-image fallback
  }

  const getNextBtn     = g =>
    g?.querySelector('svg.tabler-icon-chevron-right')?.closest('button') || null;

  const slidesInGallery = g => {
    const strip = g?.querySelector('div.flex.w-full.gap-px');
    return strip ? strip.querySelectorAll('button').length || 1 : 1;
  };

  const getReactBtns   = g =>
    [...g.querySelectorAll('button[data-button="true"]')]
      .filter(b => /👍|❤️/.test(b.textContent));

  const isPressed      = b =>
    window.getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)';

  /* ── core: react on ONE gallery ───────────────────────── */

  async function reactOnGallery(gallery) {
    if (!gallery) return;

    const clickReactions = () =>
      getReactBtns(gallery).forEach(b => { if (!isPressed(b)) b.click(); });

    clickReactions();                              // current frame

    const nextBtn = getNextBtn(gallery);
    if (!nextBtn) return;                          // single-image

    const total = slidesInGallery(gallery);
    for (let i = 1; i < total; i++) {              // walk rightward
      nextBtn.click();
      await sleep(SLIDE_DELAY);
      clickReactions();
    }
  }

  /* ── mouse tracking ──────────────────────────────────── */

  let mx = 0, my = 0;
  document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });

  /* ── hot-key: hovered post (Ctrl+Shift+S) ────────────── */

  async function runHovered() {
    const elem  = document.elementsFromPoint(mx, my)[0];
    const card  = getCard(elem);
    const gal   = getGallery(elem, card);
    if (!gal) return console.log('Emoji: move cursor over a post first.');
    await reactOnGallery(gal);
  }

  /* ── hot-key: all galleries in the same post (Ctrl+Shift+A) ───── */

  async function runAll() {
    const elem  = document.elementsFromPoint(mx, my)[0];
    const card  = getCard(elem);
    if (!card)  return console.log('Emoji: move cursor over a post first.');

    const galleries = new Set(
      [...card.querySelectorAll('button[data-button="true"]')]
        .map(btn => getGallery(btn, card))
        .filter(Boolean)
    );

    for (const g of galleries) {
      await reactOnGallery(g);
      await sleep(20);
    }
    //console.log(`✅ reacted on ${galleries.size} galleries in this post`);
  }

  /* ── key bindings ────────────────────────────────────── */

  window.addEventListener('keydown', e => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    //if (e.key === 'S') { e.preventDefault(); runHovered(); }
    if (e.key === 'S') { e.preventDefault(); runAll();     }
  });

  //console.log('✅  Civitai Emoji 0.6 – S = single, A = all, delay =', SLIDE_DELAY, 'ms');
})();
