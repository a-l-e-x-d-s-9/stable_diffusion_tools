// ==UserScript==
// @name         Insta Scan with Full Caption — FAST (hires DOM, minimal changes)
// @namespace    http://tampermonkey.net/
// @version      0.45
// @description  Fast image downloads with captions and optional video downloads
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      cdninstagram.com
// @connect      *.cdninstagram.com
// @connect      fbcdn.net
// @connect      *.fbcdn.net
// @connect      *.fna.fbcdn.net
// @connect      instagram.com
// @connect      *.instagram.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ---- minimal config (keep it fast) ----
  const DEBUG = false;
  const TARGET_SIZE = 1080;           // prefer >=1080 candidates
  const MIN_MEDIA_W = 140, MIN_MEDIA_H = 140;

  // ---- persistent state ----
  let downloadedImages = JSON.parse(GM_getValue('downloadedImages', '{}'));
  let downloadedVideos = JSON.parse(GM_getValue('downloadedVideos', '{}'));
  let startSlideshow = false;
  let stopSlideshow  = false;

  // Per-run download limit (persistent; configurable from the userscript menu)
  const savedMaximum = Number.parseInt(GM_getValue('maximum_downloads', 1000), 10);
  let MAXIMUM_DOWNLOADS = Number.isFinite(savedMaximum) && savedMaximum > 0 ? savedMaximum : 1000;
  let sessionDownloadCount = 0;
  let downloadStatus = 'idle';
  let statusBadge = null;
  let limitNotificationShown = false;
  let unsupportedVideoNoticeShown = false;

  // caption .txt toggle (persistent; default ON)
  let SAVE_CAPTIONS = GM_getValue('save_captions', true);
  // Video downloads are opt-in and persist across page loads.
  let DOWNLOAD_VIDEOS = GM_getValue('download_videos', false);

  // ====== helpers ======
  const log = (...a)=> DEBUG && console.log('[InstaFast]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function ensureStatusBadge(){
    if (statusBadge && statusBadge.isConnected) return statusBadge;
    statusBadge = document.createElement('div');
    statusBadge.id = 'instafast-download-status';
    Object.assign(statusBadge.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: '2147483647',
      padding: '10px 14px',
      borderRadius: '8px',
      background: 'rgba(20, 20, 20, 0.92)',
      color: '#fff',
      font: '600 14px/1.35 system-ui, sans-serif',
      boxShadow: '0 2px 12px rgba(0, 0, 0, 0.35)',
      pointerEvents: 'none'
    });
    (document.body || document.documentElement).appendChild(statusBadge);
    return statusBadge;
  }

  function updateDownloadStatus(status = downloadStatus){
    downloadStatus = status;
    const badge = ensureStatusBadge();
    const labels = {
      running: 'Downloading',
      stopped: 'Stopped',
      limit: 'Limit reached'
    };
    badge.textContent = `InstaFast — ${labels[status] || 'Ready'}: ${sessionDownloadCount.toLocaleString()} / ${MAXIMUM_DOWNLOADS.toLocaleString()} media (videos ${DOWNLOAD_VIDEOS ? 'ON' : 'OFF'})`;
    badge.style.border = status === 'running' ? '1px solid #42d392' :
                         status === 'limit' ? '1px solid #ffb020' : '1px solid #777';
  }

  function stopDownloadMode(status = 'stopped'){
    startSlideshow = false;
    stopSlideshow = true;
    updateDownloadStatus(status);
  }

  function stopAtDownloadLimit(){
    stopDownloadMode('limit');
    if (limitNotificationShown) return;
    limitNotificationShown = true;
    GM_notification({
      text: `Downloaded ${sessionDownloadCount.toLocaleString()} / ${MAXIMUM_DOWNLOADS.toLocaleString()} media files. Download mode stopped.`,
      title: 'InstaFast — download limit reached',
      timeout: 4000
    });
  }

  function isVisible(el){
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  // prefer modal; else article nearest center
  function getCurrentContainer(){
    const modal = document.querySelector('div[role="dialog"]');
    if (modal) return modal;
    const arts = [...document.querySelectorAll('article')].filter(isVisible);
    if (!arts.length) return document.body;
    const cx = innerWidth/2, cy = innerHeight/2;
    let best=null;
    for (const a of arts){
      const r=a.getBoundingClientRect();
      const dx=Math.max(r.left-cx,cx-r.right,0), dy=Math.max(r.top-cy,cy-r.bottom,0);
      const d=dx*dx+dy*dy;
      if (!best || d<best.d) best={el:a,d};
    }
    return best?best.el:document.body;
  }

  function isLikelyMedia(img){
    if (!isVisible(img)) return false;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_MEDIA_W || r.height < MIN_MEDIA_H) return false;
    const u = (img.currentSrc || img.src || '').toLowerCase();
    if (!/cdninstagram|fbcdn|instagram\.f/.test(u)) return false;
    const alt = (img.alt || '').toLowerCase();
    if (alt.includes('profile picture')) return false;
    return true;
  }

  // Looser media detector used only if strict scan finds nothing
  function isMaybeMedia(img){
    if (!isVisible(img)) return false;
    const r = img.getBoundingClientRect();
    if (r.width < 32 || r.height < 32) return false; // allow small, but not tiny
    const combo = ((img.currentSrc || img.src || '') + ' ' + (img.getAttribute('srcset') || '')).toLowerCase();
    if (!/cdninstagram|fbcdn|instagram\.f/.test(combo)) return false;
    const alt = (img.alt || '').toLowerCase();
    if (alt.includes('profile picture')) return false;
    return true;
  }

  function isLikelyVideo(video){
    if (!isVisible(video)) return false;
    const r = video.getBoundingClientRect();
    return r.width >= MIN_MEDIA_W && r.height >= MIN_MEDIA_H;
  }

  function isDirectVideoUrl(raw){
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' &&
        /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(u.hostname) &&
        !/\.m3u8$/i.test(u.pathname);
    } catch { return false; }
  }

  function videoUrl(video){
    const candidates = [video.currentSrc, video.src,
      ...[...video.querySelectorAll('source[src]')].map(source => source.src)];
    return candidates.find(isDirectVideoUrl) || '';
  }

  function postInfo(container){
    const links = [];
    const timeLink = container.querySelector('time')?.closest('a');
    if (timeLink) links.push(timeLink.href);
    for (const a of container.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]')){
      links.push(a.href);
    }
    links.push(location.href);
    for (const raw of links){
      try {
        const u = new URL(raw, location.origin);
        if (u.origin !== location.origin) continue;
        const match = u.pathname.match(/^\/(p|reel|reels)\/([A-Za-z0-9_-]+)(?:\/|$)/);
        if (match) return {
          code: match[2],
          url: location.origin + '/' + (match[1] === 'reels' ? 'reel' : match[1]) + '/' + match[2] + '/'
        };
      } catch {}
    }
    return null;
  }

  function videoEntry(media, index){
    const variants = [];
    if (Array.isArray(media.video_versions)){
      for (const version of media.video_versions){
        if (isDirectVideoUrl(version.url)){
          variants.push({
            url: version.url,
            pixels: (Number(version.width) || 0) * (Number(version.height) || 0)
          });
        }
      }
    }
    if (isDirectVideoUrl(media.video_url)) variants.push({url: media.video_url, pixels: 0});
    if (!variants.length) return null;
    variants.sort((a, b) => b.pixels - a.pixels);
    const posters = [
      media.display_url,
      ...((media.image_versions2 && media.image_versions2.candidates) || []).map(c => c.url)
    ].filter(Boolean);
    return {url: variants[0].url, index, posters};
  }

  function postVideosFromData(root, code){
    const stack = [root];
    let scanned = 0;
    while (stack.length && scanned++ < 100000){
      const node = stack.pop();
      if (typeof node === 'string'){
        if (node.includes(code) && (node.includes('video_versions') || node.includes('video_url')) && /^[\s]*[\[{]/.test(node)){
          try { stack.push(JSON.parse(node)); } catch {}
        }
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      if (node.code === code || node.shortcode === code){
        const children = Array.isArray(node.carousel_media) ? node.carousel_media :
          (node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges || [])
            .map(edge => edge.node).filter(Boolean);
        if (children.length){
          const entries = children.map((child, index) => videoEntry(child, index)).filter(Boolean);
          if (entries.length) return entries;
        }
        const single = videoEntry(node, 0);
        if (single) return [single];
      }
      if (Array.isArray(node)){
        for (const child of node) stack.push(child);
      } else {
        for (const child of Object.values(node)) stack.push(child);
      }
    }
    return [];
  }

  function postVideosFromScripts(scripts, code){
    for (const script of scripts){
      const source = script.textContent || '';
      if (!source.includes(code) ||
          (!source.includes('video_versions') && !source.includes('video_url'))) continue;
      try {
        const entries = postVideosFromData(JSON.parse(source), code);
        if (entries.length) return entries;
      } catch {}
    }
    return [];
  }

  const postVideoCache = new Map();
  async function postVideos(info){
    const cached = postVideoCache.get(info.code);
    if (cached && cached.hasData && Date.now() - cached.time < 120000) return cached.promise;
    const embedded = postVideosFromScripts(document.scripts, info.code);
    if (embedded.length){
      const promise = Promise.resolve(embedded);
      postVideoCache.set(info.code, {time: Date.now(), promise, hasData: true});
      return promise;
    }
    if (cached && Date.now() - cached.time < 120000) return cached.promise;
    const promise = (async () => {
      try {
        const response = await fetch(info.url, {credentials: 'include'});
        if (!response.ok) return [];
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        return postVideosFromScripts(page.scripts, info.code);
      } catch (error) {
        log('Could not load post video data', error);
        return [];
      }
    })();
    postVideoCache.set(info.code, {time: Date.now(), promise});
    return promise;
  }

  function mediaPath(raw){
    try {
      const u = new URL(raw);
      return u.origin + u.pathname;
    } catch { return ''; }
  }

  function videoEntryForElement(entries, video){
    if (entries.length === 1) return entries[0];

    const slide = typeof video.closest === 'function' ? video.closest('li') : null;
    const poster = video.poster || (slide && slide.querySelector('img')?.currentSrc) || '';
    const posterPath = mediaPath(poster);
    if (posterPath){
      const matches = entries.filter(entry => entry.posters.some(url => mediaPath(url) === posterPath));
      if (matches.length === 1) return matches[0];
    }

    if (slide && slide.parentElement){
      const siblings = [...slide.parentElement.children].filter(el => el.tagName === 'LI');
      const index = siblings.indexOf(slide);
      const match = entries.find(entry => entry.index === index);
      if (match) return match;
    }
    return null;
  }

  async function resolveVideoUrl(video, container){
    const direct = videoUrl(video);
    if (direct) return direct;
    const info = postInfo(container);
    if (!info) return '';
    const entries = await postVideos(info);
    return videoEntryForElement(entries, video)?.url || '';
  }

  function getCarouselNextButton(container){
    return (
      container.querySelector('button[aria-label="Next"]:not([disabled])') ||
      container.querySelector('button[aria-label="Next"][aria-disabled="false"]') ||
      container.querySelector('[role="button"][aria-label="Next"]') ||
      (()=>{ const svg=container.querySelector('svg[aria-label="Next"]'); return svg? svg.closest("button,[role='button'],a") : null; })()
    );
  }

  function getActiveMediaKey(container){
    const media = [
      ...[...container.querySelectorAll('picture img, img')].filter(isLikelyMedia),
      ...[...container.querySelectorAll('video')].filter(isLikelyVideo)
    ];
    if (!media.length) return '';
    const scope = container.getBoundingClientRect();
    const cx = scope.left + scope.width/2, cy = scope.top + scope.height/2;
    media.sort((a, b) => {
      const distance = el => {
        const r = el.getBoundingClientRect();
        return Math.abs((r.left + r.width/2) - cx) + Math.abs((r.top + r.height/2) - cy);
      };
      return distance(a) - distance(b);
    });
    const el = media[0];
    const isVideo = el.tagName === 'VIDEO';
    const url = isVideo ? (el.currentSrc || el.src || el.poster) : bestHiResFromImg(el);
    return url ? `${isVideo ? 'video' : 'image'}:${keyFor(url)}` : '';
  }

  function keyFor(url){
    try{
      const u = new URL(url);
      const igk = u.searchParams.get('ig_cache_key');
      if (igk) return 'igk:'+igk;
      const base = (u.pathname.split('/').pop()||'image').replace(/\.[a-z0-9]+$/i,'');
      return 'base:'+base;
    }catch{
      const base = (url.split('?')[0].split('/').pop()||'image').replace(/\.[a-z0-9]+$/i,'');
      return 'base:'+base;
    }
  }

  // ---- pick hi-res from <img>/<picture> (single robust version) ----
  function hasStp(u){
    try { return new URL(u).searchParams.has('stp'); }
    catch { return /[?&]stp=/.test(u); }
  }
  function hintedWidthFromPath(u){
    const m = u.match(/[_/](?:[ps])(\d{3,4})x\1([_/?.]|$)/);
    return m ? parseInt(m[1],10) : 0;
  }
  function stpWidth(u){
    try {
      const s = new URL(u).searchParams.get('stp') || '';
      const m = s.match(/(?:^|_)p(\d{3,4})x\1(?:_|$)/);
      if (m) return parseInt(m[1],10);
    } catch {}
    const m2 = u.match(/[?&]stp=[^&]*?(?:^|_)p(\d{3,4})x\1(?:_|$)/);
    return m2 ? parseInt(m2[1],10) : 0;
  }
  function parseSrcset(ss){
    const out = [];
    if (!ss) return out;
    for (const part of ss.split(',').map(s=>s.trim()).filter(Boolean)){
      const sp = part.lastIndexOf(' ');
      let u = part, desc = '';
      if (sp>0){ u = part.slice(0,sp); desc = part.slice(sp+1); }
      let w = 0;
      if (/^\d+w$/.test(desc)) w = parseInt(desc,10);
      else if (/^\d+(\.\d+)?x$/.test(desc)) w = Math.round(parseFloat(desc)*1000);
      const wStp = stpWidth(u);
      const wHint= hintedWidthFromPath(u);
      if (!w) w = wStp || wHint;
      const stp = hasStp(u);
      if (!w && !stp) w = 999999; // prefer no-stp (often original/or larger)
      out.push({u,w,stp});
    }
    return out;
  }
  function bestHiResFromImg(img){
    const cand = [];
    const pic = img.closest('picture');
    if (pic){
      for (const s of pic.querySelectorAll('source[srcset]')){
        cand.push(...parseSrcset(s.getAttribute('srcset')));
      }
    }
    cand.push(...parseSrcset(img.getAttribute('srcset')||''));
    for (const raw of [img.currentSrc, img.src]){
      if (!raw) continue;
      const u = String(raw);
      cand.push({ u, w: stpWidth(u)||hintedWidthFromPath(u)||0, stp: hasStp(u) });
    }
    const filtered = cand.filter(c => /(?:cdninstagram|fbcdn|instagram\.f)/.test(c.u))
                         .filter(c => !/\/s150x150\//.test(c.u));
    if (!filtered.length) return img.currentSrc || img.src || '';
    const noStp = filtered.filter(c=>!c.stp).sort((a,b)=>(b.w||0)-(a.w||0));
    if (noStp.length) return noStp[0].u;
    const stp = filtered.filter(c=>c.stp).sort((a,b)=>(b.w||0)-(a.w||0));
    const ge  = stp.find(c => (c.w||0)>=TARGET_SIZE);
    return (ge && ge.u) || (stp[0] && stp[0].u) || (img.currentSrc || img.src || '');
  }

    // Helper: save a Blob without blocking the slideshow
    function saveBlob(blob, filename, revokeAfterMs = 60000){
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), revokeAfterMs);
    }

    // Fast, non-blocking downloader with smart fallback.
    // Always resolves immediately (true) after *starting* a download.
    function downloadImage(url, filename){
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

        // fbcdn/cdninstagram frequently trigger GM_download "not_whitelisted".
        // Go straight to GM_xhr for these to avoid errors and keep speed.
        const bypassGMDownload =
              /\.fbcdn\.net$/i.test(host) ||
              /\.fna\.fbcdn\.net$/i.test(host) ||
              /\.cdninstagram\.com$/i.test(host);

        const startXhr = () => {
            if (typeof GM_xmlhttpRequest !== 'function') return false;
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'blob',
                    timeout: 30000,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300 && res.response) {
                            saveBlob(res.response, filename);
                        } else {
                            console.warn('[InstaFast] XHR status', res.status, url);
                        }
                    },
                    onerror:   () => console.warn('[InstaFast] XHR error', url),
                    ontimeout: () => console.warn('[InstaFast] XHR timeout', url),
                });
                return true;
            } catch (e) {
                console.error('[InstaFast] GM_xhr threw', e);
                return false;
            }
        };

        if (!bypassGMDownload && typeof GM_download === 'function'){
            try{
                GM_download({
                    url,
                    name: filename,
                    saveAs: false,
                    onerror:   (e) => {
                        const err = String(e && (e.error || e.message) || '');
                        // If not whitelisted, immediately fallback to XHR
                        if (err === 'not_whitelisted') startXhr();
                        else console.warn('[InstaFast] GM_download error', err, url);
                    },
                    ontimeout: () => console.warn('[InstaFast] GM_download timeout', url),
                    // onload fires when the browser *starts* the download; nothing to do here
                });
                return Promise.resolve(true); // fire-and-forget
            } catch (e){
                console.warn('[InstaFast] GM_download threw', e, '→ falling back to XHR');
                return Promise.resolve(startXhr());
            }
        }

        // Directly use XHR for fbcdn/cdninstagram (or if GM_download unavailable)
        return Promise.resolve(startXhr());
    }



  function getFileName(url){
    try{ const u=new URL(url); return (u.pathname.split('/').pop()||'image').split('?')[0]; }
    catch{ const p=url.split('/'); return (p[p.length-1]||'image').split('?')[0]; }
  }

  function getVideoFileName(url){
    const name = getFileName(url);
    return /\.(?:mp4|webm|mov)$/i.test(name) ? name : `${name.replace(/\.[^/.]+$/, '') || 'video'}.mp4`;
  }

  function downloadVideo(url, filename){
    return new Promise(resolve => {
      if (typeof GM_xmlhttpRequest !== 'function') return resolve(false);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: 180000,
          onload: res => {
            if (res.status >= 200 && res.status < 300 && res.response && res.response.size > 0){
              try {
                saveBlob(res.response, filename, 300000);
                resolve(true);
              } catch (e) {
                console.warn('[InstaFast] Could not save video', e);
                resolve(false);
              }
            } else {
              console.warn('[InstaFast] Video XHR status', res.status, url);
              resolve(false);
            }
          },
          onerror: () => { console.warn('[InstaFast] Video XHR error', url); resolve(false); },
          ontimeout: () => { console.warn('[InstaFast] Video XHR timeout', url); resolve(false); }
        });
      } catch (e) {
        console.warn('[InstaFast] Video XHR threw', e);
        resolve(false);
      }
    });
  }

  // ====== core flow ======
    let isRunning = false;
    async function startAsyncSlideshow() {
        if (isRunning) return;
        isRunning = true;
        stopSlideshow = false;
        try {
            while (startSlideshow && !stopSlideshow) {
                await downloadCurrentImages();
                if (!startSlideshow || stopSlideshow) break;
                await goToNextImageOrPost();
            }
        } finally {
            isRunning = false;
            if (downloadStatus === 'running') updateDownloadStatus('stopped');
        }
    }

    function startDownloadMode(){
        if (isRunning) return;
        sessionDownloadCount = 0;
        limitNotificationShown = false;
        unsupportedVideoNoticeShown = false;
        startSlideshow = true;
        stopSlideshow = false;
        updateDownloadStatus('running');
        startAsyncSlideshow();
    }

  async function goToNextImageOrPost(){
    const container = getCurrentContainer();
    const nextBtn = getCarouselNextButton(container);

    if (nextBtn){
      const curKey = getActiveMediaKey(container);
      nextBtn.click();
      const deadline = Date.now() + 320;
      for(;;){
        const nowKey = getActiveMediaKey(container);
        if (nowKey && nowKey !== curKey) break;
        if (Date.now() >= deadline) break;
        await sleep(40);
      }
      await sleep(60);
      return;
    }

    // no carousel next → next post
    const oldY = scrollY;
    const nextSvg = document.querySelector('svg[aria-label="Next"]');
    if (nextSvg && nextSvg.parentNode) nextSvg.parentNode.click();
    else window.scrollBy({ top: innerHeight * 0.85, behavior: 'smooth' });

    const deadline = Date.now() + 260;
    while (Date.now() < deadline){
      if (scrollY !== oldY) break;
      await sleep(30);
    }
    await sleep(60);
  }

    async function downloadCurrentImages(){
        const container = getCurrentContainer();

        // Strict scan (fast path - current behavior)
        let imgs = [...container.querySelectorAll("picture img, img")].filter(isLikelyMedia);
        let videos = DOWNLOAD_VIDEOS
            ? [...container.querySelectorAll('video')].filter(isLikelyVideo)
            : [];

        // If strict scan found nothing, try a tiny rescue (lazyload race / small thumbs)
        if (imgs.length === 0 && videos.length === 0){
            for (let tries = 0; tries < 3 && imgs.length === 0 && videos.length === 0; tries++){
                await sleep(120);
                imgs = [...container.querySelectorAll("picture img, img")].filter(isMaybeMedia);
                if (DOWNLOAD_VIDEOS) videos = [...container.querySelectorAll('video')].filter(isLikelyVideo);
            }
        }

        if (imgs.length === 0 && videos.length === 0) return;

        // De-dupe within post by normalized key
        const seenLocal = new Set();

        // Capture caption once per post
        const caption = (() => {
            const el = container.querySelector('h1[dir="auto"]') || container.querySelector("h1");
            let cap = el ? (el.innerText || el.textContent || "").trim() : "";
            const tags = [...container.querySelectorAll('a[href^="/explore/tags/"]')]
            .map(a => (a.innerText || "").trim())
            .filter(Boolean);
            if (tags.length) cap = cap ? cap + "\n\n" + tags.join(" ") : tags.join(" ");
            return cap || "Caption not found";
        })();

        let captionSaved = false;

        for (const img of imgs){
            if (sessionDownloadCount >= MAXIMUM_DOWNLOADS){
                stopAtDownloadLimit();
                break;
            }

            const url = bestHiResFromImg(img);
            if (!url) continue;

            const key = keyFor(url);
            if (seenLocal.has(key)) continue;
            seenLocal.add(key);

            // Skip if we’ve already saved this image in a previous run
            if (downloadedImages[key] || downloadedImages[url]) continue;

            // Small settle helps with lazyload races
            if (!(img.complete && img.naturalWidth > 0)) await sleep(60);

            const imageName = getFileName(url);
            const ok = await downloadImage(url, imageName);

            if (ok){
                if (SAVE_CAPTIONS && !captionSaved && caption && caption !== "Caption not found"){
                    captionSaved = true;
                    downloadTextFile(imageName.replace(/\.[^/.]+$/, ".txt"), caption);
                }
                // Mark as downloaded only after a successful save
                downloadedImages[key] = true;
                downloadedImages[url] = true;
                GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
                sessionDownloadCount++;
                updateDownloadStatus('running');
                if (sessionDownloadCount >= MAXIMUM_DOWNLOADS){
                    stopAtDownloadLimit();
                    break;
                }
            } else {
                console.warn('[InstaFast] Download failed, will retry if seen again:', url);
            }
        }

        for (const video of videos){
            if (!DOWNLOAD_VIDEOS || stopSlideshow) break;
            if (sessionDownloadCount >= MAXIMUM_DOWNLOADS){
                stopAtDownloadLimit();
                break;
            }
            let url = await resolveVideoUrl(video, container);
            for (let tries = 0; !url && tries < 3; tries++){
                await sleep(150);
                url = await resolveVideoUrl(video, container);
            }
            if (!url){
                if (!unsupportedVideoNoticeShown){
                    unsupportedVideoNoticeShown = true;
                    GM_notification({
                        text: 'Could not find a downloadable URL for this video in the post data.',
                        title: 'InstaFast — video skipped',
                        timeout: 4000
                    });
                }
                continue;
            }
            const parsedUrl = new URL(url);
            const key = 'video:' + parsedUrl.origin + parsedUrl.pathname;
            if (seenLocal.has(key) || downloadedVideos[key] || downloadedVideos[url]) continue;
            seenLocal.add(key);

            const videoName = getVideoFileName(url);
            const ok = await downloadVideo(url, videoName);
            if (!ok) continue;
            if (SAVE_CAPTIONS && !captionSaved && caption && caption !== "Caption not found"){
                captionSaved = true;
                downloadTextFile(videoName.replace(/\.[^/.]+$/, ".txt"), caption);
            }
            downloadedVideos[key] = true;
            downloadedVideos[url] = true;
            GM_setValue('downloadedVideos', JSON.stringify(downloadedVideos));
            sessionDownloadCount++;
            updateDownloadStatus(downloadStatus);
            if (sessionDownloadCount >= MAXIMUM_DOWNLOADS){
                stopAtDownloadLimit();
                break;
            }
        }
    }


    function downloadTextFile(fileName, content) {
        const blob = new Blob([content], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>URL.revokeObjectURL(url), 60000);
    }


  function clearList() {
    downloadedImages = {};
    GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
  }

  function clearVideoList() {
    downloadedVideos = {};
    GM_setValue('downloadedVideos', JSON.stringify(downloadedVideos));
  }

  // hotkeys
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey) return;
    if (event.code === 'KeyS') {
      startDownloadMode();
    } else if (event.code === 'KeyZ') {
      stopDownloadMode();
    }
  });

  // menu
  GM_registerMenuCommand('Start Downloading [CTRL+SHIFT+S]', () => {
    startDownloadMode();
  });
  GM_registerMenuCommand('Stop Downloading [CTRL+SHIFT+Z]', () => {
    stopDownloadMode();
  });
  GM_registerMenuCommand(`Set maximum downloads (currently ${MAXIMUM_DOWNLOADS})`, () => {
    const answer = window.prompt('Maximum media files to download per run:', String(MAXIMUM_DOWNLOADS));
    if (answer === null) return;
    const parsed = Number(answer.trim());
    if (!Number.isInteger(parsed) || parsed < 1){
      GM_notification({
        text: 'Enter a whole number greater than zero.',
        title: 'InstaFast — invalid maximum',
        timeout: 3000
      });
      return;
    }
    MAXIMUM_DOWNLOADS = parsed;
    GM_setValue('maximum_downloads', MAXIMUM_DOWNLOADS);
    if (downloadStatus !== 'idle') updateDownloadStatus(downloadStatus);
    if (isRunning && sessionDownloadCount >= MAXIMUM_DOWNLOADS) stopAtDownloadLimit();
    GM_notification({
      text: `Maximum downloads per run set to ${MAXIMUM_DOWNLOADS.toLocaleString()}.`,
      title: 'InstaFast',
      timeout: 2500
    });
  });
  GM_registerMenuCommand(
    `Toggle caption .txt downloads (currently ${SAVE_CAPTIONS ? 'ON' : 'OFF'})`,
    () => {
      SAVE_CAPTIONS = !SAVE_CAPTIONS;
      GM_setValue('save_captions', SAVE_CAPTIONS);
      GM_notification({
        text: `Caption .txt downloads ${SAVE_CAPTIONS ? 'ENABLED' : 'DISABLED'} at start (refresh to update menu text)`,
        title: 'InstaFast',
        timeout: 2500
      });
    }
  );
  GM_registerMenuCommand(
    `Video downloads: ${DOWNLOAD_VIDEOS ? 'ON' : 'OFF'} (click to toggle)`,
    () => {
      DOWNLOAD_VIDEOS = !DOWNLOAD_VIDEOS;
      GM_setValue('download_videos', DOWNLOAD_VIDEOS);
      updateDownloadStatus(downloadStatus);
      GM_notification({
        text: `Video downloads ${DOWNLOAD_VIDEOS ? 'ENABLED' : 'DISABLED'} (refresh to update menu text)`,
        title: 'InstaFast',
        timeout: 2500
      });
    }
  );
  GM_registerMenuCommand('Clear Image List', clearList);
  GM_registerMenuCommand('Clear Video List', clearVideoList);
})();
