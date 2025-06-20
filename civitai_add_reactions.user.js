// ==UserScript==
// @name         Civitai Emoji – auto-react 2025-06-20
// @description  Ctrl + Shift + S → add 👍❤️ to every frame in the post under the cursor
// @icon         https://civitai.com/favicon.ico
// @version      0.7
// @author       You
// @match        https://civitai.com/*
// ==/UserScript==

(() => {
  'use strict';

  /* ───── config ───── */
  const SLIDE_DELAY = 20;        // ms between right-arrow clicks

  /* ───── utilities ───── */

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* “Has reactions” = node contains a button whose visible text is 👍 or ❤️ */
  const hasReactions = node =>
    !![...node.querySelectorAll('button')].find(b => /👍|❤️/.test(b.textContent));

  /* find the post card the cursor is in: first ancestor with an id AND reactions */
  function getCard(node) {
    while (node && !(node.id && hasReactions(node))) node = node.parentElement;
    return node;
  }

  /* gallery root = element that owns ➡️ ; fallback = first ancestor with reactions */
  function getGallery(node, card) {
    let withReacts = null;
    while (node && node !== card.parentElement) {
      if (!withReacts && hasReactions(node)) withReacts = node;
      if (node.querySelector('svg.tabler-icon-chevron-right')) return node;
      node = node.parentElement;
    }
    return withReacts;   // single-image card
  }

  const getNextBtn = g =>
    g?.querySelector('svg.tabler-icon-chevron-right')?.closest('button') || null;

  const slideCount = g => {
    const strip = g?.querySelector('div.flex.w-full.gap-px');
    return strip ? strip.querySelectorAll('button').length || 1 : 1;
  };

  const getReactionButtons = g =>
    [...g.querySelectorAll('button')].filter(b => /👍|❤️/.test(b.textContent));

  const isPressed = b =>
    window.getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)';

  /* ───── core: react on ONE gallery ───── */

  async function reactOnGallery(g) {
    if (!g) return;

    const press = () => getReactionButtons(g).forEach(b => { if (!isPressed(b)) b.click(); });

    press();                                           // current frame first

    const next = getNextBtn(g);
    if (!next) return;                                // single-image

    for (let i = 1; i < slideCount(g); i++) {
      next.click();
      await sleep(SLIDE_DELAY);
      press();
    }
  }

  /* ───── run on hovered post (Ctrl+Shift+S) ───── */

  let cx = 0, cy = 0;
  document.addEventListener('mousemove', e => { cx = e.clientX; cy = e.clientY; });

  async function runAllInPost() {
    const elem = document.elementsFromPoint(cx, cy)[0];
    const card = getCard(elem);
    if (!card) return console.log('Emoji: move cursor over a post first.');

    const galleries = new Set(
      [...card.querySelectorAll('button')]
        .filter(b => /👍|❤️/.test(b.textContent))
        .map(b => getGallery(b, card))
        .filter(Boolean)
    );

    for (const g of galleries) {
      await reactOnGallery(g);
      await sleep(20);
    }
  }

  /* ───── hot-key binding ───── */

  window.addEventListener('keydown', e => {
    if (e.key === 'S' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      runAllInPost();
    }
  });

  console.log('✅  Civitai Emoji 0.7 loaded – Ctrl+Shift+S to react');
})();
