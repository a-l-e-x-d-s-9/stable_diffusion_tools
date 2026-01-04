// ==UserScript==
// @name         Grok Imagine - Quick Favorite (Heart) Button
// @namespace    grok_imagine_favorite
// @version      0.41.1
// @description  Adds a heart button on media tiles. Better per-tile UUID detection + debug dump of all candidate UUIDs/URLs.
// @match        https://grok.com/imagine*
// @match        https://www.grok.com/imagine*
// @match        https://grok.com/imagine/post/*
// @match        https://www.grok.com/imagine/post/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.41.0';

  // Main debug toggle
  const DEBUG = true;

  // Extra UUID tracing. If true, clicking a heart prints *all* UUID candidates we see.
  const DEBUG_UUID_DUMP_ON_CLICK = true;

  // Optional: periodic duplicate-id report (can be noisy).
  const DEBUG_DUPES_EVERY_MS = 0; // e.g. 3000

  const log  = (...a) => DEBUG && console.log('[Fav]', ...a);
  const warn = (...a) => DEBUG && console.warn('[Fav]', ...a);

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
  const UUID_ONE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // Like-state cache to keep heart state stable across virtualized re-renders.
  const LIKE_CACHE_KEY = 'grok_imagine_like_cache_v1';
  const likedStateById = new Map();
  let likeCacheSaveTimer = null;

  function loadLikeCache() {
    try {
      const raw = localStorage.getItem(LIKE_CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (UUID_ONE.test(k) && v) likedStateById.set(k, true);
      }
    } catch (e) {
      log('warn', 'Failed to load like cache:', e);
    }
  }

  function saveLikeCacheSoon() {
    if (likeCacheSaveTimer) return;
    likeCacheSaveTimer = setTimeout(() => {
      likeCacheSaveTimer = null;
      try {
        const obj = {};
        // cap size to avoid unlimited growth
        let count = 0;
        for (const [k, v] of likedStateById.entries()) {
          if (!v) continue;
          obj[k] = 1;
          count += 1;
          if (count >= 4000) break;
        }
        localStorage.setItem(LIKE_CACHE_KEY, JSON.stringify(obj));
      } catch (e) {
        log('warn', 'Failed to save like cache:', e);
      }
    }, 350);
  }

  function setLikedCached(postId, liked) {
    if (!postId || !UUID_ONE.test(postId)) return;
    if (liked) likedStateById.set(postId, true);
    else likedStateById.delete(postId);
    saveLikeCacheSoon();
  }

  function isLikedCached(postId) {
    if (!postId || !UUID_ONE.test(postId)) return false;
    return likedStateById.get(postId) === true;
  }

  function pageIsFavorites() {
    return /\/imagine\/favorites(\/|$)/.test(location.pathname);
  }

  loadLikeCache();

  // -----------------------------
  // Small helpers
  // -----------------------------
  function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16)
    );
  }

  function cookieVal(name) {
    const parts = document.cookie.split(';').map(s => s.trim());
    const hit = parts.find(s => s.startsWith(name + '='));
    if (!hit) return null;
    try { return decodeURIComponent(hit.split('=').slice(1).join('=')); } catch { return hit.split('=').slice(1).join('='); }
  }

  function buildHeaders() {
    const h = {
      'accept': '*/*',
      'content-type': 'application/json',
      'x-xai-request-id': uuidv4(),
    };
    for (const k of ['x-challenge','x-signature','x-anon-token','x-anonuserid']) {
      const v = cookieVal(k);
      if (v) h[k] = v;
    }
    return h;
  }

  function originsToTry() {
    return [location.origin];
  }

  async function apiPost(path, body, opts = {}) {
    const p = path.startsWith('/') ? path : ('/' + path);
    const tries = originsToTry();

    let lastRes = null;
    for (const origin of tries) {
      const url = origin + p;
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          mode: 'cors',
          headers: { ...buildHeaders(), ...(opts.headers || {}) },
          body: JSON.stringify(body),
          referrer: opts.referrer || location.href,
          referrerPolicy: 'strict-origin-when-cross-origin',
        });

        lastRes = res;

        if (res.status === 404) continue;
        return res;
      } catch (e) {
        warn('apiPost exception for', url, e);
      }
    }
    return lastRes;
  }

  function unwrapNextImageUrl(u) {
    if (!u) return null;
    try {
      const urlObj = new URL(u, location.origin);
      const raw = urlObj.searchParams.get('url');
      if (!raw) return u;
      let real = decodeURIComponent(raw);
      if (real.startsWith('//')) real = 'https:' + real;
      if (real.startsWith('/imagine-public/')) real = 'https://imagine-public.x.ai' + real;
      return real;
    } catch {
      return u;
    }
  }

  function extractUuids(str) {
    if (!str) return [];
    const s = String(str);
    const m = s.match(UUID_RE);
    return m ? Array.from(new Set(m.map(x => x.toLowerCase()))) : [];
  }

    function firstUuidInUrl(u) {
      if (!u) return null;
      const m = String(u).match(UUID_ONE);
      return m ? String(m[0]).toLowerCase() : null;
    }

  function isBadMediaUrl(u) {
    if (!u) return true;
    const s = String(u);
    if (/^data:/i.test(s) || /^blob:/i.test(s)) return true;
    if (/profile-picture/i.test(s)) return true;
    if (/avatar/i.test(s)) return true;
    if (/favicon/i.test(s)) return true;
    return false;
  }

  function isAllowedMediaUrl(u) {
    if (!u || isBadMediaUrl(u)) return false;
    const s = String(u);
    if (s.includes('imagine-public.x.ai/imagine-public/')) return true;
    if (s.includes('imagine-public.x.ai/cdn-cgi/image/')) return true;
    if (s.includes('assets.grok.com/users/') && UUID_ONE.test(s)) return true;
    if (/^https?:\/\//i.test(s) && UUID_ONE.test(s) && /\.(png|jpe?g|webp|gif|mp4)(\?|$)/i.test(s)) return true;
    return false;
  }

  function parseSrcset(srcset) {
    if (!srcset) return [];
    const out = [];
    for (const part of String(srcset).split(',')) {
      const first = part.trim().split(/\s+/)[0];
      if (first) out.push(first);
    }
    return out;
  }

  // -----------------------------
  // Capture real image urls when the site sets src/srcset
  // -----------------------------
  function patchImageProps() {
    const proto = HTMLImageElement && HTMLImageElement.prototype;
    if (!proto) return;
    if (proto.__grokFavPatched) return;
    proto.__grokFavPatched = true;

    const descSrc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (descSrc && typeof descSrc.set === 'function') {
      Object.defineProperty(proto, 'src', {
        get: descSrc.get,
        set: function (v) {
          try {
            if (v && typeof v === 'string' && !/^data:/i.test(v) && !/^blob:/i.test(v)) {
              this.dataset.grokCdnSrc = v;
            }
          } catch {}
          return descSrc.set.call(this, v);
        },
        configurable: true,
        enumerable: true,
      });
    }

    const descSrcset = Object.getOwnPropertyDescriptor(proto, 'srcset');
    if (descSrcset && typeof descSrcset.set === 'function') {
      Object.defineProperty(proto, 'srcset', {
        get: descSrcset.get,
        set: function (v) {
          try {
            const urls = parseSrcset(v);
            const best = urls.map(unwrapNextImageUrl).find(isAllowedMediaUrl);
            if (best) this.dataset.grokCdnSrc = best;
          } catch {}
          return descSrcset.set.call(this, v);
        },
        configurable: true,
        enumerable: true,
      });
    }
  }
  patchImageProps();

  // -----------------------------
  // React fiber helpers
  // -----------------------------
  function getReactFiber(el) {
    if (!el) return null;
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
    }
    return null;
  }

  function looksLikeDomNode(obj) {
    return !!(obj && typeof obj === 'object' && (obj.nodeType || obj.tagName || obj.ownerDocument));
  }

  function collectPostsInObject(root, maxNodes = 5000, maxPosts = 60) {
    // BFS tends to stay "closer" to the current fiber props, which reduces picking a random global store URL.
    const q = [root];
    const seen = new Set();
    const posts = [];
    let steps = 0;

    while (q.length && steps < maxNodes) {
      steps++;
      const cur = q.shift();
      if (!cur) continue;

      if (typeof cur === 'string') continue;
      if (typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (looksLikeDomNode(cur)) continue;

      if (Array.isArray(cur)) {
        for (let i = 0; i < cur.length; i++) q.push(cur[i]);
        continue;
      }

      // Detect post-like objects
      const id = (typeof cur.id === 'string' && UUID_ONE.test(cur.id)) ? String(cur.id) : null;
      const mu0 = (typeof cur.mediaUrl === 'string') ? unwrapNextImageUrl(cur.mediaUrl) : null;
      const mu = (mu0 && isAllowedMediaUrl(mu0)) ? mu0 : null;

      if (id && mu) {
        const res = cur.resolution && typeof cur.resolution === 'object' ? cur.resolution : null;
        const w = res && typeof res.width === 'number' ? res.width : null;
        const h = res && typeof res.height === 'number' ? res.height : null;
        posts.push({
          id,
          mediaUrl: mu,
          width: w,
          height: h,
          mediaType: (typeof cur.mediaType === 'string') ? cur.mediaType : null,
          thumb: (typeof cur.thumbnailImageUrl === 'string') ? cur.thumbnailImageUrl : null,
        });
        if (posts.length >= maxPosts) break;
      }

      // Prioritize common containers first
      for (const k of ['post','posts','images','videos','childPosts','items','data','result','memoizedProps','pendingProps']) {
        if (k in cur) q.push(cur[k]);
      }

      // Then walk all keys
      for (const k of Object.keys(cur)) {
        if (k === 'children' || k === 'parent' || k === 'return') continue;
        q.push(cur[k]);
      }
    }

    // Dedup by id
    const uniq = new Map();
    for (const p of posts) {
      const key = String(p.id);
      if (!uniq.has(key)) uniq.set(key, p);
    }
    return Array.from(uniq.values());
  }

  function getTileDims(cardEl) {
    if (!cardEl) return null;
    const img = cardEl.querySelector('img[data-grok-saved-dims], img');
    if (!img) return null;

    const ds = (img.dataset && img.dataset.grokSavedDims) ? img.dataset.grokSavedDims : img.getAttribute('data-grok-saved-dims');
    if (ds) {
      const m = String(ds).match(/(\d{2,5})x(\d{2,5})/);
      if (m) return { w: Number(m[1]), h: Number(m[2]), src: 'data-grok-saved-dims' };
    }

    if (img.naturalWidth && img.naturalHeight) {
      return { w: img.naturalWidth, h: img.naturalHeight, src: 'natural' };
    }

    return null;
  }

  function chooseBestPostForTile(posts, dims, wantType) {
    if (!posts || !posts.length) return null;

    let filtered = posts;

    if (wantType === 'MEDIA_POST_TYPE_VIDEO') {
      filtered = posts.filter(p => (p.mediaType || '').includes('VIDEO')) || posts;
    } else if (wantType === 'MEDIA_POST_TYPE_IMAGE') {
      filtered = posts.filter(p => (p.mediaType || '').includes('IMAGE')) || posts;
    }
    if (!filtered.length) filtered = posts;

    if (dims && dims.w && dims.h) {
      const exact = filtered.filter(p => p.width === dims.w && p.height === dims.h);
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return exact[0]; // still ambiguous, but at least consistent
    }

    // If only one post, use it.
    if (filtered.length === 1) return filtered[0];

    // Otherwise, we cannot be sure; return first but debug will show the ambiguity.
    return filtered[0];
  }

  function findBestPostViaReact(cardEl) {
    const probeEls = [];
    if (cardEl) probeEls.push(cardEl);
    if (cardEl) {
      const img = cardEl.querySelector('img');
      if (img) probeEls.push(img);
      const video = cardEl.querySelector('video');
      if (video) probeEls.push(video);
    }

    const wantType = (cardEl && cardEl.querySelector('video')) ? 'MEDIA_POST_TYPE_VIDEO' : 'MEDIA_POST_TYPE_IMAGE';
    const dims = getTileDims(cardEl);

    for (const el of probeEls) {
      const fiber = getReactFiber(el);
      if (!fiber) continue;

      let f = fiber;
      for (let i = 0; i < 10 && f; i++) {
        // IMPORTANT: Only scan props first. StateNode/memoizedState can be huge global stores and cause "same uuid everywhere".
        const postsA = collectPostsInObject(f.memoizedProps, 2500, 40);
        const pickA = chooseBestPostForTile(postsA, dims, wantType);
        if (pickA) return { post: pickA, posts: postsA, dims, wantType, source: 'memoizedProps' };

        const postsB = collectPostsInObject(f.pendingProps, 2500, 40);
        const pickB = chooseBestPostForTile(postsB, dims, wantType);
        if (pickB) return { post: pickB, posts: postsB, dims, wantType, source: 'pendingProps' };

        f = f.return;
      }
    }

    return { post: null, posts: [], dims: getTileDims(cardEl), wantType: (cardEl && cardEl.querySelector('video')) ? 'MEDIA_POST_TYPE_VIDEO' : 'MEDIA_POST_TYPE_IMAGE', source: null };
  }

  // -----------------------------
  // Intercept /create called by the page and cache mediaUrl->postId
  // -----------------------------
  let lastPointerEl = null;
  document.addEventListener('pointerdown', (e) => {
    lastPointerEl = e && e.target ? e.target : null;
  }, true);

  const mediaUrlToPostId = new Map();

  function findTileFromEl(el) {
    if (!el) return null;
    return el.closest('[role="listitem"], [class*="group/media-post-masonry-card"]');
  }

  function interceptFetch() {
    const origFetch = window.fetch;
    if (origFetch.__grokFavWrapped) return;
    origFetch.__grokFavWrapped = true;

    window.fetch = async function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
      const method = (init && init.method) ? init.method : (typeof input !== 'string' && input && input.method) ? input.method : 'GET';

      const isCreate = (method || '').toUpperCase() === 'POST' && /\/rest\/media\/post\/create(\?|$)/.test(url);
      if (!isCreate) return origFetch.apply(this, arguments);

      let reqBody = null;
      try {
        if (init && typeof init.body === 'string') reqBody = JSON.parse(init.body);
      } catch {}

      const mediaUrl = reqBody && reqBody.mediaUrl ? String(reqBody.mediaUrl) : null;

      const res = await origFetch.apply(this, arguments);

      try {
        const clone = res.clone();
        const txt = await clone.text();
        const j = txt ? JSON.parse(txt) : null;
        const postId = j && j.post && j.post.id ? String(j.post.id) : null;

        if (mediaUrl && postId) {
          mediaUrlToPostId.set(mediaUrl, postId);

          const tile = findTileFromEl(lastPointerEl);
          if (tile) {
            try {
              tile.dataset.grokMediaUrl = mediaUrl;
              tile.dataset.grokPostId = postId;
            } catch {}
          }
        }
      } catch {}

      return res;
    };
  }
  interceptFetch();

  // -----------------------------
  // Media resolving
  // -----------------------------

  function pickBestMediaUrl(tileEl) {
    if (!tileEl) return null;

    const candidates = [];
    const seen = new Set();

    const push = (u) => {
      if (!u) return;
      const real = unwrapNextImageUrl(u);
      if (!real || isBadMediaUrl(real)) return;
      if (seen.has(real)) return;
      seen.add(real);
      candidates.push(real);
    };

    const imgs = Array.from(tileEl.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const cdn = img.dataset.grokCdnSrc || img.getAttribute('data-grok-cdn-src') || '';

      const srcIsGen = src.includes('/generated/') && UUID_ONE.test(src);
      const cdnIsContent = /\/content(\?|$)/i.test(cdn);
      const cdnIsGen = cdn.includes('/generated/') && UUID_ONE.test(cdn);

      // IMPORTANT: On the edit page, Grok often sets data-grok-cdn-src to the SOURCE image (..../content)
      // while src points to the NEW edited result (..../generated/<id>/image.jpg). Prefer the result.
    if (srcIsGen && cdnIsContent && !cdnIsGen) {
      push(src);
      push(cdn);
    } else {
      const realSrc = unwrapNextImageUrl(src);
      const realCdn = unwrapNextImageUrl(cdn);

      const srcOk = isAllowedMediaUrl(realSrc);
      const cdnOk = isAllowedMediaUrl(realCdn);

      // If both look valid but point to different UUIDs, prefer what is actually displayed (src/currentSrc).
      if (srcOk && cdnOk) {
        const us = firstUuidInUrl(realSrc);
        const uc = firstUuidInUrl(realCdn);
        if (us && uc && us !== uc) {
          push(src);
          push(cdn);
        } else {
          push(cdn);
          push(src);
        }
      } else {
        push(cdn);
        push(src);
      }
    }


      const srcset = img.getAttribute('srcset') || '';
      for (const u of parseSrcset(srcset)) push(u);

      const dataSrc = img.dataset.src || img.getAttribute('data-src') || '';
      push(dataSrc);
    }

    const norm = candidates.filter(isAllowedMediaUrl);
    if (!norm.length) {
      // React fallback (some pages do not expose direct media URLs on the DOM).
      const react = getReactProps(tileEl);
      const reactMedia = react && pickFromReactProps(react);
      if (reactMedia && isAllowedMediaUrl(reactMedia)) return reactMedia;
      return null;
    }

    // Prefer stable/public share-image URLs when available (works for both direct and cdn-cgi wrappers).
    const preferred = norm.find(s =>
      s.includes('/imagine-public/share-images/') ||
      s.includes('/imagine-public/images/')
    );

    return preferred || norm[0] || null;
  }


  function inferMediaTypeFromUrl(u, cardEl) {
    const s = String(u || '');
    if (/\.mp4(\?|$)/i.test(s)) return 'MEDIA_POST_TYPE_VIDEO';
    if (cardEl && cardEl.querySelector('video')) return 'MEDIA_POST_TYPE_VIDEO';
    return 'MEDIA_POST_TYPE_IMAGE';
  }

  function extractCandidateId(cardEl, mediaUrl) {
    if (!cardEl) return null;

     const mediaUuid = (() => {
      if (!mediaUrl) return null;
      const s = String(mediaUrl);

      // assets.grok.com/users/<userId>/generated/<postId>/image.jpg
      const mGen = s.match(/\/generated\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (mGen) return mGen[1];

      // Some CDNs use /share-images/<postId>.jpg style
      const mShare = s.match(/\/share-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (mShare) return mShare[1];

      const m = s.match(UUID_ONE);
      return m ? m[0] : null;
    })();

    // Cached by our intercept or by React post pick.
    const cached = cardEl.dataset && cardEl.dataset.grokPostId ? String(cardEl.dataset.grokPostId) : null;
    if (cached && UUID_ONE.test(cached)) {
      // If cached is stale (does not match mediaUrl uuid), ignore it to avoid "same uuid everywhere".
      if (mediaUuid && cached.toLowerCase() !== mediaUuid.toLowerCase()) {
        // stale
      } else {
        return cached;
      }
    }

    const a = cardEl.querySelector('a[href*="/imagine/post/"]');
    if (a) {
      const href = a.getAttribute('href') || '';
      const m = href.match(UUID_ONE);
      if (m) return m[0];
    }

    if (mediaUuid) return mediaUuid;

    const els = [cardEl, ...Array.from(cardEl.querySelectorAll('*')).slice(0, 30)];
    for (const el of els) {
      for (const at of Array.from(el.attributes || [])) {
        const v = at && at.value ? at.value : '';
        const m = String(v).match(UUID_ONE);
        if (m) return m[0];
      }
    }

    return null;
  }

  function isMediaCard(cardEl) {
    if (!cardEl) return false;
    if (cardEl.querySelector('.grok-fav-btn')) return true;
    if (cardEl.querySelector('a[href*="/imagine/post/"]')) return true;
    if (cardEl.querySelector('video, source')) return true;
    if (cardEl.querySelector('img')) return true;
    return false;
  }



  // Normalize mediaUrl before calling /create so the created post matches native behavior
  // (no "?cache=1" or other query/hash parts that can break downstream actions like video generation).
  function normalizeMediaUrlForCreate(u) {
    const s = String(u || '');
    if (!s) return s;

    // Do not touch non-network URLs
    if (/^(data|blob):/i.test(s)) return s;

    try {
      const url = new URL(s, location.origin);
      if (!url.search && !url.hash) return url.toString();
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // Fallback: strip at first ? or #
      return s.split('?')[0].split('#')[0];
    }
  }

  // -----------------------------
  // API flow: create -> like/unlike
  // -----------------------------
  async function createPost(mediaType, mediaUrl) {
    const cleanUrl = normalizeMediaUrlForCreate(mediaUrl);

    const res = await apiPost(
      '/rest/media/post/create',
      { mediaType, mediaUrl: cleanUrl },
      { referrer: location.href }
    );
    if (!res) return { ok: false, status: 0, postId: null, text: 'no response' };

    const txt = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, postId: null, text: txt };

    try {
      const j = txt ? JSON.parse(txt) : {};
      const postId = j && j.post && j.post.id ? String(j.post.id) : null;

      // Keep cache compatibility: store both the clean and original URL keys (if different).
      if (postId) {
        if (cleanUrl) mediaUrlToPostId.set(cleanUrl, postId);
        if (mediaUrl && mediaUrl !== cleanUrl) mediaUrlToPostId.set(mediaUrl, postId);
      }

      return { ok: true, status: res.status, postId, text: txt };
    } catch {
      return { ok: true, status: res.status, postId: null, text: txt };
    }
  }


  async function likeUnlike(postId, doUnlike) {
    const endpoint = doUnlike ? '/rest/media/post/unlike' : '/rest/media/post/like';
    const res = await apiPost(endpoint, { id: postId }, { referrer: location.href });
    if (!res) return { ok: false, status: 0, text: 'no response' };
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  }

  // -----------------------------
  // Debug dump
  // -----------------------------
  function dumpTileDebug(scanEl) {
    if (!DEBUG_UUID_DUMP_ON_CLICK || !scanEl) return;

    const badge = scanEl.querySelector('.gi-badge') ? scanEl.querySelector('.gi-badge').textContent.trim() : '';
    const dims = getTileDims(scanEl);

    const urls = [];
    for (const img of Array.from(scanEl.querySelectorAll('img'))) {
      if (img.dataset && img.dataset.grokCdnSrc) urls.push({ src: 'img.dataset.grokCdnSrc', url: img.dataset.grokCdnSrc });
      const src = img.currentSrc || img.src || img.getAttribute('src');
      if (src) urls.push({ src: 'img.src/currentSrc', url: src });
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      for (const u of parseSrcset(srcset)) urls.push({ src: 'img.srcset', url: u });
    }
    for (const s of Array.from(scanEl.querySelectorAll('video source'))) {
      const src = s.src || s.getAttribute('src');
      if (src) urls.push({ src: 'video.source', url: src });
    }
    for (const v of Array.from(scanEl.querySelectorAll('video'))) {
      const poster = v.poster || v.getAttribute('poster');
      if (poster) urls.push({ src: 'video.poster', url: poster });
    }

    const urls2 = urls.map(x => ({ ...x, url: unwrapNextImageUrl(x.url) }));
    const allowed = urls2.filter(x => isAllowedMediaUrl(x.url));
    const allowedUuids = Array.from(new Set(allowed.flatMap(x => extractUuids(x.url))));

    // Attributes UUIDs
    const attrUuids = new Set();
    const els = [scanEl, ...Array.from(scanEl.querySelectorAll('*')).slice(0, 60)];
    for (const el of els) {
      for (const at of Array.from(el.attributes || [])) {
        for (const u of extractUuids(at.value)) attrUuids.add(u);
      }
    }

    // React posts
    const r = findBestPostViaReact(scanEl);
    const postUuids = r.posts ? r.posts.map(p => String(p.id).toLowerCase()) : [];
    const uniquePostUuids = Array.from(new Set(postUuids));

    const pickedMediaUrl = pickBestMediaUrl(scanEl);
    const pickedId = extractCandidateId(scanEl, pickedMediaUrl);

    console.groupCollapsed('[Fav] UUID dump' + (badge ? (' badge=' + badge) : ''));
    console.log('dims:', dims);
    console.log('cached dataset:', {
      grokMediaUrl: scanEl.dataset ? scanEl.dataset.grokMediaUrl : null,
      grokPostId: scanEl.dataset ? scanEl.dataset.grokPostId : null,
    });
    console.log('allowed urls (dom):', allowed.slice(0, 12));
    console.log('allowed uuids (dom):', allowedUuids);
    console.log('uuids in attrs:', Array.from(attrUuids));
    console.log('react source:', r.source, 'wantType:', r.wantType, 'posts found:', r.posts ? r.posts.length : 0);
    console.log('react uuids:', uniquePostUuids.slice(0, 25));
    console.log('react sample posts:', (r.posts || []).slice(0, 8).map(p => ({ id: p.id, w: p.width, h: p.height, url: p.mediaUrl })));
    console.log('picked mediaUrl:', pickedMediaUrl);
    console.log('picked id:', pickedId);
    console.groupEnd();
  }

  // -----------------------------
  // UI
  // -----------------------------
  function makeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grok-fav-btn';
    btn.title = 'Favorite';
    btn.style.cssText = [
      'position:absolute',
      'top:10px',
      'right:10px',
      'z-index:9999',
      'width:36px',
      'height:36px',
      'border-radius:999px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.45)',
      'border:1px solid rgba(255,255,255,0.25)',
      'backdrop-filter: blur(6px)',
      'cursor:pointer',
      'color:white',
      'user-select:none',
      'opacity:1',
      'pointer-events:auto',
      'outline:none'
    ].join(';');

    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>';

    btn.dataset.liked = '0';
    btn.setState = (liked) => {
      btn.dataset.liked = liked ? '1' : '0';
      btn.style.background = liked ? 'rgba(34, 197, 94, 0.85)' : 'rgba(0,0,0,0.45)';
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
    };

    return btn;
  }


  async function onHeartClick(e, hostEl, btn) {
    e.preventDefault();
    e.stopPropagation();

    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';

    const liked = btn.dataset.liked === '1';
    const onFavPage = pageIsFavorites();

    btn.style.opacity = '0.55';
    btn.style.pointerEvents = 'none';

    try {
      const scanEl = hostEl.closest('[role="listitem"]') || hostEl;

      dumpTileDebug(scanEl);

      let mediaUrl = pickBestMediaUrl(scanEl);
      let candidateId = extractCandidateId(scanEl, mediaUrl);

      // If mediaUrl is missing or looks wrong, try React fiber for a better match.
      if (!mediaUrl || !isAllowedMediaUrl(mediaUrl)) {
        const post = findBestPostViaReact(scanEl);
        if (post && post.mediaUrl && isAllowedMediaUrl(post.mediaUrl)) {
          mediaUrl = post.mediaUrl;
          if (UUID_ONE.test(post.id || '')) candidateId = post.id;
          scanEl.dataset.grokMediaUrl = mediaUrl;
          if (UUID_ONE.test(candidateId || '')) scanEl.dataset.grokPostId = candidateId;
        }
      }

      if (onFavPage) {
        // Favorites page: toggle like/unlike by id only - never call create.
        const idToUse =
          (UUID_ONE.test(candidateId || '')) ? candidateId :
          (btn.dataset && UUID_ONE.test(btn.dataset.postId || '')) ? btn.dataset.postId :
          (scanEl.dataset && UUID_ONE.test(scanEl.dataset.grokPostId || '')) ? scanEl.dataset.grokPostId :
          null;

        if (!idToUse) throw new Error('Could not resolve post id on favorites page');
        scanEl.dataset.grokPostId = idToUse;
        btn.dataset.postId = idToUse;

        const doUnlike = liked; // if currently liked, unlike; else like
        const res = await likeUnlike(idToUse, doUnlike);
        if (!res.ok) throw new Error((doUnlike ? 'Unlike' : 'Like') + ' failed: ' + res.status + ' ' + (res.text || '').slice(0, 200));

        btn.setState(!doUnlike);
        setLikedCached(idToUse, !doUnlike);
        log((doUnlike ? 'Unliked' : 'Liked') + ' (favorites):', idToUse);
        return;
      }

      if (liked) {
        // Unlike without create.
        let idToUse = null;

        if (scanEl.dataset && UUID_ONE.test(scanEl.dataset.grokPostId || '')) idToUse = scanEl.dataset.grokPostId;
        else if (btn.dataset && UUID_ONE.test(btn.dataset.postId || '')) idToUse = btn.dataset.postId;
        else if (mediaUrl && mediaUrlToPostId.has(mediaUrl)) idToUse = mediaUrlToPostId.get(mediaUrl);
        else if (UUID_ONE.test(candidateId || '')) idToUse = candidateId;

        if (!idToUse) throw new Error('Could not resolve post id to unlike');

        const res = await likeUnlike(idToUse, true);
        if (!res.ok) throw new Error('Unlike failed: ' + res.status + ' ' + (res.text || '').slice(0, 200));

        btn.setState(false);
        setLikedCached(idToUse, false);
        log('Unliked:', idToUse);
        return;
      }

      // Like: keep the proven create -> like flow.
      if (!mediaUrl) throw new Error('Could not find mediaUrl in this tile');

      const wantType = inferMediaTypeFromUrl(mediaUrl, scanEl);

      let postId = null;
      if (mediaUrlToPostId.has(mediaUrl)) postId = mediaUrlToPostId.get(mediaUrl);

      if (!postId) {
        const created = await createPost(wantType, mediaUrl);
        if (created && created.postId && UUID_ONE.test(created.postId)) {
          postId = created.postId;
        }
      }

      if (!postId && UUID_ONE.test(candidateId || '')) postId = candidateId;
      if (!postId) throw new Error('API failed to return Post ID');

      scanEl.dataset.grokPostId = postId;
      btn.dataset.postId = postId;

      const res = await likeUnlike(postId, false);
      if (!res.ok) throw new Error('Like failed: ' + res.status + ' ' + (res.text || '').slice(0, 200));

      btn.setState(true);
      setLikedCached(postId, true);
      log('Liked:', postId);
    } catch (err) {
      warn('Operation failed:', err);
    } finally {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      btn.dataset.busy = '0';
    }
  }



function initButtonState(cardEl, btn) {
  if (!btn) return;

  // Favorites page: everything starts as liked (unlike should not call create).
  if (pageIsFavorites()) {
    btn.setState(true);
    return;
  }

  const mediaUrl = pickBestMediaUrl(cardEl);

  // Prefer the mapping we learned from /create (most reliable).
  let id = null;
  if (mediaUrl && mediaUrlToPostId.has(mediaUrl)) id = mediaUrlToPostId.get(mediaUrl);

  // Then fall back to DOM/react-derived candidates (includes stale-dataset protection).
  if (!id) {
    const candidateId = extractCandidateId(cardEl, mediaUrl);
    if (UUID_ONE.test(candidateId || '')) id = candidateId;
  }

  if (id && UUID_ONE.test(id)) {
    btn.dataset.postId = id;
    btn.setState(isLikedCached(id));
  } else {
    btn.dataset.postId = '';
    btn.setState(false);
  }
}

function inject(cardEl) {
  if (!isMediaCard(cardEl)) return;

  const target =
    cardEl.querySelector('[class*="group/media-post-masonry-card"]') ||
    cardEl.querySelector('.relative.group\\/media-post-masonry-card') ||
    cardEl.querySelector('.relative') ||
    cardEl;

  const cs = getComputedStyle(target);
  if (cs.position === 'static') target.style.position = 'relative';

  let btn = target.querySelector(':scope > .grok-fav-btn') || target.querySelector('.grok-fav-btn');
  if (!btn) {
    btn = makeButton();
    btn.addEventListener('click', (e) => onHeartClick(e, target, btn));
    target.appendChild(btn);
  }

  // IMPORTANT: Always refresh state - the main viewer swaps the <img> under the same DOM node.
  initButtonState(target, btn);
}

  function scan() {
    const set = new Set();

    // Main grids (favorites, explore, masonry).
    document
      .querySelectorAll('[role="listitem"], [class*="group/media-post-masonry-card"]')
      .forEach(el => set.add(el));

    // Edit UI / post view: main selected image wrapper (div.grid).
    document
      .querySelectorAll('div.grid > img[src], div.grid > img[data-grok-cdn-src]')
      .forEach(img => {
        if (img.closest('[role="listitem"], [class*="group/media-post-masonry-card"]')) return;

        const uSrc = img.getAttribute('src') || '';
        const uCdn = img.dataset.grokCdnSrc || img.getAttribute('data-grok-cdn-src') || '';

        if (!isAllowedMediaUrl(uSrc) && !isAllowedMediaUrl(uCdn)) return;

        const host = img.closest('div.grid') || img.parentElement;
        if (host) set.add(host);
      });

    set.forEach(inject);
  }


  function dumpDupesOnce() {
    const tiles = Array.from(document.querySelectorAll('[role="listitem"]'));
    const rows = [];
    for (const t of tiles) {
      const mediaUrl = pickBestMediaUrl(t);
      const id = extractCandidateId(t, mediaUrl);
      const badge = t.querySelector('.gi-badge') ? t.querySelector('.gi-badge').textContent.trim() : '';
      if (id) rows.push({ badge, id: id.toLowerCase(), mediaUrl });
    }
    const counts = new Map();
    for (const r of rows) counts.set(r.id, (counts.get(r.id) || 0) + 1);
    const dupes = rows.filter(r => counts.get(r.id) > 1);
    if (dupes.length) {
      console.groupCollapsed('[Fav] Duplicate id report (' + dupes.length + ' entries)');
      console.table(dupes.slice(0, 30));
      console.groupEnd();
    } else {
      log('Duplicate id report: none');
    }
  }

  scan();
  setInterval(scan, 1200);

  if (DEBUG_DUPES_EVERY_MS && DEBUG_DUPES_EVERY_MS > 0) {
    setInterval(dumpDupesOnce, DEBUG_DUPES_EVERY_MS);
  }

  log('Grok Fav Script v' + VERSION + ' active');
})();