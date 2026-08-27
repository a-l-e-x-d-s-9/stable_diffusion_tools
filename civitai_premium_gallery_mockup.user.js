// ==UserScript==
// @name         Civitai - Premium Gallery Mock-up
// @namespace    https://civitai.com/
// @version      0.4.0
// @description  Turns a Civitai model page into an interactive Premium Gallery concept mock-up.
// @match        https://civitai.com/models/*
// @match        https://civitai.green/models/*
// @match        https://civitai.red/models/*
// @run-at       document-end
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_PREFIX = '[Premium Gallery Mock-up]';
  const STORE_KEY = 'civitai-premium-gallery-mockup-v1';
  const MODE_KEY = 'civitai-premium-gallery-mockup-mode-v1';
  const MODES = Object.freeze({
    model: 'Model View',
    edit: 'Edit Mode',
    unpaid: 'Preview Mode Unpaid',
    paid: 'Paid Access Mode',
  });
  const DEFAULT_MASK = Object.freeze({
    type: 'none',
    x: 50,
    y: 45,
    size: 24,
    split: 48,
    feather: 8,
  });
  const MEDIA_SELECTOR = 'img, video';
  const GALLERY_LINK_SELECTOR = [
    'a[class*="ImagesAsPostsCard"][href^="/images/"]',
    'a[class*="ImagesAsPostsCard"][href*="/images/"]',
    '[data-testid*="gallery" i] a[href^="/images/"]',
  ].join(', ');
  const MAIN_GALLERY_LINK_SELECTOR = GALLERY_LINK_SELECTOR
    .split(', ')
    .map((selector) => `main ${selector}`)
    .join(', ');
  const RENDER_HTML_SELECTOR = '[class*="RenderHtml"], [data-testid*="description" i]';

  const state = {
    key: '',
    mode: loadMode(),
    data: null,
    route: location.href,
    galleryRoot: null,
    nativePreview: null,
    descriptionSource: null,
    observer: null,
    reconcilePending: false,
    descriptionSaveTimer: null,
  };

  injectStyles();
  registerMenus();
  start();

  function injectStyles() {
    if (document.getElementById('cpgm-styles')) return;

    const style = document.createElement('style');
    style.id = 'cpgm-styles';
    style.textContent = `
      #cpgm-mode-switch {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 7px;
        margin-top: 10px;
        padding: 8px;
        width: fit-content;
        max-width: 100%;
        border: 1px solid light-dark(#d8dbe0, #373a40);
        border-radius: 10px;
        background: light-dark(rgba(255,255,255,.94), rgba(26,27,30,.94));
        box-shadow: 0 5px 18px rgba(0,0,0,.10);
      }
      #cpgm-mode-switch .cpgm-mode-title {
        padding: 0 5px;
        color: light-dark(#495057, #c1c2c5);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .02em;
        text-transform: uppercase;
      }
      #cpgm-mode-switch button,
      .cpgm-button,
      .cpgm-editor select,
      .cpgm-editor input {
        font: inherit;
      }
      #cpgm-mode-switch button,
      .cpgm-button {
        border: 1px solid light-dark(#ced4da, #4b4f56);
        border-radius: 7px;
        background: light-dark(#fff, #25262b);
        color: inherit;
        cursor: pointer;
        font-size: 12px;
        font-weight: 650;
        line-height: 1.2;
        padding: 7px 10px;
        transition: background-color .15s ease, border-color .15s ease,
          color .15s ease, transform .15s ease;
      }
      #cpgm-mode-switch button:hover,
      .cpgm-button:hover {
        border-color: #228be6;
        transform: translateY(-1px);
      }
      #cpgm-mode-switch button[aria-pressed="true"] {
        border-color: #228be6;
        background: #228be6;
        color: #fff;
      }
      #cpgm-mode-switch .cpgm-mode-status {
        padding: 0 5px;
        color: #74c0fc;
        font-size: 12px;
        font-weight: 650;
      }

      body[data-cpgm-mode="model"] [data-cpgm-mock-only],
      body[data-cpgm-mode="model"] .cpgm-gallery-add,
      body:not([data-cpgm-mode="edit"]) .cpgm-editor,
      body:not([data-cpgm-mode="edit"]) .cpgm-gallery-add,
      body:not([data-cpgm-mode="unpaid"]) .cpgm-gallery-tile-lock,
      body[data-cpgm-mode="paid"] .cpgm-mask-layer,
      body[data-cpgm-mode="paid"] .cpgm-mask-label {
        display: none !important;
      }
      body[data-cpgm-mode]:not([data-cpgm-mode="model"])
        [data-cpgm-hide-in-mock="true"] {
        display: none !important;
      }
      body[data-cpgm-mode="edit"] [data-cpgm-add-post="true"] {
        display: revert !important;
      }
      body[data-cpgm-mode="unpaid"] [data-cpgm-add-post="true"],
      body[data-cpgm-mode="paid"] [data-cpgm-add-post="true"] {
        display: none !important;
      }

      body[data-cpgm-mode]:not([data-cpgm-mode="model"])
        [data-cpgm-native-preview="true"] {
        box-sizing: border-box;
        width: 50% !important;
        max-width: 50% !important;
        margin-inline: auto !important;
      }
      body[data-cpgm-mode]:not([data-cpgm-mode="model"])
        [data-cpgm-native-preview="true"][data-cpgm-replaced="true"] {
        display: none !important;
      }

      #cpgm-preview {
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        margin: 0 auto 18px;
      }
      #cpgm-preview .cpgm-preview-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      #cpgm-preview .cpgm-preview-heading strong {
        font-size: 15px;
      }
      #cpgm-preview .cpgm-preview-heading span {
        color: light-dark(#6c757d, #909296);
        font-size: 12px;
      }
      #cpgm-preview .cpgm-preview-window {
        overflow: hidden;
        border: 1px solid light-dark(#dee2e6, #373a40);
        border-radius: 12px;
        background: light-dark(#f1f3f5, #141517);
      }
      #cpgm-preview .cpgm-preview-track {
        display: flex;
        overflow-x: auto;
        scroll-behavior: smooth;
        scroll-snap-type: x mandatory;
        scrollbar-width: none;
      }
      #cpgm-preview .cpgm-preview-track::-webkit-scrollbar {
        display: none;
      }
      #cpgm-preview .cpgm-preview-item {
        flex: 0 0 33.333333%;
        min-width: 0;
        scroll-snap-align: start;
        border-right: 1px solid light-dark(#dee2e6, #373a40);
      }
      #cpgm-preview .cpgm-media-frame {
        position: relative;
        display: grid;
        place-items: center;
        min-height: 240px;
        max-height: 460px;
        overflow: hidden;
        background: #090a0b;
      }
      #cpgm-preview img,
      #cpgm-preview video {
        display: block;
        width: 100%;
        max-height: 460px;
        object-fit: contain;
      }
      #cpgm-preview .cpgm-mask-layer {
        position: absolute;
        z-index: 3;
        pointer-events: none;
        background: rgba(13, 14, 18, .50);
        backdrop-filter: blur(24px) saturate(.7);
        -webkit-backdrop-filter: blur(24px) saturate(.7);
      }
      #cpgm-preview .cpgm-mask-layer[data-mask="circle"] {
        inset: 0;
        -webkit-mask-image: radial-gradient(
          circle at var(--cpgm-x) var(--cpgm-y),
          transparent calc(var(--cpgm-size) - 1.2%),
          #000 calc(var(--cpgm-size) + 1.2%)
        );
        mask-image: radial-gradient(
          circle at var(--cpgm-x) var(--cpgm-y),
          transparent calc(var(--cpgm-size) - 1.2%),
          #000 calc(var(--cpgm-size) + 1.2%)
        );
      }
      #cpgm-preview .cpgm-mask-layer[data-mask="top"] {
        inset: var(--cpgm-split) 0 0;
        -webkit-mask-image: linear-gradient(
          to bottom,
          transparent 0,
          #000 var(--cpgm-feather)
        );
        mask-image: linear-gradient(
          to bottom,
          transparent 0,
          #000 var(--cpgm-feather)
        );
      }
      #cpgm-preview .cpgm-mask-label {
        position: absolute;
        z-index: 4;
        left: 50%;
        bottom: 10%;
        transform: translateX(-50%);
        pointer-events: none;
        padding: 9px 15px;
        border: 1px solid rgba(255,255,255,.42);
        border-radius: 999px;
        background: rgba(12, 13, 16, .68);
        box-shadow: 0 5px 24px rgba(0,0,0,.35);
        color: #fff;
        font-size: clamp(12px, 1.4vw, 17px);
        font-weight: 800;
        letter-spacing: .025em;
        text-align: center;
        white-space: nowrap;
      }
      #cpgm-preview .cpgm-mask-drag-handle,
      #cpgm-preview .cpgm-mask-split-handle {
        position: absolute;
        z-index: 6;
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        padding: 0;
        transform: translate(-50%, -50%);
        border: 1px solid rgba(255,255,255,.72);
        border-radius: 50%;
        background: rgba(15,16,20,.52);
        box-shadow: 0 2px 12px rgba(0,0,0,.38);
        color: rgba(255,255,255,.88);
        cursor: move;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      #cpgm-preview .cpgm-mask-drag-handle {
        left: var(--cpgm-x);
        top: var(--cpgm-y);
      }
      #cpgm-preview .cpgm-mask-split-handle {
        left: 50%;
        top: var(--cpgm-split);
      }
      #cpgm-preview .cpgm-mask-split-handle::before {
        position: absolute;
        z-index: -1;
        left: calc(-50vw + 17px);
        width: 100vw;
        border-top: 1px dashed rgba(255,255,255,.52);
        content: '';
        pointer-events: none;
      }
      #cpgm-preview .cpgm-mask-drag-handle:hover,
      #cpgm-preview .cpgm-mask-split-handle:hover {
        background: rgba(34,139,230,.68);
      }
      #cpgm-preview .cpgm-mask-drag-handle:active,
      #cpgm-preview .cpgm-mask-split-handle:active {
        cursor: grabbing;
      }
      #cpgm-preview .cpgm-mask-drag-handle svg,
      #cpgm-preview .cpgm-mask-split-handle svg {
        width: 22px;
        height: 22px;
        pointer-events: none;
      }
      body:not([data-cpgm-mode="edit"])
        #cpgm-preview .cpgm-mask-drag-handle,
      body:not([data-cpgm-mode="edit"])
        #cpgm-preview .cpgm-mask-split-handle {
        display: none !important;
      }
      #cpgm-preview .cpgm-video-shell {
        position: relative;
        width: 100%;
        overflow: hidden;
        background: #090a0b;
      }
      #cpgm-preview .cpgm-media-frame:has(.cpgm-video-shell) {
        max-height: none;
      }
      #cpgm-preview .cpgm-video-shell video,
      #cpgm-preview .cpgm-video-poster {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        max-height: none;
        object-fit: contain;
      }
      #cpgm-preview .cpgm-video-poster {
        z-index: 1;
        background: #090a0b;
        pointer-events: none;
      }
      #cpgm-preview .cpgm-video-play {
        position: absolute;
        z-index: 2;
        left: 50%;
        top: 50%;
        display: grid;
        place-items: center;
        width: 46px;
        height: 46px;
        padding: 0 0 0 3px;
        transform: translate(-50%, -50%);
        border: 1px solid rgba(255,255,255,.72);
        border-radius: 50%;
        background: rgba(12,13,16,.68);
        box-shadow: 0 4px 18px rgba(0,0,0,.42);
        color: #fff;
        cursor: pointer;
        font-size: 21px;
      }
      #cpgm-preview .cpgm-video-shell[data-cpgm-video-started="true"]
        .cpgm-video-poster,
      #cpgm-preview .cpgm-video-shell[data-cpgm-video-started="true"]
        .cpgm-video-play {
        display: none;
      }
      #cpgm-preview .cpgm-preview-nav {
        display: flex;
        justify-content: center;
        gap: 8px;
        padding: 9px;
      }
      #cpgm-preview .cpgm-editor {
        padding: 11px;
        border-top: 1px solid light-dark(#dee2e6, #373a40);
        background: light-dark(#fff, #1a1b1e);
      }
      #cpgm-preview .cpgm-editor-row {
        display: grid;
        grid-template-columns: minmax(62px, .8fr) minmax(60px, 1.2fr) 38px;
        align-items: center;
        gap: 8px;
        margin-top: 7px;
        font-size: 12px;
      }
      #cpgm-preview .cpgm-editor-row:first-child {
        margin-top: 0;
      }
      #cpgm-preview .cpgm-editor-row select {
        grid-column: 2 / 4;
        min-width: 0;
        border: 1px solid light-dark(#ced4da, #4b4f56);
        border-radius: 6px;
        background: light-dark(#fff, #25262b);
        color: inherit;
        padding: 6px;
      }
      #cpgm-preview .cpgm-editor-row input[type="range"] {
        min-width: 0;
        accent-color: #228be6;
      }
      #cpgm-preview .cpgm-remove {
        border-color: #e03131;
        color: #fa5252;
      }
      #cpgm-preview .cpgm-editor-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 11px;
      }
      #cpgm-preview .cpgm-save-next {
        border-color: #228be6;
        background: #228be6;
        color: #fff;
      }

      #cpgm-description {
        padding: 15px 17px;
        border: 1px solid light-dark(#dee2e6, #373a40);
        border-radius: 10px;
        background: light-dark(#fff, #1a1b1e);
      }
      #cpgm-description .cpgm-description-status {
        display: none;
        margin-bottom: 10px;
        color: #74c0fc;
        font-size: 12px;
        font-weight: 700;
      }
      body[data-cpgm-mode="edit"]
        #cpgm-description .cpgm-description-status {
        display: block;
      }
      #cpgm-description-editor {
        min-height: 92px;
        line-height: 1.55;
        outline: none;
      }
      body[data-cpgm-mode="edit"] #cpgm-description-editor {
        padding: 11px;
        border: 1px dashed #228be6;
        border-radius: 8px;
        background: rgba(34, 139, 230, .055);
      }
      body[data-cpgm-mode="edit"]
        #cpgm-description-editor:focus {
        border-style: solid;
        box-shadow: 0 0 0 3px rgba(34,139,230,.16);
      }

      [data-cpgm-gallery-root="true"] {
        position: relative !important;
      }
      body[data-cpgm-mode]:not([data-cpgm-mode="model"])
        [data-cpgm-gallery-root="true"] {
        min-height: max(900px, 78vh) !important;
      }
      .cpgm-gallery-tile-lock {
        position: absolute;
        z-index: 15;
        inset: 0;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: rgba(14, 15, 18, .42);
        backdrop-filter: blur(24px) saturate(.55);
        -webkit-backdrop-filter: blur(24px) saturate(.55);
        pointer-events: auto;
      }
      .cpgm-gallery-tile-lock span {
        max-width: calc(100% - 20px);
        padding: 10px 16px;
        border: 1px solid rgba(255,255,255,.44);
        border-radius: 999px;
        background: rgba(12,13,16,.76);
        box-shadow: 0 8px 30px rgba(0,0,0,.42);
        color: #fff;
        font-size: clamp(12px, 1.5vw, 18px);
        font-weight: 850;
        letter-spacing: .03em;
        text-align: center;
      }
      [data-cpgm-gallery-media="true"] {
        position: relative !important;
      }
      .cpgm-gallery-add {
        position: absolute;
        z-index: 12;
        top: auto;
        bottom: 44px;
        right: 9px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 7px 10px;
        border: 1px solid rgba(255,255,255,.65);
        border-radius: 999px;
        background: rgba(13,14,18,.78);
        box-shadow: 0 4px 18px rgba(0,0,0,.35);
        color: #fff;
        cursor: pointer;
        font: 700 12px/1.1 system-ui, sans-serif;
      }
      .cpgm-gallery-add:hover {
        background: #228be6;
      }
      .cpgm-gallery-add[data-added="true"] {
        border-color: #51cf66;
        background: rgba(43,138,62,.92);
      }
      .cpgm-toast {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        bottom: 18px;
        max-width: min(360px, calc(100vw - 36px));
        padding: 11px 15px;
        border: 1px solid rgba(255,255,255,.25);
        border-radius: 9px;
        background: rgba(20,21,24,.94);
        box-shadow: 0 8px 30px rgba(0,0,0,.35);
        color: #fff;
        font: 650 13px/1.4 system-ui, sans-serif;
      }
      @media (max-width: 760px) {
        #cpgm-mode-switch {
          width: 100%;
        }
        #cpgm-mode-switch .cpgm-mode-title,
        #cpgm-mode-switch .cpgm-mode-status {
          flex-basis: 100%;
        }
        body[data-cpgm-mode]:not([data-cpgm-mode="model"])
          [data-cpgm-native-preview="true"],
        #cpgm-preview {
          width: 100% !important;
          max-width: 100% !important;
        }
        #cpgm-preview .cpgm-preview-item {
          flex-basis: 100%;
        }
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function start() {
    resetForRoute();
    state.observer = new MutationObserver(queueReconcile);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('popstate', checkRoute);
    window.addEventListener('hashchange', checkRoute);
    setInterval(checkRoute, 900);
    queueReconcile();
    console.info(`${SCRIPT_PREFIX} loaded`);
  }

  function checkRoute() {
    if (state.route === location.href) return;
    state.route = location.href;
    resetForRoute();
    queueReconcile();
  }

  function resetForRoute() {
    state.key = getPageKey();
    state.data = loadPageData(state.key);
    state.galleryRoot = null;
    state.nativePreview = null;
    state.descriptionSource = null;
    clearTimeout(state.descriptionSaveTimer);
    document.body?.setAttribute('data-cpgm-mode', state.mode);
  }

  function queueReconcile() {
    if (state.reconcilePending) return;
    state.reconcilePending = true;
    requestAnimationFrame(() => {
      state.reconcilePending = false;
      reconcilePage();
    });
  }

  function reconcilePage() {
    if (!isModelPage() || !document.body) return;
    document.body.dataset.cpgmMode = state.mode;

    const title = findModelTitle();
    ensureModeSwitch(title);
    markCreateButtons();
    markHiddenSections();
    updateTitle(title);
    updateModelType();
    updateDownloadBlock();
    updateGallery();
    updateAddPostButtons();
    ensurePreview();
    ensureDescription();
    updateModeSwitch();
  }

  function isModelPage() {
    return /^\/models\/[^/]+/i.test(location.pathname);
  }

  function getPageKey() {
    const match = location.pathname.match(/^\/models\/([^/]+)/i);
    const modelId = match?.[1] || location.pathname;
    const version = new URLSearchParams(location.search).get('modelVersionId') || '';
    return `${location.hostname}:${modelId}:${version}`;
  }

  function loadMode() {
    try {
      const mode = localStorage.getItem(MODE_KEY);
      return Object.hasOwn(MODES, mode) ? mode : 'model';
    } catch {
      return 'model';
    }
  }

  function saveMode(mode) {
    state.mode = Object.hasOwn(MODES, mode) ? mode : 'model';
    try {
      localStorage.setItem(MODE_KEY, state.mode);
    } catch {
      // The current page can still use the selected mode.
    }
  }

  function readStore() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function loadPageData(key) {
    const saved = readStore()[key];
    const items = Array.isArray(saved?.items)
      ? saved.items.map(normalizeMediaItem).filter(Boolean).slice(0, 80)
      : [];

    return {
      description: typeof saved?.description === 'string'
        ? saved.description
        : null,
      items,
    };
  }

  function normalizeMediaItem(item) {
    if (!item || !['image', 'video'].includes(item.type)) return null;
    if (typeof item.src !== 'string' || !item.src) return null;

    return {
      id: String(item.id || item.src),
      type: item.type,
      src: item.src,
      sources: item.type === 'video' && Array.isArray(item.sources)
        ? item.sources
          .filter((source) => source && typeof source.src === 'string')
          .map((source) => ({
            src: source.src,
            type: typeof source.type === 'string' ? source.type : '',
          }))
        : [],
      poster: typeof item.poster === 'string' ? item.poster : '',
      alt: typeof item.alt === 'string' ? item.alt.slice(0, 300) : '',
      aspectRatio: Number.isFinite(Number(item.aspectRatio)) && Number(item.aspectRatio) > 0
        ? Number(item.aspectRatio)
        : null,
      mask: normalizeMask(item.mask),
    };
  }

  function normalizeMask(mask) {
    const number = (value, fallback, min, max) => {
      const parsed = Number(value);
      return Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, parsed))
        : fallback;
    };
    const type = ['none', 'circle', 'top'].includes(mask?.type)
      ? mask.type
      : DEFAULT_MASK.type;

    return {
      type,
      x: number(mask?.x, DEFAULT_MASK.x, 0, 100),
      y: number(mask?.y, DEFAULT_MASK.y, 0, 100),
      size: number(mask?.size, DEFAULT_MASK.size, 6, 60),
      split: number(mask?.split, DEFAULT_MASK.split, 5, 92),
      feather: number(mask?.feather, DEFAULT_MASK.feather, 0, 30),
    };
  }

  function savePageData() {
    try {
      const store = readStore();
      store[state.key] = state.data;
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (error) {
      console.warn(`${SCRIPT_PREFIX} Could not save mock-up data`, error);
      showToast('Could not save mock-up data in local storage.');
    }
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    GM_registerMenuCommand(
      'Premium Gallery: Clear saved description for this model',
      () => {
        const key = getPageKey();
        const store = readStore();
        if (store[key]) {
          store[key].description = null;
          localStorage.setItem(STORE_KEY, JSON.stringify(store));
        }
        if (state.key === key) {
          state.data.description = null;
          document.getElementById('cpgm-description')?.remove();
          state.descriptionSource = null;
          queueReconcile();
        }
        showToast('Saved Premium Gallery description cleared.');
      }
    );

    GM_registerMenuCommand(
      'Premium Gallery: Clear all mock-up data for this model',
      () => {
        if (!confirm('Clear the saved description, preview media, and masks for this model?')) {
          return;
        }
        const key = getPageKey();
        const store = readStore();
        delete store[key];
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        if (state.key === key) {
          state.data = loadPageData(key);
          document.getElementById('cpgm-preview')?.remove();
          document.getElementById('cpgm-description')?.remove();
          state.descriptionSource = null;
          state.nativePreview?.removeAttribute('data-cpgm-replaced');
          queueReconcile();
        }
        showToast('Premium Gallery mock-up data cleared for this model.');
      }
    );
  }

  function findModelTitle() {
    return document.querySelector(
      'main h1[class*="title" i], main h1, h1[class*="title" i]'
    );
  }

  function ensureModeSwitch(title) {
    let root = document.getElementById('cpgm-mode-switch');
    if (!root) {
      root = document.createElement('div');
      root.id = 'cpgm-mode-switch';
      root.setAttribute('aria-label', 'Premium Gallery mock-up mode');
      root.innerHTML = `
        <span class="cpgm-mode-title">Premium Gallery mock-up</span>
        ${Object.entries(MODES).map(([mode, label]) =>
          `<button type="button" data-cpgm-mode-value="${mode}">${escapeHtml(label)}</button>`
        ).join('')}
        <span class="cpgm-mode-status" aria-live="polite"></span>
      `;
      root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-cpgm-mode-value]');
        if (!button) return;
        setMode(button.dataset.cpgmModeValue);
      });
    }

    const updated = findTextElement(/^Updated:\s*/i);
    const anchor = updated?.parentElement || title?.parentElement;
    if (anchor && root.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement('afterend', root);
    }
  }

  function setMode(mode) {
    saveDescriptionNow();
    saveMode(mode);
    document.body.dataset.cpgmMode = state.mode;
    applyMockText();
    renderPreview();
    updateDescriptionMode();
    updateModeSwitch();
    updateGalleryButtons();
  }

  function updateModeSwitch() {
    const root = document.getElementById('cpgm-mode-switch');
    if (!root) return;

    for (const button of root.querySelectorAll('[data-cpgm-mode-value]')) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.cpgmModeValue === state.mode)
      );
    }
    const status = root.querySelector('.cpgm-mode-status');
    if (status) {
      const count = state.data?.items.length || 0;
      setText(status, state.mode === 'model'
        ? 'Native page'
        : `${count} preview item${count === 1 ? '' : 's'} saved locally`);
    }
  }

  function markCreateButtons() {
    for (const button of document.querySelectorAll(
      'button[data-tour="model:create"], button[data-activity="create:model"]'
    )) {
      button.dataset.cpgmHideInMock = 'true';
    }

    for (const text of findExactTextElements('Create')) {
      const button = text.closest('button');
      if (button) button.dataset.cpgmHideInMock = 'true';
    }
  }

  function markHiddenSections() {
    for (const label of ['Details', 'Tensors', 'About this version']) {
      for (const text of findExactTextElements(label)) {
        const item = text.closest(
          '[class*="Accordion-item"], [data-accordion-item], details'
        );
        if (item) item.dataset.cpgmHideInMock = 'true';
      }
    }

    for (const label of ['Suggested Resources', 'Discussion', 'Comments']) {
      for (const text of findExactTextElements(label)) {
        const section = getSectionForLabel(text);
        if (section) section.dataset.cpgmHideInMock = 'true';
      }
    }

    markModelFileDetails();
  }

  function getSectionForLabel(element) {
    const controlledId = element.closest('[aria-controls]')?.getAttribute('aria-controls');
    if (controlledId) {
      const controlled = document.getElementById(controlledId);
      if (controlled) controlled.dataset.cpgmHideInMock = 'true';
    }

    const heading = element.closest('h1, h2, h3, h4, h5, h6');
    const sectionFromHeading = heading?.parentElement?.parentElement;
    if (
      sectionFromHeading &&
      !sectionFromHeading.matches('main, body, html')
    ) {
      return sectionFromHeading;
    }

    return element.closest(
      '[class*="Accordion-item"], [data-testid*="section" i], section, article, [role="tab"]'
    ) || element.closest('button') || element.parentElement;
  }

  function markModelFileDetails() {
    const filePattern = /\.(?:safetensors?|ckpt|pt|pth|bin|gguf)(?:\s|$)/i;
    for (const filename of document.querySelectorAll('main [title]')) {
      const value = `${filename.getAttribute('title') || ''} ${filename.textContent || ''}`;
      if (!filePattern.test(value)) continue;

      const card = filename.closest('[class*="Card-root"]');
      if (!card?.querySelector('a[href*="/api/download/models"]')) continue;

      const details = filename.closest('div[style*="padding"]') ||
        filename.parentElement?.parentElement?.parentElement;
      if (details && details !== card && card.contains(details)) {
        details.dataset.cpgmHideInMock = 'true';
      }
    }
  }

  function updateTitle(title) {
    if (!title) return;
    rememberOriginalText(title);
    if (state.mode === 'model') {
      restoreOriginalText(title);
      return;
    }

    const original = title.dataset.cpgmOriginalText || title.textContent.trim();
    const cleaned = stripBaseModelSuffix(
      original.replace(/^Premium Gallery:\s*/i, '')
    );
    setText(title, `Premium Gallery: ${cleaned || original}`);
  }

  function stripBaseModelSuffix(title) {
    const candidates = getBaseModelCandidates();
    let cleaned = title.trim();

    for (const candidate of candidates.sort((a, b) => b.length - a.length)) {
      const escaped = escapeRegExp(candidate);
      cleaned = cleaned.replace(
        new RegExp(`(?:\\s*[-–—|:]?\\s*)${escaped}\\s*$`, 'i'),
        ''
      ).trim();
    }
    return cleaned.replace(/[\s\-–—|:]+$/, '').trim();
  }

  function getBaseModelCandidates() {
    const candidates = new Set([
      'Krea 2 Turbo', 'Krea 2', 'Illustrious', 'Anima', 'Pony',
      'Pony Diffusion', 'SDXL', 'SD 1.5', 'Stable Diffusion 1.5',
      'Flux.1', 'Flux', 'NoobAI', 'Wan Video', 'Hunyuan Video',
    ]);

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(script.textContent);
        const subcategory = Array.isArray(value)
          ? value.find((item) => item?.applicationSubCategory)?.applicationSubCategory
          : value?.applicationSubCategory;
        if (subcategory) {
          candidates.add(String(subcategory).replace(/\s+(?:Model|Checkpoint|LoRA)$/i, '').trim());
        }
      } catch {
        // Ignore unrelated or incomplete structured data.
      }
    }

    const pageTitle = document.querySelector('title')?.textContent || '';
    const typeSegment = pageTitle.split('|')[1]?.trim() || '';
    const fromTitle = typeSegment.replace(
      /\s+(?:Checkpoint|LoRA|LyCORIS|Model|Embedding|Hypernetwork|VAE)$/i,
      ''
    ).trim();
    if (fromTitle) candidates.add(fromTitle);

    for (const label of findExactTextElements('Base Model')) {
      const row = label.closest('[class*="detailRow"]') || label.parentElement;
      const value = row?.querySelector('a, p:last-child, div:last-child')?.textContent.trim();
      if (value && value !== 'Base Model') candidates.add(value);
    }

    return [...candidates].filter(Boolean);
  }

  function updateModelType() {
    const updated = findTextElement(/^Updated:\s*/i);
    if (!updated) return;
    const row = updated.parentElement;
    const badge = row?.querySelector(
      'a[href*="/tag/"] [class*="Badge-label"], a[href*="/tag/"]'
    );
    if (!badge) return;
    const label = badge.matches('[class*="Badge-label"]')
      ? badge
      : badge.querySelector('[class*="Badge-label"]') || badge;
    mutateMockText(label, 'Premium Gallery');
  }

  function updateDownloadBlock() {
    const links = document.querySelectorAll(
      'a[href*="/api/download/models/"], a[href*="/api/download/models?"]'
    );
    for (const link of links) {
      const card = link.closest('[class*="Card-root"], section, article') || link.parentElement;
      if (!card) continue;

      const candidates = new Set([
        ...findExactTextElements('Download', card),
        ...card.querySelectorAll('[data-cpgm-original-text="Download"]'),
      ]);
      for (const element of candidates) {
        const mockText = element.closest('a[href*="/api/download/"]')
          ? 'Access'
          : 'Pay for Access';
        mutateMockText(element, mockText);
      }
    }
  }

  function applyMockText() {
    updateTitle(findModelTitle());
    updateModelType();
    updateDownloadBlock();
    updateGalleryLabels();
  }

  function mutateMockText(element, mockText) {
    if (!element) return;
    rememberOriginalText(element);
    if (state.mode === 'model') restoreOriginalText(element);
    else setText(element, mockText);
  }

  function rememberOriginalText(element) {
    if (!Object.hasOwn(element.dataset, 'cpgmOriginalText')) {
      element.dataset.cpgmOriginalText = element.textContent.trim();
    }
  }

  function restoreOriginalText(element) {
    const original = element.dataset.cpgmOriginalText;
    if (typeof original === 'string') setText(element, original);
  }

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function updateGallery() {
    updateGalleryLabels();
    for (const oldLock of document.querySelectorAll('.cpgm-gallery-lock')) {
      oldLock.remove();
    }

    const root = findGalleryRoot();
    if (root) {
      if (state.galleryRoot && state.galleryRoot !== root) {
        state.galleryRoot.removeAttribute('data-cpgm-gallery-root');
      }
      state.galleryRoot = root;
      root.dataset.cpgmGalleryRoot = 'true';
    }
    updateGalleryButtons();
  }

  function updateGalleryLabels() {
    const labels = new Set([
      ...findExactTextElements('Gallery'),
      ...document.querySelectorAll('[data-cpgm-original-text="Gallery"]'),
    ]);
    for (const label of labels) {
      if (label.closest('#cpgm-mode-switch')) continue;
      mutateMockText(label, 'Premium Gallery');
    }
  }

  function findGalleryRoot() {
    const existing = document.querySelector('[data-cpgm-gallery-root="true"]');
    if (existing?.isConnected && isPlausibleGalleryRoot(existing)) return existing;

    const explicitRoots = document.querySelectorAll(
      '[data-testid*="model-gallery" i], [class*="ModelGallery"], [class*="modelGallery"]'
    );
    for (const explicit of explicitRoots) {
      if (isPlausibleGalleryRoot(explicit)) return explicit;
    }

    const firstGalleryLink = document.querySelector(MAIN_GALLERY_LINK_SELECTOR);
    if (firstGalleryLink) {
      const grid = firstGalleryLink.closest(
        '[role="grid"], [data-testid*="gallery" i], [class*="MasonryContainer"]'
      );
      if (grid) return grid;

      let mediaAncestor = firstGalleryLink.parentElement;
      for (let depth = 0; mediaAncestor && depth < 7; depth += 1) {
        if (mediaAncestor.querySelectorAll(GALLERY_LINK_SELECTOR).length >= 2) {
          return mediaAncestor;
        }
        if (mediaAncestor.matches('main, body')) break;
        mediaAncestor = mediaAncestor.parentElement;
      }
    }

    const label = [
      ...findExactTextElements('Gallery'),
      ...findExactTextElements('Premium Gallery'),
    ].find((element) => !element.closest('#cpgm-mode-switch'));
    if (!label) return null;

    const controller = label.closest('[aria-controls]');
    const panelId = controller?.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (panel) return panel;

    const section = label.closest('section, [data-testid*="gallery" i]');
    if (section) return section;

    const heading = label.closest('h1, h2, h3, h4, h5, h6');
    const sectionFromHeading = heading?.parentElement?.parentElement;
    if (sectionFromHeading && !sectionFromHeading.matches('main, body, html')) {
      return sectionFromHeading;
    }

    let ancestor = label.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1) {
      if (countLikelyGalleryMedia(ancestor, label) >= 2) return ancestor;
      if (ancestor.matches('main, body')) break;
      ancestor = ancestor.parentElement;
    }

    const tab = label.closest('[role="tab"]');
    const tabPanel = tab?.closest('[role="tablist"]')?.parentElement
      ?.querySelector('[role="tabpanel"]');
    if (tabPanel) return tabPanel;

    const fallback = label.closest('[role="tabpanel"]') || label.parentElement;
    return fallback && countLikelyGalleryMedia(fallback, label) > 0
      ? fallback
      : null;
  }

  function isPlausibleGalleryRoot(root) {
    if (!root) return false;
    if (root.querySelector(GALLERY_LINK_SELECTOR)) return true;
    return [...root.querySelectorAll('h1, h2, h3, [role="heading"]')]
      .some((heading) => /^(?:Premium\s+)?Gallery$/i.test(heading.textContent.trim()));
  }

  function countLikelyGalleryMedia(root, label) {
    const labelTop = label.getBoundingClientRect().top + window.scrollY;
    return [...root.querySelectorAll(MEDIA_SELECTOR)].filter((media) => {
      const rect = media.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      return top >= labelTop - 20 && Math.max(rect.width, media.width || 0) >= 120;
    }).length;
  }

  function updateGalleryButtons() {
    for (const media of getGalleryMediaElements()) {
      addGalleryButton(media);
      addGalleryTileLock(media);
    }
    refreshGalleryButtonStates();
  }

  function getGalleryMediaElements() {
    const media = [];
    const seen = new Set();
    for (const link of document.querySelectorAll(MAIN_GALLERY_LINK_SELECTOR)) {
      const item = link.querySelector('video, img');
      if (item && !seen.has(item)) {
        seen.add(item);
        media.push(item);
      }
    }
    return media;
  }

  function addGalleryButton(media) {
    if (media.closest('#cpgm-preview')) return;
    const rect = media.getBoundingClientRect();
    const width = Math.max(rect.width, media.width || 0, media.naturalWidth || 0);
    const height = Math.max(rect.height, media.height || 0, media.naturalHeight || 0);
    if (width < 120 || height < 100) {
      if (media.tagName === 'IMG' && !media.complete && !media.dataset.cpgmLoadQueued) {
        media.dataset.cpgmLoadQueued = 'true';
        media.addEventListener('load', queueReconcile, { once: true });
      }
      return;
    }

    const container = getGalleryMediaContainer(media);
    if (!container || container.querySelector(':scope > .cpgm-gallery-add')) return;
    container.dataset.cpgmGalleryMedia = 'true';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cpgm-gallery-add';
    button.textContent = '+ Preview';
    button.setAttribute('aria-label', 'Add this media to the Premium Gallery preview');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      addMediaToPreview(media);
    });
    container.append(button);
  }

  function getGalleryMediaContainer(media) {
    const link = media.closest(GALLERY_LINK_SELECTOR);
    if (link?.parentElement) return link.parentElement;
    return media.parentElement;
  }

  function addGalleryTileLock(media) {
    const container = media.parentElement;
    if (!container || container.querySelector(':scope > .cpgm-gallery-tile-lock')) return;
    container.dataset.cpgmGalleryMedia = 'true';

    const lock = document.createElement('div');
    lock.className = 'cpgm-gallery-tile-lock';
    lock.setAttribute('data-cpgm-mock-only', '');
    lock.setAttribute('aria-label', 'Premium Gallery item locked');
    lock.innerHTML = '<span>Premium Access</span>';
    container.append(lock);
  }

  function addMediaToPreview(media) {
    const item = mediaItemFromElement(media);
    if (!item) {
      showToast('This media source is not available yet. Let it load and try again.');
      return;
    }
    if (state.data.items.some((saved) => saved.id === item.id)) {
      showToast('This item is already in the public preview.');
      return;
    }

    state.data.items.push(item);
    savePageData();
    renderPreview();
    refreshGalleryButtonStates();
    updateModeSwitch();
    showToast('Added to the Premium Gallery public preview.');
  }

  function mediaItemFromElement(media) {
    const type = media.tagName === 'VIDEO' ? 'video' : 'image';
    const sources = type === 'video' ? getVideoSources(media) : [];
    const src = type === 'video'
      ? (sources[0]?.src || getVideoSource(media))
      : getImageSource(media);
    if (!src || /^blob:/i.test(src)) return null;

    const rect = media.getBoundingClientRect();
    const intrinsicWidth = type === 'video' ? media.videoWidth : media.naturalWidth;
    const intrinsicHeight = type === 'video' ? media.videoHeight : media.naturalHeight;
    const width = intrinsicWidth || rect.width || media.width || 0;
    const height = intrinsicHeight || rect.height || media.height || 0;

    return {
      id: getMediaId(src),
      type,
      src,
      sources,
      poster: type === 'video' ? absoluteUrl(media.poster || '') : '',
      alt: type === 'image' ? (media.alt || '') : '',
      aspectRatio: width > 0 && height > 0 ? width / height : null,
      mask: { ...DEFAULT_MASK },
    };
  }

  function getImageSource(image) {
    const candidates = (image.srcset || '')
      .split(',')
      .map((entry) => entry.trim().split(/\s+/)[0])
      .filter(Boolean);
    return absoluteUrl(candidates.at(-1) || image.currentSrc || image.src || '');
  }

  function getVideoSource(video) {
    const source = getVideoSources(video)[0]?.src;
    if (source) return source;

    const direct = video.currentSrc || video.src || video.getAttribute('src');
    if (direct && !/^blob:/i.test(direct)) return absoluteUrl(direct);

    const link = video.closest('a[href]')?.href;
    return link && /\.(?:mp4|webm|mov)(?:$|\?)/i.test(link) ? link : '';
  }

  function getVideoSources(video) {
    const sources = [];
    const seen = new Set();
    for (const node of video.querySelectorAll('source[src]')) {
      const src = absoluteUrl(node.src || node.getAttribute('src') || '');
      if (!src || /^blob:/i.test(src) || seen.has(src)) continue;
      seen.add(src);
      sources.push({ src, type: node.type || '' });
    }
    return sources;
  }

  function absoluteUrl(value) {
    if (!value) return '';
    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  }

  function getMediaId(src) {
    const uuid = src.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig)?.at(-1);
    if (uuid) return uuid.toLowerCase();
    try {
      const url = new URL(src);
      url.searchParams.delete('width');
      url.searchParams.delete('height');
      return url.href;
    } catch {
      return src;
    }
  }

  function refreshGalleryButtonStates() {
    const ids = new Set(state.data.items.map((item) => item.id));
    for (const button of document.querySelectorAll('.cpgm-gallery-add')) {
      const media = button.parentElement?.querySelector(MEDIA_SELECTOR);
      const item = media && mediaItemFromElement(media);
      const added = Boolean(item && ids.has(item.id));
      button.dataset.added = String(added);
      setText(button, added ? '✓ In preview' : '+ Preview');
    }
  }

  function updateAddPostButtons() {
    for (const label of findExactTextElements('Add Post')) {
      const button = label.closest('button, a') || label;
      button.dataset.cpgmAddPost = 'true';
    }
  }

  function ensurePreview() {
    const native = findNativePreview();
    if (!native) return;
    state.nativePreview = native;
    native.dataset.cpgmNativePreview = 'true';
    renderPreview();
  }

  function findNativePreview() {
    if (state.nativePreview?.isConnected) return state.nativePreview;

    const mainSection = document.querySelector(
      'main [class*="ModelVersionDetails"][class*="mainSection"], main [class*="mainSection"]'
    );
    if (!mainSection) return null;

    const known = mainSection.querySelector(
      ':scope > [class*="Stack"] > .relative > .overflow-hidden, :scope > [class*="Stack"] > div > .overflow-hidden'
    );
    if (known) return known.parentElement || known;

    const media = mainSection.querySelector('img, video');
    if (!media) return null;
    return media.closest('.relative, [class*="carousel" i]') || media.parentElement;
  }

  function renderPreview() {
    const native = state.nativePreview;
    if (!native?.isConnected) return;

    let root = document.getElementById('cpgm-preview');
    const previousScrollLeft = root
      ?.querySelector('.cpgm-preview-track')
      ?.scrollLeft || 0;
    if (!state.data.items.length) {
      root?.remove();
      native.removeAttribute('data-cpgm-replaced');
      return;
    }

    native.dataset.cpgmReplaced = 'true';
    const fingerprint = JSON.stringify(state.data.items);
    if (root?.dataset.cpgmFingerprint === fingerprint) return;
    if (!root) {
      root = document.createElement('section');
      root.id = 'cpgm-preview';
      root.setAttribute('data-cpgm-mock-only', '');
      native.insertAdjacentElement('beforebegin', root);
    }
    root.dataset.cpgmFingerprint = fingerprint;

    const cards = state.data.items.map((item, index) =>
      renderPreviewItem(item, index)
    ).join('');
    root.innerHTML = `
      <div class="cpgm-preview-heading">
        <strong>Public preview</strong>
        <span>${state.data.items.length} selected item${state.data.items.length === 1 ? '' : 's'}</span>
      </div>
      <div class="cpgm-preview-window">
        <div class="cpgm-preview-track">${cards}</div>
        ${state.data.items.length > 1 ? `
          <div class="cpgm-preview-nav">
            <button class="cpgm-button" type="button" data-cpgm-slide="-1" aria-label="Previous preview">←</button>
            <button class="cpgm-button" type="button" data-cpgm-slide="1" aria-label="Next preview">→</button>
          </div>
        ` : ''}
      </div>
    `;
    const track = root.querySelector('.cpgm-preview-track');
    if (track && previousScrollLeft) {
      track.style.scrollBehavior = 'auto';
      track.scrollLeft = previousScrollLeft;
      requestAnimationFrame(() => track.style.removeProperty('scroll-behavior'));
    }
    if (!root.dataset.cpgmBound) {
      root.dataset.cpgmBound = 'true';
      root.addEventListener('click', handlePreviewClick);
      root.addEventListener('input', handlePreviewInput);
      root.addEventListener('change', handlePreviewInput);
      root.addEventListener('pointerdown', handleMaskDragStart);
      root.addEventListener('play', handlePreviewVideoPlay, true);
      root.addEventListener('ended', handlePreviewVideoEnded, true);
      root.addEventListener('load', handlePreviewPosterLoad, true);
      root.addEventListener('loadedmetadata', handlePreviewVideoMetadata, true);
    }
    for (const poster of root.querySelectorAll('.cpgm-video-poster')) {
      if (poster.complete && poster.naturalWidth) {
        handlePreviewPosterLoad({ target: poster });
      }
    }
  }

  function renderPreviewItem(item, index) {
    const mask = normalizeMask(item.mask);
    const media = renderPreviewMedia(item);
    const maskMarkup = mask.type === 'none' ? '' : `
      <div class="cpgm-mask-layer" data-mask="${mask.type}" style="
        --cpgm-x:${mask.x}%;--cpgm-y:${mask.y}%;--cpgm-size:${mask.size}%;
        --cpgm-split:${mask.split}%;--cpgm-feather:${mask.feather}%"></div>
      <div class="cpgm-mask-label">Premium Access</div>
      ${mask.type === 'circle' ? `
        <button class="cpgm-mask-drag-handle" type="button"
          aria-label="Move circle reveal" title="Drag to move the circle reveal"
          style="--cpgm-x:${mask.x}%;--cpgm-y:${mask.y}%">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true">
            <path d="M12 3v18M3 12h18"></path>
            <path d="m8 7 4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"></path>
          </svg>
        </button>
      ` : ''}
      ${mask.type === 'top' ? `
        <button class="cpgm-mask-split-handle" type="button"
          aria-label="Move visible area boundary" title="Drag vertically to move the visible area boundary"
          style="--cpgm-split:${mask.split}%">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true">
            <path d="M12 3v18"></path>
            <path d="m8 7 4-4 4 4M8 17l4 4 4-4"></path>
          </svg>
        </button>
      ` : ''}
    `;

    return `
      <article class="cpgm-preview-item" data-cpgm-index="${index}">
        <div class="cpgm-media-frame">${media}${maskMarkup}</div>
        <div class="cpgm-editor">
          <div class="cpgm-editor-row">
            <label for="cpgm-mask-${index}">Hiding mask</label>
            <select id="cpgm-mask-${index}" data-cpgm-field="type">
              <option value="none"${mask.type === 'none' ? ' selected' : ''}>None</option>
              <option value="circle"${mask.type === 'circle' ? ' selected' : ''}>Circle reveal</option>
              <option value="top"${mask.type === 'top' ? ' selected' : ''}>Top visible / bottom hidden</option>
            </select>
          </div>
          ${mask.type === 'circle' ? renderRange('Circle size', 'size', mask.size, 6, 60) : ''}
          ${mask.type === 'top' ? renderRange('Edge fade', 'feather', mask.feather, 0, 30) : ''}
          <div class="cpgm-editor-actions">
            <button class="cpgm-button" type="button" data-cpgm-save="${index}">Save mask</button>
            <button class="cpgm-button cpgm-save-next" type="button" data-cpgm-save-next="${index}">Save &amp; Next →</button>
            <button class="cpgm-button cpgm-remove" type="button" data-cpgm-remove="${index}">Remove from preview</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderPreviewMedia(item) {
    if (item.type !== 'video') {
      return `<img src="${escapeAttribute(item.src)}" alt="${escapeAttribute(item.alt || 'Premium Gallery preview')}" loading="lazy">`;
    }

    const aspectRatio = Number.isFinite(Number(item.aspectRatio)) && Number(item.aspectRatio) > 0
      ? Number(item.aspectRatio)
      : 0.75;
    const sources = Array.isArray(item.sources) && item.sources.length
      ? item.sources.map((source) =>
        `<source src="${escapeAttribute(source.src)}"${source.type ? ` type="${escapeAttribute(source.type)}"` : ''}>`
      ).join('')
      : '';
    const sourceAttribute = sources ? '' : ` src="${escapeAttribute(item.src)}"`;
    const posterAttribute = item.poster
      ? ` poster="${escapeAttribute(item.poster)}"`
      : '';
    const poster = item.poster ? `
      <img class="cpgm-video-poster" src="${escapeAttribute(item.poster)}"
        alt="Video preview" loading="eager">
      <button class="cpgm-video-play" type="button" data-cpgm-video-play
        aria-label="Play preview video">▶</button>
    ` : '';

    return `
      <div class="cpgm-video-shell" style="aspect-ratio:${aspectRatio}">
        <video${sourceAttribute}${posterAttribute} controls playsinline preload="metadata">${sources}</video>
        ${poster}
      </div>
    `;
  }

  function renderRange(label, field, value, min, max) {
    return `
      <div class="cpgm-editor-row">
        <label>${escapeHtml(label)}</label>
        <input type="range" min="${min}" max="${max}" value="${value}" data-cpgm-field="${field}">
        <output>${Math.round(value)}%</output>
      </div>
    `;
  }

  function handlePreviewClick(event) {
    const play = event.target.closest('[data-cpgm-video-play]');
    if (play) {
      const shell = play.closest('.cpgm-video-shell');
      const video = shell?.querySelector('video');
      if (video) {
        video.play().catch(() => {
          delete shell.dataset.cpgmVideoStarted;
          showToast('The video could not start. Try its native play control.');
        });
      }
      return;
    }

    const save = event.target.closest('[data-cpgm-save], [data-cpgm-save-next]');
    if (save) {
      const index = Number(
        save.dataset.cpgmSaveNext ?? save.dataset.cpgmSave
      );
      if (Number.isInteger(index) && state.data.items[index]) {
        savePageData();
        const isSaveNext = Object.hasOwn(save.dataset, 'cpgmSaveNext');
        showToast(isSaveNext ? 'Mask saved. Moving to the next preview item.' : 'Mask saved.');
        if (isSaveNext) scrollToPreviewItem(index + 1);
      }
      return;
    }

    const remove = event.target.closest('[data-cpgm-remove]');
    if (remove) {
      const index = Number(remove.dataset.cpgmRemove);
      if (Number.isInteger(index) && state.data.items[index]) {
        state.data.items.splice(index, 1);
        savePageData();
        renderPreview();
        refreshGalleryButtonStates();
        updateModeSwitch();
        showToast('Removed from the public preview.');
      }
      return;
    }

    const slide = event.target.closest('[data-cpgm-slide]');
    if (!slide) return;
    const track = document.querySelector('#cpgm-preview .cpgm-preview-track');
    const direction = Number(slide.dataset.cpgmSlide) || 0;
    const step = getPreviewItemStep(track);
    track?.scrollBy({ left: direction * step, behavior: 'smooth' });
  }

  function handlePreviewVideoPlay(event) {
    if (event.target.tagName !== 'VIDEO') return;
    const shell = event.target.closest('.cpgm-video-shell');
    if (shell) shell.dataset.cpgmVideoStarted = 'true';
  }

  function handlePreviewVideoEnded(event) {
    if (event.target.tagName !== 'VIDEO') return;
    const shell = event.target.closest('.cpgm-video-shell');
    if (shell) delete shell.dataset.cpgmVideoStarted;
  }

  function handlePreviewPosterLoad(event) {
    const poster = event.target;
    if (!poster?.classList?.contains('cpgm-video-poster')) return;
    updateVideoAspectRatio(
      poster.closest('[data-cpgm-index]'),
      poster.naturalWidth,
      poster.naturalHeight
    );
  }

  function handlePreviewVideoMetadata(event) {
    const video = event.target;
    if (video.tagName !== 'VIDEO') return;
    updateVideoAspectRatio(
      video.closest('[data-cpgm-index]'),
      video.videoWidth,
      video.videoHeight
    );
  }

  function updateVideoAspectRatio(card, width, height) {
    const index = Number(card?.dataset.cpgmIndex);
    const item = state.data.items[index];
    if (!item || item.type !== 'video' || !(width > 0 && height > 0)) return;

    const aspectRatio = width / height;
    card.querySelector('.cpgm-video-shell')
      ?.style.setProperty('aspect-ratio', String(aspectRatio));
    if (Math.abs((item.aspectRatio || 0) - aspectRatio) < 0.001) return;

    item.aspectRatio = aspectRatio;
    const root = document.getElementById('cpgm-preview');
    if (root) root.dataset.cpgmFingerprint = JSON.stringify(state.data.items);
    savePageData();
  }

  function scrollToPreviewItem(requestedIndex) {
    const track = document.querySelector('#cpgm-preview .cpgm-preview-track');
    if (!track || !state.data.items.length) return;
    const index = requestedIndex % state.data.items.length;
    track.scrollTo({ left: index * getPreviewItemStep(track), behavior: 'smooth' });
  }

  function getPreviewItemStep(track) {
    return track?.querySelector('.cpgm-preview-item')
      ?.getBoundingClientRect().width || track?.clientWidth || 0;
  }

  function handleMaskDragStart(event) {
    const handle = event.target.closest(
      '.cpgm-mask-drag-handle, .cpgm-mask-split-handle'
    );
    const card = handle?.closest('[data-cpgm-index]');
    const frame = handle?.closest('.cpgm-media-frame');
    const index = Number(card?.dataset.cpgmIndex);
    const item = state.data.items[index];
    const isCircle = handle?.classList.contains('cpgm-mask-drag-handle');
    const isTop = handle?.classList.contains('cpgm-mask-split-handle');
    if (
      !handle || !frame || !item ||
      (isCircle && item.mask.type !== 'circle') ||
      (isTop && item.mask.type !== 'top')
    ) return;

    event.preventDefault();
    event.stopPropagation();

    const updatePosition = (pointerEvent) => {
      const rect = frame.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const y = Math.min(100, Math.max(0,
        ((pointerEvent.clientY - rect.top) / rect.height) * 100
      ));
      if (isCircle) {
        const x = Math.min(100, Math.max(0,
          ((pointerEvent.clientX - rect.left) / rect.width) * 100
        ));
        item.mask.x = Number(x.toFixed(1));
        item.mask.y = Number(y.toFixed(1));
      } else {
        item.mask.split = Number(Math.min(92, Math.max(5, y)).toFixed(1));
      }
      updateMaskLayer(card, item.mask);
    };

    const finish = (pointerEvent) => {
      updatePosition(pointerEvent);
      window.removeEventListener('pointermove', updatePosition);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const root = document.getElementById('cpgm-preview');
      if (root) root.dataset.cpgmFingerprint = JSON.stringify(state.data.items);
      savePageData();
      showToast(isCircle ? 'Circle position saved.' : 'Visible-area boundary saved.');
    };

    updatePosition(event);
    window.addEventListener('pointermove', updatePosition);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function handlePreviewInput(event) {
    const input = event.target.closest('[data-cpgm-field]');
    const card = input?.closest('[data-cpgm-index]');
    const index = Number(card?.dataset.cpgmIndex);
    const item = state.data.items[index];
    if (!input || !item) return;

    const field = input.dataset.cpgmField;
    item.mask[field] = field === 'type' ? input.value : Number(input.value);
    if (field !== 'type') {
      const output = input.nextElementSibling;
      if (output?.tagName === 'OUTPUT') output.textContent = `${Math.round(input.value)}%`;
      updateMaskLayer(card, item.mask);
      const root = document.getElementById('cpgm-preview');
      if (root) root.dataset.cpgmFingerprint = JSON.stringify(state.data.items);
    } else {
      rerenderPreviewItem(index);
    }
    savePageData();
  }

  function rerenderPreviewItem(index) {
    const root = document.getElementById('cpgm-preview');
    const current = root?.querySelector(`[data-cpgm-index="${index}"]`);
    const item = state.data.items[index];
    if (!root || !current || !item) return;

    const template = document.createElement('template');
    template.innerHTML = renderPreviewItem(item, index).trim();
    current.replaceWith(template.content.firstElementChild);
    root.dataset.cpgmFingerprint = JSON.stringify(state.data.items);
  }

  function updateMaskLayer(card, maskValue) {
    const mask = normalizeMask(maskValue);
    const layer = card.querySelector('.cpgm-mask-layer');
    if (!layer) return;
    layer.style.setProperty('--cpgm-x', `${mask.x}%`);
    layer.style.setProperty('--cpgm-y', `${mask.y}%`);
    layer.style.setProperty('--cpgm-size', `${mask.size}%`);
    layer.style.setProperty('--cpgm-split', `${mask.split}%`);
    layer.style.setProperty('--cpgm-feather', `${mask.feather}%`);
    const handle = card.querySelector('.cpgm-mask-drag-handle');
    handle?.style.setProperty('--cpgm-x', `${mask.x}%`);
    handle?.style.setProperty('--cpgm-y', `${mask.y}%`);
    card.querySelector('.cpgm-mask-split-handle')
      ?.style.setProperty('--cpgm-split', `${mask.split}%`);
  }

  function ensureDescription() {
    const source = findDescriptionSource();
    if (!source) return;
    state.descriptionSource = source;
    source.dataset.cpgmHideInMock = 'true';

    let root = document.getElementById('cpgm-description');
    if (!root) {
      root = document.createElement('section');
      root.id = 'cpgm-description';
      root.setAttribute('data-cpgm-mock-only', '');
      root.innerHTML = `
        <div class="cpgm-description-status">Editing description — changes save automatically in this browser</div>
        <div id="cpgm-description-editor"></div>
      `;
      source.insertAdjacentElement('beforebegin', root);
      const editor = root.querySelector('#cpgm-description-editor');
      editor.innerHTML = state.data.description ?? getDescriptionHtml(source);
      editor.addEventListener('input', scheduleDescriptionSave);
      editor.addEventListener('blur', saveDescriptionNow);
    }
    updateDescriptionMode();
  }

  function findDescriptionSource() {
    if (state.descriptionSource?.isConnected) return state.descriptionSource;
    const mainSection = document.querySelector(
      'main [class*="ModelVersionDetails"][class*="mainSection"], main [class*="mainSection"]'
    );
    const renderer = mainSection?.querySelector(RENDER_HTML_SELECTOR) ||
      [...document.querySelectorAll(`main ${RENDER_HTML_SELECTOR}`)]
        .find((node) => !node.closest('[class*="Accordion-item"]'));
    if (!renderer) return null;
    return renderer.closest('[class*="Spoiler-root"]') || renderer;
  }

  function getDescriptionHtml(source) {
    const renderer = source.matches(RENDER_HTML_SELECTOR)
      ? source
      : source.querySelector(RENDER_HTML_SELECTOR);
    return renderer?.innerHTML || source.innerHTML || '<p>Add a description for this Premium Gallery.</p>';
  }

  function updateDescriptionMode() {
    const editor = document.getElementById('cpgm-description-editor');
    if (!editor) return;
    const editable = state.mode === 'edit';
    editor.contentEditable = String(editable);
    editor.setAttribute('aria-label', editable
      ? 'Editable Premium Gallery description'
      : 'Premium Gallery description');
  }

  function scheduleDescriptionSave() {
    clearTimeout(state.descriptionSaveTimer);
    state.descriptionSaveTimer = setTimeout(saveDescriptionNow, 350);
  }

  function saveDescriptionNow() {
    clearTimeout(state.descriptionSaveTimer);
    const editor = document.getElementById('cpgm-description-editor');
    if (!editor || state.mode !== 'edit') return;
    state.data.description = editor.innerHTML;
    savePageData();
    updateModeSwitch();
  }

  function findTextElement(pattern, root = document) {
    return [...root.querySelectorAll('p, span, time, div')]
      .find((element) => pattern.test(element.textContent.trim()) &&
        ![...element.children].some((child) => pattern.test(child.textContent.trim()))
      ) || null;
  }

  function findExactTextElements(text, root = document) {
    const expected = text.trim().toLocaleLowerCase();
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.parentElement?.closest('script, style, #cpgm-mode-switch')) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.textContent.trim().toLocaleLowerCase() === expected
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );
    const elements = [];
    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const element = node.parentElement;
      if (element && !seen.has(element)) {
        seen.add(element);
        elements.push(element);
      }
    }
    return elements;
  }

  function showToast(message) {
    document.querySelector('.cpgm-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'cpgm-toast';
    toast.textContent = message;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
})();
