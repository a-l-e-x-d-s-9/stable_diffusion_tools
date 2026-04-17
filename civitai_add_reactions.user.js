// ==UserScript==
// @name         Civitai Add Reactions
// @namespace    https://civitai.com/
// @version      3.0
// @description  Ctrl+Shift+X → add 👍❤️ to everything visible on the page
// @author       You
// @match        https://civitai.com/*
// @match        https://civitai.green/*
// @match        https://civitai.red/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /* ── config ── */
  const SLIDE_DELAY  = 25;   // ms between carousel arrow clicks
  const AFTER_REACT  = 35;   // ms after clicking a reaction button
  const TARGET       = ['👍', '❤️'];

  /* ── utils ── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const hasEmoji = el => TARGET.some(e => (el.textContent || '').includes(e));

  const getReactBtns = root =>
    [...root.querySelectorAll('button')].filter(hasEmoji);

  /* Is this reaction button already active? */
  function isActive(btn) {
    const ap = btn.getAttribute('aria-pressed');
    if (ap === 'true')  return true;
    if (ap === 'false') return false;

    const da = btn.getAttribute('data-active');
    if (da === 'true')  return true;
    if (da === 'false') return false;

    const dv = btn.getAttribute('data-variant');
    if (dv) return dv !== 'subtle' && dv !== 'default';

    /* fallback: transparent bg = unpressed */
    const bg = getComputedStyle(btn).backgroundColor;
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
  }

  async function pressIfNeeded(btn) {
    if (!btn || btn.disabled) return;
    if (isActive(btn)) return;
    btn.click();
    await sleep(AFTER_REACT);
  }

  async function reactIn(root) {
    for (const btn of getReactBtns(root)) await pressIfNeeded(btn);
  }

  /* ── carousel handling ── */

  function getNextBtn(root) {
    const svg = root.querySelector(
      'svg.tabler-icon-chevron-right, svg[class*="chevron-right"], svg[class*="ChevronRight"]'
    );
    if (svg) return svg.closest('button');

    for (const b of root.querySelectorAll('button')) {
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      if (lbl.includes('next') || lbl.includes('right')) return b;
    }
    return null;
  }

  function slideCount(root) {
    const strip = root.querySelector('div.flex.w-full.gap-px');
    if (strip) {
      const dots = strip.querySelectorAll('button[aria-hidden="true"]');
      if (dots.length) return dots.length;
      const all = strip.querySelectorAll('button');
      if (all.length) return all.length;
    }
    return null;
  }

  function sig(root) {
    const imgs  = [...root.querySelectorAll('img, video')]
      .slice(0, 5).map(e => e.src || e.currentSrc || e.getAttribute('poster') || '').join('|');
    const links = [...root.querySelectorAll('a[href*="/images/"]')]
      .slice(0, 5).map(a => a.getAttribute('href') || '').join('|');
    return imgs + '§' + links;
  }

  async function waitChange(root, prev, timeout = 450) {
    const t = Date.now() + timeout;
    while (Date.now() < t) {
      if (sig(root) !== prev) return true;
      await sleep(30);
    }
    return false;
  }

  async function reactCarousel(root) {
    const next  = getNextBtn(root);
    const total = next ? (slideCount(root) ?? 60) : 1;
    const seen  = new Set();

    for (let i = 0; i < Math.min(total + 3, 200); i++) {
      const s = sig(root);
      if (seen.has(s)) break;
      seen.add(s);

      await reactIn(root);

      const nb = getNextBtn(root);
      if (!nb || nb.disabled) break;
      nb.click();
      await sleep(SLIDE_DELAY);
      if (!await waitChange(root, s)) break;
    }
  }

  /* ── scope collection ── */

  function findRoot(btn) {
    let withReacts = null;
    let cur = btn.parentElement;

    while (cur && cur !== document.documentElement) {
      if ([...cur.querySelectorAll('button')].some(hasEmoji)) {
        withReacts = cur;
        if (getNextBtn(cur)) return cur;
      }
      cur = cur.parentElement;
    }
    return withReacts;
  }

  function collectRoots() {
    const allBtns = [...document.querySelectorAll('button')].filter(hasEmoji);
    const roots   = new Set();

    for (const btn of allBtns) {
      const r = findRoot(btn);
      if (r) roots.add(r);
    }

    /* Keep only the most specific roots — drop ancestors */
    const arr = [...roots];
    return arr.filter(r => !arr.some(other => other !== r && r.contains(other)));
  }

  /* ── main ── */
  async function reactAll() {
    const roots = collectRoots();
    for (const root of roots) {
      if (!root.isConnected) continue;
      await reactCarousel(root);
      await sleep(15);
    }
  }

  /* ── hotkey: Ctrl + Shift + X only ── */
  window.addEventListener('keydown', e => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if ((e.key || '').toUpperCase() !== 'S') return;
    e.preventDefault();
    reactAll();
  }, true);

  console.log('Civitai Auto-React 3.0 – Ctrl+Shift+X');
})();