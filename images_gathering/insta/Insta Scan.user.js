// ==UserScript==
// @name         Insta Scan with Full Caption - hires + lazyload-safe (GraphQL+DOM fixed)
// @namespace    http://tampermonkey.net/
// @version      1.6.1
// @description  Grok+GPT 2025.08.18 18:14 Downloads Instagram images with full caption; prefers true hi-res via GraphQL; safe fallback to DOM; robust carousel handling & instant stop
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// @connect      fbcdn.net
// @connect      *.fbcdn.net
// @connect      *.fna.fbcdn.net
// @connect      *.cdninstagram.com
// @connect      cdninstagram.com
// @connect      instagram.com
// ==/UserScript==

(function () {
  "use strict";

  // -------- Config --------
  const DEBUG = true;                 // set false when you're satisfied
  const POLL_STEP_MS = 120;           // polling granularity
  const POLL_WINDOW_MS = 1200;        // per attempt wait for slide to change
  const RETRIES_PER_SLIDE = 3;        // button+ArrowRight attempts per slide
  const BETWEEN_ACTION_MS = 160;
  const MIN_MEDIA_W = 140, MIN_MEDIA_H = 140;
  const MAX_SLIDES_SAFE = 20;         // cap per post to avoid loops
  const WAIT_IMAGE_MS = 2500;         // wait for lazy-loaded image to appear
  const TARGET_SIZE = 1080;           // target hires dimension (square)
  const MAX_DL_CONCURRENCY = 4;       // parallel downloads for GraphQL path (drop to 3 if your browser prompts)


  // learned at runtime (sniffer), persisted between runs
  let IG_APP_ID    = GM_getValue("ig_app_id", null);
  let DOC_ID_CACHE = GM_getValue("docid_shortcode_media", null);

  // -------- Learn doc_id and X-IG-App-ID by sniffing IG's own fetches --------
  (function installDocIdSniffer(){
    const origFetch = window.fetch;

    function readHeader(hdrs, name){
      if (!hdrs) return null;
      const want = name.toLowerCase();
      if (hdrs instanceof Headers) return hdrs.get(name);
      if (Array.isArray(hdrs)) {
        for (const [k,v] of hdrs) if (String(k).toLowerCase() === want) return v;
        return null;
      }
      if (typeof hdrs === "object") {
        for (const k of Object.keys(hdrs)) {
          if (k.toLowerCase() === want) return hdrs[k];
        }
      }
      return null;
    }

    window.fetch = async function(input, init){
      try {
        const url  = typeof input === "string" ? input : (input && (input.url || input.href)) || "";
        const meth = (init && init.method) || (input && input.method) || "GET";

        if (url.includes("/api/graphql") && String(meth).toUpperCase() === "POST") {
          // ---- learn X-IG-App-ID from headers ----
          const appId = readHeader(init && init.headers, "X-IG-App-ID")
                     || readHeader(input && input.headers, "X-IG-App-ID");
          if (appId && appId !== IG_APP_ID) {
            IG_APP_ID = appId;
            GM_setValue("ig_app_id", IG_APP_ID);
            if (DEBUG) console.debug("[InstaScan] learned X-IG-App-ID:", IG_APP_ID);
          }

          // ---- learn doc_id for shortcode queries ----
          let body = (init && init.body) || (input && input.body) || "";
          if (body instanceof URLSearchParams) body = body.toString();
          else if (body instanceof FormData) {
            const usp = new URLSearchParams();
            for (const [k,v] of body.entries()) usp.append(k, String(v));
            body = usp.toString();
          } else if (typeof body !== "string") {
            body = String(body || "");
          }

          if (body) {
            const params = new URLSearchParams(body);
            const maybeDoc = params.get("doc_id");
            const vars = params.get("variables") || "";
            if (maybeDoc && /"shortcode"\s*:/.test(vars)) {
              DOC_ID_CACHE = maybeDoc;
              GM_setValue("docid_shortcode_media", DOC_ID_CACHE);
              if (DEBUG) console.debug("[InstaScan] learned doc_id:", DOC_ID_CACHE);
            }
          }
        }
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  })();

  // -------- State --------
  let store = JSON.parse(GM_getValue("downloadedImages_v12", "{}"));
  let stopSlideshow = false;
  let activeRunId = 0;
  const currentRun = () => activeRunId;

  // -------- Utils --------
  const log = (...a) => DEBUG && console.log("[InstaScan]", ...a);
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

  function keyFor(url){
    try {
      const u = new URL(url);
      const igk = u.searchParams.get("ig_cache_key");
      if (igk) return "igk:"+igk;
      const base = (u.pathname.split("/").pop()||"image").replace(/\.[a-z0-9]+$/i,"");
      return "base:"+base;
    } catch {
      const base = (url.split("?")[0].split("/").pop()||"image").replace(/\.[a-z0-9]+$/i,"");
      return "base:"+base;
    }
  }
  const gkey = (postId,url)=> `v12:${postId}|${keyFor(url)}`;

  function markDownloaded(postId, url){
    store[gkey(postId,url)] = true;
    GM_setValue("downloadedImages_v12", JSON.stringify(store));
  }

  function isVisible(el){
    const r = el.getBoundingClientRect();
    if (!r || r.width<=0 || r.height<=0) return false;
    if (r.bottom<=0 || r.right<=0 || r.top>=innerHeight || r.left>=innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility!=="hidden" && cs.opacity!=="0";
  }

  function getPostId(){
    const m = location.pathname.match(/^\/(p|reel)\/([^\/\?]+)/);
    if (m) return m[2]; // shortcode
    const c = getCurrentContainer();
    const a = c.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    if (a){
      const m2 = a.getAttribute("href").match(/\/(p|reel)\/([^\/\?]+)/);
      if (m2) return m2[2];
    }
    return "feed";
  }

  function getCurrentContainer(){
    const modal = document.querySelector('div[role="dialog"]');
    if (modal) return modal;
    const arts = [...document.querySelectorAll("article")].filter(isVisible);
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

  // ------ DOM hi-res selection helpers ------
  function hasStp(u){
    try { return new URL(u).searchParams.has("stp"); }
    catch { return /[?&]stp=/.test(u); }
  }
  function igKeyFromUrl(u){
    try { return new URL(u).searchParams.get("ig_cache_key") || ""; }
    catch { return ""; }
  }
  function stpWidth(u){
    try {
      const s = new URL(u).searchParams.get("stp") || "";
      const m = s.match(/(?:^|_)p(\d{3,4})x\1(?:_|$)/);
      if (m) return parseInt(m[1], 10);
    } catch {}
    const m2 = u.match(/[?&]stp=[^&]*?(?:^|_)p(\d{3,4})x\1(?:_|$)/);
    return m2 ? parseInt(m2[1], 10) : 0;
  }
  function hintedWidthFromPath(u){
    const m = u.match(/[_\/](?:[ps])(\d{3,4})x\1([_\/\?]|$)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function parseSrcset(ss){
    const out = [];
    if (!ss) return out;
    for (const part of ss.split(",").map(s => s.trim()).filter(Boolean)) {
      const sp = part.lastIndexOf(" ");
      let u = part, desc = "";
      if (sp > 0){ u = part.slice(0, sp); desc = part.slice(sp + 1); }
      let w = 0;
      if (/^\d+w$/.test(desc)) w = parseInt(desc, 10);
      else if (/^\d+(\.\d+)?x$/.test(desc)) w = Math.round(parseFloat(desc) * 1000);
      const wStp = stpWidth(u);
      const wHint = hintedWidthFromPath(u);
      if (!w) w = wStp || wHint;
      const stp = hasStp(u);
      const igk = igKeyFromUrl(u);
      if (!w && !stp) w = 999999; // no-stp likely original
      out.push({ u, w, stp, igk });
    }
    return out;
  }

  function bestHiResFromImg(img){
    const candidates = [];
    const pic = img.closest("picture");
    if (pic){
      for (const s of pic.querySelectorAll("source[srcset]")){
        candidates.push(...parseSrcset(s.getAttribute("srcset")));
      }
    }
    // include img srcset
    candidates.push(...parseSrcset(img.getAttribute("srcset") || ""));
    // ALSO include src/currentSrc (often holds hi-res)
    for (const raw of [img.currentSrc, img.src]) {
      if (!raw) continue;
      const u = String(raw);
      const c = {
        u,
        w: stpWidth(u) || hintedWidthFromPath(u) || 0,
        stp: hasStp(u),
        igk: igKeyFromUrl(u)
      };
      if (!c.w && !c.stp) c.w = 999999;
      candidates.push(c);
    }

    const fallback = img.currentSrc || img.src || "";
    if (!candidates.length) return fallback || "";

    const cleaned = candidates
      .filter(c => /(?:cdninstagram|fbcdn|instagram\.f)/.test(c.u))
      .filter(c => !/\/s150x150\//.test(c.u));

    // 1) Prefer native no-stp variants
    const noStp = cleaned.filter(c => !c.stp);
    if (noStp.length){
      noStp.sort((a,b) => (b.w||0) - (a.w||0));
      DEBUG && console.debug("[InstaScan] choose no-stp", noStp[0].w, noStp[0].u);
      return noStp[0].u;
    }

    // 2) Else pick largest stp; prefer >= TARGET_SIZE
    const hiStp = cleaned.filter(c => c.stp).sort((a,b) => (b.w||0) - (a.w||0));
    if (hiStp.length){
      const geTarget = hiStp.find(c => (c.w||0) >= TARGET_SIZE);
      if (geTarget){
        DEBUG && console.debug("[InstaScan] choose stp>=TARGET", geTarget.w, geTarget.u);
        return geTarget.u;
      }
      DEBUG && console.debug("[InstaScan] choose largest stp available", hiStp[0].w || 0, hiStp[0].u);
      return hiStp[0].u;
    }

    return fallback || cleaned[0].u;
  }

  function isLikelyMedia(img){
    if (!isVisible(img)) return false;
    const r = img.getBoundingClientRect();
    if (r.width<MIN_MEDIA_W || r.height<MIN_MEDIA_H) return false;
    const url = (img.currentSrc || img.src || "").toLowerCase();
    if (!/cdninstagram|fbcdn|instagram\.f/.test(url)) return false;
    const alt = (img.alt||"").toLowerCase();
    if (alt.includes("profile picture")) return false;
    return true;
  }

  function getActiveMediaImage(container){
    const imgs = [...container.querySelectorAll("picture img, img")].filter(isLikelyMedia);
    if (!imgs.length) return null;

    const scope = container.getBoundingClientRect();
    const cx = scope.left + scope.width / 2;
    const cy = scope.top  + scope.height / 2;

    function overlapArea(a, b){
      const x1 = Math.max(a.left, b.left),  y1 = Math.max(a.top, b.top);
      const x2 = Math.min(a.right, b.right),y2 = Math.min(a.bottom, b.bottom);
      const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
      return w * h;
    }
    function translateXAbs(el){
      let cur = el, tries = 0;
      while (cur && tries++ < 5){
        const s = getComputedStyle(cur);
        if (s.transform && s.transform !== "none"){
          const m = s.transform.match(/matrix\(([^)]+)\)/);
          if (m){
            const parts = m[1].split(",").map(x=>parseFloat(x.trim()));
            const tx = parts[4] || 0;
            return Math.abs(tx);
          }
        }
        cur = cur.parentElement;
      }
      return 99999;
    }

    let best = null;
    for (const img of imgs){
      const r = img.getBoundingClientRect();
      const centerDx = Math.abs((r.left + r.width/2) - cx) / (scope.width || 1);
      const centerDy = Math.abs((r.top  + r.height/2) - cy) / (scope.height|| 1);
      const centerScore = 1 - Math.min(1, (centerDx + centerDy));
      const vis = overlapArea(r, scope) / Math.max(1, r.width * r.height);
      const shiftPenalty = translateXAbs(img);
      const score = centerScore * 3 + vis * 2 - (shiftPenalty > 1 ? 1 : 0);
      if (!best || score > best.score) best = { img, score };
    }
    return best ? best.img : null;
  }

  async function waitForActiveImage(container, ms=WAIT_IMAGE_MS){
    const deadline = performance.now() + ms;
    const myRun = currentRun();
    try { container.scrollIntoView({behavior:"auto", block:"center"}); } catch {}
    while (performance.now() < deadline && activeRunId === myRun && !stopSlideshow){
      const img = getActiveMediaImage(container);
      if (img) return img;
      await sleep(POLL_STEP_MS);
    }
    return null;
  }

  function getActiveVideo(container){
    const vids=[...container.querySelectorAll('[aria-hidden="false"] video, video')].filter(isVisible);
    return vids.length?vids[0]:null;
  }

  function getCarouselNextButton(container){
    return (
      container.querySelector('button[aria-label="Next"]:not([disabled])') ||
      container.querySelector('button[aria-label="Next"][aria-disabled="false"]') ||
      container.querySelector('[role="button"][aria-label="Next"]') ||
      (()=>{
        const svg=container.querySelector('svg[aria-label="Next"]');
        return svg ? svg.closest("button,[role='button'],a") : null;
      })()
    );
  }

  function sendArrowRight(){
    document.dispatchEvent(new KeyboardEvent("keydown",{ key:"ArrowRight", code:"ArrowRight", bubbles:true }));
  }

  function allCandidateKeys(container){
    const imgs = [...container.querySelectorAll("picture img, img")].filter(isLikelyMedia);
    const keys = [];
    for (const img of imgs){
      const u = bestHiResFromImg(img);
      if (u) keys.push(keyFor(u));
    }
    return Array.from(new Set(keys));
  }

  async function pollForNewKey(prevKey, container, windowMs=POLL_WINDOW_MS){
    const deadline = performance.now() + windowMs;
    const myRun = currentRun();
    while (performance.now() < deadline && activeRunId === myRun && !stopSlideshow){
      const img = getActiveMediaImage(container);
      const url = img ? bestHiResFromImg(img) : "";
      const k = url ? keyFor(url) : "";
      if (k && (!prevKey || k !== prevKey)) {
        log("new key observed", { prevKey, newKey: k, dt: `${Math.round(POLL_WINDOW_MS-(deadline-performance.now()))}ms` });
        return k;
      }
      await sleep(POLL_STEP_MS);
    }
    log("poll timeout, key unchanged", { prevKey, windowMs });
    return null;
  }

  // >>>> MISSING BEFORE — added back: advance carousel robustly
  async function goNextSlide(container, prevKey, seenThisPost){
    let baseKey = prevKey || null;
    for (let attempt=0; attempt<RETRIES_PER_SLIDE; attempt++){
      const btn = getCarouselNextButton(container);
      if (btn) { btn.click(); }
      else { sendArrowRight(); }

      const k = await pollForNewKey(baseKey, container);
      if (k && (!baseKey || k !== baseKey)) return k;

      // rescue: any different, unseen key already in DOM?
      const keys = allCandidateKeys(container);
      const candidate = keys.find(x => x && x !== baseKey && !seenThisPost.has(x));
      if (candidate) return candidate;

      await sleep(120);
    }
    return null;
  }

  // ----- Downloads -----
  function directAnchorDownload(url, filename){
    return new Promise((resolve) => {
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click(); // keeps cookies + referrer
        a.remove();
        console.log("[InstaScan] download ok via direct anchor", filename);
        resolve(true);
      } catch (e) {
        console.error("[InstaScan] direct anchor failed", e);
        resolve(false);
      }
    });
  }

  async function downloadFile(url, filename){
    log("download begin", filename);
    if (typeof GM_download === "function"){
      const ok = await new Promise((resolve)=>{
        try{
          GM_download({
            url,
            name: filename,
            saveAs: false,
            timeout: 30000,
            onload: ()=> { log("download ok (GM_download)", filename); resolve(true); },
            ontimeout: ()=>{ console.error("[InstaScan] GM_download timeout", { url, filename }); resolve(false); },
            onerror: (e)=>{ console.error("[InstaScan] GM_download failed", e?.error || e?.message || e, e?.details); resolve(false); }
          });
        } catch (e){
          console.error("[InstaScan] GM_download threw", e, { url, filename });
          resolve(false);
        }
      });
      if (ok) return true;
    }
    return await directAnchorDownload(url, filename);
  }

  function getFileName(url){
    try{ const u=new URL(url); return (u.pathname.split("/").pop()||"image").split("?")[0]; }
    catch{ const p=url.split("/"); return (p[p.length-1]||"image").split("?")[0]; }
  }

  function extractCaption(container){
    const capEl =
      container.querySelector('h1[dir="auto"]') ||
      container.querySelector("h1") ||
      container.querySelector('div[role="dialog"] [dir="auto"]') ||
      container.querySelector('[data-testid="post-caption-text"]') ||
      container.querySelector('[dir="auto"]');
    let caption = capEl ? (capEl.innerText||capEl.textContent||"").trim() : "";
    const tags = [...container.querySelectorAll('a[href^="/explore/tags/"]')]
      .map(a=>(a.innerText||"").trim()).filter(Boolean);
    if (tags.length) caption = caption ? caption+"\n\n"+tags.join(" ") : tags.join(" ");
    return caption || "Caption not found";
  }

  function downloadTextFile(fileName, content){
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ------ GraphQL (hi-res) ------
  function getLSD(){
    // Try to extract the LSD token from inline scripts (works on IG web UI)
    const html = document.documentElement.innerHTML;
    let m = html.match(/"LSD",\s*{\s*"token":"([^"]+)"/);
    if (m && m[1]) return m[1];
    // fallback attempt (sometimes present)
    const m2 = html.match(/name="lsd"\s+value="([^"]+)"/i);
    if (m2 && m2[1]) return m2[1];
    return null;
  }

  async function fetchPostMedia(shortcode){
    if (!shortcode) throw new Error("shortcode missing");

    // One request attempt. When useCache=false we force known-safe defaults.
    const attempt = async (useCache) => {
      const lsd = getLSD();
      if (!lsd) throw new Error("LSD token not found");

      const docId = (useCache && DOC_ID_CACHE) || "10015901848480474"; // fallback doc_id
      const appId = (useCache && IG_APP_ID)    || "936619743392459";   // fallback app id

      const vars = JSON.stringify({ shortcode });
      const body = new URLSearchParams({ lsd, variables: vars, doc_id: docId });

      const resp = await fetch("https://www.instagram.com/api/graphql", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-IG-App-ID": appId,
          "X-FB-LSD": lsd,
          "X-ASBD-ID": "129477"
        },
        body
      });

      return resp;
    };

    let resp;
    // First: try with whatever we've learned/cached so far
    try {
      resp = await attempt(true);
      if (!resp.ok) throw new Error(String(resp.status));
    } catch (e1) {
      if (DEBUG) console.warn("[InstaScan] GraphQL attempt with cache failed:", e1);

      // Purge stale cache so the sniffer can relearn cleanly
      if (DOC_ID_CACHE) { GM_setValue("docid_shortcode_media", null); DOC_ID_CACHE = null; }
      if (IG_APP_ID)    { GM_setValue("ig_app_id", null);             IG_APP_ID    = null; }

      // Retry once with safe defaults
      try {
        resp = await attempt(false);
        if (!resp.ok) throw new Error(String(resp.status));
      } catch (e2) {
        if (DEBUG) console.warn("[InstaScan] GraphQL fallback attempt failed:", e2);
        throw e2; // let caller fall back to DOM method
      }
    }

    return resp.json();
  }

  async function getHighResUrls(shortcode) {
    try {
      const json = await fetchPostMedia(shortcode);
      const media = json?.data?.xdt_shortcode_media;
      if (!media) return { urls: [], caption: "" };

      const urls = [];
      function pushBiggest(resources){
        if (!Array.isArray(resources) || resources.length === 0) return;
        // pick largest by width/height if present; otherwise last item (IG usually sorts asc)
        const best = [...resources].sort((a,b)=> (b.config_width||0)-(a.config_width||0))[0] || resources[resources.length-1];
        if (best?.src) urls.push(best.src);
      }

      if (media.product_type === "carousel_container") {
        const children = media.edge_sidecar_to_children?.edges || [];
        for (const child of children) {
          const n = child?.node;
          if (!n) continue;
          if (n.media_type === 1) pushBiggest(n.display_resources); // images
          // skip videos
        }
      } else if (media.media_type === 1) {
        pushBiggest(media.display_resources); // single image
      }
      const caption =
        media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
        media?.caption?.text ||
        "Caption not found";

      return { urls, caption };
    } catch (e) {
      console.error("[InstaScan] GraphQL fetch failed", e);
      return { urls: [], caption: "" };
    }
  }

  // Concurrency helper
    async function runPool(items, limit, worker){
        let i = 0;
        const n = Math.min(limit, items.length);
        const runners = Array.from({ length: n }, async () => {
            for (;;){
                const idx = i++;
                if (idx >= items.length) break;
                try { await worker(items[idx], idx); }
                catch (e){ console.warn("[InstaScan] worker error", e); }
            }
        });
        await Promise.all(runners);
    }


  // ------ Flow ------
  async function processCurrentPost(){
    const myRun = currentRun();
    const container = getCurrentContainer();
    const shortcode = getPostId();
    const seenThisPost = new Set();

    log("=== PROCESS POST ===", { shortcode, url: location.pathname });

      // Try GraphQL hi-res first
      if (shortcode && shortcode !== "feed") {
          const { urls: highResUrls, caption: graphqlCaption } = await getHighResUrls(shortcode);

          if (highResUrls.length > 0) {
              log("Using GraphQL high-res URLs", highResUrls.length);
              let capSaved = false;

              await runPool(highResUrls, MAX_DL_CONCURRENCY, async (url, idx) => {
                  if (stopSlideshow || activeRunId !== myRun) return;

                  const kLocal = keyFor(url);
                  const kGlobal = gkey(shortcode, url);
                  if (seenThisPost.has(kLocal)) return;
                  seenThisPost.add(kLocal);

                  if (store[kGlobal]) { log("Already downloaded globally:", kGlobal); return; }

                  const name = getFileName(url);
                  log("download", { name, url: (url||"").replace(/^https?:\/\//,"").slice(0,120), key: kLocal });
                  const ok = await downloadFile(url, name);
                  if (ok){
                      if (!capSaved && graphqlCaption && graphqlCaption !== "Caption not found"){
                          capSaved = true; // only once
                          const txtName = name.replace(/\.[^/.]+$/, ".txt");
                          downloadTextFile(txtName, graphqlCaption);
                      }
                      markDownloaded(shortcode, url);
                  } else {
                      console.warn("Download failed:", url);
                  }
              });

              return; // done with this post
          }

          log("GraphQL gave no URLs; fallback to DOM method");
      }




    // Fallback to DOM traversal
    for (let step=0; step<MAX_SLIDES_SAFE; step++){
      if (stopSlideshow || activeRunId !== myRun) { log("stop requested mid-post"); return; }

      // video? skip the pane
      const vid = getActiveVideo(container);
      if (vid){
        log("Video pane; skipping");
        const nextK = await goNextSlide(container, null, seenThisPost);
        if (nextK === null){ log("stuck on video; finishing post"); break; }
        await sleep(BETWEEN_ACTION_MS);
        continue;
      }

      // ensure an image has actually loaded (lazy load)
      let img = getActiveMediaImage(container);
      if (!img){
        img = await waitForActiveImage(container, WAIT_IMAGE_MS);
        if (!img){
          log("No image after wait; attempt advance");
          const moved = await goNextSlide(container, null, seenThisPost);
          if (moved === null){ log("No image and cannot advance; finishing post"); break; }
          await sleep(BETWEEN_ACTION_MS);
          img = await waitForActiveImage(container, WAIT_IMAGE_MS);
          if (!img){
            log("Still no image after advance; continue");
            continue;
          }
        }
      }

      const url = bestHiResFromImg(img);
      if (!url){ log("No URL; stopping post"); break; }
      const kLocal = keyFor(url);
      const kGlobal = gkey(shortcode, url);

      log("current image", {
        short: (url||"").replace(/^https?:\/\//,"").slice(0,120),
        kLocal, kGlobal
      });

      if (!seenThisPost.has(kLocal)){
        seenThisPost.add(kLocal);

        if (!store[kGlobal]){
          const name = getFileName(url);
          log("download", { name, url: (url||"").replace(/^https?:\/\//,"").slice(0,120), key: kLocal });
          const ok = await downloadFile(url, name);
          if (ok){
            const cap = extractCaption(container);
            if (cap && cap !== "Caption not found"){
              const txtName = name.replace(/\.[^/.]+$/, ".txt");
              downloadTextFile(txtName, cap);
            }
            markDownloaded(shortcode, url);
          } else {
            console.warn("Download failed:", url);
          }
          await sleep(BETWEEN_ACTION_MS);
        } else {
          log("Already downloaded globally:", kGlobal);
        }
      } else {
        log("skip (seen in this post)", kLocal);
      }

      const newKey = await goNextSlide(container, kLocal, seenThisPost);
      if (newKey === null || newKey === kLocal){
        log("Carousel stuck after retries; finishing post");
        break;
      }
      log("advanced to newKey", newKey);
      await sleep(BETWEEN_ACTION_MS);
    }
  }

  function nextFeedArticleScroll(){
    const current = getCurrentContainer();
    const arts = [...document.querySelectorAll("article")].filter(isVisible)
      .sort((a,b)=> a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (!arts.length){
      window.scrollBy({ top: innerHeight*0.85, behavior:"smooth" });
      return;
    }
    const curTop = current.getBoundingClientRect().top;
    const next = arts.find(a => a.getBoundingClientRect().top > curTop + 8) || arts[arts.length-1];
    next.scrollIntoView({ behavior:"smooth", block:"center" });
  }

  async function goToNextImageOrPost(){
    const myRun = currentRun();
    if (stopSlideshow || activeRunId !== myRun) return;
    const modalNext = document.querySelector('div[role="dialog"] button[aria-label="Next"]');
    if (modalNext && isVisible(modalNext)){ modalNext.click(); await sleep(280); return; }
    nextFeedArticleScroll();
    await sleep(480);
  }

  async function startAsyncSlideshow(){
      if (activeRunId) { log("already running; ignoring start"); return; }
      stopSlideshow = false;
      activeRunId = Date.now();
      const runId = activeRunId;
      log("START run", runId);

      while (!stopSlideshow && activeRunId === runId){
          try {
              await processCurrentPost();
          } catch (e) {
              console.error("[InstaScan] processCurrentPost failed", e);
          }
          if (stopSlideshow || activeRunId !== runId) break;
          await goToNextImageOrPost();
      }


      if (activeRunId === runId) activeRunId = 0;
      log("END run", runId);
  }

  function requestStop(){
    stopSlideshow = true;
    activeRunId = 0;
    log("STOP requested");
  }

  // hotkeys
  window.addEventListener("keydown",(e)=>{
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.code==="KeyS"){ startAsyncSlideshow(); }
    else if (e.code==="KeyZ"){ requestStop(); }
  });

  // menu
  function clearList(){
    store = {};
    GM_setValue("downloadedImages_v12", JSON.stringify(store));
    GM_notification({ text:"Cleared downloaded list", title:"Insta Scan", timeout: 3000 });
  }
  GM_registerMenuCommand("Start Downloading [CTRL+SHIFT+S]", ()=>{ startAsyncSlideshow(); });
  GM_registerMenuCommand("Stop Downloading [CTRL+SHIFT+Z]",  ()=>{ requestStop(); });
  GM_registerMenuCommand("Clear Image List", clearList);
  GM_registerMenuCommand("Toggle Debug Logs", ()=> GM_notification({ text:`Set DEBUG=${!DEBUG} in the script and reload`, title:"Insta Scan", timeout:3000 }));
})();
