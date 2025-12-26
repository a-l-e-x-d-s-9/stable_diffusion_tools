// ==UserScript==
// @name         Grok Imagine - Auto Favorite (Like/Unlike All)
// @namespace    grok_imagine_auto_favorite
// @version      0.11.0
// @description  Auto-like (default) or auto-unlike tiles by clicking the heart buttons injected by the Quick Favorite script. Includes persistent draggable UI, minimize/hide, and Tampermonkey menu commands.
// @match        https://grok.com/imagine*
// @match        https://www.grok.com/imagine*
// @match        https://grok.com/imagine/post/*
// @match        https://www.grok.com/imagine/post/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  // This script expects the "Quick Favorite (Heart) Button" script to be installed and running,
  // since it clicks the injected .grok-fav-btn buttons.

  const LS_PREFIX = 'grok_auto_fav.v2.';
  const K_SETTINGS = LS_PREFIX + 'settings';
  const K_POS = LS_PREFIX + 'pos';              // { x: 0..1, y: 0..1 }
  const K_PANEL_STATE = LS_PREFIX + 'panelState'; // 'open' | 'min' | 'hidden'

  const DEFAULTS = {
    enabled: false,
    mode: 'like',        // 'like' or 'unlike'
    delayMs: 900,
    onlyVisible: true,
    debug: false
  };

  const DEFAULT_PANEL_STATE = 'open';

  const state = {
    lastActionAt: 0,
    tickTimer: null,
    scanTimer: null,
    counters: {
      clicked: 0,
      success: 0,
      failed: 0,
      retries: 0
    }
  };

  // Queue-based processing (avoid re-checking same buttons repeatedly)
  const seenBtns = new WeakSet();       // discovered
  const readySet = new WeakSet();       // queued
  const readyQueue = [];               // FIFO
  const retryMap = new WeakMap();      // btn -> retry count
  let mo = null;                       // MutationObserver
  let io = null;                       // IntersectionObserver

  // UI state
  let settings = loadJson(K_SETTINGS, null);
  if (!settings || typeof settings !== 'object') settings = { ...DEFAULTS };
  settings = { ...DEFAULTS, ...settings };

  let panelState = lsGet(K_PANEL_STATE, DEFAULT_PANEL_STATE);
  if (panelState !== 'open' && panelState !== 'min' && panelState !== 'hidden') {
    panelState = DEFAULT_PANEL_STATE;
  }

  const ui = {
    root: null,
    header: null,
    title: null,
    btnMin: null,
    btnClose: null,
    content: null,

    enabled: null,
    like: null,
    unlike: null,
    delay: null,
    onlyVisible: null,
    debug: null,

    status: null,
    counters: null,
    queue: null
  };

  function log(...a) {
    if (settings.debug) console.log('[AutoFav]', ...a);
  }

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function loadJson(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (_) {}
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function isActuallyVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null) return false;
    const cs = getComputedStyle(el);
    if (!cs) return true;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    return true;
  }

  function isInViewport(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const pad = 80;
    return (
      r.bottom > -pad &&
      r.right > -pad &&
      r.top < (window.innerHeight + pad) &&
      r.left < (window.innerWidth + pad)
    );
  }

  // ---------- Position (ratio-based, clamped) ----------
  function getSavedPos() {
    const pos = loadJson(K_POS, null);
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      return { x: clamp(pos.x, 0, 1), y: clamp(pos.y, 0, 1) };
    }
    return null;
  }

  function maxLeft() {
    if (!ui.root) return 0;
    return Math.max(0, window.innerWidth - ui.root.offsetWidth);
  }

  function maxTop() {
    if (!ui.root) return 0;
    return Math.max(0, window.innerHeight - ui.root.offsetHeight);
  }

  function applyPosFromRatios(pos) {
    if (!ui.root || !pos) return;
    const ml = maxLeft();
    const mt = maxTop();
    const left = Math.round(clamp(pos.x, 0, 1) * ml);
    const top = Math.round(clamp(pos.y, 0, 1) * mt);

    ui.root.style.left = left + 'px';
    ui.root.style.top = top + 'px';
    ui.root.style.right = 'auto';
    ui.root.style.bottom = 'auto';
  }

  function savePosFromRect() {
    if (!ui.root) return;
    const rect = ui.root.getBoundingClientRect();
    const ml = maxLeft();
    const mt = maxTop();

    const x = ml ? clamp(rect.left / ml, 0, 1) : 0;
    const y = mt ? clamp(rect.top / mt, 0, 1) : 0;

    saveJson(K_POS, { x, y });
  }

  function restorePosOrDefault() {
    const pos = getSavedPos();
    if (pos) {
      applyPosFromRatios(pos);
      return;
    }
    // Default: bottom-left-ish
    applyPosFromRatios({ x: 0.02, y: 0.80 });
    savePosFromRect();
  }

  function reanchorPos() {
    const pos = getSavedPos();
    if (pos) applyPosFromRatios(pos);
  }

  // Also react to visualViewport changes (zoom, mobile viewport)
  function hookViewportReanchor() {
    let raf = 0;

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        reanchorPos();
      });
    };

    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', () => {
      // Not required, but helps if browser changes viewport metrics subtly.
      if (settings.onlyVisible) schedule();
    }, { passive: true });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedule);
      window.visualViewport.addEventListener('scroll', schedule);
    }
  }

  // ---------- Panel state ----------
  function setPanelState(next) {
    if (next !== 'open' && next !== 'min' && next !== 'hidden') return;
    panelState = next;
    lsSet(K_PANEL_STATE, panelState);

    if (!ui.root) return;

    if (panelState === 'hidden') {
      ui.root.style.display = 'none';
      showLauncher(true);
      return;
    }

    ui.root.style.display = 'block';
    showLauncher(false);

    if (panelState === 'min') {
      applyMinimized(true);
    } else {
      applyMinimized(false);
    }

    // After size changes, keep position clamped/anchored
    reanchorPos();
    updatePanel();
  }

  function applyMinimized(min) {
    if (!ui.root || !ui.content || !ui.btnMin) return;

    if (min) {
      ui.content.style.display = 'none';
      ui.root.style.minWidth = '180px';
      ui.root.style.padding = '8px';
      ui.btnMin.textContent = 'Open';
    } else {
      ui.content.style.display = 'block';
      ui.root.style.minWidth = '260px';
      ui.root.style.padding = '10px';
      ui.btnMin.textContent = 'Min';
    }
  }

  // ---------- Launcher button (reopen when hidden) ----------
  let launcher = null;

  function ensureLauncher() {
    if (launcher && launcher.isConnected) return;

    launcher = document.createElement('button');
    launcher.id = 'grok-auto-fav-launcher';
    launcher.textContent = 'AF';
    launcher.title = 'Auto Favorite - show panel';
    launcher.style.cssText = [
      'position:fixed',
      'top:10px',
      'right:10px',
      'z-index:2147483647',
      'width:34px',
      'height:34px',
      'border-radius:12px',
      'border:1px solid rgba(255,255,255,0.20)',
      'background:rgba(20,20,20,0.80)',
      'color:#fff',
      'font:12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      'cursor:pointer',
      'backdrop-filter: blur(8px)'
    ].join(';');

    launcher.addEventListener('click', () => {
      setPanelState(panelState === 'hidden' ? 'open' : panelState);
    });

    document.body.appendChild(launcher);
  }

  function showLauncher(show) {
    ensureLauncher();
    launcher.style.display = show ? 'block' : 'none';
  }

  // ---------- Menu commands ----------
  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    GM_registerMenuCommand('AutoFav: Show panel', () => setPanelState('open'));
    GM_registerMenuCommand('AutoFav: Minimize/Restore', () => {
      if (panelState === 'hidden') setPanelState('open');
      else setPanelState(panelState === 'min' ? 'open' : 'min');
    });
    GM_registerMenuCommand('AutoFav: Hide panel', () => setPanelState('hidden'));

    GM_registerMenuCommand('AutoFav: Toggle enabled', () => {
      settings.enabled = !settings.enabled;
      saveJson(K_SETTINGS, settings);
      syncUiFromSettings();
      if (settings.enabled) start();
      else stop();
      updatePanel();
    });

    GM_registerMenuCommand('AutoFav: Mode = like', () => {
      settings.mode = 'like';
      saveJson(K_SETTINGS, settings);
      syncUiFromSettings();
      rebuildTracking();
      updatePanel();
    });

    GM_registerMenuCommand('AutoFav: Mode = unlike', () => {
      settings.mode = 'unlike';
      saveJson(K_SETTINGS, settings);
      syncUiFromSettings();
      rebuildTracking();
      updatePanel();
    });

    GM_registerMenuCommand('AutoFav: Reset counters', () => {
      resetCounters();
      updatePanel();
    });
  }

  // ---------- Queue + observers ----------
  function pushReady(btn) {
    if (!btn || readySet.has(btn)) return;
    readySet.add(btn);
    readyQueue.push(btn);
  }

  function ensureIntersectionObserver() {
    if (io || !('IntersectionObserver' in window)) return;

    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        try { io.unobserve(e.target); } catch (_) {}
        pushReady(e.target);
      }
    }, {
      root: null,
      rootMargin: '160px'
    });
  }

  function trackButton(btn) {
    if (!btn || seenBtns.has(btn)) return;
    seenBtns.add(btn);

    if (settings.onlyVisible) {
      ensureIntersectionObserver();
      if (io) {
        try { io.observe(btn); } catch (_) { pushReady(btn); }
      } else {
        if (isActuallyVisible(btn) && isInViewport(btn)) pushReady(btn);
      }
    } else {
      pushReady(btn);
    }
  }

  function scanExistingButtons() {
    const btns = document.querySelectorAll('button.grok-fav-btn');
    for (const btn of btns) trackButton(btn);
  }

  function ensureMutationObserver() {
    if (mo) return;

    mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node || node.nodeType !== 1) continue;

          if (node.matches && node.matches('button.grok-fav-btn')) {
            trackButton(node);
            continue;
          }

          const btns = node.querySelectorAll ? node.querySelectorAll('button.grok-fav-btn') : null;
          if (btns && btns.length) {
            for (const b of btns) trackButton(b);
          }
        }
      }
    });

    mo.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function rebuildTracking() {
    // Recreate IO depending on onlyVisible, but keep discovered buttons in WeakSet
    if (io) {
      try { io.disconnect(); } catch (_) {}
      io = null;
    }
    if (settings.onlyVisible) ensureIntersectionObserver();

    // Ensure existing buttons get picked up (only new ones will be tracked)
    scanExistingButtons();
    updatePanel();
  }

  function getNextEligibleButtonFromQueue() {
    const wantLiked = settings.mode === 'like' ? '1' : '0';

    while (readyQueue.length) {
      const btn = readyQueue.shift();
      if (!btn) continue;
      if (!btn.isConnected) continue;
      if (!isActuallyVisible(btn)) continue;

      if (settings.onlyVisible && !isInViewport(btn)) {
        // Put back under observation so it will be enqueued again when visible
        if (io) {
          try { io.observe(btn); } catch (_) {}
        }
        continue;
      }

      const liked = btn.dataset && btn.dataset.liked ? String(btn.dataset.liked) : '0';
      if (liked === wantLiked) continue;

      return btn;
    }

    return null;
  }

  // ---------- Clicking + retries ----------
  function safeClick(btn) {
    // Try multiple click methods to avoid edge cases
    try { btn.focus(); } catch (_) {}

    try {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (_) {}

    try {
      btn.click();
      return true;
    } catch (_) {}

    return false;
  }

  function clickAndVerify(btn) {
    const want = settings.mode === 'like' ? '1' : '0';

    state.counters.clicked += 1;
    state.lastActionAt = Date.now();

    const ok = safeClick(btn);
    if (!ok) {
      state.counters.failed += 1;
      maybeRetry(btn, 'dispatch_failed');
      updatePanel();
      return;
    }

    // Verify after delay (other script does async fetch then updates dataset.liked)
    setTimeout(() => {
      try {
        const nowLiked = btn.dataset && btn.dataset.liked ? String(btn.dataset.liked) : null;
        if (nowLiked === want) {
          state.counters.success += 1;
        } else {
          state.counters.failed += 1;
          maybeRetry(btn, 'state_mismatch');
        }
      } catch (_) {
        state.counters.failed += 1;
        maybeRetry(btn, 'verify_error');
      }
      updatePanel();
    }, 1600);
  }

  function maybeRetry(btn, reason) {
    const cur = retryMap.get(btn) || 0;
    const maxRetries = 3;

    if (cur >= maxRetries) {
      log('No more retries for button see reason:', reason);
      return;
    }

    retryMap.set(btn, cur + 1);
    state.counters.retries += 1;

    // Re-queue with slight backoff (also helps if the button was mid-update)
    setTimeout(() => {
      if (!btn || !btn.isConnected) return;
      // Allow it to be queued again even if it was queued before
      // (readySet is WeakSet, we keep it as "ever queued", so push directly here)
      readyQueue.push(btn);
      updatePanel();
    }, 900 + (cur * 600));
  }

  // ---------- Engine ----------
  function tick() {
    if (!settings.enabled) return;

    const now = Date.now();
    const delay = Math.max(150, Number(settings.delayMs) || DEFAULTS.delayMs);
    if ((now - state.lastActionAt) < delay) return;

    // Ensure we keep discovering new buttons even if MutationObserver misses something
    // This scan is cheap due to WeakSet seenBtns.
    scanExistingButtons();

    const btn = getNextEligibleButtonFromQueue();
    if (!btn) {
      updatePanel();
      return;
    }

    clickAndVerify(btn);
    updatePanel();
  }

  function start() {
    if (state.tickTimer) return;
    state.tickTimer = setInterval(tick, 250);
    log('Started');
  }

  function stop() {
    if (!state.tickTimer) return;
    clearInterval(state.tickTimer);
    state.tickTimer = null;
    log('Stopped');
  }

  function resetCounters() {
    state.counters.clicked = 0;
    state.counters.success = 0;
    state.counters.failed = 0;
    state.counters.retries = 0;
  }

  // ---------- UI ----------
  function syncUiFromSettings() {
    if (!ui.root) return;
    if (ui.enabled) ui.enabled.checked = !!settings.enabled;
    if (ui.like) ui.like.checked = settings.mode === 'like';
    if (ui.unlike) ui.unlike.checked = settings.mode === 'unlike';
    if (ui.delay) ui.delay.value = String(Number(settings.delayMs) || DEFAULTS.delayMs);
    if (ui.onlyVisible) ui.onlyVisible.checked = !!settings.onlyVisible;
    if (ui.debug) ui.debug.checked = !!settings.debug;
  }

  function makePanel() {
    if (document.getElementById('grok-auto-fav-panel')) return;

    const root = document.createElement('div');
    root.id = 'grok-auto-fav-panel';
    root.style.cssText = [
      'position:fixed',
      'left:12px',
      'top:120px',
      'z-index:2147483647',
      'background:rgba(20,20,20,0.88)',
      'color:#fff',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:12px',
      'padding:10px',
      'font:12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      'backdrop-filter: blur(8px)',
      'min-width:260px',
      'box-shadow: 0 6px 18px rgba(0,0,0,0.35)',
      'user-select:none'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:10px',
      'cursor:move',
      'user-select:none',
      'margin-bottom:8px'
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:800; font-size:13px;';
    title.textContent = 'Auto Favorite v0.11.0';

    const headBtns = document.createElement('div');
    headBtns.style.cssText = 'display:flex; gap:6px; align-items:center;';

    const btnMin = document.createElement('button');
    btnMin.textContent = 'Min';
    btnMin.style.cssText = 'border-radius:10px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.08); color:#fff; padding:4px 8px; cursor:pointer;';

    const btnClose = document.createElement('button');
    btnClose.textContent = 'Close';
    btnClose.style.cssText = 'border-radius:10px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.08); color:#fff; padding:4px 8px; cursor:pointer;';

    headBtns.appendChild(btnMin);
    headBtns.appendChild(btnClose);

    header.appendChild(title);
    header.appendChild(headBtns);

    const content = document.createElement('div');
    content.style.cssText = 'display:block; user-select:text;';

    content.innerHTML = `
      <label style="display:flex; gap:8px; align-items:center; margin:6px 0;">
        <input id="gaf_enabled" type="checkbox" />
        <span>Enabled (Alt+L)</span>
      </label>

      <div style="display:flex; gap:10px; align-items:center; margin:6px 0;">
        <label style="display:flex; gap:6px; align-items:center;">
          <input id="gaf_mode_like" type="radio" name="gaf_mode" />
          <span>Auto-like (Alt+I)</span>
        </label>
        <label style="display:flex; gap:6px; align-items:center;">
          <input id="gaf_mode_unlike" type="radio" name="gaf_mode" />
          <span>Auto-unlike (Alt+U)</span>
        </label>
      </div>

      <label style="display:flex; gap:8px; align-items:center; margin:6px 0;">
        <span style="min-width:86px; opacity:0.9;">Delay (ms)</span>
        <input id="gaf_delay" type="number" min="150" step="50"
          style="width:100px; border-radius:8px; border:1px solid rgba(255,255,255,0.18); background:rgba(0,0,0,0.25); color:#fff; padding:4px 6px;" />
      </label>

      <label style="display:flex; gap:8px; align-items:center; margin:6px 0;">
        <input id="gaf_only_visible" type="checkbox" />
        <span>Only visible tiles</span>
      </label>

      <label style="display:flex; gap:8px; align-items:center; margin:6px 0;">
        <input id="gaf_debug" type="checkbox" />
        <span>Debug logs</span>
      </label>

      <div id="gaf_status" style="margin-top:8px; opacity:0.95;"></div>
      <div id="gaf_queue" style="margin-top:6px; opacity:0.85;"></div>
      <div id="gaf_counters" style="margin-top:6px; white-space:pre; opacity:0.9;"></div>

      <div style="display:flex; gap:8px; margin-top:10px;">
        <button id="gaf_reset"
          style="flex:1; border-radius:10px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.08); color:#fff; padding:6px; cursor:pointer;">
          Reset
        </button>
        <button id="gaf_hide"
          style="flex:1; border-radius:10px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.08); color:#fff; padding:6px; cursor:pointer;">
          Hide
        </button>
      </div>

      <div style="margin-top:8px; opacity:0.7;">
        Tip: scroll to load more tiles. This clicks the hearts from the other script.
      </div>
    `;

    root.appendChild(header);
    root.appendChild(content);
    document.body.appendChild(root);

    ui.root = root;
    ui.header = header;
    ui.title = title;
    ui.btnMin = btnMin;
    ui.btnClose = btnClose;
    ui.content = content;

    ui.enabled = root.querySelector('#gaf_enabled');
    ui.like = root.querySelector('#gaf_mode_like');
    ui.unlike = root.querySelector('#gaf_mode_unlike');
    ui.delay = root.querySelector('#gaf_delay');
    ui.onlyVisible = root.querySelector('#gaf_only_visible');
    ui.debug = root.querySelector('#gaf_debug');
    ui.status = root.querySelector('#gaf_status');
    ui.queue = root.querySelector('#gaf_queue');
    ui.counters = root.querySelector('#gaf_counters');

    // init values
    syncUiFromSettings();

    // panel buttons
    btnMin.addEventListener('click', () => {
      setPanelState(panelState === 'min' ? 'open' : 'min');
    });
    btnClose.addEventListener('click', () => {
      setPanelState('hidden');
    });

    // UI handlers
    ui.enabled.addEventListener('change', () => {
      settings.enabled = !!ui.enabled.checked;
      saveJson(K_SETTINGS, settings);
      if (settings.enabled) start();
      else stop();
      updatePanel();
    });

    ui.like.addEventListener('change', () => {
      if (!ui.like.checked) return;
      settings.mode = 'like';
      saveJson(K_SETTINGS, settings);
      rebuildTracking();
      updatePanel();
    });

    ui.unlike.addEventListener('change', () => {
      if (!ui.unlike.checked) return;
      settings.mode = 'unlike';
      saveJson(K_SETTINGS, settings);
      rebuildTracking();
      updatePanel();
    });

    ui.delay.addEventListener('change', () => {
      const v = Math.max(150, Number(ui.delay.value) || DEFAULTS.delayMs);
      settings.delayMs = v;
      ui.delay.value = String(v);
      saveJson(K_SETTINGS, settings);
      updatePanel();
    });

    ui.onlyVisible.addEventListener('change', () => {
      settings.onlyVisible = !!ui.onlyVisible.checked;
      saveJson(K_SETTINGS, settings);
      rebuildTracking();
      updatePanel();
    });

    ui.debug.addEventListener('change', () => {
      settings.debug = !!ui.debug.checked;
      saveJson(K_SETTINGS, settings);
      updatePanel();
    });

    root.querySelector('#gaf_reset').addEventListener('click', () => {
      resetCounters();
      updatePanel();
    });

    root.querySelector('#gaf_hide').addEventListener('click', () => {
      setPanelState('hidden');
    });

    // Draggable behavior (header handle), persist position ratios
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const left = clamp(startLeft + dx, 0, window.innerWidth - root.offsetWidth);
      const top = clamp(startTop + dy, 0, window.innerHeight - root.offsetHeight);

      root.style.left = left + 'px';
      root.style.top = top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      savePosFromRect();
    }

    header.addEventListener('mousedown', (e) => {
      // Allow clicks on header buttons without dragging
      const t = e.target;
      if (t && t.tagName === 'BUTTON') return;

      if (e.button !== 0) return;
      dragging = true;

      const rect = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    // Apply state, restore position
    if (panelState === 'min') applyMinimized(true);
    else applyMinimized(false);

    restorePosOrDefault();
    updatePanel();
  }

  function updatePanel() {
    if (!ui.root || ui.root.style.display === 'none') return;

    const btnCount = document.querySelectorAll('button.grok-fav-btn').length;
    const enabledLabel = settings.enabled ? 'ON' : 'OFF';
    const modeLabel = settings.mode === 'like' ? 'like' : 'unlike';
    const qLen = readyQueue.length;

    if (ui.status) {
      ui.status.textContent = 'Status: ' + enabledLabel + ' | Mode: ' + modeLabel + ' | Hearts found: ' + btnCount;
    }
    if (ui.queue) {
      ui.queue.textContent = 'Queue: ' + qLen + (settings.onlyVisible ? ' (visible-only)' : ' (all-loaded)');
    }
    if (ui.counters) {
      ui.counters.textContent =
        'Clicked:  ' + state.counters.clicked + '\n' +
        'OK:       ' + state.counters.success + '\n' +
        'Failed:   ' + state.counters.failed + '\n' +
        'Retries:  ' + state.counters.retries;
    }
  }

  // ---------- Hotkeys ----------
  // Alt+L: toggle enabled
  // Alt+I: set like
  // Alt+U: set unlike
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const k = (e.key || '').toLowerCase();

    if (k === 'l') {
      settings.enabled = !settings.enabled;
      saveJson(K_SETTINGS, settings);
      syncUiFromSettings();
      if (settings.enabled) start();
      else stop();
      updatePanel();
    } else if (k === 'i') {
      settings.mode = 'like';
      saveJson(K_SETTINGS, settings);
      syncUiFromSettings();
      rebuildTracking();
      updatePanel();
    } else if (k === 'u') {
      settings.mode = 'unlike';
      saveJson(K_SETTINGS, settings);
      syncUiFromSettings();
      rebuildTracking();
      updatePanel();
    }
  }, true);

  // ---------- Boot ----------
  function boot() {
    makePanel();
    ensureLauncher();
    registerMenuCommands();

    ensureMutationObserver();
    rebuildTracking();

    hookViewportReanchor();

    // Apply saved panel state (open/min/hidden)
    setPanelState(panelState);

    // Start engine if enabled
    if (settings.enabled) start();
    else stop();
  }

  // Wait for body
  const wait = setInterval(() => {
    if (document.body) {
      clearInterval(wait);
      boot();
    }
  }, 150);
})();
