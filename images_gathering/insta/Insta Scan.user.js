// ==UserScript==
// @name         Insta Scan with Full Caption — FAST (hires DOM, minimal changes)
// @namespace    http://tampermonkey.net/
// @version      0.41
// @description  Old fast loop + reliable hi-res picking + robust dedupe + caption
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @run-at       document-end
// @grant        GM_download
// ==/UserScript==

(function() {
  'use strict';

  // ---- minimal config (keep it fast) ----
  const DEBUG = false;
  const TARGET_SIZE = 1080;           // prefer >=1080 candidates
  const MIN_MEDIA_W = 140, MIN_MEDIA_H = 140;

  // ---- persistent state (same key name you used before) ----
  let downloadedImages = JSON.parse(GM_getValue('downloadedImages', '{}'));
  let startSlideshow = false;
  let stopSlideshow  = false;

    // NEW: persist caption .txt toggle (default ON)
    let SAVE_CAPTIONS = GM_getValue('save_captions', true);

  // ====== FAST HELPERS (tiny + reliable) ======
  const log = (...a)=> DEBUG && console.log('[InstaFast]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

    // --- fast helpers (robust but lightweight) ---
    function isVisible(el){
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.opacity !== "0";
    }

    // choose the current post container (modal first; else the centered article)
    function getCurrentContainer(){
        const modal = document.querySelector('div[role="dialog"]');
        if (modal) return modal;
        const arts = [...document.querySelectorAll("article")].filter(isVisible);
        if (!arts.length) return document.body;
        const cx = innerWidth/2, cy = innerHeight/2;
        let best = null;
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
        if (r.width < 120 || r.height < 120) return false;
        const u = (img.currentSrc || img.src || "").toLowerCase();
        if (!/cdninstagram|fbcdn|instagram\.f/.test(u)) return false;
        const alt = (img.alt || "").toLowerCase();
        if (alt.includes("profile picture")) return false;
        return true;
    }

    // srcset parsing (tiny + fast)
    function parseSrcset(ss){
        if (!ss) return [];
        return ss.split(",").map(s => s.trim()).filter(Boolean).map(p=>{
            const sp = p.lastIndexOf(" ");
            const u  = sp > 0 ? p.slice(0, sp) : p;
            const d  = sp > 0 ? p.slice(sp+1) : "";
            let w = 0;
            if (/^\d+w$/.test(d)) w = parseInt(d,10);
            else if (/^\d+(\.\d+)?x$/.test(d)) w = Math.round(parseFloat(d)*1000);
            // quick width hint from path if missing
            if (!w){
                const m = u.match(/[_\/](?:[ps])(\d{3,4})x\1([_\/\?]|$)/);
                if (m) w = parseInt(m[1],10);
            }
            return {u, w};
        });
    }

    function bestHiResFromImg(img){
        const cands = [];
        const pic = img.closest("picture");
        if (pic){
            for (const s of pic.querySelectorAll("source[srcset]")){
                cands.push(...parseSrcset(s.getAttribute("srcset")));
            }
        }
        cands.push(...parseSrcset(img.getAttribute("srcset") || ""));
        for (const raw of [img.currentSrc, img.src]) if (raw) cands.push({u:String(raw), w:0});
        const cleaned = cands
        .filter(c => /cdninstagram|fbcdn|instagram\.f/.test(c.u))
        .filter(c => !/\/s150x150\//.test(c.u));
        if (!cleaned.length) return img.currentSrc || img.src || "";
        cleaned.sort((a,b)=>(b.w||0)-(a.w||0));
        return cleaned[0].u;
    }

    function keyFor(url){
        try{
            const u = new URL(url);
            const igk = u.searchParams.get("ig_cache_key");
            if (igk) return "igk:"+igk;
            const base = (u.pathname.split("/").pop()||"image").replace(/\.[a-z0-9]+$/i,"");
            return "base:"+base;
        }catch{
            const base = (url.split("?")[0].split("/").pop()||"image").replace(/\.[a-z0-9]+$/i,"");
            return "base:"+base;
        }
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
        const imgs = [...container.querySelectorAll("picture img, img")].filter(isLikelyMedia);
        if (!imgs.length) return null;
        // take the one most centered in container (cheap scoring)
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


  function keyFromUrl(url){
    try{
      const u = new URL(url);
      // Prefer ig_cache_key when present; it’s stable across size variants
      const igk = u.searchParams.get('ig_cache_key');
      if (igk) return 'igk:'+igk;
      // fallback to filename base
      const base = (u.pathname.split('/').pop()||'image').replace(/\.[a-z0-9]+$/i,'');
      return 'base:'+base;
    }catch{
      const base = (url.split('?')[0].split('/').pop()||'image').replace(/\.[a-z0-9]+$/i,'');
      return 'base:'+base;
    }
  }

  function visibleRect(el){
    try { return el.getBoundingClientRect(); } catch { return null; }
  }
  function isVisible(el){
    const r = visibleRect(el);
    if (!r || r.width<=0 || r.height<=0) return false;
    if (r.bottom<=0 || r.right<=0 || r.top>=innerHeight || r.left>=innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility!=='hidden' && cs.opacity!=='0';
  }

  function getCurrentContainer(){
    // Prefer modal (post view) if present; else closest article to center
    const modal = document.querySelector('div[role="dialog"]');
    if (modal) return modal;
    const arts = [...document.querySelectorAll('article')].filter(isVisible);
    if (!arts.length) return document.body;
    const cx = innerWidth/2, cy = innerHeight/2;
    let best = null;
    for (const a of arts){
      const r=a.getBoundingClientRect();
      const dx=Math.max(r.left-cx,cx-r.right,0), dy=Math.max(r.top-cy,cy-r.bottom,0);
      const d=dx*dx+dy*dy;
      if (!best || d<best.d) best={el:a,d};
    }
    return (best && best.el) || document.body;
  }

  // ---- pick hi-res from <img>/<picture> ----
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
      // try to infer
      const wStp = stpWidth(u);
      const wHint= hintedWidthFromPath(u);
      if (!w) w = wStp || wHint;
      const stp = hasStp(u);
      if (!w && !stp) w = 999999; // big bonus for no-stp (often original)
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
    if (!filtered.length){
      return img.currentSrc || img.src || '';
    }
    // Prefer no-stp > big stp >= TARGET
    const noStp = filtered.filter(c=>!c.stp).sort((a,b)=>(b.w||0)-(a.w||0));
    if (noStp.length) return noStp[0].u;
    const stp = filtered.filter(c=>c.stp).sort((a,b)=>(b.w||0)-(a.w||0));
    const ge  = stp.find(c => (c.w||0)>=TARGET_SIZE);
    return (ge && ge.u) || (stp[0] && stp[0].u) || (img.currentSrc || img.src || '');
  }

  function isLikelyMedia(img){
    if (!isVisible(img)) return false;
    const r = img.getBoundingClientRect();
    if (r.width<MIN_MEDIA_W || r.height<MIN_MEDIA_H) return false;
    const url = (img.currentSrc || img.src || '').toLowerCase();
    if (!/cdninstagram|fbcdn|instagram\.f/.test(url)) return false;
    const alt = (img.alt||'').toLowerCase();
    if (alt.includes('profile picture')) return false;
    return true;
  }
  function activeImage(container){
    const imgs = [...container.querySelectorAll('picture img, img')].filter(isLikelyMedia);
    if (!imgs.length) return null;
    // pick the most centered / most visible
    const scope = container.getBoundingClientRect();
    const cx = scope.left + scope.width/2, cy = scope.top + scope.height/2;
    let best = null;
    for (const img of imgs){
      const r = img.getBoundingClientRect();
      const dx = Math.abs((r.left+r.width/2) - cx) / Math.max(1, scope.width);
      const dy = Math.abs((r.top +r.height/2) - cy) / Math.max(1, scope.height);
      const centerScore = 1 - Math.min(1, dx+dy);
      const visArea = Math.max(0, Math.min(r.right,scope.right)-Math.max(r.left,scope.left))
                    * Math.max(0, Math.min(r.bottom,scope.bottom)-Math.max(r.top,scope.top));
      const score = centerScore*3 + visArea/(Math.max(1,r.width*r.height))*2;
      if (!best || score>best.score) best = {img, score};
    }
    return best ? best.img : imgs[0];
  }

  // Fast direct save (no extra fetch)
  // Safe, no-navigation downloader: prefer GM_download; fallback to blob
    async function downloadImage(url, filename){
        // Fast path: Tampermonkey background download (no page navigation)
        if (typeof GM_download === "function"){
            try{
                GM_download({
                    url,
                    name: filename,
                    saveAs: false,
                    // We resolve immediately to keep things snappy
                    onload:  () => {},
                    onerror: (e) => console.warn("[InstaFast] GM_download error", e && (e.error || e.message) || e),
                    ontimeout: () => console.warn("[InstaFast] GM_download timeout", url)
                });
                return true; // don't block slideshow
            }catch(e){
                console.warn("[InstaFast] GM_download threw", e);
                // fall through to blob
            }
        }

        // Fallback: fetch→blob→objectURL (download attribute works on blob:)
        try{
            const res  = await fetch(url);
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(()=>URL.revokeObjectURL(blobUrl), 60_000); // tidy up
            return true;
        }catch(e){
            console.error("[InstaFast] blob download failed", e);
            return false;
        }
    }


    function fileNameFromUrl(url){
        try{ const u=new URL(url); return (u.pathname.split('/').pop()||'image').split('?')[0]; }
        catch{ const p=url.split('/'); return (p[p.length-1]||'image').split('?')[0]; }
    }

    const getFileName = fileNameFromUrl;

    // ====== YOUR ORIGINAL FLOW, MINIMALLY CHANGED ======
    async function startAsyncSlideshow() {
        stopSlideshow = false;
        while (startSlideshow && !stopSlideshow) {
            await downloadCurrentImages();     // do the current slide/post
            await goToNextImageOrPost();       // advance quickly (like before)
        }
    }

    async function goToNextImageOrPost(){
        const container = getCurrentContainer();
        const nextBtn = getCarouselNextButton(container);

        if (nextBtn){
            // get a key for the active slide to confirm change
            const curImg = getActiveMediaImage(container);
            const curKey = curImg ? keyFor(bestHiResFromImg(curImg)) : "";

            nextBtn.click();

            // tiny poll (≤ ~300ms) for a different slide; keeps things fast
            const deadline = Date.now() + 320;
            for (;;){
                const nowImg = getActiveMediaImage(container);
                const nowKey = nowImg ? keyFor(bestHiResFromImg(nowImg)) : "";
                if (nowKey && nowKey !== curKey) break;
                if (Date.now() >= deadline) break;
                await sleep(40);
            }
            // small settle time
            await sleep(60);
            return;
        }

        // No carousel next → move to next post quickly
        const oldY = scrollY;
        const nextSvg = document.querySelector('svg[aria-label="Next"]');
        if (nextSvg && nextSvg.parentNode) nextSvg.parentNode.click();
        else window.scrollBy({ top: innerHeight * 0.85, behavior: "smooth" });

        // brief wait so new post centers & images lazy-load
        const deadline = Date.now() + 260;
        while (Date.now() < deadline){
            if (scrollY !== oldY) break;
            await sleep(30);
        }
        await sleep(60);
    }


    async function downloadCurrentImages(){
        const container = getCurrentContainer();

        // collect hi-res candidates visible in this post
        const imgs = [...container.querySelectorAll("picture img, img")].filter(isLikelyMedia);

        // de-dupe within post and across runs by a normalized key, not raw URL
        const seenLocal = new Set();

        // capture caption once per post (same logic you already had)
        const caption = (()=>{
            const el = container.querySelector('h1[dir="auto"]') || container.querySelector("h1");
            let cap = el ? (el.innerText || el.textContent || "").trim() : "";
            const tags = [...container.querySelectorAll('a[href^="/explore/tags/"]')]
            .map(a=>(a.innerText||"").trim()).filter(Boolean);
            if (tags.length) cap = cap ? cap+"\n\n"+tags.join(" ") : tags.join(" ");
            return cap || "Caption not found";
        })();

        let captionSaved = false;

        for (const img of imgs){
            const url = bestHiResFromImg(img);
            if (!url) continue;
            const key = keyFor(url);
            if (seenLocal.has(key)) continue;
            seenLocal.add(key);

            // Backward-compat: if you previously stored by raw src, consider both keys
            if (downloadedImages[key] || downloadedImages[url]) continue;

            // (very short wait helps when lazyload is racing)
            if (!(img.complete && img.naturalWidth>0)) await sleep(60);

            const imageName = getFileName(url);
            await downloadImage(url, imageName);

            if (SAVE_CAPTIONS && !captionSaved && caption && caption !== "Caption not found"){
                captionSaved = true;
                downloadTextFile(imageName.replace(/\.[^/.]+$/, ".txt"), caption);
            }

            // store both normalized and raw to avoid re-grabbing later
            downloadedImages[key] = true;
            downloadedImages[url] = true;
            GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
        }
    }


  // same keys / menu / hotkeys as your original
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

  function extractPostCaption(scope){
    // match your original selector but scoped to current container first
    const capEl =
      (scope && scope.querySelector('h1[dir="auto"]')) ||
      document.querySelector('h1[dir="auto"]');
    if (!capEl) return 'Caption not found';

    let caption = (capEl.innerText||capEl.textContent||'').trim();
    const tags = [...capEl.querySelectorAll('a[href^="/explore/tags/"]')]
      .map(a => (a.innerText||'').trim())
      .filter(Boolean);
    if (tags.length) caption = caption ? caption + '\n\n' + tags.join(' ') : tags.join(' ');
    return caption || 'Caption not found';
  }

  function downloadTextFile(fileName, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

    function clearList() {
        downloadedImages = {};
        GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
    }


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
              text: `Caption .txt downloads ${SAVE_CAPTIONS ? 'ENABLED' : 'DISABLED'} at start(refresh to update)`,
              title: 'InstaFast',
              timeout: 2500
          });
      }
  );

    GM_registerMenuCommand('Clear Image List', clearList);

})();
