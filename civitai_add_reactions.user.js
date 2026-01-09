// ==UserScript==
// @name         Civitai Add Reactions
// @namespace    https://civitai.com/
// @version      1.6
// @description  Add (or remove) 👍 and ❤️ reactions using keyboard shortcuts. Supports model preview, gallery carousel, image page, post page, and review carousel.
// @author       You
// @match        https://civitai.com/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /* ───── config ───── */
  const TARGET_EMOJIS = ['👍', '❤️'];
  const REACTION_RE = new RegExp(`[${TARGET_EMOJIS.join('')}]`);

    const SLIDE_DELAY = 65;
    const WAIT_FAST_MS = 260;
    const WAIT_SLOW_MS = 650;
    const MAX_SLIDES_FALLBACK = 120;

  /* ───── helpers ───── */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function notify(msg, kind = 'info') {
    const old = document.getElementById('civitai-emoji-toast');
    if (old) old.remove();

    const el = document.createElement('div');
    el.id = 'civitai-emoji-toast';
    el.textContent = msg;

    const bg = kind === 'add' ? '#1b5e20'
      : kind === 'remove' ? '#7f1d1d'
      : '#111827';

    el.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'left:16px',
      'z-index:999999',
      'padding:10px 12px',
      'border-radius:10px',
      'background:' + bg,
      'color:#fff',
      'font:13px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
      'max-width:60vw',
      'white-space:pre-wrap'
    ].join(';');

    document.body.appendChild(el);
    setTimeout(() => { if (el && el.parentNode) el.remove(); }, 2200);
  }

  function isDisabled(btn) {
    if (!btn) return true;
    if (btn.disabled) return true;
    const aria = btn.getAttribute('aria-disabled');
    if (aria === 'true') return true;
    const cs = getComputedStyle(btn);
    if (cs.pointerEvents === 'none') return true;
    if (cs.opacity && parseFloat(cs.opacity) < 0.1) return true;
    return false;
  }

function textHasTargetEmoji(el) {
  const t = (el && el.textContent) ? el.textContent.trim() : '';
  return t.startsWith('👍') || t.startsWith('❤️');
}

  /* ───── reaction state detection (add-only safe) ───── */
  function getReactionContainer(el) {
    return el?.closest?.('div[class*="reactions__"], div[class*="_reactions__"], div[class*="reactions"]') || null;
  }

  function collectAllReactionBadgeButtons(container) {
    if (!container) return [];
    const byClass = [...container.querySelectorAll('button[class*="Reactions_reactionBadge__"]')];
    if (byClass.length) return byClass;

    // Fallback: "badge-like" buttons that contain an emoji + a number
    return [...container.querySelectorAll('button')].filter(b => {
      const t = (b.textContent || '').trim();
      return /[\u{1F300}-\u{1FAFF}]/u.test(t) && /\d/.test(t);
    });
  }

  function mostCommon(arr) {
    const m = new Map();
    for (const v of arr) {
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [k, n] of m.entries()) {
      if (n > bestN) { best = k; bestN = n; }
    }
    return best;
  }

  function styleKey(btn) {
    if (!btn) return null;
    const cs = getComputedStyle(btn);
    return [
      cs.backgroundColor,
      cs.borderColor,
      cs.color,
      cs.boxShadow,
      cs.filter,
      cs.outlineColor,
      cs.outlineStyle,
      cs.outlineWidth
    ].join('|');
  }

  function getBaseline(container) {
    const badges = collectAllReactionBadgeButtons(container);
    const variants = badges.map(b => b.getAttribute('data-variant') || '');
    const baselineVariant = mostCommon(variants);

    const keys = badges.map(styleKey);
    const baselineStyle = mostCommon(keys);

    return { baselineVariant, baselineStyle };
  }

  function readPressedState(btn, baseline) {
    if (!btn) return null;

    const ap = btn.getAttribute('aria-pressed');
    if (ap === 'true') return true;
    if (ap === 'false') return false;

    const ac = btn.getAttribute('aria-checked');
    if (ac === 'true') return true;
    if (ac === 'false') return false;

    const da = btn.getAttribute('data-active');
    if (da === 'true') return true;
    if (da === 'false') return false;

    const dv = btn.getAttribute('data-variant');
    if (dv && baseline?.baselineVariant && dv !== baseline.baselineVariant) return true;
    if (dv && baseline?.baselineVariant && dv === baseline.baselineVariant) return false;

    const k = styleKey(btn);
    if (k && baseline?.baselineStyle) return k !== baseline.baselineStyle;

    return null;
  }

  async function ensureFinalState(btn, wantPressed) {
    const container = getReactionContainer(btn) || btn.parentElement;
    const baseline = getBaseline(container);

    let state = readPressedState(btn, baseline);
    if (state === null) {
      // If we cannot safely detect, do nothing rather than risk un-reacting.
      return;
    }
    if (state === wantPressed) return;

    // Try click once, then verify. If it toggled the wrong way (because it was already pressed),
    // the verification will catch it and we will click again to restore.
    btn.click();
    await sleep(140);

    state = readPressedState(btn, baseline);
    if (state === null) return;
    if (state === wantPressed) return;

    btn.click();
    await sleep(140);
  }

  function getReactionButtons(root) {
    if (!root) return [];
    return [...root.querySelectorAll('button')].filter(textHasTargetEmoji);
  }

  function groupTargetButtonsByContainer(root) {
  const m = new Map();
  for (const b of getReactionButtons(root)) {
    const c = getReactionContainer(b) || b.parentElement;
    if (!c) continue;
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(b);
  }
  return m;
}

function containerHasAnyPressedReaction(container) {
  const baseline = getBaseline(container);
  const badges = collectAllReactionBadgeButtons(container);

  for (const b of badges) {
    const st = readPressedState(b, baseline);

    // If we cannot safely detect, treat as "already reacted" to avoid damage.
    if (st === null) return true;

    if (st === true) return true;
  }
  return false;
}

function pickAddButton(btns) {
  // Prefer 👍 then ❤️ (TARGET_EMOJIS order)
  for (const emo of TARGET_EMOJIS) {
    const b = btns.find(x => ((x.textContent || '').trim().startsWith(emo)));
    if (b) return b;
  }
  return btns[0] || null;
}


async function reactButtonsIn(root, mode) {
  const groups = groupTargetButtonsByContainer(root);

  for (const [container, btns] of groups.entries()) {
    if (!container || !container.isConnected) continue;

    if (mode === 'add') {
      // If user already reacted with ANY emoji (including 😂 😢), never override it.
      if (containerHasAnyPressedReaction(container)) continue;

      const b = pickAddButton(btns);
      if (b) await ensureFinalState(b, true);
    } else {
      // remove: only remove 👍/❤️ if they are the active reaction (ensureFinalState handles it safely)
      for (const b of btns) {
        await ensureFinalState(b, false);
        await sleep(25);
      }
    }

    await sleep(25);
  }
}


  /* ───── carousel navigation ───── */
  function findNextButton(root) {
    if (!root) return null;

    // Prefer a local "chevron-right" inside the scope.
    const local = root.querySelector('button svg.tabler-icon-chevron-right, button svg[class*="chevron-right"]');
    if (local) return local.closest('button');

    // Fallback: nearest next-like button in root.
    const btns = [...root.querySelectorAll('button')];
    for (const b of btns) {
      if (b.querySelector('svg.tabler-icon-chevron-right, svg[class*="chevron-right"]')) return b;
    }
    return null;
  }

  function slideCountFromDots(root) {
    if (!root) return null;
    const strip = root.querySelector('div.flex.w-full.gap-px');
    if (!strip) return null;
    const dots = strip.querySelectorAll('button[aria-hidden="true"]');
    if (dots && dots.length) return dots.length;
    return null;
  }

  function slideSignature(root) {
    if (!root) return '';

    const hrefs = [...root.querySelectorAll('a[href^="/images/"]')]
      .slice(0, 6)
      .map(a => a.getAttribute('href') || '')
      .join('|');

    const srcs = [...root.querySelectorAll('img, video source')]
      .slice(0, 6)
      .map(el => el.getAttribute('src') || el.getAttribute('poster') || '')
      .join('|');

    const activeDot = root.querySelector(
      'div.flex.w-full.gap-px button[data-active="true"], ' +
      'div.flex.w-full.gap-px button[aria-current="true"], ' +
      'div.flex.w-full.gap-px button[aria-selected="true"]'
    );
    const activeIdx = activeDot ? [...activeDot.parentElement.querySelectorAll('button')].indexOf(activeDot) : -1;

    return `${hrefs}##${srcs}##${activeIdx}`;
  }

  async function waitForSlideChange(root, prevSig, timeoutMs) {
    const start = Date.now();
    let resolved = false;

    const check = () => slideSignature(root) !== prevSig;

    if (check()) return true;

    await new Promise(resolve => {
      const obs = new MutationObserver(() => {
        if (resolved) return;
        if (check()) {
          resolved = true;
          try { obs.disconnect(); } catch (_) {}
          resolve();
        }
      });

      try { obs.observe(root, { childList: true, subtree: true, attributes: true }); } catch (_) {}

      const tick = async () => {
        while (!resolved && (Date.now() - start) < timeoutMs) {
          if (check()) {
            resolved = true;
            try { obs.disconnect(); } catch (_) {}
            resolve();
            return;
          }
          await sleep(90);
        }
        if (!resolved) {
          resolved = true;
          try { obs.disconnect(); } catch (_) {}
          resolve();
        }
      };
      tick();
    });

    return check();
  }

  async function waitForSlideChangeStaged(root, prevSig) {
    const fast = await waitForSlideChange(root, prevSig, WAIT_FAST_MS);
    if (fast) return true;
    return await waitForSlideChange(root, prevSig, WAIT_SLOW_MS);
  }

  /* ───── scoping ───── */
  function hasReactionButtons(root) {
    if (!root) return false;
    const btn = [...root.querySelectorAll('button')].find(textHasTargetEmoji);
    return !!btn;
  }

  function findSmallestScopeWithMediaAndReactions(startEl) {
    let cur = startEl;
    for (let i = 0; cur && i < 35; i++, cur = cur.parentElement) {
      const hasMedia = !!cur.querySelector('a[href^="/images/"], img, video');
      const hasReacts = hasReactionButtons(cur);
      if (hasMedia && hasReacts) return cur;
    }
    return null;
  }

  function expandScopeToCarouselRoot(scope) {
    if (!scope) return null;

    // Try to find a nearby ancestor that includes both reactions and a next button.
    let cur = scope;
    for (let i = 0; cur && i < 30; i++, cur = cur.parentElement) {
      const hasMedia = !!cur.querySelector('a[href^="/images/"], img, video');
      const hasReacts = hasReactionButtons(cur);
      const hasNext = !!findNextButton(cur);
      if (hasMedia && hasReacts && hasNext) return cur;
    }

    // Otherwise, bubble up to something that at least has a next button.
    cur = scope;
    for (let i = 0; cur && i < 26; i++, cur = cur.parentElement) {
      if (findNextButton(cur)) return cur;
    }

    return scope;
  }

  function getScopeFromCursor(cx, cy) {
    const el = document.elementsFromPoint(cx, cy)[0];
    if (!el) return null;

    const smallest = findSmallestScopeWithMediaAndReactions(el);
    if (smallest) return expandScopeToCarouselRoot(smallest);

    let cur = el;
    for (let i = 0; cur && i < 45; i++, cur = cur.parentElement) {
      if (hasReactionButtons(cur)) return expandScopeToCarouselRoot(cur);
    }
    return null;
  }

  async function reactOnCarousel(initialScope, mode, refreshScopeFn) {
    let scope = initialScope;
    if (!scope) return;

    const dotCount = slideCountFromDots(scope);
    const maxSteps = Math.min(
      MAX_SLIDES_FALLBACK,
      (dotCount && dotCount > 1) ? (dotCount + 3) : MAX_SLIDES_FALLBACK
    );

    const seen = new Set();

    for (let step = 0; step < maxSteps; step++) {
      // Always refresh the scope (React often replaces DOM nodes after navigation).
      const refreshed = refreshScopeFn ? refreshScopeFn() : null;
      if (refreshed) scope = refreshed;

      if (!scope || !scope.isConnected) break;

      const sig = slideSignature(scope);
      if (seen.has(sig)) break;
      seen.add(sig);

      await reactButtonsIn(scope, mode);

      const next = findNextButton(scope);
      if (!next || isDisabled(next)) break;

      next.click();
      await sleep(SLIDE_DELAY);

      const changed = await waitForSlideChangeStaged(scope, sig);
      if (!changed) break;
    }
  }

  /* ───── view-post mode (/posts/...) ───── */
  function getPostReactionGroups() {
    return [...document.querySelectorAll('div[class*="PostImages_reactions__"]')];
  }

  function getHoveredPostGroup(cx, cy) {
    const el = document.elementsFromPoint(cx, cy)[0];
    if (!el) return null;
    return el.closest?.('div[class*="PostImages_reactions__"]') || null;
  }

  async function reactOnViewPost(mode, startFromHovered, cx, cy) {
    const groups = getPostReactionGroups();
    if (groups.length === 0) return;

    let startIdx = 0;
    if (startFromHovered) {
      const hovered = getHoveredPostGroup(cx, cy);
      if (hovered) {
        const idx = groups.indexOf(hovered);
        if (idx >= 0) startIdx = idx;
      }
    }

    for (let i = startIdx; i < groups.length; i++) {
      const g = groups[i];
      try { g.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
      await sleep(120);
      await reactButtonsIn(g, mode);
      await sleep(80);
    }
  }

  /* ───── entrypoints ───── */
  let cx = 0, cy = 0;
  document.addEventListener('mousemove', e => { cx = e.clientX; cy = e.clientY; }, { passive: true });

  function isViewPostPage() {
    return (location.pathname || '').startsWith('/posts/');
  }

  async function reactToHovered(mode = 'add') {
    notify(`${mode === 'add' ? 'Adding' : 'Removing'} 👍❤️ ...`, mode);

    if (isViewPostPage()) {
      await reactOnViewPost(mode, true, cx, cy);
      notify('Done.', mode);
      return;
    }

    const refresh = () => getScopeFromCursor(cx, cy);
    const scope = refresh();
    if (!scope) {
      notify('Move cursor over an image/post first.', 'info');
      return;
    }

    if (findNextButton(scope)) {
      await reactOnCarousel(scope, mode, refresh);
    } else {
      await reactButtonsIn(scope, mode);
    }

    notify('Done.', mode);
  }

  async function reactToAllVisible(mode = 'add') {
    notify(`${mode === 'add' ? 'Adding' : 'Removing'} 👍❤️ ...`, mode);

    if (isViewPostPage()) {
      await reactOnViewPost(mode, false, cx, cy);
      notify('Done.', mode);
      return;
    }

    const buttons = [...document.querySelectorAll('button')].filter(textHasTargetEmoji);

    if (buttons.length === 0) {
      notify('No reaction buttons found on this page.', 'info');
      return;
    }

    const scopes = new Set();
    for (const b of buttons) {
      const s = findSmallestScopeWithMediaAndReactions(b) || b.parentElement;
      if (s) scopes.add(expandScopeToCarouselRoot(s));
    }

    let n = 0;
    for (const s of scopes) {
      if (!s || !s.isConnected) continue;
      if (findNextButton(s)) {
        await reactOnCarousel(s, mode, null);
      } else {
        await reactButtonsIn(s, mode);
      }
      n++;
      await sleep(60);
    }

    notify(`Finished on ${n} target(s).`, mode);
  }

  /* ───── UI and hotkeys ───── */
  function createShortcutButton() {
    const button = document.createElement('button');
    button.id = 'civitai-emoji-button';
    button.textContent = '👍';
    button.title = 'Civitai Auto-React Shortcuts';
    document.body.appendChild(button);

    button.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:999999',
      'width:44px',
      'height:44px',
      'border-radius:999px',
      'border:none',
      'background:#111827',
      'color:#fff',
      'cursor:pointer',
      'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
      'font-size:18px'
    ].join(';');

    function showHelp() {
      let panel = document.querySelector('#civitai-help');
      if (panel) { panel.remove(); return; }

      panel = document.createElement('div');
      panel.id = 'civitai-help';
      panel.style.cssText = [
        'position:fixed',
        'bottom:72px',
        'right:16px',
        'z-index:999999',
        'padding:12px 12px',
        'border-radius:12px',
        'background:#0b1220',
        'color:#fff',
        'white-space:pre-wrap',
        'font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif',
        'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
        'max-width:360px'
      ].join(';');

      panel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<div style="font-weight:700">Civitai Auto-React</div>' +
          '<div class="close" style="cursor:pointer;opacity:.8">x</div>' +
        '</div>' +
        'Hovered target\n' +
        '  Add:    Ctrl + Shift + S\n' +
        '  Remove: Ctrl + Shift + Win + S\n\n' +
        'All visible targets\n' +
        '  Add:    Ctrl + Shift + A\n' +
        '  Remove: Ctrl + Shift + Win + A\n\n' +
        'Notes\n' +
        '  On /posts/... pages, S processes from hovered image down.\n' +
        '  A processes the full post.\n' +
        '  Carousels stop on wrap-around (repeat detection).';
      panel.querySelector('.close').onclick = () => panel.remove();
      document.body.appendChild(panel);
    }

    button.addEventListener('click', showHelp);
  }

  window.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;

    if (e.altKey) return;
    if (!e.ctrlKey || !e.shiftKey) return;

    const mode = e.metaKey ? 'remove' : 'add';

    switch ((e.key || '').toUpperCase()) {
      case 'S':
        e.preventDefault();
        reactToHovered(mode);
        break;
      case 'A':
        e.preventDefault();
        reactToAllVisible(mode);
        break;
    }
  }, true);

  createShortcutButton();
  console.log('✅ Civitai Auto-React Helper 1.5 loaded (👍❤️).');
})();