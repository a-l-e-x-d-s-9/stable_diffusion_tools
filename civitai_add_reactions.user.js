// ==UserScript==
// @name         Civitai Auto-React Helper
// @description  Adds/removes 👍❤️. Ctrl+Shift+S/A to add; hold Win to remove.
// @icon         https://civitai.com/favicon.ico
// @version      1.1
// @author       You (revised by Gemini+GPT)
// @match        https://civitai.com/*
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  'use strict';

  /* ───── config ───── */
  const SLIDE_DELAY = 60; // ms between right-arrow clicks
  const NOTIFY_MS = 2200;

  /* ───── styles for notifications ───── */
  GM_addStyle(`
    #civitai-react-notifier {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      color: #fff;
      padding: 10px 14px;
      border-radius: 8px;
      font: 600 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,.3);
      opacity: .95;
    }
    #civitai-react-notifier.add { background: #27ae60; }   /* green */
    #civitai-react-notifier.remove { background: #c0392b; }/* red */
    #civitai-react-notifier.info { background: #4b5563; }  /* gray */
  `);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const hasReactions = node =>
    !![...node.querySelectorAll('button')].find(b => /👍|❤️/.test(b.textContent));

  function getCard(node) {
    return node.closest('div[style*="transform: translateY"]');
  }

  function getGallery(node, card) {
    let withReacts = null;
    while (node && node !== card.parentElement) {
      if (!withReacts && hasReactions(node)) withReacts = node;
      if (node.querySelector('svg.tabler-icon-chevron-right')) return node;
      node = node.parentElement;
    }
    return withReacts; // single-image fallback
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
    // "Pressed" has a non-transparent background
    !['transparent', 'rgba(0, 0, 0, 0)'].includes(
      window.getComputedStyle(b).backgroundColor
    );

  /* ───── notifications ───── */
  function notify(message, kind = 'info') {
    document.querySelector('#civitai-react-notifier')?.remove();
    const el = document.createElement('div');
    el.id = 'civitai-react-notifier';
    el.className = kind; // add | remove | info
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), NOTIFY_MS);
  }

  /* ───── core: react on ONE gallery ───── */
  async function reactOnGallery(g, mode = 'add') {
    if (!g) return;

    const press = () => {
      getReactionButtons(g).forEach(b => {
        const pressed = isPressed(b);
        if (mode === 'add' && !pressed) b.click();
        if (mode === 'remove' && pressed) b.click();
      });
    };

    // current frame
    press();

    const next = getNextBtn(g);
    if (!next) return; // single-image post

    // other frames
    for (let i = 1; i < slideCount(g); i++) {
      next.click();
      await sleep(SLIDE_DELAY);
      press();
    }
  }

  /* ───── action functions ───── */
  let cx = 0, cy = 0;
  document.addEventListener('mousemove', e => { cx = e.clientX; cy = e.clientY; });

  async function reactToHoveredPost(mode = 'add') {
    const elem = document.elementsFromPoint(cx, cy)[0];
    const card = getCard(elem);
    if (!card) {
      notify('Move cursor over a post first.', 'info');
      return;
    }
    notify(`${mode === 'add' ? 'Adding' : 'Removing'} 👍❤️ for hovered post…`, mode);

    const galleries = new Set(
      [...card.querySelectorAll('button')]
        .filter(b => /👍|❤️/.test(b.textContent))
        .map(b => getGallery(b, card))
        .filter(Boolean)
    );

    for (const g of galleries) {
      await reactOnGallery(g, mode);
      await sleep(50);
    }
    notify(`Done (${galleries.size} gallery${galleries.size !== 1 ? 'ies' : ''}).`, mode);
  }

  async function reactToAllVisiblePosts(mode = 'add') {
    const cards = document.querySelectorAll('div[style*="transform: translateY"]');
    if (cards.length === 0) {
      notify('No posts found on the page.', 'info');
      return;
    }
    notify(`${mode === 'add' ? 'Adding' : 'Removing'} 👍❤️ for visible posts…`, mode);

    for (const card of cards) {
      const galleries = new Set(
        [...card.querySelectorAll('button')]
          .filter(b => /👍|❤️/.test(b.textContent))
          .map(b => getGallery(b, card))
          .filter(Boolean)
      );
      for (const g of galleries) {
        await reactOnGallery(g, mode);
        await sleep(50);
      }
    }
    notify(`Finished ${mode === 'add' ? 'adding' : 'removing'} on ${cards.length} post(s).`, mode);
  }

  /* ───── UI and hot-key binding ───── */
  function createShortcutButton() {
    GM_addStyle(`
      #civitai-emoji-button {
        position: fixed;
        bottom: 12px;
        right: 100px;
        z-index: 9999;
        background-color: #1a1b1e;
        color: #c1c2c5;
        border: 1px solid #373a40;
        border-radius: 50%;
        width: 20px;
        height: 20px;
        font-size: 15px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        transition: transform 0.2s ease, background-color 0.2s ease;
      }
      #civitai-emoji-button:hover {
        transform: scale(1.1);
        background-color: #2c2e33;
      }
      #civitai-help {
        position: fixed; right: 76px; bottom: 76px; z-index: 10000;
        background: #1a1b1e; color: #c1c2c5; border: 1px solid #373a40;
        border-radius: 12px; padding: 14px 16px; width: 360px;
        white-space: pre-line; line-height: 1.3;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
      }
      #civitai-help .close { position: absolute; top: 6px; right: 8px; cursor: pointer; opacity: .7; }
    `);

    const button = document.createElement('button');
    button.id = 'civitai-emoji-button';
    button.textContent = '👍';
    button.title = 'Civitai Auto-React Shortcuts';

    document.body.appendChild(button);

     function showHelp() {
        let panel = document.querySelector('#civitai-help');
        if (panel) { panel.remove(); return; } // toggle

        panel = document.createElement('div');
        panel.id = 'civitai-help';
        panel.innerHTML =
            '<div class="close">✕</div>' +
            'Civitai Auto-React Shortcuts\n\n' +
            '► Hovered post\n' +
            '   Add:    Ctrl + Shift + S\n' +
            '   Remove: Ctrl + Shift + Win + S\n\n' +
            '► All visible posts\n' +
            '   Add:    Ctrl + Shift + A\n' +
            '   Remove: Ctrl + Shift + Win + A';
        panel.querySelector('.close').onclick = () => panel.remove();
        document.body.appendChild(panel);
    }

    // replace the old alert(...) with:
    button.addEventListener('click', showHelp);
  }

  // Hotkeys:
  // - Add:    Ctrl+Shift+S / Ctrl+Shift+A
  // - Remove: Ctrl+Shift+Win+S / Ctrl+Shift+Win+A
  window.addEventListener('keydown', e => {
    if (e.altKey) return; // ignore Cmd/Win
    if (!e.ctrlKey || !e.shiftKey) return;

    const mode = e.metaKey ? 'remove' : 'add';

    switch (e.key.toUpperCase()) {
      case 'S':
        e.preventDefault();
        reactToHoveredPost(mode);
        break;
      case 'A':
        e.preventDefault();
        reactToAllVisiblePosts(mode);
        break;
    }
  });


    createShortcutButton();
    console.log('✅ Civitai Auto-React Helper 1.1 loaded (👍❤️).');
})();
