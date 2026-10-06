// ==UserScript==
// @name         Civitai Add Reactions
// @namespace    https://civitai.com/
// @version      4.1
// @description  Ctrl+Shift+S (or X): add 👍❤️ to the hovered gallery post/model carousel, or images in an open post; advance right.
// @author       You
// @match        https://civitai.com/*
// @match        https://civitai.green/*
// @match        https://civitai.red/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const TARGETS = [
    { emoji: '👍', label: 'Like reaction' },
    { emoji: '❤️', label: 'Heart reaction' },
  ];
  const AFTER_REACT = 30;
  const POLL_DELAY = 20;
  const SETTLE_DELAY = 80;
  const CHANGE_TIMEOUT = 4000;
  const MAX_SLIDES = 200;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let pointer = null;
  let running = false;

  // Coordinates survive scrolling and DOM replacement; event.target does not.
  window.addEventListener('pointermove', event => {
    pointer = { x: event.clientX, y: event.clientY };
  }, true);
  document.addEventListener('mouseleave', () => { pointer = null; });
  window.addEventListener('blur', () => { pointer = null; });

  function isDisabled(button) {
    return button.disabled || button.getAttribute('aria-disabled') === 'true' ||
      (button.hasAttribute('data-disabled') && button.getAttribute('data-disabled') !== 'false');
  }

  function isActive(button) {
    for (const attribute of ['aria-pressed', 'data-active']) {
      if (button.hasAttribute(attribute)) return button.getAttribute(attribute) === 'true';
    }
    // Civitai's explicit marker also works with custom reaction colors.
    const classes = [...button.classList];
    if (classes.some(name => name.includes('__hasReacted'))) return true;
    if (classes.some(name => name.includes('__reactionBadge'))) return false;
    const variant = button.getAttribute('data-variant');
    return variant === 'light' || variant === 'filled';
  }

  function matchesReaction(button, target) {
    return button.getAttribute('aria-label') === target.label ||
      (button.textContent || '').replace(/\uFE0F/g, '').includes(target.emoji.replace(/\uFE0F/g, ''));
  }

  function reactionGroups(root) {
    const groups = new Set();
    for (const button of root.querySelectorAll('button')) {
      if (button.closest('#comments, [class*="Comment"], [role="menu"], [role="listbox"]')) continue;
      if (button.getAttribute('aria-label') === 'Add reaction' ||
          TARGETS.some(target => matchesReaction(button, target))) {
        groups.add(button.parentElement);
      }
    }
    return [...groups];
  }

  function isRendered(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }

  // Carousel slides must intersect their clipping viewport. Static post images
  // and the viewer's reaction footer only need to be rendered in the document.
  function visibleRect(element, inViewport = false) {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
    if (right <= left || bottom <= top) return null;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
      if (current === element) continue;
      const bounds = current.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
    if (inViewport) {
      left = Math.max(left, 0); right = Math.min(right, window.innerWidth);
      top = Math.max(top, 0); bottom = Math.min(bottom, window.innerHeight);
    }
    return right - left > 1 && bottom - top > 1 ? { left, right, top, bottom } : null;
  }

  function nextButton(root) {
    return [...root.querySelectorAll('button')].find(button => {
      if (!visibleRect(button)) return false;
      const label = button.getAttribute('aria-label') || '';
      return /^(next( image| slide)?|right)$/i.test(label) || button.querySelector(
        'svg.tabler-icon-chevron-right, svg[class*="chevron-right"], svg[class*="ChevronRight"]'
      );
    }) || null;
  }

  function hasMedia(root) {
    return !!root.querySelector('a[href*="/images/"], img:not([alt*="Avatar"]), video, [data-civitai-rating-color]');
  }

  function scopeForGroup(group) {
    let card = null;
    for (let current = group.parentElement; current &&
        !current.matches('body, html, main'); current = current.parentElement) {
      const groups = reactionGroups(current);
      // Multiple groups are allowed within one Embla strip, never across cards
      // or across the image viewer and its comments sidebar.
      if (groups.length > 1) {
        const slides = groups.map(item => item.closest('.transform-3d'));
        if (slides.some(slide => !slide) || slides.some(slide => slide.parentElement !== slides[0].parentElement)) break;
      }
      if (!hasMedia(current)) continue;
      card ||= current;
      if (nextButton(current)) return current;
    }
    return card;
  }

  function collectRoots(container) {
    const roots = [...new Set(reactionGroups(container).map(scopeForGroup).filter(Boolean))];
    return roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
  }

  function hoveredRoot(roots) {
    if (!pointer) return null;
    let hit = document.elementFromPoint(pointer.x, pointer.y);
    for (; hit && !hit.matches('body, html, main'); hit = hit.parentElement) {
      const inside = roots.find(root => root.contains(hit));
      if (inside) return inside;
      // Card headers and indicator bars can be siblings of the media scope.
      const contained = roots.filter(root => hit.contains(root));
      if (contained.length === 1 && reactionGroups(hit).length === reactionGroups(contained[0]).length) {
        return contained[0];
      }
    }
    return null;
  }

  function selectScopes() {
    const url = new URL(location.href);
    const imageView = isImageView(url);
    const postView = /^\/posts\/\d+\/?$/.test(url.pathname);
    // A modal may leave the gallery mounted behind it.
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(dialog =>
      !dialog.closest('.mantine-Popover-dropdown, [role="tooltip"]') &&
      visibleRect(dialog, true) && hasMedia(dialog) && reactionGroups(dialog).length);
    const container = dialogs.at(-1) || document;
    const roots = collectRoots(container);
    if (imageView) {
      const visible = roots.filter(root => visibleRect(root, true));
      // Full-page viewers can coexist with mounted gallery content. Prefer
      // their own reaction row even when the cursor is over a gallery card.
      const detail = visible.filter(root => reactionGroups(root).some(group =>
        !/ImagesAsPostsCard|ModelCarousel/.test(group.className)));
      const root = detail.find(item => nextButton(item)) || detail[0];
      return root ? [{ root, inViewport: false, mode: 'viewer' }] : [];
    }
    if (postView) return roots.map(root => ({ root, inViewport: false, mode: 'post' }));
    const root = hoveredRoot(roots);
    return root ? [{ root, inViewport: true }] : [];
  }

  function isImageView(url) {
    return /^\/(images|videos)\/\d+\/?$/.test(url.pathname) || /^\d+$/.test(url.searchParams.get('imageId') || '');
  }

  async function waitFor(check, timeout = CHANGE_TIMEOUT) {
    const deadline = Date.now() + timeout;
    do {
      if (check()) return true;
      await sleep(POLL_DELAY);
    } while (Date.now() < deadline);
    return false;
  }

  function groupIdentity(group, includeClipped = false) {
    // Use this image's card, not the full carousel: two model previews can be
    // visible at once, and each needs its own reactions.
    for (let current = group.parentElement; current; current = current.parentElement) {
      if (hasMedia(current)) return mediaState(current, !includeClipped);
    }
    return '';
  }

  async function reactIn(root, inViewport, valid, reacted, mode) {
    for (const group of reactionGroups(root)) {
      const includeClipped = mode === 'post';
      const renderedRow = includeClipped || (mode === 'viewer' && !group.closest('.transform-3d'));
      if (!valid() || !(renderedRow ? isRendered(group) : visibleRect(group, inViewport))) continue;
      const identity = groupIdentity(group, includeClipped);
      let buttons = [...group.querySelectorAll('button')];
      if (TARGETS.some(target => !buttons.some(button => matchesReaction(button, target)))) {
        const add = buttons.find(button => button.getAttribute('aria-label') === 'Add reaction');
        if (add && !isDisabled(add)) {
          add.click();
          await waitFor(() => !valid() || !group.isConnected || TARGETS.every(target =>
            [...group.querySelectorAll('button')].some(button => matchesReaction(button, target))));
        }
      }
      // Re-query after each click: React can replace/reorder the buttons.
      for (const target of TARGETS) {
        if (!valid() || !group.isConnected || groupIdentity(group, includeClipped) !== identity) break;
        const key = identity + target.label;
        const button = [...group.querySelectorAll('button')].find(item => matchesReaction(item, target));
        if (!button || isDisabled(button) || isActive(button) || reacted.has(key)) continue;
        button.click();
        reacted.add(key);
        await sleep(AFTER_REACT);
      }
    }
  }

  function mediaState(root, clip = true) {
    const rendered = item => clip ? visibleRect(item) : isRendered(item);
    const media = [...root.querySelectorAll('img, video')].filter(rendered);
    const keys = media.map(item => {
      const source = item.getAttribute('src') || item.getAttribute('poster') ||
        item.querySelector('source')?.getAttribute('src') || '';
      // Different CDN resolutions/posters of the same media share this UUID.
      const asset = source.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0] || source;
      return (item.closest('a[href*="/images/"]')?.getAttribute('href') || '') + ':' + asset;
    });
    const links = [...root.querySelectorAll('a[href*="/images/"]')].filter(rendered)
      .map(item => item.getAttribute('href'));
    const indicators = [...root.querySelectorAll('button[aria-hidden="true"]')];
    const active = indicators.findIndex(item => item.hasAttribute('data-active') && item.getAttribute('data-active') !== 'false');
    return JSON.stringify([keys, links, active]);
  }

  function geometry(root) {
    return JSON.stringify([...root.querySelectorAll('.transform-3d, img, video')].map(item => {
      const rect = item.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width)];
    }));
  }

  async function waitForSlide(root, before, valid) {
    if (!await waitFor(() => !valid() || mediaState(root) !== before)) return false;
    // Embla moves mounted slides without changing img.src. Wait for layout and
    // media identity to settle before reacting to the next slide.
    let previous = '', stableSince = Date.now();
    return waitFor(() => {
      if (!valid()) return true;
      const current = geometry(root) + mediaState(root);
      if (current !== previous) { previous = current; stableSince = Date.now(); }
      return Date.now() - stableSince >= SETTLE_DELAY && reactionGroups(root).some(isRendered);
    });
  }

  async function reactCarousel(root, inViewport, pageUrl, mode) {
    const imageViewer = isImageView(new URL(pageUrl));
    const activeDialog = root.closest('[role="dialog"]');
    // Image viewers update their URL as they advance. Leaving the viewer or
    // closing its modal stops the run; a gallery run also stops on navigation.
    const valid = () => root.isConnected && (!activeDialog || visibleRect(activeDialog, true)) &&
      (imageViewer ? isImageView(new URL(location.href)) : location.href === pageUrl);
    const seen = new Set();
    const reacted = new Set();
    if (mode === 'post') {
      await reactIn(root, false, valid, reacted, mode);
      return;
    }
    for (let index = 0; index < MAX_SLIDES && valid(); index++) {
      const state = mediaState(root);
      if (seen.has(state)) break;
      seen.add(state);
      await reactIn(root, inViewport, valid, reacted, mode);
      const next = nextButton(root);
      if (!valid() || !next || isDisabled(next)) break;
      next.click();
      if (!await waitForSlide(root, state, valid)) break;
    }
  }

  async function reactSelected() {
    if (running) return;
    const scopes = selectScopes();
    if (!scopes.length) {
      console.info('[Civitai Add Reactions] Hover a gallery post or model preview carousel first.');
      return;
    }
    running = true;
    const pageUrl = location.href;
    try {
      for (const { root, inViewport, mode } of scopes) {
        if (location.href !== pageUrl) break;
        await reactCarousel(root, inViewport, pageUrl, mode);
      }
    } catch (error) {
      console.error('[Civitai Add Reactions]', error);
    } finally {
      running = false;
    }
  }

  window.addEventListener('keydown', event => {
    if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
    if (!['S', 'X'].includes((event.key || '').toUpperCase())) return;
    event.preventDefault();
    if (!event.repeat) void reactSelected();
  }, true);

  console.log('Civitai Add Reactions 4.1 – Ctrl+Shift+S / Ctrl+Shift+X');
})();
