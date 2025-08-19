// ==UserScript==
// @name         Insta Scan with Full Caption — FAST (hires DOM, minimal changes)
// @namespace    http://tampermonkey.net/
// @version      0.42
// @description  Old fast loop + reliable hi-res picking + robust dedupe + caption
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
  let startSlideshow = false;
  let stopSlideshow  = false;

  // caption .txt toggle (persistent; default ON)
  let SAVE_CAPTIONS = GM_getValue('save_captions', true);

  // ====== helpers ======
  const log = (...a)=> DEBUG && console.log('[InstaFast]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  function getCarouselNextButton(container){
    return (
      container.querySelector('button[aria-label="Next"]:not([disabled])') ||
      container.querySelector('button[aria-label="Next"][aria-disabled="false"]') ||
      container.querySelector('[role="button"][aria-label="Next"]') ||
      (()=>{ const svg=container.querySelector('svg[aria-label="Next"]'); return svg? svg.closest("button,[role='button'],a") : null; })()
    );
  }

  function getActiveMediaImage(container){
    const imgs = [...container.querySelectorAll('picture img, img')].filter(isLikelyMedia);
    if (!imgs.length) return null;
    // pick the most centered
    const scope = container.getBoundingClientRect();
    const cx = scope.left + scope.width/2;
    const cy = scope.top  + scope.height/2;
    let best=null;
    for (const img of imgs){
      const r = img.getBoundingClientRect();
      const dx = Math.abs((r.left+r.width/2)-cx)/(scope.width||1);
      const dy = Math.abs((r.top +r.height/2)-cy)/(scope.height||1);
      const score = 1 - Math.min(1, dx+dy);
      if (!best || score>best.s) best={img, s:score};
    }
    return best?best.img:null;
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
    function saveBlob(blob, filename){
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
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
            if (typeof GM_xmlhttpRequest !== 'function') return;
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
            } catch (e) {
                console.error('[InstaFast] GM_xhr threw', e);
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
                startXhr();
                return Promise.resolve(true);
            }
        }

        // Directly use XHR for fbcdn/cdninstagram (or if GM_download unavailable)
        startXhr();
        return Promise.resolve(true);
    }



  function getFileName(url){
    try{ const u=new URL(url); return (u.pathname.split('/').pop()||'image').split('?')[0]; }
    catch{ const p=url.split('/'); return (p[p.length-1]||'image').split('?')[0]; }
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
                await goToNextImageOrPost();
            }
        } finally {
            isRunning = false;
        }
    }

  async function goToNextImageOrPost(){
    const container = getCurrentContainer();
    const nextBtn = getCarouselNextButton(container);

    if (nextBtn){
      const curImg = getActiveMediaImage(container);
      const curKey = curImg ? keyFor(bestHiResFromImg(curImg)) : '';
      nextBtn.click();
      const deadline = Date.now() + 320;
      for(;;){
        const nowImg = getActiveMediaImage(container);
        const nowKey = nowImg ? keyFor(bestHiResFromImg(nowImg)) : '';
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

        // If strict scan found nothing, try a tiny rescue (lazyload race / small thumbs)
        if (imgs.length === 0){
            for (let tries = 0; tries < 3 && imgs.length === 0; tries++){
                await sleep(120);
                imgs = [...container.querySelectorAll("picture img, img")].filter(isMaybeMedia);
            }
        }

        // Nothing to do (likely video-only slide/post)
        if (imgs.length === 0) return;

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
            const ok = downloadImage(url, imageName);

            if (ok){
                if (SAVE_CAPTIONS && !captionSaved && caption && caption !== "Caption not found"){
                    captionSaved = true;
                    downloadTextFile(imageName.replace(/\.[^/.]+$/, ".txt"), caption);
                }
                // Mark as downloaded only after a successful save
                downloadedImages[key] = true;
                downloadedImages[url] = true;
                GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
            } else {
                console.warn('[InstaFast] Download failed, will retry if seen again:', url);
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

  // hotkeys
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey) return;
    if (event.code === 'KeyS') {
      startSlideshow = true;
      startAsyncSlideshow();
    } else if (event.code === 'KeyZ') {
      startSlideshow = false;
      stopSlideshow = true;
    }
  });

  // menu
  GM_registerMenuCommand('Start Downloading [CTRL+SHIFT+S]', () => {
    startSlideshow = true;
    startAsyncSlideshow();
  });
  GM_registerMenuCommand('Stop Downloading [CTRL+SHIFT+Z]', () => {
    startSlideshow = false;
    stopSlideshow = true;
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
  GM_registerMenuCommand('Clear Image List', clearList);
})();
