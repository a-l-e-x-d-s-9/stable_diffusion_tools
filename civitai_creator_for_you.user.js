// ==UserScript==
// @name         Civitai Creator For You Feed
// @namespace    https://civitai.com/
// @version      1.0.0
// @description  Adds a randomized, full-screen image and video feed to every Civitai creator profile.
// @author       alexds9 & OpenAI
// @match        https://civitai.com/user/*
// @match        https://civitai.green/user/*
// @match        https://civitai.red/user/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT = 'Civitai Creator For You';
  const ROUTE_NAME = 'for-you';
  const PAGE_SIZE = 18;
  const LOAD_AHEAD = 8;
  const STORAGE_MUTED = 'civitai-for-you-muted';
  const modelCache = new Map();

  const icons = {
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.7-7.5a5.5 5.5 0 0 0 1.1-8.9Z"/></svg>',
    comment: '<svg viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4Zm4.5 3.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4Zm11 4-6 6m0-6 6 6"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
    external: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>'
  };

  let mounted = null;
  let lastUrl = location.href;
  let routeTimer = 0;

  function creatorRoute() {
    const match = location.pathname.match(/^\/user\/([^/?#]+)(?:\/([^/?#]+))?/i);
    if (!match) return null;
    try {
      return {
        username: decodeURIComponent(match[1]),
        section: (match[2] || '').toLowerCase()
      };
    } catch (_) {
      return null;
    }
  }

  function creatorPath(username, section = '') {
    return `/user/${encodeURIComponent(username)}${section ? `/${section}` : ''}`;
  }

  function navigate(path) {
    if (location.pathname === path) return syncRoute();
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
    syncRoute();
  }

  function shuffled(values) {
    const result = values.slice();
    const random = new Uint32Array(Math.max(1, result.length));
    crypto.getRandomValues(random);
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = random[i] % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function compactNumber(value) {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(Number(value) || 0);
  }

  function profileAvatar(username) {
    const wanted = creatorPath(username).toLowerCase();
    const links = Array.from(document.querySelectorAll('a[href*="/user/"]'));
    for (const link of links) {
      let path = '';
      try { path = new URL(link.href, location.origin).pathname.toLowerCase(); } catch (_) {}
      if (path !== wanted && !path.startsWith(`${wanted}/`)) continue;
      const image = link.querySelector('img[src]');
      if (image && image.currentSrc) return image.currentSrc;
      if (image && image.src) return image.src;
    }
    return '';
  }

  function findProfileTabReference(username) {
    const base = creatorPath(username).toLowerCase();
    const candidates = Array.from(document.querySelectorAll('a[href]')).filter(link => {
      try {
        const path = new URL(link.href, location.origin).pathname.toLowerCase();
        return path === `${base}/videos` || path === `${base}/images` || path === `${base}/posts`;
      } catch (_) {
        return false;
      }
    });
    return candidates.find(link => link.offsetParent !== null) || candidates[0] || null;
  }

  function ensureProfileTab() {
    const route = creatorRoute();
    if (!route || route.section === ROUTE_NAME || document.querySelector('[data-cfy-tab]')) return;
    const reference = findProfileTabReference(route.username);
    if (!reference || !reference.parentElement) return;

    const tab = reference.cloneNode(false);
    tab.dataset.cfyTab = 'true';
    tab.href = creatorPath(route.username, ROUTE_NAME);
    tab.removeAttribute('aria-current');
    tab.textContent = 'For You';
    tab.title = `Randomized media by ${route.username}`;
    tab.style.whiteSpace = 'nowrap';
    tab.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      navigate(creatorPath(route.username, ROUTE_NAME));
    });

    const videoTab = Array.from(reference.parentElement.children).find(child => {
      try { return new URL(child.href, location.origin).pathname.toLowerCase() === `${creatorPath(route.username).toLowerCase()}/videos`; }
      catch (_) { return false; }
    });
    (videoTab || reference).insertAdjacentElement('afterend', tab);
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Civitai returned HTTP ${response.status}`);
    return response.json();
  }

  async function getModelVersion(versionId) {
    const key = String(versionId);
    if (!modelCache.has(key)) {
      modelCache.set(key, fetchJson(`/api/v1/model-versions/${encodeURIComponent(key)}`)
        .catch(error => {
          modelCache.delete(key);
          throw error;
        }));
    }
    return modelCache.get(key);
  }

  function pageStyles() {
    return `
      :host { color-scheme: dark; }
      * { box-sizing: border-box; }
      button, a { -webkit-tap-highlight-color: transparent; }
      button { font: inherit; }
      svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .app { position: fixed; inset: 0; z-index: 2147483000; overflow: hidden; background: #050505; color: #fff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .topbar { position: absolute; z-index: 20; top: 0; left: 0; right: 0; height: 64px; display: grid; grid-template-columns: minmax(80px, 1fr) auto minmax(80px, 1fr); align-items: center; padding: max(8px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left)); background: linear-gradient(180deg, rgba(0,0,0,.78), transparent); pointer-events: none; }
      .topbar > * { pointer-events: auto; }
      .back, .tool { border: 0; color: #fff; background: rgba(20,20,22,.68); backdrop-filter: blur(12px); cursor: pointer; display: inline-grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; transition: background .15s, transform .15s; }
      .back:hover, .tool:hover, .rail-button:hover { background: rgba(62,62,67,.88); transform: scale(1.04); }
      .brand { justify-self: start; display: flex; align-items: center; gap: 10px; }
      .brand-copy { min-width: 0; line-height: 1.12; }
      .brand-copy b, .brand-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .brand-copy b { font-size: 14px; }
      .brand-copy span { color: #b7b7bd; font-size: 11px; margin-top: 3px; }
      .tabs { justify-self: center; display: flex; gap: 19px; align-items: center; font-weight: 700; text-shadow: 0 1px 10px #000; }
      .tabs span { position: relative; padding: 8px 0; color: #aaa; }
      .tabs span:first-child { cursor: pointer; }
      .tabs .active { color: #fff; }
      .tabs .active::after { content: ''; position: absolute; left: 20%; right: 20%; bottom: 0; height: 3px; border-radius: 3px; background: #fff; }
      .tools { justify-self: end; display: flex; gap: 8px; }
      .tool svg { width: 21px; height: 21px; }
      .feed { width: 100%; height: 100%; overflow: auto; overscroll-behavior-y: contain; scroll-snap-type: y mandatory; scrollbar-width: none; }
      .feed::-webkit-scrollbar { display: none; }
      .slide { position: relative; width: 100%; height: 100%; min-height: 100%; scroll-snap-align: start; scroll-snap-stop: always; display: grid; place-items: center; overflow: hidden; background: #050505; }
      .ambient { position: absolute; inset: -35px; background-position: center; background-size: cover; filter: blur(45px) brightness(.31) saturate(.85); transform: scale(1.12); opacity: .72; }
      .ambient::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,.2); }
      .stage { position: relative; height: 100%; width: min(720px, calc(100vw - 132px)); display: grid; place-items: center; background: #000; box-shadow: 0 0 50px rgba(0,0,0,.45); }
      .media { display: block; width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #000; user-select: none; }
      .video { cursor: pointer; }
      .gradient { pointer-events: none; position: absolute; inset: 44% 0 0; background: linear-gradient(transparent, rgba(0,0,0,.08) 18%, rgba(0,0,0,.84)); }
      .details { position: absolute; z-index: 3; left: 20px; right: 74px; bottom: max(22px, env(safe-area-inset-bottom)); text-shadow: 0 1px 4px #000, 0 2px 12px #000; }
      .creator { color: #fff; text-decoration: none; font-weight: 800; font-size: 16px; display: inline-flex; gap: 5px; align-items: center; margin-bottom: 9px; }
      .creator:hover { text-decoration: underline; }
      .descriptor { font-size: 13px; color: #e2e2e5; margin-bottom: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
      .descriptor span + span::before { content: '•'; color: #929299; margin-right: 8px; }
      .models { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-height: 28px; }
      .model-label { font-size: 12px; font-weight: 700; color: #d0d0d4; }
      .chip { color: #fff; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; max-width: min(100%, 330px); padding: 6px 9px; border: 1px solid rgba(255,255,255,.22); background: rgba(18,18,20,.62); backdrop-filter: blur(10px); border-radius: 8px; font-size: 12px; line-height: 1; }
      .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip svg { width: 13px; height: 13px; flex: 0 0 auto; }
      .chip:hover { background: rgba(50,50,54,.82); border-color: rgba(255,255,255,.4); }
      .muted-text { color: #b5b5bb; font-size: 12px; }
      .rail { position: absolute; z-index: 4; right: -70px; bottom: max(24px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; align-items: center; gap: 15px; }
      .avatar { display: grid; place-items: center; width: 50px; height: 50px; color: #fff; text-decoration: none; border-radius: 50%; border: 2px solid #fff; overflow: hidden; background: linear-gradient(135deg, #7950f2, #e64980); font-weight: 900; box-shadow: 0 2px 14px rgba(0,0,0,.45); }
      .avatar img { width: 100%; height: 100%; object-fit: cover; }
      .rail-action { display: grid; justify-items: center; gap: 4px; color: #fff; text-decoration: none; border: 0; background: transparent; padding: 0; cursor: pointer; }
      .rail-button { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%; background: rgba(28,28,31,.72); backdrop-filter: blur(10px); transition: background .15s, transform .15s; }
      .rail-action b { font-size: 11px; font-weight: 700; text-shadow: 0 1px 4px #000; }
      .pause-indicator { position: absolute; z-index: 5; display: grid; place-items: center; width: 70px; height: 70px; border-radius: 50%; background: rgba(0,0,0,.52); backdrop-filter: blur(8px); opacity: 0; transform: scale(.75); pointer-events: none; transition: opacity .16s, transform .16s; }
      .pause-indicator.show { opacity: 1; transform: scale(1); }
      .pause-indicator svg { width: 32px; height: 32px; }
      .loading-page { height: 100%; min-height: 100%; scroll-snap-align: start; display: grid; place-items: center; color: #b9b9bf; text-align: center; padding: 24px; }
      .loader { width: 34px; height: 34px; border: 3px solid #39393e; border-top-color: #9775fa; border-radius: 50%; animation: spin .8s linear infinite; margin: 0 auto 14px; }
      .retry { color: #fff; background: #7950f2; border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer; margin-top: 12px; }
      .toast { position: absolute; z-index: 30; top: 74px; left: 50%; transform: translate(-50%, -12px); opacity: 0; pointer-events: none; padding: 9px 13px; border-radius: 9px; background: rgba(30,30,33,.9); backdrop-filter: blur(12px); box-shadow: 0 6px 24px rgba(0,0,0,.35); font-size: 13px; transition: .2s; }
      .toast.show { opacity: 1; transform: translate(-50%, 0); }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (max-width: 760px) {
        .topbar { height: 58px; grid-template-columns: 48px 1fr 88px; padding-left: 8px; padding-right: 8px; }
        .brand-copy { display: none; }
        .tabs { font-size: 14px; gap: 14px; }
        .stage { width: 100vw; }
        .ambient { display: none; }
        .rail { right: 12px; bottom: max(100px, calc(env(safe-area-inset-bottom) + 82px)); }
        .details { left: 13px; right: 72px; bottom: max(18px, env(safe-area-inset-bottom)); }
        .tools { gap: 5px; }
        .tool, .back { width: 38px; height: 38px; }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
      }
    `;
  }

  function mountFeed(username) {
    if (mounted && mounted.username === username) return;
    unmountFeed();

    const previousOverflow = document.documentElement.style.overflow;
    const host = document.createElement('div');
    host.id = 'civitai-creator-for-you';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = pageStyles();
    shadow.appendChild(style);

    const app = document.createElement('main');
    app.className = 'app';
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <button class="back" type="button" title="Back to creator profile" aria-label="Back to creator profile">${icons.back}</button>
          <div class="brand-copy"><b></b><span>Creator feed</span></div>
        </div>
        <div class="tabs" aria-label="Feed"><span>Following</span><span class="active">For You</span></div>
        <div class="tools">
          <button class="tool sound" type="button" aria-label="Toggle sound"></button>
          <button class="tool reshuffle" type="button" title="Shuffle loaded posts" aria-label="Shuffle loaded posts">${icons.shuffle}</button>
        </div>
      </header>
      <div class="feed" tabindex="0"></div>
      <div class="toast" role="status" aria-live="polite"></div>
    `;
    shadow.appendChild(app);
    (document.body || document.documentElement).appendChild(host);
    document.documentElement.style.overflow = 'hidden';

    const feed = app.querySelector('.feed');
    feed.setAttribute('aria-label', `Random media by ${username}`);
    const state = {
      username,
      host,
      shadow,
      app,
      feed,
      previousOverflow,
      avatar: profileAvatar(username),
      items: [],
      seen: new Set(),
      loading: false,
      stopped: false,
      muted: localStorage.getItem(STORAGE_MUTED) !== 'false',
      activeIndex: 0,
      toastTimer: 0,
      sources: [
        { type: 'image', sort: 'Newest', cursor: '', done: false },
        { type: 'video', sort: 'Newest', cursor: '', done: false },
        { type: 'image', sort: 'Most Reactions', cursor: '', done: false },
        { type: 'video', sort: 'Most Reactions', cursor: '', done: false }
      ]
    };
    mounted = state;

    app.querySelector('.brand-copy b').textContent = `@${username}`;
    app.querySelector('.back').addEventListener('click', () => navigate(creatorPath(username, 'images')));
    const following = app.querySelector('.tabs span:not(.active)');
    following.title = 'Back to the creator gallery';
    following.addEventListener('click', () => navigate(creatorPath(username, 'images')));
    app.querySelector('.reshuffle').addEventListener('click', () => reshuffleFeed(state));
    app.querySelector('.sound').addEventListener('click', () => setMuted(state, !state.muted));
    updateSoundButton(state);

    state.mediaObserver = new IntersectionObserver(entries => onMediaVisibility(state, entries), {
      root: feed,
      threshold: [0, 0.72, 1]
    });
    state.endObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting && entry.target.isConnected)) loadMore(state);
    }, { root: feed, rootMargin: '150% 0px' });

    feed.addEventListener('scroll', () => {
      const index = Math.round(feed.scrollTop / Math.max(1, feed.clientHeight));
      if (state.items.length - index <= LOAD_AHEAD) loadMore(state);
    }, { passive: true });
    feed.addEventListener('keydown', event => onFeedKeydown(state, event));
    feed.focus({ preventScroll: true });
    loadMore(state);
  }

  function unmountFeed() {
    if (!mounted) return;
    mounted.stopped = true;
    mounted.mediaObserver?.disconnect();
    mounted.endObserver?.disconnect();
    mounted.host.remove();
    document.documentElement.style.overflow = mounted.previousOverflow;
    mounted = null;
  }

  function toast(state, message) {
    const element = state.app.querySelector('.toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('show'), 1600);
  }

  function updateSoundButton(state) {
    const button = state.app.querySelector('.sound');
    button.innerHTML = state.muted ? icons.muted : icons.volume;
    button.title = state.muted ? 'Turn sound on (M)' : 'Mute videos (M)';
    button.setAttribute('aria-pressed', String(!state.muted));
    state.feed.querySelectorAll('video').forEach(video => { video.muted = state.muted; });
  }

  function setMuted(state, muted) {
    state.muted = muted;
    localStorage.setItem(STORAGE_MUTED, String(muted));
    updateSoundButton(state);
    toast(state, muted ? 'Sound off' : 'Sound on');
    if (!muted) activeVideo(state)?.play().catch(() => {});
  }

  function activeVideo(state) {
    return state.feed.querySelector(`.slide[data-index="${state.activeIndex}"] video`);
  }

  async function fetchSource(state, source) {
    const url = new URL('/api/v1/images', location.origin);
    url.searchParams.set('username', state.username);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('type', source.type);
    url.searchParams.set('sort', source.sort);
    if (source.sort === 'Most Reactions') url.searchParams.set('period', 'AllTime');
    if (source.cursor) url.searchParams.set('cursor', source.cursor);

    const data = await fetchJson(url);
    const items = Array.isArray(data?.items) ? data.items : [];
    source.cursor = data?.metadata?.nextCursor || '';
    source.done = !source.cursor || items.length === 0;
    return items;
  }

  async function loadMore(state) {
    if (state.loading || state.stopped) return;
    const sources = state.sources.filter(source => !source.done);
    if (!sources.length) return showEnd(state);
    state.loading = true;
    showLoading(state);

    const results = await Promise.allSettled(sources.map(source => fetchSource(state, source)));
    if (state.stopped) return;
    const fresh = [];
    let errors = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        errors += 1;
        console.warn(`[${SCRIPT}] media request failed`, result.reason);
        continue;
      }
      for (const item of result.value) {
        const key = String(item.id);
        if (!item.url || state.seen.has(key)) continue;
        state.seen.add(key);
        fresh.push(item);
      }
    }

    removeLoading(state);
    state.loading = false;
    if (fresh.length) {
      appendItems(state, shuffled(fresh));
      return;
    }
    if (errors > 0) showError(state);
    else showEnd(state);
  }

  function showLoading(state) {
    if (state.feed.querySelector('[data-feed-status]')) return;
    const status = document.createElement('div');
    status.className = 'loading-page';
    status.dataset.feedStatus = 'loading';
    status.innerHTML = '<div><div class="loader"></div><div>Mixing images and videos…</div></div>';
    state.feed.appendChild(status);
    state.endObserver.observe(status);
  }

  function removeLoading(state) {
    const status = state.feed.querySelector('[data-feed-status]');
    if (status) {
      state.endObserver.unobserve(status);
      status.remove();
    }
  }

  function showError(state) {
    removeLoading(state);
    const status = document.createElement('div');
    status.className = 'loading-page';
    status.dataset.feedStatus = 'error';
    status.innerHTML = '<div><b>Could not load this creator\'s media.</b><br><span class="muted-text">Check your connection and Civitai content settings.</span><br><button class="retry" type="button">Try again</button></div>';
    status.querySelector('.retry').addEventListener('click', () => {
      status.remove();
      loadMore(state);
    });
    state.feed.appendChild(status);
  }

  function showEnd(state) {
    removeLoading(state);
    if (state.feed.querySelector('[data-feed-status="end"]')) return;
    const status = document.createElement('div');
    status.className = 'loading-page';
    status.dataset.feedStatus = 'end';
    const content = document.createElement('div');
    const heading = document.createElement('b');
    heading.textContent = 'You reached the end.';
    const message = document.createElement('span');
    message.className = 'muted-text';
    message.textContent = `That was all available media from @${state.username}.`;
    content.append(heading, document.createElement('br'), message);
    status.appendChild(content);
    state.feed.appendChild(status);
  }

  function appendItems(state, items) {
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const index = state.items.length;
      state.items.push(item);
      const slide = createSlide(state, item, index);
      fragment.appendChild(slide);
      state.mediaObserver.observe(slide);
    }
    state.feed.appendChild(fragment);
    showLoading(state);
  }

  function itemUrl(item) {
    return `/images/${encodeURIComponent(item.id)}`;
  }

  function createSlide(state, item, index) {
    const slide = document.createElement('article');
    slide.className = 'slide';
    slide.dataset.id = String(item.id);
    slide.dataset.index = String(index);
    slide.setAttribute('aria-label', `${item.type === 'video' ? 'Video' : 'Image'} by ${state.username}`);

    const ambient = document.createElement('div');
    ambient.className = 'ambient';
    if (item.type !== 'video') ambient.style.backgroundImage = `url("${String(item.url).replace(/"/g, '%22')}")`;
    slide.appendChild(ambient);

    const stage = document.createElement('div');
    stage.className = 'stage';
    const media = document.createElement(item.type === 'video' ? 'video' : 'img');
    media.className = `media ${item.type === 'video' ? 'video' : 'image'}`;
    if (item.type === 'video') {
      media.src = item.url;
      media.loop = true;
      media.muted = state.muted;
      media.playsInline = true;
      media.preload = index < 2 ? 'auto' : 'metadata';
      media.addEventListener('click', () => toggleVideo(state, media, stage));
    } else {
      media.src = item.url;
      media.alt = `Creation by ${state.username}`;
      media.loading = index < 2 ? 'eager' : 'lazy';
      media.decoding = 'async';
    }
    stage.appendChild(media);

    const pause = document.createElement('div');
    pause.className = 'pause-indicator';
    pause.innerHTML = icons.pause;
    stage.appendChild(pause);
    const gradient = document.createElement('div');
    gradient.className = 'gradient';
    stage.appendChild(gradient);

    const details = document.createElement('div');
    details.className = 'details';
    const creator = document.createElement('a');
    creator.className = 'creator';
    creator.href = creatorPath(state.username);
    creator.textContent = `@${state.username}`;
    details.appendChild(creator);

    const descriptor = document.createElement('div');
    descriptor.className = 'descriptor';
    const type = document.createElement('span');
    type.textContent = item.type === 'video' ? 'Video' : 'Image';
    const base = document.createElement('span');
    base.textContent = item.baseModel || 'AI creation';
    const date = document.createElement('span');
    date.textContent = item.createdAt ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.createdAt)) : '';
    descriptor.append(type, base);
    if (date.textContent) descriptor.appendChild(date);
    details.appendChild(descriptor);

    const models = document.createElement('div');
    models.className = 'models';
    models.innerHTML = '<span class="model-label">Made with</span><span class="muted-text">Loading models…</span>';
    details.appendChild(models);
    stage.appendChild(details);
    stage.appendChild(createRail(state, item));
    slide.appendChild(stage);
    return slide;
  }

  function createRail(state, item) {
    const rail = document.createElement('aside');
    rail.className = 'rail';

    const avatar = document.createElement('a');
    avatar.className = 'avatar';
    avatar.href = creatorPath(state.username);
    avatar.title = `View @${state.username}`;
    if (state.avatar) {
      const image = document.createElement('img');
      image.src = state.avatar;
      image.alt = `${state.username}'s avatar`;
      avatar.appendChild(image);
    } else {
      avatar.textContent = state.username.slice(0, 1).toUpperCase();
    }
    rail.appendChild(avatar);

    rail.appendChild(railLink(itemUrl(item), icons.heart, compactNumber((item.stats?.likeCount || 0) + (item.stats?.heartCount || 0)), 'Open reactions'));
    rail.appendChild(railLink(itemUrl(item), icons.comment, compactNumber(item.stats?.commentCount || 0), 'Open comments'));

    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'rail-action';
    share.title = 'Share';
    share.innerHTML = `<span class="rail-button">${icons.share}</span><b>Share</b>`;
    share.addEventListener('click', () => shareItem(state, item));
    rail.appendChild(share);
    return rail;
  }

  function railLink(href, icon, count, title) {
    const link = document.createElement('a');
    link.className = 'rail-action';
    link.href = href;
    link.title = title;
    link.innerHTML = `<span class="rail-button">${icon}</span><b>${count}</b>`;
    return link;
  }

  async function shareItem(state, item) {
    const url = new URL(itemUrl(item), location.origin).href;
    try {
      if (navigator.share) await navigator.share({ title: `@${state.username} on Civitai`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast(state, 'Link copied');
      }
    } catch (error) {
      if (error?.name !== 'AbortError') toast(state, 'Could not share link');
    }
  }

  function toggleVideo(state, video, stage) {
    if (video.paused) {
      video.play().catch(() => {});
      stage.querySelector('.pause-indicator').classList.remove('show');
    } else {
      video.pause();
      stage.querySelector('.pause-indicator').classList.add('show');
    }
  }

  function onMediaVisibility(state, entries) {
    let active = null;
    for (const entry of entries) {
      const video = entry.target.querySelector('video');
      if (entry.intersectionRatio >= 0.72) active = entry.target;
      else if (video) video.pause();
    }
    if (!active) return;
    state.activeIndex = Number(active.dataset.index) || 0;
    state.feed.querySelectorAll('video').forEach(video => {
      if (video === active.querySelector('video')) video.play().catch(() => {});
      else video.pause();
    });
    hydrateAround(state, state.activeIndex);
    if (state.items.length - state.activeIndex <= LOAD_AHEAD) loadMore(state);
  }

  function hydrateAround(state, index) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const slide = state.feed.querySelector(`.slide[data-index="${index + offset}"]`);
      if (!slide || slide.dataset.hydrated) continue;
      slide.dataset.hydrated = 'true';
      hydrateModels(slide, state.items[index + offset]);
      const video = slide.querySelector('video[preload="metadata"]');
      if (video) video.preload = 'auto';
    }
  }

  async function hydrateModels(slide, item) {
    const container = slide.querySelector('.models');
    const ids = Array.from(new Set(Array.isArray(item.modelVersionIds) ? item.modelVersionIds : [])).slice(0, 6);
    if (!ids.length) {
      container.innerHTML = '';
      const label = document.createElement('span');
      label.className = 'model-label';
      label.textContent = 'Made with';
      const base = document.createElement('span');
      base.className = 'chip';
      base.textContent = item.baseModel || 'Model not listed';
      container.append(label, base);
      return;
    }

    const results = await Promise.allSettled(ids.map(getModelVersion));
    if (!slide.isConnected) return;
    container.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'model-label';
    label.textContent = 'Made with';
    container.appendChild(label);
    let added = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const version = result.value;
      const chip = document.createElement('a');
      chip.className = 'chip';
      chip.href = `/models/${encodeURIComponent(version.modelId)}?modelVersionId=${encodeURIComponent(version.id)}`;
      chip.title = `${version.model?.name || 'Model'} — ${version.name || 'version'}`;
      const text = document.createElement('span');
      text.textContent = `${version.model?.name || 'Model'} · ${version.name || 'version'}`;
      chip.appendChild(text);
      chip.insertAdjacentHTML('beforeend', icons.external);
      container.appendChild(chip);
      added += 1;
    }
    if (!added) {
      const fallback = document.createElement('span');
      fallback.className = 'chip';
      fallback.textContent = item.baseModel || 'Model unavailable';
      container.appendChild(fallback);
    }
  }

  function scrollToIndex(state, index, behavior = 'smooth') {
    const target = Math.max(0, Math.min(index, state.items.length - 1));
    state.feed.querySelector(`.slide[data-index="${target}"]`)?.scrollIntoView({ behavior, block: 'start' });
  }

  function onFeedKeydown(state, event) {
    if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      scrollToIndex(state, state.activeIndex + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      scrollToIndex(state, state.activeIndex - 1);
    } else if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      setMuted(state, !state.muted);
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      reshuffleFeed(state);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      navigate(creatorPath(state.username, 'images'));
    }
  }

  function reshuffleFeed(state) {
    if (state.items.length < 2) return;
    state.mediaObserver.disconnect();
    const slides = Array.from(state.feed.querySelectorAll('.slide'));
    const status = state.feed.querySelector('[data-feed-status]');
    const order = shuffled(state.items.map((item, index) => ({ item, slide: slides[index] })));
    state.items = order.map(entry => entry.item);
    const fragment = document.createDocumentFragment();
    order.forEach((entry, index) => {
      entry.slide.dataset.index = String(index);
      fragment.appendChild(entry.slide);
      state.mediaObserver.observe(entry.slide);
    });
    if (status) fragment.appendChild(status);
    state.feed.appendChild(fragment);
    scrollToIndex(state, 0, 'auto');
    state.activeIndex = 0;
    toast(state, 'Feed shuffled');
  }

  function syncRoute() {
    const route = creatorRoute();
    if (!route) return unmountFeed();
    if (route.section === ROUTE_NAME) mountFeed(route.username);
    else {
      unmountFeed();
      ensureProfileTab();
    }
  }

  function scheduleSync() {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      if (lastUrl !== location.href) lastUrl = location.href;
      syncRoute();
    }, 80);
  }

  function start() {
    syncRoute();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', scheduleSync);
    setInterval(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        scheduleSync();
      } else if (!mounted) ensureProfileTab();
    }, 800);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Open creator For You feed', () => {
        const route = creatorRoute();
        if (route) navigate(creatorPath(route.username, ROUTE_NAME));
      });
      GM_registerMenuCommand('Shuffle loaded For You feed', () => {
        if (mounted) reshuffleFeed(mounted);
      });
    }
    console.info(`[${SCRIPT}] ready`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
